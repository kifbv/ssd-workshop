// Ticket 3.19: photos and voice recordings through templates/basic/workshop-data.js (savePhoto, recordVoice,
// deleteMedia), in Playwright's Chromium under the apps' REAL sandbox CSP (opaque origin), against a local stand-in for
// the media API (ticket 3.18) that judges the bytes with the real format check (`inspectMedia`) and serves what it
// stored at `/app-media/...` with the media headers.
// - Criterion 1: a 12-megapixel JPEG is uploaded at 2,560 px on its long side, and the page shows it from its address.
// - Criterion 2: a PNG is uploaded as a JPEG; a file the browser cannot decode (HEIC in Chromium) gets a plain message.
// - Criterion 3: a refused upload shows the API's message; a retry uses a new id.
// - Criterion 4: in the sandbox Chromium refuses the microphone ("Invalid security origin", even with a fake microphone
//   and the permission prompt answered yes), so recordVoice() opens the phone's own recorder (a file input with
//   accept="audio/*" and capture); the recording picked there is uploaded and plays back from its address. The
//   microphone path itself (MediaRecorder, stop, the 5-minute stop) is proved on the same client served WITHOUT the
//   sandbox, as a browser that allows the microphone runs it. AGENTS.md rule 15's example runs as written there: a
//   second tap while the microphone is being asked for starts nothing.
// - An answer with an address that is not this app's (another server, another app, a short id, none) and an id that app
//   code broke (btoa replaced) fail with a plain message; deleteMedia and savePhoto ignore a <base> app code adds.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_MEDIA_CONTENT_SECURITY_POLICY, APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { inspectMedia, MEDIA_CONTENT_TYPES, recordingSeconds } from "../app-media/formats.js";
import { APP_MEDIA_MESSAGES, MAX_MEDIA_FILE_BYTES, MEDIA_ID_PATTERN } from "../app-media/media.js";

const CLIENT = readFileSync(fileURLToPath(new URL("../../../templates/basic/workshop-data.js", import.meta.url)), "utf8");
/** The app under test is served sandboxed; `mic-nick` is the same app without the sandbox (a page allowed the microphone). */
const NICKNAME = "test-nick";
const OPEN_NICKNAME = "mic-nick";
/** The same open page, with AGENTS.md rule 15's Record/Stop example as its app code (RULE_APP). */
const RULE_NICKNAME = "rule-nick";
const OPEN_CSP = APPS_CONTENT_SECURITY_POLICY.split("; ").filter((part) => !part.startsWith("sandbox")).join("; ");
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const HAND_OFF = `#wt=${TOKEN}`;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" };
const LOGGED = (status: number) => `Failed to load resource: the server responded with a status of ${status}`;

/** A small photo-and-voice app written the way AGENTS.md asks (rules 14 and 15). */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <script src="workshop-data.js"></script>
    <title>Media test</title>
    <link rel="icon" href="data:,">
    <script src="app.js" defer></script>
  </head>
  <body>
    <label for="photo">Add a photo</label>
    <input id="photo" type="file" accept="image/*" capture="environment">
    <button id="record" type="button">Record</button>
    <p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p>
    <img id="shown" alt="The photo" loading="lazy" hidden>
    <audio id="voice" controls hidden></audio>
    <button id="remove" type="button">Delete the photo</button>
    <p id="status" role="status"></p>
  </body>
