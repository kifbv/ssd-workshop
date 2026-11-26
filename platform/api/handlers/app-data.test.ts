// Ticket 2.4 criterion 6: the function's logs hold no stored value. Every console method is captured
// while the handler (with its real logger) serves the whole range of requests; then no stored value,
// key or nickname may appear in what was written.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAppDataStore } from "../app-data/fakes.js";
import { MAX_VALUE_BYTES } from "../app-data/data.js";
import type { HttpRequest } from "../http.js";
import { hashAppToken } from "../app-token/token.js";
import { createHandler, logEntry } from "./app-data.js";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

function captureConsole(): { output: () => string; lines: () => number } {
  const written: string[] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  void stdout;
  void stderr;
  return { output: () => written.join("\n"), lines: () => written.length };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const NICK = "Marker-Nick";
/** Ticket 3.24: the write token (its text is a marker too: it must never be logged, nor its hash). */
const TOKEN = Buffer.from("TOKENMARKER".padEnd(32, "t")).toString("base64url");
const AUTH = { authorization: `Bearer ${TOKEN}` };
const route = (method: string) => `${method} /api/apps/{nickname}/data/{key}`;
const req = (method: string, key: string, body?: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
  routeKey: route(method),
  pathParameters: { nickname: NICK, key },
  headers: { origin: "null", ...(method === "PUT" ? { "content-type": "application/json" } : {}), ...(method === "PUT" || method === "DELETE" ? AUTH : {}) },
  ...(body === undefined ? {} : { body }),
  ...extra,
});

describe("criterion 6: the function's logs hold no stored value", () => {
  it("writes one line per request with method, outcome, status and size, and none of the values, keys or nicknames", async () => {
    const capture = captureConsole();
    const store = new FakeAppDataStore();
    store.live.add(NICK.toLowerCase());
    store.tokens.tokens.set(hashAppToken(TOKEN), { app: NICK.toLowerCase(), nickname: "WRITER-MARKER", expiresAt: Date.parse("2026-11-25T10:00:00.000Z") / 1000 });
    const call = createHandler({ store, tokens: store.tokens, now: () => new Date("2026-11-24T10:00:00.000Z"), log: logEntry, pause: async () => {} });
    const values = [
      "VALUE-MARKER-TEXT",
      { secretField: "VALUE-MARKER-OBJECT", list: ["VALUE-MARKER-LIST"] },
      ["VALUE-MARKER-ARRAY"],
      987654321.123,
    ];
    const statuses: number[] = [];
    for (const [index, value] of values.entries()) {
      const key = `KEYMARKER${index}`;
      statuses.push((await call(req("PUT", key, JSON.stringify(value)))).statusCode);
      statuses.push((await call(req("GET", key))).statusCode);
    }
    statuses.push((await call(req("PUT", "KEYMARKERbig", JSON.stringify(`VALUE-MARKER-BIG${"x".repeat(MAX_VALUE_BYTES)}`)))).statusCode);
    statuses.push((await call(req("PUT", "KEYMARKERbad", "{VALUE-MARKER-BROKEN"))).statusCode);
    statuses.push((await call(req("PUT", "KEYMARKER0", '"VALUE-MARKER-TYPE"', { headers: { "content-type": "text/plain", ...AUTH } }))).statusCode);
    statuses.push((await call(req("GET", "KEYMARKER bad key"))).statusCode);
    statuses.push((await call(req("OPTIONS", "KEYMARKER0"))).statusCode);
    statuses.push((await call(req("DELETE", "KEYMARKER1"))).statusCode);
    // Ticket 3.24: refused writes (no token, an unknown one) log no token either.
    statuses.push((await call(req("PUT", "KEYMARKER0", "1", { headers: { "content-type": "application/json" } }))).statusCode);
    statuses.push((await call(req("PUT", "KEYMARKER0", "1", { headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN.slice(0, -1)}A` } }))).statusCode);
    statuses.push((await call({ ...req("GET", "KEYMARKER0"), pathParameters: { nickname: "Other-Marker", key: "KEYMARKER0" } })).statusCode);
    statuses.push((await call(req("GET", "KEYMARKER0", undefined, { cookies: ["ssd_session=COOKIE-MARKER"] }))).statusCode);
    store.failure = Object.assign(new Error("VALUE-MARKER-IN-ERROR"), { name: "InternalServerError" });
    statuses.push((await call(req("PUT", "KEYMARKER0", '"VALUE-MARKER-FAIL"'))).statusCode);

    expect(statuses).toEqual([204, 200, 204, 200, 204, 200, 204, 200, 413, 400, 415, 400, 204, 204, 401, 401, 404, 200, 500]);
    const output = capture.output();
    expect(capture.lines()).toBe(statuses.length);
    for (const line of output.split("\n")) expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(expect.arrayContaining(["event", "method", "outcome", "status"]));
    for (const marker of ["VALUE-MARKER", "secretField", "987654321", "KEYMARKER", "Marker-Nick", "marker-nick", "Other-Marker", "COOKIE-MARKER", TOKEN, TOKEN.slice(0, 20), hashAppToken(TOKEN), "WRITER-MARKER", "Bearer"]) {
      expect(output, marker).not.toContain(marker);
    }
  });

  it("the handler's code logs only through logEntry, never the event", () => {
    const sources = ["./app-data.ts", "../app-data/data.ts", "../app-data/store.ts", "../app-token/token.ts", "../app-token/store.ts"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    const consoleCalls = sources.flatMap((source) => source.match(/console\.[a-z]+\([^;\n]*/g) ?? []);
    expect(consoleCalls).toEqual(["console.log(JSON.stringify(entry))"]);
    // Criterion 4 too: outside comments, the code never names a cookie (no `cookies`, `cookie` or `set-cookie`).
    const code = sources.map((source) => source.replace(/^\s*(\/\/|\/?\*).*$/gm, "")).join("\n");
    expect(code).not.toMatch(/cookie/i);
  });
});
