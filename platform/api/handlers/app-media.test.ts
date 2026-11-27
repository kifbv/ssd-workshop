// Ticket 3.18: the media function's logs hold no token, no email, no app nickname and no id. Every console method is
// captured while the handler (with its real logger) serves uploads, refusals, deletes and a failure.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAppToken } from "../app-token/token.js";
import { FakeAppMediaStore, FakeMediaBucket } from "../app-media/fakes.js";
import { exifWithGps, jpegOfSize, webmOfSize } from "../app-media/fixtures.js";
import type { HttpRequest } from "../http.js";
import { createHandler, logEntry } from "./app-media.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const NICK = "Marker-Nick";
const ID = "IDMARKERxxxxxxxxxxxxxx";
const TOKEN = Buffer.from("TOKENMARKER".padEnd(32, "t")).toString("base64url");
const req = (method: string, options: { id?: string; body?: Buffer; token?: string; nickname?: string } = {}): HttpRequest => ({
  routeKey: `${method} /api/apps/{nickname}/media/{id}`,
  pathParameters: { nickname: options.nickname ?? NICK, id: options.id ?? ID },
  headers: { origin: "null", authorization: `Bearer ${options.token ?? TOKEN}`, "x-forwarded-for": "ada@example.com" },
  ...(options.body === undefined ? {} : { body: options.body.toString("base64"), isBase64Encoded: true }),
});

describe("ticket 3.18: the media function's logs", () => {
  it("writes one JSON line per request (method, outcome, status, size, kind, the writer after the token check) and never the token, its hash, an email, the app's nickname or an id", async () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void written.push(args.map(String).join(" ")));
    }
    const store = new FakeAppMediaStore();
    const bucket = new FakeMediaBucket();
    store.live.add(NICK.toLowerCase());
    store.tokens.tokens.set(hashAppToken(TOKEN), { app: NICK.toLowerCase(), nickname: "Writer-Nick", kind: "edit" });
    const call = createHandler({ store, bucket, tokens: store.tokens, now: () => new Date("2026-11-27T10:00:00.000Z"), log: logEntry, pause: async () => {} });

    const statuses: number[] = [];
    statuses.push((await call(req("PUT", { body: jpegOfSize(20_000, [exifWithGps()]) }))).statusCode);
    statuses.push((await call(req("PUT", { id: "IDMARKERyyyyyyyyyyyyyy", body: webmOfSize(30_000) }))).statusCode);
    statuses.push((await call(req("PUT", { id: "IDMARKERzzzzzzzzzzzzzz", body: Buffer.from("<html>MARKER</html>") }))).statusCode);
    statuses.push((await call(req("PUT", { token: TOKEN.slice(0, -1) + "A", body: jpegOfSize(1000) }))).statusCode);
    statuses.push((await call(req("PUT", { id: "IDMARKER/../x", body: jpegOfSize(1000) }))).statusCode);
    statuses.push((await call(req("DELETE"))).statusCode);
    statuses.push((await call(req("OPTIONS"))).statusCode);
    statuses.push((await call(req("PUT", { nickname: "Other-Marker", body: jpegOfSize(1000) }))).statusCode);
    store.failure = Object.assign(new Error(`APPMEDIA#${NICK} ${ID} failed`), { name: "InternalServerError" });
    statuses.push((await call(req("DELETE"))).statusCode);

    expect(statuses).toEqual([201, 201, 415, 401, 400, 204, 204, 404, 500]);
    expect(written).toHaveLength(statuses.length);
    const lines = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) expect(Object.keys(line)).toEqual(expect.arrayContaining(["event", "method", "outcome", "status"]));
    const output = written.join("\n");
    for (const marker of ["Marker-Nick", "marker-nick", "Other-Marker", "IDMARKER", "MARKER", TOKEN, TOKEN.slice(0, 20), hashAppToken(TOKEN), "Bearer", "@", "APPMEDIA#", "app-media/"]) {
      expect(output, marker).not.toContain(marker);
    }
    expect(lines.filter((l) => l["writer"] !== undefined).map((l) => [l["method"], l["outcome"], l["writer"]])).toEqual([
      ["PUT", "stored", "Writer-Nick"],
      ["PUT", "stored", "Writer-Nick"],
      ["PUT", "unsupported-media-type", "Writer-Nick"],
      ["DELETE", "deleted", "Writer-Nick"],
    ]);
  });

  it("logs only through logEntry, and never names a cookie", () => {
    const sources = ["./app-media.ts", "../app-media/media.ts", "../app-media/store.ts", "../app-media/formats.ts"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    expect(sources.flatMap((source) => source.match(/console\.[a-z]+\([^;\n]*/g) ?? [])).toEqual(["console.log(JSON.stringify(entry))"]);
    const code = sources.map((source) => source.replace(/^\s*(\/\/|\/?\*).*$/gm, "")).join("\n");
    expect(code).not.toMatch(/cookie/i);
  });
});