</html>`;

const APP = `"use strict";
const photoInput = document.getElementById("photo");
const recordButton = document.getElementById("record");
const shown = document.getElementById("shown");
const voice = document.getElementById("voice");
const statusText = document.getElementById("status");
let photoAddress = null;
let recording = null;
photoInput.addEventListener("change", async function () {
  const file = photoInput.files[0];
  photoInput.value = "";
  statusText.textContent = "Saving...";
  try {
    photoAddress = await workshopData.savePhoto(file);
    shown.src = photoAddress;
    shown.hidden = false;
    statusText.textContent = "Saved.";
  } catch (error) {
    statusText.textContent = error.message;
  }
});
recordButton.addEventListener("click", async function () {
  if (recording !== null) {
    recording.stop();
    return;
  }
  try {
    recording = await workshopData.recordVoice();
    window.usedMicrophone = recording.microphone;
    recordButton.textContent = "Stop";
    statusText.textContent = "Recording...";
    const address = await recording.done;
    voice.src = address;
    voice.hidden = false;
    statusText.textContent = "Saved.";
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    recording = null;
    recordButton.textContent = "Record";
  }
});
document.getElementById("remove").addEventListener("click", async function () {
  try {
    await workshopData.deleteMedia(photoAddress);
    shown.hidden = true;
    statusText.textContent = "Deleted.";
  } catch (error) {
    statusText.textContent = error.message;
  }
});`;

/**
 * AGENTS.md rule 15's Record/Stop example, run as it is written there, the address shown in #voice. Its first code block
 * after "15. Voice recordings".
 */
const AGENTS = readFileSync(fileURLToPath(new URL("../../../templates/basic/AGENTS.md", import.meta.url)), "utf8");
const RULE_EXAMPLE = /^15\. Voice recordings[\s\S]*?```js\n([\s\S]*?)```/m.exec(AGENTS)?.[1] ?? "";
const RULE_APP = `"use strict";
const recordButton = document.getElementById("record");
const voice = document.getElementById("voice");
const statusText = document.getElementById("status");
${RULE_EXAMPLE.replace("// Save the address with the message's other fields, then show it.", 'voice.src = address; voice.hidden = false; statusText.textContent = "Saved.";')}`;

/** One request the stand-in received. */
interface MediaCall {
  method: string;
  path: string;
  id: string;
  authorization: string | undefined;
  contentType: string | undefined;
  origin: string | undefined;
  status: number;
  bytes: number;
}

let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: string[];
let calls: MediaCall[];
/** What the stand-in stored, by id: the bytes and the type it serves them with. */
let stored: Map<string, { bytes: Buffer; type: string }>;
/** The next upload is refused with this answer (criterion 3). */
let refuseNext: { status: number; message: string } | undefined;
/** The next successful upload answers this address instead of its own (null: no address at all). */
let answerNext: ((id: string) => string | null) | undefined;
/** Expected console lines in the test under way (Chromium logs a refused request itself). */
let allowed: string[];

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const app = /^\/(?:api\/)?apps\/([a-z-]+)\//.exec(path)?.[1];
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { ...CORS, "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (app !== undefined && path === `/apps/${app}/`) {
        response.writeHead(200, { "content-type": "text/html", "content-security-policy": app === OPEN_NICKNAME || app === RULE_NICKNAME ? OPEN_CSP : APPS_CONTENT_SECURITY_POLICY });
        response.end(PAGE);
        return;
      }
      if (app !== undefined && (path === `/apps/${app}/workshop-data.js` || path === `/apps/${app}/app.js`)) {
        response.writeHead(200, { "content-type": "text/javascript", "content-security-policy": APPS_CONTENT_SECURITY_POLICY, "x-content-type-options": "nosniff" });
        response.end(path.endsWith("app.js") ? (app === RULE_NICKNAME ? RULE_APP : APP) : CLIENT);
        return;
      }
      if (app !== undefined && path === `/api/apps/${app}/data/whoami`) {
        if (request.method === "OPTIONS") return json(204, "");
        if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: APP_MEDIA_MESSAGES.signInToSave });
        return json(200, { nickname: "Bob" });
      }
      const media = /^\/api\/apps\/([a-z-]+)\/media\/([^/]+)$/.exec(path);
      if (media !== null) {
        const [, nick, id] = media as unknown as [string, string, string];
        if (request.method === "OPTIONS") {
          response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" });
          response.end();
          return;
        }
        const body = await readBody(request);
        const call: MediaCall = {
          method: request.method ?? "",
          path,
          id,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          origin: request.headers.origin,
          status: 0,
          bytes: body.length,
        };
        calls.push(call);
        const answer = (status: number, value: unknown) => {
          call.status = status;
          if (status === 204) {
            response.writeHead(204, CORS);
            response.end();
          } else json(status, value);
        };
        if (!MEDIA_ID_PATTERN.test(id)) return answer(400, { message: APP_MEDIA_MESSAGES.badId });
        if (request.headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { message: APP_MEDIA_MESSAGES.signInToSave });
        if (request.method === "DELETE") {
          stored.delete(id);
          return answer(204, null);
        }
        if (refuseNext !== undefined) {
          const refusal = refuseNext;
          refuseNext = undefined;
          return answer(refusal.status, { message: refusal.message });
        }
        if (stored.has(id) || calls.some((other) => other !== call && other.id === id)) return answer(409, { message: APP_MEDIA_MESSAGES.idTaken });
        if (body.length > MAX_MEDIA_FILE_BYTES) return answer(413, { message: APP_MEDIA_MESSAGES.fileTooBig });
        const found = inspectMedia(body);
        if (found === undefined) return answer(415, { message: APP_MEDIA_MESSAGES.unsupported });
        if (found.kind !== "jpeg" && (recordingSeconds(body, found.kind) ?? Infinity) > 305) return answer(413, { message: APP_MEDIA_MESSAGES.recordingTooLong });
        const bytes = found.kind === "jpeg" ? found.photo : body;
        stored.set(id, { bytes, type: MEDIA_CONTENT_TYPES[found.kind] });
        const odd = answerNext?.(id);
        answerNext = undefined;
        if (odd === null) return answer(201, { contentType: MEDIA_CONTENT_TYPES[found.kind], bytes: bytes.length });
        return answer(201, { address: odd ?? `${origin}/app-media/${nick}/${id}`, contentType: MEDIA_CONTENT_TYPES[found.kind], bytes: bytes.length });
      }
      const file = /^\/app-media\/[a-z-]+\/([^/]+)$/.exec(path)?.[1];
      const media2 = file === undefined ? undefined : stored.get(file);
      if (media2 !== undefined) {
        response.writeHead(200, { "content-type": media2.type, "content-security-policy": APP_MEDIA_CONTENT_SECURITY_POLICY, "x-content-type-options": "nosniff" });
        response.end(media2.bytes);
        return;
      }
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A fake microphone (a tone), with the permission prompt answered yes: the sandbox, not a missing device or a "no",
  // is what refuses it.
  browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  errors = [];
  allowed = [];
  calls = [];
  stored = new Map();
  refuseNext = undefined;
  answerNext = undefined;
  page.on("console", (message) => {
    if (message.type() === "error" && !allowed.some((line) => message.text().startsWith(line))) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // Every CSP refusal on the page, whatever its kind (a blob: preview would be one).
  await page.addInitScript(`window.violations = []; document.addEventListener("securitypolicyviolation", (event) => window.violations.push(event.effectiveDirective + " " + event.blockedURI));`);
});

afterEach(async () => {
  await context.close();
});

/** Opens the app (sandboxed unless `nickname` is the open one) and waits until whoAmI() settled. */
async function openApp(hash = HAND_OFF, nickname = NICKNAME): Promise<void> {
  const response = await page.goto(`${origin}/apps/${nickname}/${hash}`);
  expect(response?.headers()["content-security-policy"]).toBe(nickname === OPEN_NICKNAME || nickname === RULE_NICKNAME ? OPEN_CSP : APPS_CONTENT_SECURITY_POLICY);
  await page.evaluate("workshopData.whoAmI()");
}

/** Makes a picture in a blank page with OffscreenCanvas: a gradient, and a red square in the top-left corner. */
async function picture(type: "image/jpeg" | "image/png", width: number, height: number): Promise<Buffer> {
  const maker = await context.newPage();
  try {
    const base64 = await maker.evaluate<string>(`(async () => {
      const canvas = new OffscreenCanvas(${width}, ${height});
      const context = canvas.getContext("2d");
      const gradient = context.createLinearGradient(0, 0, ${width}, ${height});
      gradient.addColorStop(0, "#2f5bd3");
      gradient.addColorStop(1, "#f2c94c");
      context.fillStyle = gradient;
      context.fillRect(0, 0, ${width}, ${height});
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, ${Math.round(width / 10)}, ${Math.round(width / 10)});
      const blob = await canvas.convertToBlob({ type: "${type}", quality: 0.92 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(text);
    })()`);
    return Buffer.from(base64, "base64");
  } finally {
    await maker.close();
  }
}

/** Decodes JPEG bytes in the page: its size and the colour near its top-left corner. */
async function decoded(bytes: Buffer): Promise<{ width: number; height: number; corner: number[] }> {
  return page.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, corner: Array.from(context.getImageData(20, 20, 1, 1).data.slice(0, 3)) };
  })()`);
}

