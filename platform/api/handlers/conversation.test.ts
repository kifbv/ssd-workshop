import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, verdictReply } from "../conversation/fakes.js";
import type { HttpRequest } from "../http.js";
import { hashToken, SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { aiDeadlineMs, createHandler as createWorker, JOB_FAILED, logEntry as workerLogEntry, WRITE_RESERVE_MS } from "./ai-worker.js";
import { createHandler, handler, logEntry } from "./conversation.js";

const NOW = new Date("2026-11-23T10:00:00.000Z");
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const SECRET_TEXT = "Track the private salaries of Zebulon Quartermaine";
const SECRET_REPLY = "Glorious-xylophone answer";
const SUGGESTION = "a marmalade inventory";

/** Captures everything written to the console and to stdout/stderr. */
function captureOutput(): string[] {
  const captured: string[] = [];
  const keep = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, method).mockImplementation(keep);
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    });
  }
  return captured;
}

describe("conversation and AI worker logs (ticket 1.7)", () => {
  let captured: string[];
  beforeEach(() => {
    captured = captureOutput();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs one JSON line per request and job, never the text, the prompt, the reply, an id, the nickname or the token", async () => {
    const table = new FakeConversationTable();
    table.addParticipant("p-secret-id", "Zephyrine-77", TOKEN, NOW.getTime() / 1000 + 3600);
    const queue = new FakeQueue();
    const model = new FakeModel();
    let clock = NOW;
    const api = createHandler({ sessions: table, store: table, editLinks: table.appTokens, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, 9), log: logEntry });
    const worker = createWorker({ store: table, model, modelId: MODEL_ID, builds: new FakeBuildQueue(), held: queue, now: () => clock, log: workerLogEntry });
    const send = (text: string): HttpRequest => ({
      routeKey: "POST /api/conversation/messages",
      cookies: [`${SESSION_COOKIE}=${TOKEN}`],
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const runQueued = async () => {
      const job = queue.sent.shift();
      await worker({ Records: [{ body: JSON.stringify(job) }] }, { getRemainingTimeInMillis: () => 300_000 });
    };

    // Answered, declined, flagged; a refused send; a poll of another id; a malformed body; a failure.
    const first = JSON.parse((await api(send(SECRET_TEXT))).body ?? "{}") as { id: string };
    model.push(verdictReply("on-path"), { text: SECRET_REPLY, inputTokens: 5, outputTokens: 5 });
    await runQueued();
    await api({ routeKey: "GET /api/conversation/messages/{id}", cookies: [`${SESSION_COOKIE}=${TOKEN}`], pathParameters: { id: first.id } });
    clock = new Date(NOW.getTime() + 1000);
    await api(send(SECRET_TEXT));
    model.push(verdictReply("decline", SUGGESTION, SECRET_TEXT));
    await runQueued();
    clock = new Date(NOW.getTime() + 2000);
    await api(send(SECRET_TEXT));
    await api(send(SECRET_TEXT));
    model.push(Object.assign(new Error(`ValidationException: ${SECRET_TEXT}`), { name: "ValidationException" }));
    await runQueued();
    clock = new Date(NOW.getTime() + 3000);
    await api(send(SECRET_TEXT));
    model.push(verdictReply("flag", SUGGESTION, SECRET_TEXT));
    await runQueued();
    await api(send(SECRET_TEXT));
    await api({ ...send("x"), body: `{"text": "${SECRET_TEXT}", oops}` });
    // A job whose table read throws an error carrying the text: logged by name only, rethrown bare.
    const failing = createWorker({
      store: { getMessage: async () => Promise.reject(Object.assign(new Error(`read failed: ${SECRET_TEXT}`), { name: "ProvisionedThroughputExceededException" })) } as never,
      model,
      modelId: MODEL_ID,
      builds: new FakeBuildQueue(),
      held: queue,
      now: () => clock,
      log: workerLogEntry,
    });
    const thrown = await failing({ Records: [{ body: JSON.stringify({ participantId: "p-secret-id", messageId: first.id }) }] }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(JOB_FAILED);
    expect(JSON.stringify(thrown) + String((thrown as Error).stack) + String((thrown as Error).cause)).not.toContain(SECRET_TEXT);
    await api({ routeKey: "GET /api/conversation/messages/{id}", cookies: [`${SESSION_COOKIE}=${TOKEN}`], pathParameters: { id: SECRET_TEXT } });
    // Ticket 1.8: the history (texts and ids in the answer, never in the log) and Write my spec.
    await api({ routeKey: "GET /api/conversation", cookies: [`${SESSION_COOKIE}=${TOKEN}`] });
    await api({ routeKey: "POST /api/conversation/step", cookies: [`${SESSION_COOKIE}=${TOKEN}`], headers: { "content-type": "application/json" }, body: '{"step":"spec"}' });
    await api({ routeKey: "POST /api/conversation/step", cookies: [`${SESSION_COOKIE}=${TOKEN}`], headers: { "content-type": "application/json" }, body: JSON.stringify({ step: SECRET_TEXT }) });
    // Ticket 1.9: the spec and Approve spec.
    await api({ routeKey: "GET /api/conversation/spec", cookies: [`${SESSION_COOKIE}=${TOKEN}`], queryStringParameters: { version: SECRET_TEXT } });
    await api({ routeKey: "POST /api/conversation/spec/approve", cookies: [`${SESSION_COOKIE}=${TOKEN}`], headers: { "content-type": "application/json" }, body: JSON.stringify({ version: SECRET_TEXT }) });

    const lines = captured.join("\n").split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) expect(() => JSON.parse(line) as unknown, line).not.toThrow();
    const logs = lines.join("\n");
    for (const expected of [
      '"event":"conversation","route":"send","outcome":"accepted"',
      '"event":"conversation","route":"poll","outcome":"ok"',
      '"outcome":"busy"',
      '"outcome":"waiting"',
      '"outcome":"invalid-request"',
      '"outcome":"not-found"',
      '"event":"conversation","route":"history","outcome":"ok"',
      '"event":"conversation","route":"step","outcome":"waiting"',
      '"event":"conversation","route":"step","outcome":"invalid-request"',
      '"event":"conversation","route":"spec","outcome":"not-found"',
      '"event":"conversation","route":"approve","outcome":"invalid-request"',
      '"event":"ai-worker","outcome":"done","verdict":"on-path"',
      '"event":"ai-worker","outcome":"declined","verdict":"decline"',
      '"event":"ai-worker","outcome":"failed","error":"ValidationException"',
      '"event":"ai-worker","outcome":"flagged","verdict":"flag"',
      '{"event":"ai-worker","outcome":"error","error":"ProvisionedThroughputExceededException"}',
    ]) {
      expect(logs, expected).toContain(expected);
    }
    for (const secret of [SECRET_TEXT, "Zebulon", "salaries", SECRET_REPLY, "xylophone", SUGGESTION, "marmalade", first.id, "p-secret-id", "zephyrine", TOKEN, hashToken(TOKEN)]) {
      expect(logs.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    }
  });

  it("cuts the AI calls off before the Lambda timeout, keeping 30 s to store the outcome", () => {
    expect(WRITE_RESERVE_MS).toBe(30_000);
    expect(aiDeadlineMs(300_000)).toBe(270_000);
    expect(aiDeadlineMs(10_000)).toBe(1000);
  });
});

describe("handler (live wiring)", () => {
  it("answers a call without a session 401 before any AWS call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await handler({ routeKey: "POST /api/conversation/messages", body: "{}" });
    expect(res.statusCode).toBe(401);
    vi.restoreAllMocks();
  });
});
