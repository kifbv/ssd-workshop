import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { FakeTable } from "../fakes.js";
import { hashToken, SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { CLARIFY_PROMPT_VERSION, CLARIFY_SYSTEM_PROMPT } from "./answer.js";
import {
  handleConversationRequest,
  MAX_MESSAGE_CHARS,
  MESSAGES,
  POLL_ROUTE,
  SEND_ROUTE,
  type ConversationDeps,
  type ConversationLogEntry,
} from "./conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, verdictReply } from "./fakes.js";
import { GUARDRAIL_SYSTEM_PROMPT } from "./guardrail.js";
import { FAILURE_REPLY, STALE_PENDING_SECONDS, jobBody, parseJob } from "./state.js";
import { FINISH_ATTEMPTS, FINISH_BACKOFF_MS, processJob, type WorkerDeps, type WorkerLogEntry } from "./worker.js";

/** The value, or a thrown error when it is missing (instead of a non-null assertion). */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const START = new Date("2026-11-23T10:00:00.000Z");
const START_S = START.getTime() / 1000;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const MINE = token(1);
const THEIRS = token(2);
const NEWBIE = token(3);

function setup() {
  const table = new FakeConversationTable();
  table.addParticipant("me-1", "Ada", MINE, START_S + 3600);
  table.addParticipant("other-2", "Bob", THEIRS, START_S + 3600);
  table.addParticipant("new-3", undefined, NEWBIE, START_S + 3600, "nickname");
  const queue = new FakeQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const logs: ConversationLogEntry[] = [];
  const workerLogs: WorkerLogEntry[] = [];
  const deps: ConversationDeps = {
    sessions: table,
    store: table,
    queue,
    now: () => clock,
    randomBytes: (n) => Buffer.alloc(n, ++counter),
    log: (e) => logs.push(e),
  };
  const sleeps: number[] = [];
  const workerDeps: WorkerDeps = {
    store: table,
    model,
    modelId: MODEL_ID,
    builds: new FakeBuildQueue(),
    now: () => clock,
    log: (e) => workerLogs.push(e),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  /** Runs the worker on every queued job, as the event source mapping would (through the JSON body). */
  const drain = async () => {
    const outcomes = [];
    while (queue.sent.length > 0) outcomes.push(await processJob(parseJob(jobBody(must(queue.sent.shift()))), workerDeps));
    return outcomes;
  };
  return { table, queue, model, logs, workerLogs, deps, workerDeps, advance, drain, sleeps };
}

const send = (text: unknown, t: string = MINE, contentType = "application/json"): HttpRequest => ({
  routeKey: SEND_ROUTE,
  cookies: [`${SESSION_COOKIE}=${t}`],
  headers: { "content-type": contentType },
  body: JSON.stringify({ text }),
});
const poll = (id: string, t: string = MINE): HttpRequest => ({
  routeKey: POLL_ROUTE,
  cookies: [`${SESSION_COOKIE}=${t}`],
  pathParameters: { id },
});
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;
const ANSWER = { text: "Nice idea! Who will use the tracker?", inputTokens: 900, outputTokens: 120 };

describe("criterion 1: send answers at once with an id, polling returns the reply when the worker is done", () => {
  it("WHEN a participant sends a message THEN the API answers 202 with a message id, and polling returns the AI's reply once the worker is done", async () => {
    const s = setup();
    const sent = await handleConversationRequest(send("  I want a habit tracker for my runs  "), s.deps);
    expect(sent.statusCode).toBe(202);
    expect(sent.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
    const id = json(sent)["id"] as string;
    expect(id).toMatch(/^2026-11-23T10:00:00\.000Z-[0-9a-f]{16}$/);
    // The queue carries ids only, never the text.
    expect(s.queue.sent).toEqual([{ participantId: "me-1", messageId: id }]);
    expect(jobBody(must(s.queue.sent[0]))).toBe(JSON.stringify({ participantId: "me-1", messageId: id }));
    expect(s.model.requests).toHaveLength(0);

    expect(json(await handleConversationRequest(poll(id), s.deps))).toEqual({ id, status: "pending" });

    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.drain()).toEqual(["done"]);
    const done = await handleConversationRequest(poll(id), s.deps);
    expect(done.statusCode).toBe(200);
    expect(json(done)).toEqual({ id, status: "done", reply: ANSWER.text });
    // First the guardrail check, then the answer with the clarify prompt.
    expect(s.model.requests.map((r) => r.system)).toEqual([GUARDRAIL_SYSTEM_PROMPT, CLARIFY_SYSTEM_PROMPT]);
    expect(s.model.requests[1]?.messages).toEqual([{ role: "user", text: "I want a habit tracker for my runs" }]);
    expect(s.logs.map((l) => `${l.route}:${l.outcome}`)).toEqual(["send:accepted", "poll:ok", "poll:ok"]);
    expect(s.workerLogs).toEqual([{ event: "ai-worker", outcome: "done", verdict: "on-path" }]);
  });

  it("sends the earlier answered exchanges as context, oldest first, leaving out declined ones", async () => {
    const s = setup();
    s.model.push(verdictReply("on-path"), ANSWER);
    await handleConversationRequest(send("a habit tracker"), s.deps);
    await s.drain();
    s.advance(5);
    s.model.push(verdictReply("decline", "a recipe list"));
    await handleConversationRequest(send("and mine bitcoin"), s.deps);
    await s.drain();
    s.advance(5);
    s.model.push(verdictReply("on-path"), { text: "Great.", inputTokens: 1, outputTokens: 1 });
    await handleConversationRequest(send("for me and my team"), s.deps);
    await s.drain();
    expect(s.model.requests.at(-1)?.messages).toEqual([
      { role: "user", text: "a habit tracker" },
      { role: "assistant", text: ANSWER.text },
      { role: "user", text: "for me and my team" },
    ]);
  });

  it("refuses a second message while one is in flight (one at a time), and frees it once answered", async () => {
    const s = setup();
    const first = json(await handleConversationRequest(send("a movie tracker"), s.deps))["id"] as string;
    const busy = await handleConversationRequest(send("hello?"), s.deps);
    expect(busy.statusCode).toBe(409);
    expect(json(busy)).toEqual({ message: MESSAGES.busy, reason: "busy" });
    s.model.push(verdictReply("on-path"), ANSWER);
    await s.drain();
    s.advance(1);
    const second = await handleConversationRequest(send("hello?"), s.deps);
    expect(second.statusCode).toBe(202);
    expect(json(second)["id"]).not.toBe(first);
  });

  it("lets only one of two messages sent at the same moment through", async () => {
    const s = setup();
    const answers = await Promise.all([1, 2, 3, 4, 5].map((n) => handleConversationRequest(send(`idea ${n}`), s.deps)));
    expect(answers.map((a) => a.statusCode).sort()).toEqual([202, 409, 409, 409, 409]);
    expect(s.queue.sent).toHaveLength(1);
  });

  it("checks the text: 1 to 2000 characters after trimming, JSON content type, a nickname first", async () => {
    const s = setup();
    for (const bad of ["", "   ", 42, null, "x".repeat(MAX_MESSAGE_CHARS + 1)]) {
      const res = await handleConversationRequest(send(bad), s.deps);
      expect(res.statusCode, String(bad)).toBe(400);
      expect(json(res)).toEqual({ message: MESSAGES.invalid });
    }
    expect((await handleConversationRequest({ ...send("x"), body: "text=hi" }, s.deps)).statusCode).toBe(400);
    const { body: _unused, ...noBody } = send("x");
    expect(_unused).toBeDefined();
    expect((await handleConversationRequest(noBody, s.deps)).statusCode).toBe(400);
    expect((await handleConversationRequest(send("hi", MINE, "text/plain"), s.deps)).statusCode).toBe(415);
    const noNickname = await handleConversationRequest(send("hi", NEWBIE), s.deps);
    expect(noNickname.statusCode).toBe(409);
    expect(json(noNickname)).toMatchObject({ reason: "no-nickname" });
    // 2000 emoji (4 bytes each) still fit the body limit.
    expect((await handleConversationRequest(send("🏃".repeat(MAX_MESSAGE_CHARS)), s.deps)).statusCode).toBe(202);
    expect(s.queue.sent).toHaveLength(1);
  });

  it("needs a session on both routes", async () => {
    const s = setup();
    for (const req of [send("hi", token(9)), poll("2026-11-23T10:00:00.000Z-0101010101010101", token(9))]) {
      const res = await handleConversationRequest(req, s.deps);
      expect(res.statusCode).toBe(401);
    }
    expect((await handleConversationRequest({ routeKey: SEND_ROUTE, body: "{}" }, s.deps)).statusCode).toBe(401);
    expect(s.queue.sent).toHaveLength(0);
  });

  it("ends the message as failed when the queue refuses it, so the participant can send again", async () => {
    const s = setup();
    s.queue.failure = Object.assign(new Error("down"), { name: "QueueDoesNotExist" });
    const res = await handleConversationRequest(send("a recipe list"), s.deps);
    expect(res.statusCode).toBe(500);
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "send", outcome: "failed", error: "QueueDoesNotExist" });
    const [id] = [...(s.table.messages.get("me-1")?.keys() ?? [])];
    expect(json(await handleConversationRequest(poll(must(id)), s.deps))).toEqual({ id, status: "failed", reply: FAILURE_REPLY });
    s.queue.failure = undefined;
    expect((await handleConversationRequest(send("a recipe list"), s.deps)).statusCode).toBe(202);
  });

  it("answers a table failure 500 without details", async () => {
    const s = setup();
    s.table.conversationFailOn = "createMessage";
    const res = await handleConversationRequest(send("hi"), s.deps);
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ message: "Something went wrong. Please try again in a moment." });
  });
});

