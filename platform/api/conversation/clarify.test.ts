// Ticket 1.8 (Step 1: Clarify): the ready marker, the page's history route and Write my spec.
import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { hashToken, SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { answerMessage, CLARIFY_PROMPT_VERSION, CLARIFY_SYSTEM_PROMPT, parseReadyMarker, READY_MARKER } from "./answer.js";
import {
  handleConversationRequest,
  HISTORY_ROUTE,
  MESSAGES,
  POLL_ROUTE,
  SEND_ROUTE,
  shapeHistory,
  STEP_ROUTE,
  type ConversationDeps,
  type ConversationLogEntry,
} from "./conversation.js";
import { FakeConversationTable, FakeModel, FakeQueue, verdictReply } from "./fakes.js";
import { FAILURE_REPLY, HISTORY_PAGE_LIMIT, jobBody, parseJob, STALE_PENDING_SECONDS, type ListedItem } from "./state.js";
import { processJob, type WorkerDeps } from "./worker.js";

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
  table.addParticipant("me-1", "Ada", hashToken(MINE), START_S + 3600);
  table.addParticipant("other-2", "Bob", hashToken(THEIRS), START_S + 3600);
  table.addParticipant("new-3", undefined, hashToken(NEWBIE), START_S + 3600, "nickname");
  const queue = new FakeQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const logs: ConversationLogEntry[] = [];
  const deps: ConversationDeps = {
    sessions: table,
    store: table,
    queue,
    now: () => clock,
    randomBytes: (n) => Buffer.alloc(n, ++counter),
    log: (e) => logs.push(e),
  };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, now: () => clock, log: () => undefined, sleep: async () => undefined };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  const drain = async () => {
    while (queue.sent.length > 0) await processJob(parseJob(jobBody(must(queue.sent.shift()))), workerDeps);
  };
  const call = (request: HttpRequest) => handleConversationRequest(request, deps);
  /** Sends a message as `t` and lets the worker answer it with `reply` (after an on-path verdict). */
  const exchange = async (text: string, reply: string, t = MINE) => {
    const id = json(await call(send(text, t)))["id"] as string;
    model.push(verdictReply("on-path"), { text: reply, inputTokens: 10, outputTokens: 10 });
    await drain();
    advance(5);
    return id;
  };
  return { table, queue, model, logs, deps, advance, drain, call, exchange };
}

