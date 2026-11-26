// Ticket 3.18 in Playwright's Chromium: real encoder output and real loading.
// - A photo Chromium encodes (canvas JPEG) with an Exif GPS segment added still decodes after stripJpegMetadata, with
//   the same size and pixels, and the stripped bytes hold no Exif (criterion 4, "still decodes").
// - MediaRecorder's own recordings (WebM/Opus, and MP4 when this Chromium records it) pass detectMedia (criterion 2's
//   formats, from the real recorder rather than a hand-made file).
// - An app page under the REAL apps CSP (sandboxed, opaque origin) shows a photo and plays a recording served from
//   `/app-media/...` of its own server with the media headers (nosniff, the media CSP): `img-src 'self'` and
//   `media-src`, which falls back to `default-src 'self'`, both match the served address, not the opaque origin.
// - A file at `/app-media/...` opened on its own runs nothing, even if a browser were handed HTML there (the media CSP's
//   `sandbox` and `default-src 'none'`).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_MEDIA_CONTENT_SECURITY_POLICY, APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { exifWithGps } from "./fixtures.js";
import { detectMedia, stripJpegMetadata } from "./formats.js";
import { MEDIA_CACHE_CONTROL } from "./media.js";

const PHOTO_ID = "PhotoPhotoPhotoPhoto01";
const VOICE_ID = "VoiceVoiceVoiceVoice01";
const EVIL_ID = "EvilEvilEvilEvilEvil01";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/**
 * Runs browser code (plain JavaScript text: this package's TypeScript has no DOM types) on one JSON argument and
 * returns its result.
 */
async function inPage<T>(page: Page, source: string, argument: unknown = null): Promise<T> {
  return (await page.evaluate(`(${source})(${JSON.stringify(argument)})`)) as T;
}

/** Bytes to base64 inside the page. */
const TO_BASE64 = `(bytes) => { let text = ""; for (const b of bytes) text += String.fromCharCode(b); return btoa(text); }`;

/** A JPEG Chromium encodes: a 64 x 48 picture, left half red, right half blue. */
async function chromiumJpeg(page: Page): Promise<Buffer> {
  const base64 = await inPage<string>(
    page,
    `async () => {
      const canvas = new OffscreenCanvas(64, 48);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 32, 48);
      context.fillStyle = "#0000ff";
      context.fillRect(32, 0, 32, 48);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
      return (${TO_BASE64})(new Uint8Array(await blob.arrayBuffer()));
    }`,
  );
  return Buffer.from(base64, "base64");
}

/** Decodes JPEG bytes in Chromium: its size and the colour of a pixel in each half. */
async function decode(page: Page, jpeg: Buffer): Promise<{ width: number; height: number; left: number[]; right: number[] }> {
  return inPage(
    page,
    `async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const pixel = (x) => Array.from(context.getImageData(x, 24, 1, 1).data.slice(0, 3));
      return { width: bitmap.width, height: bitmap.height, left: pixel(8), right: pixel(56) };
    }`,
    jpeg.toString("base64"),
  );
}

/** Records about a second of a 440 Hz tone with MediaRecorder in the given type, or undefined when Chromium cannot. */
async function record(page: Page, mimeType: string): Promise<Buffer | undefined> {
  const base64 = await inPage<string | null>(
    page,
    `async (type) => {
      if (!MediaRecorder.isTypeSupported(type)) return null;
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      const recorder = new MediaRecorder(destination.stream, { mimeType: type });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      recorder.stop();
      await stopped;
      oscillator.stop();
      await context.close();
      return (${TO_BASE64})(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    }`,
    mimeType,
  );
  return base64 === null ? undefined : Buffer.from(base64, "base64");
}

/** A short video recording (a canvas stream as WebM/VP8), which the media API must refuse. */
async function recordVideo(page: Page): Promise<Buffer> {
  const base64 = await inPage<string>(
    page,
    `async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      for (let i = 0; i < 8; i += 1) {
        context.fillStyle = i % 2 === 0 ? "#000" : "#fff";
        context.fillRect(0, 0, 32, 32);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      recorder.stop();
      await stopped;
      return (${TO_BASE64})(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    }`,
  );
  return Buffer.from(base64, "base64");
}

describe("real encoder output", () => {
  it("criterion 4: a Chromium JPEG with an Exif GPS segment, stripped, has no Exif and decodes to the same picture", async () => {
    const page = await browser.newPage();
    try {
      const original = await chromiumJpeg(page);
      // Exif goes right after SOI (and Chromium's JFIF APP0, if any), where cameras put it.
      const afterApp0 = original[3] === 0xe0 ? 4 + original.readUInt16BE(4) : 2;
      const photo = Buffer.concat([original.subarray(0, afterApp0), exifWithGps(), original.subarray(afterApp0)]);
      expect(photo.includes(Buffer.from("Exif\0\0"))).toBe(true);
      expect(detectMedia(photo)).toBe("jpeg");
      const before = await decode(page, photo);

      const stripped = stripJpegMetadata(photo) as Buffer;
      expect(stripped.includes(Buffer.from("Exif\0\0"))).toBe(false);
      expect(stripped.length).toBe(photo.length - exifWithGps().length);
      const after = await decode(page, stripped);
      expect(after).toEqual(before);
      expect(after.width).toBe(64);
      expect(after.height).toBe(48);
      // Red on the left, blue on the right (JPEG is lossy: close, not exact).
      expect(after.left[0]).toBeGreaterThan(200);
      expect(after.left[2]).toBeLessThan(60);
      expect(after.right[2]).toBeGreaterThan(200);
      expect(after.right[0]).toBeLessThan(60);
    } finally {
      await page.close();
    }
  });

  it("criterion 2: MediaRecorder's WebM/Opus (and its MP4, where this Chromium records one) pass the format check", async () => {
    const page = await browser.newPage();
    try {
      const webm = await record(page, "audio/webm;codecs=opus");
      expect(webm).toBeDefined();
      expect((webm as Buffer).length).toBeGreaterThan(500);
      expect(detectMedia(webm as Buffer)).toBe("webm");
      // Newer Chromium records MP4 too (AAC or Opus inside); older ones answer isTypeSupported false.
      const mp4 = await record(page, "audio/mp4");
      if (mp4 !== undefined) expect(detectMedia(mp4)).toBe("mp4");
      // A video recording is refused: a canvas stream recorded as WebM (VP8).
      const video = await recordVideo(page);
      expect(video.length).toBeGreaterThan(100);
      expect(detectMedia(video)).toBeUndefined();
    } finally {
      await page.close();
    }
  });
});