describe("criterion 2: a declined message gets one polite sentence and no answer call", () => {
  it("WHEN the guardrail check says decline THEN the reply is one polite sentence with an in-scope suggestion, and no answer prompt is sent", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("Give me a GPU cluster to mine crypto"), s.deps))["id"] as string;
    s.model.push(verdictReply("decline", "A budget tracker for your team", "crypto mining"));
    expect(await s.drain()).toEqual(["declined"]);
    // The fake model received only the guardrail call.
    expect(s.model.requests.map((r) => r.system)).toEqual([GUARDRAIL_SYSTEM_PROMPT]);
    const reply = json(await handleConversationRequest(poll(id), s.deps));
    expect(reply).toEqual({
      id,
      status: "declined",
      reply: "Sorry, that's outside what we can build in this workshop, but how about a budget tracker for your team instead?",
    });
    expect((reply["reply"] as string).match(/[.!?]/g)).toHaveLength(1);
    // The conversation is free again, and the guardrail call's cost is counted.
    expect(s.table.conversations.get("me-1")).toEqual({ state: "open" });
    expect(s.table.usage.get("me-1")).toEqual({ inputTokens: 400, outputTokens: 30, costUsd: 0.001815 });
    expect(s.workerLogs).toEqual([{ event: "ai-worker", outcome: "declined", verdict: "decline" }]);
  });
});