const cookie = (t: string) => [`${SESSION_COOKIE}=${t}`];
const send = (text: string, t: string = MINE): HttpRequest => ({
  routeKey: SEND_ROUTE,
  cookies: cookie(t),
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
const historyOf = (t: string = MINE): HttpRequest => ({ routeKey: HISTORY_ROUTE, cookies: cookie(t) });
const writeSpec = (t: string = MINE, body: unknown = { step: "spec" }, contentType = "application/json"): HttpRequest => ({
  routeKey: STEP_ROUTE,
  cookies: cookie(t),
  headers: { "content-type": contentType },
  body: JSON.stringify(body),
});
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;

const QUESTIONS = "A run tracker for you.\n1. Who will use it?\n2. What do you log?\n3. Which totals matter?";
const OFFER = `You want a run log for yourself with weekly totals. I have enough to write your spec: press "Write my spec" when you are ready.\n${READY_MARKER}`;

describe("the ready marker (clarify-v2)", () => {
  it("strips the marker from the reply and reports the offer", () => {
    expect(parseReadyMarker(OFFER)).toEqual({
      text: 'You want a run log for yourself with weekly totals. I have enough to write your spec: press "Write my spec" when you are ready.',
      offersSpec: true,
    });
    expect(parseReadyMarker(QUESTIONS)).toEqual({ text: QUESTIONS, offersSpec: false });
    // Tolerates small variations of the marker, anywhere in the text.
    expect(parseReadyMarker("Ready! [ready for spec] Press the button.")).toEqual({ text: "Ready!  Press the button.", offersSpec: true });
    expect(parseReadyMarker("Done.\n[ READY_FOR_SPEC ]\n")).toEqual({ text: "Done.", offersSpec: true });
  });

  it("asks for numbered questions about a new idea, follows a changed idea and names the marker in the prompt", () => {
    expect(CLARIFY_PROMPT_VERSION).toBe("clarify-v2");
    expect(CLARIFY_SYSTEM_PROMPT).toContain("3 to 5 questions as a numbered list");
    expect(CLARIFY_SYSTEM_PROMPT).toContain("drop the old idea completely");
    expect(CLARIFY_SYSTEM_PROMPT).toContain(`end your reply with this exact line on its own: ${READY_MARKER}`);
    expect(CLARIFY_SYSTEM_PROMPT).toContain('"Write my spec"');
  });

  it("treats a reply that is only the marker as empty (the worker then fails it with the neutral reply)", async () => {
    const model = new FakeModel([{ text: READY_MARKER, inputTokens: 1, outputTokens: 1 }]);
    await expect(answerMessage(model, "clarify", [], "hi")).rejects.toMatchObject({ name: "EmptyAnswer" });
  });

  it("stores the reply without the marker and with offersSpec, and records the prompt version", async () => {
    const s = setup();
    await s.exchange("a run tracker", QUESTIONS);
    await s.exchange("just me, distance and time, weekly totals, no maps", OFFER);
    const replies = [...must(s.table.replies.get("me-1")).values()];
    expect(replies.map((r) => r.offersSpec)).toEqual([undefined, true]);
    expect(replies[1]?.text).not.toContain("READY");
    expect(replies.map((r) => r.promptVersion)).toEqual(["clarify-v2", "clarify-v2"]);
    // The history sent to the model holds the stored text, never the marker.
    s.model.push(verdictReply("on-path"), { text: "Sure.", inputTokens: 1, outputTokens: 1 });
    await s.call(send("one more thing"));
    await s.drain();
    expect(JSON.stringify(s.model.requests.at(-1)?.messages)).not.toContain("READY");
  });
});

describe("criterion 4: GET /api/conversation shows the conversation so far", () => {
  it("WHEN the page is reloaded THEN the caller's own conversation comes back in order, with the step and the offer", async () => {
    const s = setup();
    const first = await s.exchange("a run tracker", QUESTIONS);
    const second = await s.exchange("just me, weekly totals", OFFER);
    const res = await s.call(historyOf());
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
    expect(json(res)).toEqual({
      step: "clarify",
      state: "open",
      messages: [
        { id: first, author: "participant", text: "a run tracker", status: "done" },
        { id: `${first}-r`, author: "assistant", text: QUESTIONS },
        { id: second, author: "participant", text: "just me, weekly totals", status: "done" },
        { id: `${second}-r`, author: "assistant", text: parseReadyMarker(OFFER).text, offersSpec: true },
      ],
    });
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "history", outcome: "ok" });
  });

  it("names the message in flight while it is pending or flagged, so the page polls it or shows the facilitator notice", async () => {
    const s = setup();
    expect(json(await s.call(historyOf()))).toEqual({ step: "clarify", state: "open", messages: [] });
    const id = json(await s.call(send("a quiz about our office plants")))["id"] as string;
    expect(json(await s.call(historyOf()))).toMatchObject({ state: "open", pendingId: id, messages: [{ id, status: "pending" }] });
    s.model.push(verdictReply("flag", "", "unsure"));
    await s.drain();
    expect(json(await s.call(historyOf()))).toMatchObject({ state: "waiting", pendingId: id, messages: [{ id, status: "flagged" }] });
  });

  it("shows a declined message with its one-sentence reply, and a stale pending one as failed with the neutral reply", async () => {
    const s = setup();
    const declined = json(await s.call(send("mine bitcoin")))["id"] as string;
    s.model.push(verdictReply("decline", "a habit tracker"));
    await s.drain();
    s.advance(5);
    const stale = json(await s.call(send("a recipe list")))["id"] as string;
    s.queue.sent.length = 0;
    s.advance(STALE_PENDING_SECONDS + 1);
    const body = json(await s.call(historyOf()));
    expect(body["pendingId"]).toBeUndefined();
    expect(body["messages"]).toEqual([
      { id: declined, author: "participant", text: "mine bitcoin", status: "declined" },
      { id: `${declined}-r`, author: "assistant", text: expect.stringContaining("a habit tracker") as unknown },
      { id: stale, author: "participant", text: "a recipe list", status: "failed" },
      { id: `${stale}-r`, author: "assistant", text: FAILURE_REPLY },
    ]);
  });

  it("returns the last 50 messages and replies only", async () => {
    const s = setup();
    for (let i = 0; i < 30; i++) await s.exchange(`answer ${String(i).padStart(2, "0")}`, `reply ${i}`);
    const messages = json(await s.call(historyOf()))["messages"] as { text: string }[];
    expect(HISTORY_PAGE_LIMIT).toBe(50);
    expect(messages).toHaveLength(50);
    expect(messages[0]?.text).toBe("answer 05");
    expect(messages.at(-1)?.text).toBe("reply 29");
  });

  it("needs a session (401) and shows a participant only their own conversation", async () => {
    const s = setup();
    await s.exchange("my secret idea about llamas", QUESTIONS);
    await s.exchange("Bob's idea about kites", "Who flies them?", THEIRS);
    for (const req of [historyOf(token(9)), { routeKey: HISTORY_ROUTE }]) expect((await s.call(req)).statusCode).toBe(401);
    const theirs = JSON.stringify(json(await s.call(historyOf(THEIRS))));
    expect(theirs).toContain("kites");
    expect(theirs).not.toContain("llamas");
    const mine = JSON.stringify(json(await s.call(historyOf())));
    expect(mine).toContain("llamas");
    expect(mine).not.toContain("kites");
  });

  it("answers a table failure 500 without details", async () => {
    const s = setup();
    s.table.conversationFailOn = "listItems";
    const res = await s.call(historyOf());
    expect(res.statusCode).toBe(500);
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "history", outcome: "failed", error: "InternalServerError" });
  });
});

