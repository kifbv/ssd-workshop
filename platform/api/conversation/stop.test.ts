// Ticket 3.5 (global Stop), the AI side: while the admin's Stop is on, the AI worker makes no Bedrock call and holds each
// message pending (its job comes back on the worker's own queue); after Resume the held jobs are answered. The page's
// reads answer `paused: true` meanwhile. Against the in-memory table, model and queues.
import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { APPROVE_ROUTE, BUILD_ROUTE, HISTORY_ROUTE, handleConversationRequest, POLL_ROUTE, SEND_ROUTE, STATUS_ROUTE, type ConversationDeps, type ConversationLogEntry } from "./conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, readinessReply, verdictReply } from "./fakes.js";
import { READINESS_REQUEST } from "./readiness.js";
import { STALE_PENDING_SECONDS, STOP_HOLD_SECONDS, buildIdFor, jobBody, parseJob, type AiJob } from "./state.js";
import { processJob, type WorkerDeps, type WorkerLogEntry } from "./worker.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const START = new Date("2026-11-25T10:00:00.000Z");
const START_S = START.getTime() / 1000;
const ADA = Buffer.alloc(32, 1).toString("base64url");
const BOB = Buffer.alloc(32, 2).toString("base64url");
const SPEC = "# Run log\n\n## What it does\nA log of your runs.";
const ANSWER = { text: "Who is it for?", inputTokens: 1000, outputTokens: 100 };
const STOPPED = { stopped: { BOOL: true } };

function setup(step: "clarify" | "spec" = "clarify") {
  const table = new FakeConversationTable();
  table.addParticipant("ada-1", "Ada-Runner", ADA, START_S + 8 * 3600, step);
  table.conversations.set("ada-1", { state: "open", ...(step === "spec" ? { latestSpecVersion: 1 } : {}) });
  if (step === "spec") table.specs.set("ada-1", [{ version: 1, text: SPEC, messageId: "m", createdAt: "x" }]);
  const queue = new FakeQueue();
  const builds = new FakeBuildQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const workerLogs: WorkerLogEntry[] = [];
  const logs: ConversationLogEntry[] = [];
  const deps: ConversationDeps = { sessions: table, store: table, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, ++counter), log: (e) => logs.push(e) };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, builds, held: queue, now: () => clock, log: (e) => workerLogs.push(e), sleep: async () => undefined };
  const run = (job: AiJob) => processJob(parseJob(jobBody(job)), workerDeps);
  /** Delivers the jobs the conversation queued. */
  const drain = async () => {
    const outcomes = [];
    while (queue.sent.length > 0) outcomes.push(await run(must(queue.sent.shift())));
    return outcomes;
  };
  /** Delivers the jobs the worker held (as SQS does once their delay has passed). */
  const deliverHeld = async () => {
    const outcomes = [];
    for (const { job } of queue.later.splice(0)) outcomes.push(await run(job));
    return outcomes;
  };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  const call = (request: HttpRequest) => handleConversationRequest(request, deps);
  const stop = () => {
    table.settingsItem = { ...STOPPED };
  };
  const resume = () => {
    table.settingsItem = { stopped: { BOOL: false }, resumedAt: { S: clock.toISOString() } };
  };
  return { table, queue, builds, model, workerLogs, logs, drain, deliverHeld, advance, call, stop, resume, run };
}