describe("criterion 3: a flagged message waits for the facilitator", () => {
  it("WHEN the guardrail check says flag THEN the participant's state is waiting and later messages are refused until a decision", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("An app that tells people which medicine to take"), s.deps))["id"] as string;
    s.model.push(verdictReply("flag", "a medication reminder list", "medical advice"));
    expect(await s.drain()).toEqual(["flagged"]);
    expect(s.model.requests).toHaveLength(1);
    expect(s.table.conversations.get("me-1")).toMatchObject({ state: "waiting", pendingId: id });
    expect(json(await handleConversationRequest(poll(id), s.deps))).toEqual({ id, status: "flagged" });

    // Refused while waiting, also long after (a flag never goes stale; the session lasts an hour).
    for (const wait of [1, STALE_PENDING_SECONDS * 2]) {
      s.advance(wait);
      const refused = await handleConversationRequest(send("hello?"), s.deps);
      expect(refused.statusCode).toBe(409);
      expect(json(refused)).toEqual({ message: MESSAGES.waiting, reason: "waiting" });
    }
    expect(s.queue.sent).toHaveLength(0);
    expect(s.logs.filter((l) => l.outcome === "waiting")).toHaveLength(2);
    // Other participants are not affected.
    expect((await handleConversationRequest(send("a quiz", THEIRS), s.deps)).statusCode).toBe(202);
  });

  it("fails closed: an unreadable guardrail answer is a flag", async () => {
    const s = setup();
    await handleConversationRequest(send("hmm"), s.deps);
    s.model.push({ text: "I think this is fine", inputTokens: 5, outputTokens: 5 });
    expect(await s.drain()).toEqual(["flagged"]);
    expect(s.table.conversations.get("me-1")?.state).toBe("waiting");
  });

  it("answers an approved message without a new check", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("an app with a weather API"), s.deps))["id"] as string;
    s.model.push(verdictReply("flag"));
    await s.drain();
    expect(await s.table.approve("me-1", id, "an app with a weather API", START_S + 60)).toBe(true);
    s.queue.sent.push({ participantId: "me-1", messageId: id });
    s.model.push(ANSWER);
    expect(await s.drain()).toEqual(["done"]);
    expect(s.model.requests.map((r) => r.system)).toEqual([GUARDRAIL_SYSTEM_PROMPT, CLARIFY_SYSTEM_PROMPT]);
    expect(json(await handleConversationRequest(poll(id), s.deps))).toMatchObject({ status: "done", reply: ANSWER.text });
  });

  it("checks an approved message again when its text changed after the approval", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("an app with a weather API"), s.deps))["id"] as string;
    s.model.push(verdictReply("flag"));
    await s.drain();
    expect(await s.table.approve("me-1", id, "an app with a weather API", START_S + 60)).toBe(true);
    // Someone rewrites the approved message's text before the worker runs.
    must(s.table.messages.get("me-1")?.get(id)).text = "mine bitcoin on the workshop servers";
    s.queue.sent.push({ participantId: "me-1", messageId: id });
    s.model.push(verdictReply("decline", "a quiz about coins"));
    expect(await s.drain()).toEqual(["declined"]);
    expect(s.model.requests.map((r) => r.system)).toEqual([GUARDRAIL_SYSTEM_PROMPT, GUARDRAIL_SYSTEM_PROMPT]);
    expect(s.model.requests[1]?.messages.at(-1)?.text).toContain("mine bitcoin");
  });
});