const statusText = () => page.locator("#status").textContent();
const uploads = () => calls.filter((call) => call.method === "PUT");

describe("savePhoto (ticket 3.19)", () => {
  it("criterion 1: WHEN a 12-megapixel JPEG is picked under the sandbox CSP THEN savePhoto uploads it at 2,560 px on its long side and the page shows it from its address", async () => {
    const photo = await picture("image/jpeg", 4000, 3000);
    expect(photo.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    await openApp();
    expect(await page.evaluate<string>("window.origin")).toBe("null");
    // App code adds a <base> to another server first (3.25's rule for every request the client makes).
    const elsewhere: string[] = [];
    await page.route("https://evil.example/**", (route) => {
      elsewhere.push(route.request().url());
      return route.fulfill({ status: 204, body: "" });
    });
    await page.evaluate(`(() => { const base = document.createElement("base"); base.href = "https://evil.example/"; document.head.append(base); })()`);

    await page.setInputFiles("#photo", { name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect.poll(statusText).toBe("Saved.");

    const [upload] = uploads();
    expect(uploads()).toHaveLength(1);
    expect(upload).toMatchObject({ path: `/api/apps/${NICKNAME}/media/${upload?.id}`, authorization: `Bearer ${TOKEN}`, contentType: "application/octet-stream", origin: "null", status: 201 });
    expect(upload?.id).toMatch(MEDIA_ID_PATTERN);
    expect(upload?.bytes).toBeLessThanOrEqual(MAX_MEDIA_FILE_BYTES);
    const kept = stored.get(upload?.id ?? "");
    expect(kept?.type).toBe("image/jpeg");
    const picture2 = await decoded(kept?.bytes ?? Buffer.alloc(0));
    expect({ width: picture2.width, height: picture2.height }).toEqual({ width: 2560, height: 1920 });
    // The same way up: the red square stays in the top-left corner.
    expect(picture2.corner[0]).toBeGreaterThan(200);
    expect(picture2.corner[2]).toBeLessThan(60);

    // The page shows it from the address the API answered: an https-or-own-server address, never a blob: one.
    const address = `${origin}/app-media/${NICKNAME}/${upload?.id}`;
    expect(await page.locator("#shown").getAttribute("src")).toBe(address);
    await expect.poll(() => page.evaluate<number>(`document.getElementById("shown").naturalWidth`)).toBe(2560);
    expect(await page.locator("#shown").isVisible()).toBe(true);
    expect(elsewhere).toEqual([]);
    expect(await page.evaluate<string[]>("window.violations")).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("criterion 2: WHEN the picked file is a PNG THEN it is uploaded as a JPEG (a small one keeps its size)", async () => {
    await openApp();
    for (const [width, height, expected] of [
      [3000, 2000, { width: 2560, height: 1707 }],
      [800, 600, { width: 800, height: 600 }],
      [1200, 3600, { width: 853, height: 2560 }],
    ] as const) {
      const png = await picture("image/png", width, height);
      expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
      await page.setInputFiles("#photo", { name: "drawing.png", mimeType: "image/png", buffer: png });
      await expect.poll(statusText).toBe("Saved.");
      const id = uploads().at(-1)?.id ?? "";
      const kept = stored.get(id);
      expect(kept?.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(kept?.type).toBe("image/jpeg");
      const { width: w, height: h } = await decoded(kept?.bytes ?? Buffer.alloc(0));
      expect({ width: w, height: h }).toEqual(expected);
      await page.evaluate(`document.getElementById("status").textContent = ""`);
    }
    expect(uploads().map((call) => call.status)).toEqual([201, 201, 201]);
    expect(new Set(uploads().map((call) => call.id)).size).toBe(3);
    expect(errors).toEqual([]);
  });

  it("criterion 2: WHEN the browser cannot decode the picked file (HEIC in Chromium, or not a picture) THEN a plain message shows and nothing is uploaded", async () => {
    await openApp();
    // The start of an iPhone HEIC file: Chromium has no HEIC decoder (Safari has one, and decodes it).
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64, 1)]);
    for (const [name, mimeType, buffer] of [
      ["IMG_0002.HEIC", "image/heic", heic],
      ["notes.txt", "text/plain", Buffer.from("not a picture")],
    ] as const) {
      await page.setInputFiles("#photo", { name, mimeType, buffer });
      await expect.poll(statusText).toBe("This browser cannot read this photo. Try another photo, or take it again with the camera.");
      await page.evaluate(`document.getElementById("status").textContent = ""`);
    }
    // No file picked at all (savePhoto called without one).
    expect(await page.evaluate<string>(`workshopData.savePhoto(undefined).then(() => "saved", (error) => error.message)`)).toBe("Choose a photo first.");
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("criterion 3: WHEN the upload is refused THEN the API's message is shown, and a retry uses a new id", async () => {
    allowed.push(LOGGED(429));
    await openApp();
    const photo = await picture("image/jpeg", 1600, 1200);
    refuseNext = { status: 429, message: APP_MEDIA_MESSAGES.uploadBudget };
    await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect.poll(statusText).toBe(APP_MEDIA_MESSAGES.uploadBudget);
    expect(await page.locator("#shown").isHidden()).toBe(true);
    // WAF's own 429 (too many uploads from one address) reads the same way.
    refuseNext = { status: 429, message: "Too many uploads from this address. Please wait a few minutes and try again." };
    await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect.poll(statusText).toBe("Too many uploads from this address. Please wait a few minutes and try again.");
    await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect.poll(statusText).toBe("Saved.");
    expect(uploads().map((call) => call.status)).toEqual([429, 429, 201]);
    expect(new Set(uploads().map((call) => call.id)).size).toBe(3);
    expect(errors).toEqual([]);
  });

  it("criterion 3: WHEN the API refuses the format THEN its message shows (a recording picked as a photo cannot be decoded either)", async () => {
    allowed.push(LOGGED(415));
    await openApp();
    refuseNext = { status: 415, message: APP_MEDIA_MESSAGES.unsupported };
    await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: await picture("image/jpeg", 64, 48) });
    await expect.poll(statusText).toBe(APP_MEDIA_MESSAGES.unsupported);
    expect(errors).toEqual([]);
  });

  it("WHEN the media API answers an address that is not this app's photo (another server, another app, a short id, none) THEN the odd-answer message shows and nothing shows that address", async () => {
    await openApp();
    const elsewhere: string[] = [];
    await page.route("https://evil.example/**", (route) => {
      elsewhere.push(route.request().url());
      return route.fulfill({ status: 204, body: "" });
    });
    const photo = await picture("image/jpeg", 64, 48);
    const odd: [string, (id: string) => string | null][] = [
      ["another server", (id) => `https://evil.example/app-media/${NICKNAME}/${id}`],
      ["another app", (id) => `${origin}/app-media/someone-else/${id}`],
      ["a short id", () => `${origin}/app-media/${NICKNAME}/short`],
      ["a longer path", (id) => `${origin}/app-media/${NICKNAME}/${id}/../x`],
      ["a query after the id", (id) => `${origin}/app-media/${NICKNAME}/${id}?x=1`],
      ["no address", () => null],
    ];
    const answered: string[] = [];
    for (const [what, address] of odd) {
      answerNext = (id) => {
        const chosen = address(id);
        if (chosen !== null) answered.push(chosen);
        return chosen;
      };
      await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: photo });
      await expect.poll(statusText, { message: what }).toBe("The workshop answered something unexpected. Please try again.");
      await page.evaluate(`document.getElementById("status").textContent = ""`);
    }
    expect(answered).toHaveLength(5);
    expect(uploads().map((call) => call.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const sources = await page.evaluate<string[]>(`Array.from(document.querySelectorAll("img, audio, source")).map((el) => el.getAttribute("src") || "")`);
    for (const address of answered) expect(sources).not.toContain(address);
    expect(await page.locator("#shown").isHidden()).toBe(true);
    expect(elsewhere).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("WHEN app code replaces btoa so the new id is not 22 base64url characters THEN nothing is sent and a plain message shows", async () => {
    await openApp();
    const photo = await picture("image/jpeg", 64, 48);
    for (const made of ["../../data/x", "a".repeat(21), "a".repeat(23), "a/b?c#d" + "a".repeat(15)]) {
      await page.evaluate(`window.btoa = () => ${JSON.stringify(made)}`);
      await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: photo });
      await expect.poll(statusText, { message: made }).toBe("Something on this page stopped the upload. Please reload the page and try again.");
      await page.evaluate(`document.getElementById("status").textContent = ""`);
    }
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("WHEN a visitor (no sign-in) picks a photo THEN the sign-in message and button show and nothing is sent", async () => {
    await openApp("");
    expect(await page.getByRole("button", { name: "Sign in to save" }).isVisible()).toBe(true);
    await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: await picture("image/jpeg", 64, 48) });
    await expect.poll(statusText).toBe(APP_MEDIA_MESSAGES.signInToSave);
    await page.click("#record");
    await expect.poll(() => page.evaluate<unknown>("window.usedMicrophone")).toBeUndefined();
    expect(await statusText()).toBe(APP_MEDIA_MESSAGES.signInToSave);
    expect(calls).toEqual([]);
    expect(await page.getByRole("button", { name: "Sign in to save" }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });

  it("WHEN the sign-in has ended (the API answers 401) THEN its message shows and the sign-in button comes back", async () => {
    allowed.push(LOGGED(401));
    await openApp();
    expect(await page.locator("[data-workshop-sign-in]").isHidden()).toBe(true);
    refuseNext = { status: 401, message: APP_MEDIA_MESSAGES.signInToSave };
    await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: await picture("image/jpeg", 64, 48) });
    await expect.poll(statusText).toBe(APP_MEDIA_MESSAGES.signInToSave);
    expect(await page.getByRole("button", { name: "Sign in to save" }).isVisible()).toBe(true);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("deleteMedia (ticket 3.19)", () => {
  it("WHEN the app deletes a photo by its address THEN the media API gets a DELETE of that id with the sign-in, and other addresses are refused unsent", async () => {
    await openApp();
    await page.setInputFiles("#photo", { name: "a.jpg", mimeType: "image/jpeg", buffer: await picture("image/jpeg", 64, 48) });
    await expect.poll(statusText).toBe("Saved.");
    const id = uploads()[0]?.id ?? "";
    // App code adds a <base> to another server first (3.25's rule for every request the client makes).
    const elsewhere: string[] = [];
    await page.route("https://evil.example/**", (route) => {
      elsewhere.push(route.request().url());
      return route.fulfill({ status: 204, body: "" });
    });
    await page.evaluate(`(() => { const base = document.createElement("base"); base.href = "https://evil.example/"; document.head.append(base); })()`);
    await page.click("#remove");
    await expect.poll(statusText).toBe("Deleted.");
    expect(calls.filter((call) => call.method === "DELETE").map((call) => [call.path, call.authorization, call.status])).toEqual([
      [`/api/apps/${NICKNAME}/media/${id}`, `Bearer ${TOKEN}`, 204],
    ]);
    expect(stored.has(id)).toBe(false);
    const refused = await page.evaluate<string[]>(`Promise.all([
      "https://evil.example/app-media/${NICKNAME}/${id}",
      "${origin}/app-media/someone-else/${id}",
      "${origin}/app-media/${NICKNAME}/../x",
      "${origin}/app-media/${NICKNAME}/short",
      42,
    ].map((address) => workshopData.deleteMedia(address).then(() => "deleted", (error) => error.message)))`);
    expect(new Set(refused)).toEqual(new Set(["This is not the address of one of this app's photos or recordings."]));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(elsewhere).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/** Records about 1.5 s of the fake microphone with workshop-data.js on the page served without the sandbox. */
async function recordOnOpenPage(): Promise<{ id: string; bytes: Buffer }> {
  await openApp(HAND_OFF, OPEN_NICKNAME);
  await page.click("#record");
  await expect.poll(statusText).toBe("Recording...");
  expect(await page.evaluate<unknown>("window.usedMicrophone")).toBe(true);
  expect(await page.locator("#record").textContent()).toBe("Stop");
  await page.waitForTimeout(1500);
  await page.click("#record");
  await expect.poll(statusText).toBe("Saved.");
  const id = uploads().at(-1)?.id ?? "";
  return { id, bytes: stored.get(id)?.bytes ?? Buffer.alloc(0) };
}

/** The <audio> element plays its address: metadata loads and the time moves forward. */
async function playsBack(address: string): Promise<void> {
  expect(await page.locator("#voice").getAttribute("src")).toBe(address);
  const played = await page.evaluate<{ ready: number; time: number; error: unknown }>(`(async () => {
    const voice = document.getElementById("voice");
    if (voice.readyState < 1) await new Promise((resolve, reject) => { voice.addEventListener("loadedmetadata", resolve); voice.addEventListener("error", reject); });
    await voice.play();
    await new Promise((resolve) => setTimeout(resolve, 600));
    voice.pause();
    return { ready: voice.readyState, time: voice.currentTime, error: voice.error && voice.error.code };
  })()`);
  expect(played.error).toBeNull();
  expect(played.ready).toBeGreaterThanOrEqual(1);
  expect(played.time).toBeGreaterThan(0.2);
}

describe("recordVoice (ticket 3.19)", () => {
  it("finding: WHEN a sandboxed app asks for the microphone in Chromium THEN it is refused (opaque origin), even with a fake microphone and the prompt answered yes", async () => {
    await openApp();
    expect(await page.evaluate<string>(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "allowed", (error) => error.name + ": " + error.message)`)).toBe(
      "SecurityError: Invalid security origin",
    );
    // The same page without the sandbox gets it (the control).
    await openApp(HAND_OFF, OPEN_NICKNAME);
    expect(await page.evaluate<string>(`navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => { stream.getTracks().forEach((t) => t.stop()); return "allowed"; }, (error) => error.name)`)).toBe("allowed");
  });

  it("criterion 4: WHEN recordVoice() runs in Chromium with a fake microphone under the sandbox CSP THEN the phone's own recorder opens, and the recording is uploaded and plays back from its address", async () => {
    // A real recording of the fake microphone (MediaRecorder's WebM/Opus), made where the microphone is allowed.
    const made = await recordOnOpenPage();
    expect(inspectMedia(made.bytes)?.kind).toBe("webm");
    calls = [];

    await openApp();
    const chooser = page.waitForEvent("filechooser");
    await page.click("#record");
    const picker = await chooser;
    expect(await picker.element().getAttribute("accept")).toBe("audio/*");
    expect(await picker.element().getAttribute("capture")).toBe("");
    expect(picker.isMultiple()).toBe(false);
    expect(await page.evaluate<unknown>("window.usedMicrophone")).toBe(false);
    await picker.setFiles({ name: "Voice 001.webm", mimeType: "audio/webm", buffer: made.bytes });
    await expect.poll(statusText).toBe("Saved.");

    const [upload] = uploads();
    expect(upload).toMatchObject({ authorization: `Bearer ${TOKEN}`, contentType: "application/octet-stream", origin: "null", status: 201 });
    expect(stored.get(upload?.id ?? "")?.type).toBe("audio/webm");
    await playsBack(`${origin}/app-media/${NICKNAME}/${upload?.id}`);
    // The file input it used is gone again.
    expect(await page.locator("input[type=file][accept='audio/*']").count()).toBe(0);
    expect(await page.evaluate<string[]>("window.violations")).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("criterion 4 (fallback): WHEN the visitor closes the phone's recorder without a recording THEN recordVoice says so and nothing is sent", async () => {
    await openApp();
    const chooser = page.waitForEvent("filechooser");
    await page.click("#record");
    await chooser;
    // Pressing the app's Stop while the recorder is open (or a browser's cancel event) ends it.
    await page.click("#record");
    await expect.poll(statusText).toBe("No recording was chosen.");
    expect(await page.locator("#record").textContent()).toBe("Record");
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("WHEN the microphone is allowed (the page without the sandbox) THEN recordVoice records with MediaRecorder until stop(), uploads, and the recording plays back", async () => {
    const made = await recordOnOpenPage();
    const upload = uploads().at(-1);
    expect(upload).toMatchObject({ authorization: `Bearer ${TOKEN}`, contentType: "application/octet-stream", status: 201 });
    expect(inspectMedia(made.bytes)?.kind).toBe("webm");
    const seconds = recordingSeconds(made.bytes, "webm") ?? 0;
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(4);
    await playsBack(`${origin}/app-media/${OPEN_NICKNAME}/${made.id}`);
    expect(errors).toEqual([]);
  });

  it("WHEN the Record button of AGENTS.md rule 15's example is tapped twice while the microphone is still being asked for THEN one recording starts, and the next tap stops and saves it", async () => {
    expect(RULE_EXAMPLE).toContain("await workshopData.recordVoice()");
    expect(RULE_APP).toContain('statusText.textContent = "Saved."');
    // The visitor takes a second to answer the microphone prompt; every request for the microphone is counted.
    await page.addInitScript(`(() => {
      window.microphoneAsks = 0;
      const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => { window.microphoneAsks += 1; return new Promise((resolve) => setTimeout(resolve, 1000)).then(() => ask(constraints)); };
    })()`);
    await openApp(HAND_OFF, RULE_NICKNAME);
    await page.click("#record");
    await page.click("#record");
    await expect.poll(statusText, { timeout: 5_000 }).toBe("Recording...");
    expect(await page.evaluate<number>("window.microphoneAsks")).toBe(1);
    await page.waitForTimeout(1000);
    await page.click("#record");
    await expect.poll(statusText).toBe("Saved.");
    expect(await page.locator("#record").textContent()).toBe("Record");
    await page.waitForTimeout(500);
    expect(uploads().map((call) => call.status)).toEqual([201]);
    await playsBack(`${origin}/app-media/${RULE_NICKNAME}/${uploads()[0]?.id}`);
    expect(errors).toEqual([]);
  });

  it("WHEN a microphone recording reaches 5 minutes THEN it stops by itself and is uploaded", async () => {
    await page.clock.install();
    await openApp(HAND_OFF, OPEN_NICKNAME);
    await page.click("#record");
    await expect.poll(statusText).toBe("Recording...");
    await page.waitForTimeout(800);
    await page.clock.fastForward(296_000);
    await page.waitForTimeout(300);
    expect(await statusText()).toBe("Recording...");
    expect(uploads()).toEqual([]);
    await page.clock.fastForward(5_000);
    await expect.poll(statusText).toBe("Saved.");
    expect(uploads().map((call) => call.status)).toEqual([201]);
    expect(errors).toEqual([]);
  });
});