const post = (routeKey: string, body: unknown): HttpRequest => ({
  routeKey,
  cookies: [`${SESSION_COOKIE}=${ADA}`],
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const get = (routeKey: string, id?: string): HttpRequest => ({ routeKey, cookies: [`${SESSION_COOKIE}=${ADA}`], ...(id === undefined ? {} : { pathParameters: { id } }) });
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;

describe("ticket 3.5: the AI worker while the global Stop is on", () => {
  it("criterion 1: WHEN Stop is on THEN no Bedrock call is made: the message stays pending and its job comes back later", async () => {
    const s = setup();
    s.stop();
    const id = json(await s.call(post(SEND_ROUTE, { text: "a run tracker for me" })))["id"] as string;
    expect(await s.drain()).toEqual(["held"]);
    expect(s.model.requests).toHaveLength(0);
    expect(s.queue.later).toEqual([{ job: { participantId: "ada-1", messageId: id }, delaySeconds: STOP_HOLD_SECONDS }]);
    expect(s.table.messages.get("ada-1")?.get(id)?.status).toBe("pending");
    expect(s.table.replies.get("ada-1")?.get(id)).toBeUndefined();
    expect(s.table.usage.get("ada-1")).toBeUndefined();
    // Held again and again while Stop stays on, still without any AI call.
    for (let i = 0; i < 3; i += 1) {
      s.advance(STOP_HOLD_SECONDS);
      expect(await s.deliverHeld()).toEqual(["held"]);
    }
    expect(s.model.requests).toHaveLength(0);
    expect(s.workerLogs.map((l) => l.outcome)).toEqual(["held", "held", "held", "held"]);
  });

  it("criterion 3: WHEN Resume is pressed THEN the pending message is answered at its next delivery", async () => {
    const s = setup();
    s.stop();
    const id = json(await s.call(post(SEND_ROUTE, { text: "a run tracker for me" })))["id"] as string;
    expect(await s.drain()).toEqual(["held"]);
    s.resume();
    s.advance(STOP_HOLD_SECONDS);
    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.deliverHeld()).toEqual(["done"]);
    expect(s.model.requests).toHaveLength(2);
    expect(json(await s.call(get(POLL_ROUTE, id)))).toEqual({ id, status: "done", reply: ANSWER.text });
    expect(s.queue.later).toEqual([]);
  });

  it("WHEN Stop lasts longer than the 20-minute stale limit THEN the held message stays pending and is still answered after Resume", async () => {
    const s = setup();
    s.stop();
    const id = json(await s.call(post(SEND_ROUTE, { text: "a run tracker for me" })))["id"] as string;
    await s.drain();
    // An hour of Stop, delivered every 30 s.
    for (let t = 0; t < 3600; t += STOP_HOLD_SECONDS) {
      s.advance(STOP_HOLD_SECONDS);
      expect(await s.deliverHeld()).toEqual(["held"]);
    }
    expect(3600).toBeGreaterThan(STALE_PENDING_SECONDS);
    // The page still sees it pending (not failed), and a second message waits for it.
    expect(json(await s.call(get(POLL_ROUTE, id)))).toEqual({ id, status: "pending", paused: true });
    expect((await s.call(post(SEND_ROUTE, { text: "hello?" }))).statusCode).toBe(409);
    s.resume();
    s.advance(STOP_HOLD_SECONDS);
    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.deliverHeld()).toEqual(["done"]);
    expect(s.model.requests).toHaveLength(2);
  });

  it("WHEN the held message is no longer pending THEN its job is dropped; WHEN the queue refuses the hold THEN the job fails and is held at the redelivery", async () => {
    const s = setup();
    s.stop();
    const id = json(await s.call(post(SEND_ROUTE, { text: "a run tracker" })))["id"] as string;
    const job = { participantId: "ada-1", messageId: id };
    s.queue.failure = Object.assign(new Error("queue down"), { name: "ServiceUnavailable" });
    await expect(s.run(job)).rejects.toThrow("queue down");
    expect(s.model.requests).toHaveLength(0);
    s.queue.failure = undefined;
    expect(await s.run(job)).toBe("held");
    // Ended meanwhile (an operator's reset, a redelivered duplicate that was answered): nothing more is sent.
    await s.table.finish("ada-1", id, { kind: "failed", reply: "x" }, "pending", START.toISOString());
    s.queue.later.length = 0;
    expect(await s.run(job)).toBe("skipped");
    expect(s.queue.later).toEqual([]);
  });

  it("criteria 1 and 3: WHEN Approve spec is pressed while Stop is on THEN the readiness check waits (no AI call, no build), and runs after Resume", async () => {
    const s = setup("spec");
    s.stop();
    const id = must(json(await s.call(post(APPROVE_ROUTE, { version: 1 })))["id"] as string | undefined);
    expect(await s.drain()).toEqual(["held"]);
    expect(s.model.requests).toHaveLength(0);
    expect(s.builds.sent).toEqual([]);
    expect(s.table.builds.size).toBe(0);
    expect(s.table.messages.get("ada-1")?.get(id)).toMatchObject({ text: READINESS_REQUEST, status: "pending" });
    expect(s.table.profiles.get("ada-1")?.step).toBe("approved");
    s.resume();
    s.model.push(readinessReply("ready"));
    expect(await s.deliverHeld()).toEqual(["building"]);
    expect(s.builds.sent).toEqual([{ buildId: buildIdFor(id), participantId: "ada-1" }]);
  });

  it("WHEN Stop is on THEN a redelivered readiness job that only re-sends its build id still does (no AI call)", async () => {
    const s = setup("spec");
    await s.call(post(APPROVE_ROUTE, { version: 1 }));
    const job = must(s.queue.sent[0]);
    s.model.push(readinessReply("ready"));
    expect(await s.drain()).toEqual(["building"]);
    s.stop();
    expect(await s.run(job)).toBe("resent");
    expect(s.model.requests).toHaveLength(1);
    expect(s.builds.sent).toHaveLength(2);
  });
});