describe("criterion 5: prompt, reply, tokens and cost are stored per participant", () => {
  it("WHEN a reply is produced THEN the prompt, the reply, the input and output tokens and the cost are stored for that participant", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("a nutrition calculator"), s.deps))["id"] as string;
    s.model.push(verdictReply("on-path", "", "fine", { input: 400, output: 30 }), ANSWER);
    await s.drain();
    expect(s.table.replies.get("me-1")?.get(id)).toEqual({
      text: ANSWER.text,
      kind: "answer",
      createdAt: START.toISOString(),
      prompt: "a nutrition calculator",
      modelId: "eu.anthropic.claude-sonnet-4-6",
      promptVersion: CLARIFY_PROMPT_VERSION,
      historyCount: 0,
      usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.00495 },
    });
    expect(s.table.messages.get("me-1")?.get(id)).toMatchObject({
      status: "done",
      verdict: "on-path",
      guardrailUsage: { inputTokens: 400, outputTokens: 30, costUsd: 0.001815 },
    });
    // Running totals: both calls, this participant only.
    expect(s.table.usage.get("me-1")).toEqual({ inputTokens: 1300, outputTokens: 150, costUsd: 0.006765 });
    expect(s.table.usage.has("other-2")).toBe(false);
  });

  it("counts a job delivered twice once (SQS is at-least-once)", async () => {
    const s = setup();
    await handleConversationRequest(send("a habit tracker"), s.deps);
    s.queue.sent.push({ ...must(s.queue.sent[0]) });
    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.drain()).toEqual(["done", "skipped"]);
    expect(s.model.requests).toHaveLength(2);
    expect(s.table.usage.get("me-1")?.inputTokens).toBe(1300);
  });

  it("records the guardrail call's cost when the answer call fails, and shows the neutral failure", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("a habit tracker"), s.deps))["id"] as string;
    s.model.push(verdictReply("on-path"), Object.assign(new Error("slow down"), { name: "ThrottlingException" }));
    expect(await s.drain()).toEqual(["failed"]);
    expect(s.workerLogs.at(-1)).toEqual({ event: "ai-worker", outcome: "failed", error: "ThrottlingException" });
    expect(json(await handleConversationRequest(poll(id), s.deps))).toEqual({ id, status: "failed", reply: FAILURE_REPLY });
    expect(s.table.usage.get("me-1")?.inputTokens).toBe(400);
    expect((await handleConversationRequest(send("again"), s.deps)).statusCode).toBe(202);
  });

  it("fails on the deadline without calling the model again", async () => {
    const s = setup();
    await handleConversationRequest(send("a habit tracker"), s.deps);
    const job = parseJob(jobBody(must(s.queue.sent.shift())));
    expect(await processJob(job, s.workerDeps, AbortSignal.abort())).toBe("failed");
    expect(s.table.conversations.get("me-1")).toEqual({ state: "open" });
  });

  it("retries a failed final write with a short backoff and stores the outcome when a later try works", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("a habit tracker"), s.deps))["id"] as string;
    s.model.push(verdictReply("on-path"), ANSWER);
    s.table.conversationFailOn = "finish";
    s.table.conversationFailTimes = FINISH_ATTEMPTS - 1;
    expect(await s.drain()).toEqual(["done"]);
    expect(s.sleeps).toEqual([...FINISH_BACKOFF_MS]);
    expect(json(await handleConversationRequest(poll(id), s.deps))).toMatchObject({ status: "done", reply: ANSWER.text });
    expect(s.table.usage.get("me-1")?.inputTokens).toBe(1300);
  });

  it("after the last try of the final write, still adds the spent tokens to the usage, then throws", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("a habit tracker"), s.deps))["id"] as string;
    s.model.push(verdictReply("on-path"), ANSWER);
    s.table.conversationFailOn = "finish";
    await expect(s.drain()).rejects.toThrow("table down");
    expect(FINISH_ATTEMPTS).toBe(3);
    expect(s.sleeps).toEqual([200, 800]);
    expect(s.table.usage.get("me-1")).toEqual({ inputTokens: 1300, outputTokens: 150, costUsd: 0.006765 });
    expect(s.table.messages.get("me-1")?.get(id)?.status).toBe("pending");

    // A decline's guardrail tokens are counted the same way; a failing usage write does not hide the error.
    const t = setup();
    await handleConversationRequest(send("mine bitcoin"), t.deps);
    t.model.push(verdictReply("decline", "a quiz", "r", { input: 400, output: 30 }));
    t.table.conversationFailOn = "finish";
    await expect(t.drain()).rejects.toThrow("table down");
    expect(t.table.usage.get("me-1")?.inputTokens).toBe(400);
    const u = setup();
    await handleConversationRequest(send("a habit tracker"), u.deps);
    u.model.push(verdictReply("on-path"), ANSWER);
    u.table.conversationFailOn = "finish";
    u.table.addUsage = async () => Promise.reject(new Error("usage down"));
    await expect(u.drain()).rejects.toThrow("table down");
  });

  it("answers a crashed job on SQS's later deliveries while the message is still pending", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("a habit tracker"), s.deps))["id"] as string;
    const job = must(s.queue.sent[0]);
    s.model.push(verdictReply("on-path"), ANSWER, verdictReply("on-path"), ANSWER);
    s.table.conversationFailOn = "finish";
    await expect(s.drain()).rejects.toThrow("table down");
    // The second delivery comes one visibility timeout (330 s) later, and also fails.
    s.advance(330);
    s.queue.sent.push(job);
    await expect(s.drain()).rejects.toThrow("table down");
    // The third and last comes another 330 s later, and may run its full 300 s: still not stale.
    s.advance(330 + 299);
    s.table.conversationFailOn = undefined;
    s.queue.sent.push(job);
    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.drain()).toEqual(["done"]);
    expect(json(await handleConversationRequest(poll(id), s.deps))).toMatchObject({ status: "done" });
    expect(2 * 330 + 300).toBeLessThan(STALE_PENDING_SECONDS);
  });

  it("throws a table failure on the final write, so SQS delivers the job again", async () => {
    const s = setup();
    await handleConversationRequest(send("a habit tracker"), s.deps);
    s.model.push(verdictReply("on-path"), ANSWER);
    s.table.conversationFailOn = "finish";
    await expect(s.drain()).rejects.toThrow("table down");
    s.table.conversationFailOn = undefined;
    s.queue.sent.push({ participantId: "me-1", messageId: must([...must(s.table.messages.get("me-1")).keys()][0]) });
    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.drain()).toEqual(["done"]);
  });

  it("skips a malformed job, an unknown message and a stale one", async () => {
    const s = setup();
    expect(await processJob(parseJob("not json"), s.workerDeps)).toBe("invalid");
    expect(await processJob(parseJob('{"participantId":"a#b","messageId":"x"}'), s.workerDeps)).toBe("invalid");
    expect(await processJob({ participantId: "me-1", messageId: "2026-11-23T10:00:00.000Z-0000000000000000" }, s.workerDeps)).toBe("skipped");
    await handleConversationRequest(send("a habit tracker"), s.deps);
    s.advance(STALE_PENDING_SECONDS + 1);
    expect(await s.drain()).toEqual(["skipped"]);
    expect(s.model.requests).toHaveLength(0);
  });
});

