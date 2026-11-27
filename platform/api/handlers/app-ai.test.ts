// Ticket 3.21: the AI function's logs hold no token, no email, no app nickname, no address, no text and no answer.
// Every console method is captured while the handler (with its real logger) serves tasks, refusals and a failure.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAppToken } from "../app-token/token.js";
import { FakeAppAiModel, FakeAppAiStore, FakeMediaReader, FakeTranscriber } from "../app-ai/fakes.js";
import { jpegOfSize, webmOfSize } from "../app-media/fixtures.js";
import { mediaKey } from "../app-media/media.js";
import type { HttpRequest } from "../http.js";
import { createHandler, logEntry } from "./app-ai.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const NICK = "Marker-Nick";
const PHOTO = "IDMARKERxxxxxxxxxxxxxx";
const VOICE = "IDMARKERvvvvvvvvvvvvvv";
const TOKEN = Buffer.from("TOKENMARKER".padEnd(32, "t")).toString("base64url");
const req = (body: unknown, options: { token?: string; method?: string } = {}): HttpRequest => ({
  routeKey: `${options.method ?? "POST"} /api/apps/{nickname}/ai`,
  pathParameters: { nickname: NICK },
  headers: { origin: "null", "content-type": "application/json", authorization: `Bearer ${options.token ?? TOKEN}`, "x-forwarded-for": "ada@example.com" },
  body: JSON.stringify(body),
});

describe("ticket 3.21: the AI function's logs", () => {
  it("writes one JSON line per request (method, task, outcome, status, cost, the writer) and never a token, an email, the nickname, an address, a text or an answer", async () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void written.push(args.map(String).join(" ")));
    }
    const store = new FakeAppAiStore();
    const media = new FakeMediaReader();
    const model = new FakeAppAiModel();
    const transcriber = new FakeTranscriber();
    transcriber.transcriptText = "SPOKENMARKER words";
    store.live.add(NICK.toLowerCase());
    store.tokens.tokens.set(hashAppToken(TOKEN), { app: NICK.toLowerCase(), nickname: "Writer-Nick", kind: "edit" });
    media.objects.set(mediaKey(NICK, PHOTO), jpegOfSize(20_000));
    media.objects.set(mediaKey(NICK, VOICE), webmOfSize(30_000));
    model.next = { input: { values: { f1: "SHOPMARKER" } }, text: "", inputTokens: 1000, outputTokens: 20 };
    const call = createHandler({ store, tokens: store.tokens, media, model, transcriber, now: () => new Date("2026-11-27T10:00:00.000Z"), log: logEntry, pause: async () => {}, sleep: async () => {} });

    const photo = `/app-media/marker-nick/${PHOTO}`;
    const statuses: number[] = [];
    statuses.push((await call(req({ task: "read-photo", photo, fields: [{ name: "FIELDMARKER", type: "text" }] }))).statusCode);
    statuses.push((await call(req({ task: "sort-text", text: "TEXTMARKER", categories: ["CATMARKER"], prompt: "PROMPTMARKER" }))).statusCode);
    statuses.push((await call(req({ task: "transcribe", recording: `/app-media/marker-nick/${VOICE}` }))).statusCode);
    statuses.push((await call(req({ task: "tag-photo", photo }, { token: TOKEN.slice(0, -1) + "A" }))).statusCode);
    statuses.push((await call(req({}, { method: "OPTIONS" }))).statusCode);
    store.failure = Object.assign(new Error(`APPAI#${NICK} failed`), { name: "InternalServerError" });
    statuses.push((await call(req({ task: "tag-photo", photo }))).statusCode);

    expect(statuses).toEqual([200, 400, 200, 401, 204, 500]);
    expect(written).toHaveLength(statuses.length);
    const lines = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) expect(Object.keys(line)).toEqual(expect.arrayContaining(["event", "method", "outcome", "status"]));
    const output = written.join("\n");
    for (const marker of ["Marker-Nick", "marker-nick", "IDMARKER", "MARKER", TOKEN, TOKEN.slice(0, 20), hashAppToken(TOKEN), "Bearer", "@", "APPAI#", "app-media/", "transcripts/"]) {
      expect(output, marker).not.toContain(marker);
    }
    expect(lines.map((l) => [l["outcome"], l["task"] ?? null])).toEqual([
      ["answered", "read-photo"],
      ["bad-request", null],
      ["transcribed", "transcribe"],
      ["unauthorized", null],
      ["preflight", null],
      ["failed", null],
    ]);
  });

  it("logs only through logEntry, and never names a cookie", () => {
    const sources = ["./app-ai.ts", "../app-ai/ai.ts", "../app-ai/store.ts", "../app-ai/tasks.ts", "../app-ai/budget.ts"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    expect(sources.flatMap((source) => source.match(/console\.[a-z]+\([^;\n]*/g) ?? [])).toEqual(["console.log(JSON.stringify(entry))"]);
    const code = sources.map((source) => source.replace(/^\s*(\/\/|\/?\*).*$/gm, "")).join("\n");
    expect(code).not.toMatch(/cookie/i);
  });
});