describe("shapeHistory", () => {
  it("keeps a reply whose message fell outside the window, and names no pending id for a message that is not in flight", () => {
    const items: ListedItem[] = [
      { author: "assistant", replyTo: "m-0", text: "old reply", offersSpec: false },
      { author: "participant", id: "m-1", text: "hello", status: "pending", pendingSince: 100 },
    ];
    expect(shapeHistory("clarify", items, { state: "open" }, 110)).toEqual({
      step: "clarify",
      state: "open",
      messages: [
        { id: "m-0-r", author: "assistant", text: "old reply" },
        { id: "m-1", author: "participant", text: "hello", status: "pending" },
      ],
    });
    expect(shapeHistory("clarify", items, { state: "open", pendingId: "m-1" }, 110).pendingId).toBe("m-1");
  });
});

describe("criterion 5: Write my spec moves the participant to step 2", () => {
  it("WHEN the participant presses Write my spec THEN their step becomes spec, and GET /api/me's step follows", async () => {
    const s = setup();
    await s.exchange("a run tracker", QUESTIONS);
    const res = await s.call(writeSpec());
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ step: "spec" });
    expect(s.table.profiles.get("me-1")?.step).toBe("spec");
    expect(json(await s.call(historyOf()))["step"]).toBe("spec");
    // Pressed twice: still fine.
    expect((await s.call(writeSpec())).statusCode).toBe(200);
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "step", outcome: "ok" });
    // Another participant is untouched.
    expect(s.table.profiles.get("other-2")?.step).toBe("clarify");
  });

  it("refuses before any answered exchange (too-early), while a message is pending (busy) or flagged (waiting)", async () => {
    const s = setup();
    const early = await s.call(writeSpec());
    expect(early.statusCode).toBe(409);
    expect(json(early)).toEqual({ reason: "too-early", message: MESSAGES["too-early"] });
    s.model.push(verdictReply("decline", "a quiz"));
    await s.call(send("mine bitcoin"));
    await s.drain();
    s.advance(5);
    expect(json(await s.call(writeSpec()))["reason"]).toBe("too-early");

    await s.exchange("a run tracker", QUESTIONS);
    await s.call(send("just me"));
    expect(json(await s.call(writeSpec()))).toEqual({ reason: "busy", message: MESSAGES.busy });
    s.model.push(verdictReply("flag", "", "unsure"));
    await s.drain();
    expect(json(await s.call(writeSpec()))).toEqual({ reason: "waiting", message: MESSAGES.waiting });
    expect(s.table.profiles.get("me-1")?.step).toBe("clarify");
  });

  it("lets the participant move on when the only message in flight went stale", async () => {
    const s = setup();
    await s.exchange("a run tracker", QUESTIONS);
    await s.call(send("just me"));
    s.queue.sent.length = 0;
    s.advance(STALE_PENDING_SECONDS + 1);
    expect((await s.call(writeSpec())).statusCode).toBe(200);
  });

  it("checks the body, the content type, the nickname and the step", async () => {
    const s = setup();
    await s.exchange("a run tracker", QUESTIONS);
    for (const body of [{}, { step: "approved" }, { step: "clarify" }, "spec"]) {
      const res = await s.call(writeSpec(MINE, body));
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(json(res)).toEqual({ message: MESSAGES["invalid-step"] });
    }
    expect((await s.call(writeSpec(MINE, { step: "spec" }, "text/plain"))).statusCode).toBe(415);
    expect(json(await s.call(writeSpec(NEWBIE)))["reason"]).toBe("no-nickname");
    s.table.profiles.set("me-1", { ...must(s.table.profiles.get("me-1")), step: "approved" });
    expect(json(await s.call(writeSpec()))).toEqual({ reason: "wrong-step", message: MESSAGES["wrong-step"] });
    expect(s.table.profiles.get("me-1")?.step).toBe("approved");
  });

  it("needs a session (401) and moves only the caller", async () => {
    const s = setup();
    await s.exchange("a run tracker", QUESTIONS);
    for (const req of [writeSpec(token(9)), { routeKey: STEP_ROUTE, headers: { "content-type": "application/json" }, body: '{"step":"spec"}' }]) {
      expect((await s.call(req)).statusCode).toBe(401);
    }
    // Bob has no answered exchange of his own: Ada's does not count for him.
    expect(json(await s.call(writeSpec(THEIRS)))["reason"]).toBe("too-early");
    expect(s.table.profiles.get("me-1")?.step).toBe("clarify");
    expect(s.table.profiles.get("other-2")?.step).toBe("clarify");
  });

  it("still polls a message by id after the move (the poll route is unchanged)", async () => {
    const s = setup();
    const id = await s.exchange("a run tracker", QUESTIONS);
    await s.call(writeSpec());
    expect(json(await s.call({ routeKey: POLL_ROUTE, cookies: cookie(MINE), pathParameters: { id } }))).toEqual({ id, status: "done", reply: QUESTIONS });
  });
});