describe("a worker that never finished (stale pending message)", () => {
  it("shows the message as failed after 20 minutes and lets the participant send again", async () => {
    const s = setup();
    const id = json(await handleConversationRequest(send("a habit tracker"), s.deps))["id"] as string;
    s.queue.sent.length = 0;
    s.advance(STALE_PENDING_SECONDS - 1);
    expect((await handleConversationRequest(send("hello?"), s.deps)).statusCode).toBe(409);
    expect(json(await handleConversationRequest(poll(id), s.deps))).toEqual({ id, status: "pending" });
    s.advance(2);
    expect(json(await handleConversationRequest(poll(id), s.deps))).toEqual({ id, status: "failed", reply: FAILURE_REPLY });
    expect((await handleConversationRequest(send("hello?"), s.deps)).statusCode).toBe(202);
    // The late job of the old message is skipped.
    s.queue.sent.unshift({ participantId: "me-1", messageId: id });
    s.model.push(verdictReply("on-path"), ANSWER);
    expect((await s.drain())[0]).toBe("skipped");
  });
});

describe("criterion 6: another participant's message id is not found", () => {
  it("WHEN a participant polls for another participant's message id THEN the API answers not found", async () => {
    const s = setup();
    const theirs = json(await handleConversationRequest(send("a quiz", THEIRS), s.deps))["id"] as string;
    s.model.push(verdictReply("on-path"), ANSWER);
    await s.drain();
    expect(json(await handleConversationRequest(poll(theirs, THEIRS), s.deps))).toMatchObject({ status: "done" });

    const res = await handleConversationRequest(poll(theirs, MINE), s.deps);
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ message: "Not found." });
    // Malformed ids are not looked up at all; a reply id is not a message id.
    for (const id of ["", "x", "../x", `${theirs}-r`, "PROFILE"]) {
      expect((await handleConversationRequest(poll(id, MINE), s.deps)).statusCode, id).toBe(404);
    }
    expect((await handleConversationRequest({ routeKey: POLL_ROUTE, cookies: [`${SESSION_COOKIE}=${MINE}`] }, s.deps)).statusCode).toBe(404);
    expect(s.logs.filter((l) => l.outcome === "not-found")).toHaveLength(7);
  });
});

describe("the conversation routes follow the allow-list (ticket 3.1)", () => {
  it("criterion 1: WHEN a signed-in person's allow-list entry is removed THEN their next conversation call answers 401, the session is deleted and nothing is sent", async () => {
    const s = setup();
    s.table.allow.delete(FakeTable.emailOf("me-1"));
    const res = await handleConversationRequest(send("A plant watering app"), s.deps);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? "")).toEqual({ message: "Please sign in." });
    expect(s.table.sessions.has(hashToken(MINE))).toBe(false);
    expect(s.table.sessions.has(hashToken(THEIRS))).toBe(true);
    expect(s.queue.sent).toEqual([]);
    // Logged as `removed` (try 2), like the participant routes; the next call finds no session at all.
    expect(s.logs.at(-1)?.outcome).toBe("removed");
    expect((await handleConversationRequest(send("A plant watering app"), s.deps)).statusCode).toBe(401);
    expect(s.logs.at(-1)?.outcome).toBe("unauthorized");
  });
});