describe("ticket 3.5 criterion 4 (API part): the page's reads say the workshop is paused", () => {
  it("WHEN Stop is on THEN GET /api/conversation, the message poll and GET /api/build answer paused: true; WHEN off THEN they do not", async () => {
    const s = setup("spec");
    await s.call(post(APPROVE_ROUTE, { version: 1 }));
    const id = must(s.queue.sent[0]).messageId;
    s.stop();
    expect(json(await s.call(get(HISTORY_ROUTE)))["paused"]).toBe(true);
    expect(json(await s.call(get(POLL_ROUTE, id)))).toEqual({ id, status: "pending", paused: true });
    s.resume();
    expect(json(await s.call(get(HISTORY_ROUTE)))["paused"]).toBeUndefined();
    expect(json(await s.call(get(POLL_ROUTE, id)))).toEqual({ id, status: "pending" });
    s.model.push(readinessReply("ready"));
    await s.drain();
    expect(json(await s.call(get(BUILD_ROUTE)))["paused"]).toBeUndefined();
    s.stop();
    expect(json(await s.call(get(BUILD_ROUTE)))).toMatchObject({ status: "queued", paused: true });
  });

  it("WHEN the settings read fails THEN the poll and the build still answer 200, without paused, logging the error name only", async () => {
    const s = setup("spec");
    await s.call(post(APPROVE_ROUTE, { version: 1 }));
    const id = must(s.queue.sent[0]).messageId;
    s.stop();
    s.table.conversationFailOn = "getSettings";
    const res = await s.call(get(POLL_ROUTE, id));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ id, status: "pending" });
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "poll", outcome: "ok", error: "InternalServerError" });
  });

  it("WHEN any signed-in person (the nickname screen included) asks GET /api/status THEN it answers paused: true while Stop is on and {} after Resume", async () => {
    const s = setup();
    s.table.addParticipant("new-1", undefined, BOB, START_S + 8 * 3600, "nickname");
    const bob: HttpRequest = { routeKey: STATUS_ROUTE, cookies: [`${SESSION_COOKIE}=${BOB}`] };
    expect(json(await s.call(get(STATUS_ROUTE)))).toEqual({});
    s.stop();
    for (const request of [get(STATUS_ROUTE), bob]) {
      const res = await s.call(request);
      expect(res.statusCode).toBe(200);
      expect(json(res)).toEqual({ paused: true });
    }
    s.resume();
    expect(json(await s.call(bob))).toEqual({});
    expect(s.logs.map((e) => [e.route, e.outcome])).toEqual(Array.from({ length: 4 }, () => ["status", "ok"]));
  });

  it("WHEN someone signed out asks GET /api/status THEN the answer is 401 and the settings are not read", async () => {
    const s = setup();
    s.stop();
    s.table.conversationFailOn = "getSettings";
    const res = await s.call({ routeKey: STATUS_ROUTE, cookies: [] });
    expect(res.statusCode).toBe(401);
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "status", outcome: "unauthorized" });
  });

  it("WHEN the settings read fails THEN GET /api/status answers 500 (the page keeps what it showed), logging the error name only", async () => {
    const s = setup();
    s.stop();
    s.table.conversationFailOn = "getSettings";
    const res = await s.call(get(STATUS_ROUTE));
    expect(res.statusCode).toBe(500);
    expect(json(res)).not.toHaveProperty("paused");
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "status", outcome: "failed", error: "InternalServerError" });
  });
});