describe("criterion 7 and the apps CSP: media from /app-media/ in a sandboxed app", () => {
  let server: Server;
  let origin: string;
  let photo: Buffer;
  let voice: Buffer;
  const served: { path: string; status: number }[] = [];

  beforeAll(async () => {
    const page = await browser.newPage();
    photo = stripJpegMetadata(await chromiumJpeg(page)) as Buffer;
    voice = (await record(page, "audio/webm;codecs=opus")) as Buffer;
    await page.close();
    const files: Record<string, { type: string; body: Buffer | string; csp: string }> = {
      "/apps/test-nick/": {
        type: "text/html",
        csp: APPS_CONTENT_SECURITY_POLICY,
        body: `<!doctype html><html><head><meta charset="utf-8"><script src="app.js" defer></script></head><body>
<img id="photo" src="/app-media/test-nick/${PHOTO_ID}" alt="">
<audio id="voice" src="/app-media/test-nick/${VOICE_ID}" preload="auto" controls></audio>
<p id="result"></p></body></html>`,
      },
      "/apps/test-nick/app.js": {
        type: "text/javascript",
        csp: APPS_CONTENT_SECURITY_POLICY,
        body: `const result = document.getElementById("result");
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
const voice = document.getElementById("voice");
const photo = document.getElementById("photo");
const loaded = new Promise((resolve) => (photo.complete ? resolve() : photo.addEventListener("load", resolve)));
const metadata = new Promise((resolve, reject) => {
  if (voice.readyState >= 1) resolve();
  voice.addEventListener("loadedmetadata", resolve);
  voice.addEventListener("error", () => reject(new Error("audio " + (voice.error && voice.error.code))));
});
Promise.all([loaded, metadata]).then(
  () => (result.textContent = JSON.stringify({ origin: window.origin, width: photo.naturalWidth, height: photo.naturalHeight, audio: voice.readyState, violations })),
  (error) => (result.textContent = "failed: " + error.message),
);`,
      },
      [`/app-media/test-nick/${PHOTO_ID}`]: { type: "image/jpeg", csp: APP_MEDIA_CONTENT_SECURITY_POLICY, body: "" },
      [`/app-media/test-nick/${VOICE_ID}`]: { type: "audio/webm", csp: APP_MEDIA_CONTENT_SECURITY_POLICY, body: "" },
      // Not something the API ever stores (it stores only JPEG and audio): proves the media CSP alone keeps a page inert.
      [`/app-media/test-nick/${EVIL_ID}`]: { type: "text/html", csp: APP_MEDIA_CONTENT_SECURITY_POLICY, body: "<script>document.title = 'ran'</script><p>x</p>" },
    };
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const file = files[path];
      if (file === undefined) {
        served.push({ path, status: 404 });
        response.writeHead(404).end();
        return;
      }
      const body = path.endsWith(PHOTO_ID) ? photo : path.endsWith(VOICE_ID) ? voice : file.body;
      served.push({ path, status: 200 });
      response.writeHead(200, {
        "content-type": file.type,
        "content-security-policy": file.csp,
        "x-content-type-options": "nosniff",
        ...(path.startsWith("/app-media/") ? { "cache-control": MEDIA_CACHE_CONTROL } : {}),
      });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  it("WHEN a sandboxed app shows a photo and a recording from /app-media/ THEN both load, with no CSP violation or console error", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}/apps/test-nick/`);
      await expect.poll(() => page.locator("#result").textContent(), { timeout: 10_000 }).not.toBe("");
      const result = JSON.parse((await page.locator("#result").textContent()) ?? "{}") as { origin: string; width: number; height: number; audio: number; violations: string[] };
      expect(result.origin).toBe("null");
      expect(result).toMatchObject({ width: 64, height: 48, violations: [] });
      expect(result.audio).toBeGreaterThanOrEqual(1);
      expect(errors).toEqual([]);
      expect(served.map((s) => s.path)).toEqual(expect.arrayContaining([`/app-media/test-nick/${PHOTO_ID}`, `/app-media/test-nick/${VOICE_ID}`]));
    } finally {
      await page.close();
    }
  });

  it("WHEN a media address is opened on its own THEN nothing in it runs (the media CSP sandboxes it), even for a page", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/app-media/test-nick/${EVIL_ID}`);
      await page.waitForTimeout(200);
      expect(await page.title()).not.toBe("ran");
      const photoPage = await page.goto(`${origin}/app-media/test-nick/${PHOTO_ID}`);
      expect(photoPage?.headers()["content-type"]).toBe("image/jpeg");
      expect(photoPage?.headers()["x-content-type-options"]).toBe("nosniff");
    } finally {
      await page.close();
    }
  });
});
