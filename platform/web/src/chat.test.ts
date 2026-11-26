import { describe, expect, it } from "vitest";
import {
  POLL_INTERVAL_MS,
  budgetLeftText,
  canWriteSpec,
  conversationResult,
  parseConversation,
  pollResult,
  sendResult,
  specOffered,
  stageOf,
  statusResult,
  writeSpecResult,
  type ChatMessage,
} from "./chat.js";
import { MESSAGES } from "./flow.js";

const asked: ChatMessage[] = [
  { id: "m1", author: "participant", text: "a run tracker", status: "done" },
  { id: "m1-r", author: "assistant", text: "1. Who?\n2. What?\n3. When?" },
];

describe("AI budget left (ticket 3.3)", () => {
  it("reads budgetLeft only as a number of dollars from 0, and shows it to the cent", () => {
    const base = { step: "clarify", state: "open", messages: [] };
    expect(parseConversation({ ...base, budgetLeft: 3.2 })?.budgetLeft).toBe(3.2);
    expect(parseConversation({ ...base, budgetLeft: 0 })?.budgetLeft).toBe(0);
    for (const bad of [-1, "3", null, Number.NaN, Number.POSITIVE_INFINITY]) expect(parseConversation({ ...base, budgetLeft: bad })).toEqual(base);
    expect(budgetLeftText(3.2)).toBe("AI budget left: $3.20");
    expect(budgetLeftText(0)).toBe("AI budget left: $0.00");
    expect(budgetLeftText(4.99)).toBe("AI budget left: $4.99");
  });
});

describe("the workshop paused by the global Stop (ticket 3.5)", () => {
  it("reads paused only as true, on the conversation and on a pending poll", () => {
    const base = { step: "clarify", state: "open", messages: [] };
    expect(parseConversation({ ...base, paused: true })).toEqual({ ...base, paused: true });
    for (const bad of [false, "true", 1, null]) expect(parseConversation({ ...base, paused: bad })).toEqual(base);
    expect(pollResult({ status: 200, body: { id: "m", status: "pending", paused: true } })).toEqual({ kind: "pending", paused: true });
    expect(pollResult({ status: 200, body: { id: "m", status: "pending", paused: "yes" } })).toEqual({ kind: "pending" });
  });

  it("keeps paused on every poll status (flagged and answered too), and reads pausedUnknown only as true", () => {
    expect(pollResult({ status: 200, body: { id: "m", status: "flagged", paused: true } })).toEqual({ kind: "flagged", paused: true });
    expect(pollResult({ status: 200, body: { id: "m", status: "flagged" } })).toEqual({ kind: "flagged" });
    expect(pollResult({ status: 200, body: { id: "m", status: "done", reply: "Hi", paused: true } })).toEqual({ kind: "answered", status: "done", reply: "Hi", paused: true });
    for (const status of ["pending", "flagged"]) {
      expect(pollResult({ status: 200, body: { id: "m", status, pausedUnknown: true } })).toEqual({ kind: status, pausedUnknown: true });
      expect(pollResult({ status: 200, body: { id: "m", status, pausedUnknown: "true" } })).toEqual({ kind: status });
    }
    const base = { step: "clarify", state: "open", messages: [] };
    expect(parseConversation({ ...base, pausedUnknown: true })).toEqual({ ...base, pausedUnknown: true });
    for (const bad of [false, "true", 1]) expect(parseConversation({ ...base, pausedUnknown: bad })).toEqual(base);
  });

  it("reads GET /api/status: paused only as true, off on any other 200 body, and nothing to change on any other answer", () => {
    expect(statusResult({ status: 200, body: { paused: true } })).toBe(true);
    for (const body of [{}, { paused: false }, { paused: "true" }]) expect(statusResult({ status: 200, body })).toBe(false);
    for (const answer of [{ status: 200, body: null }, { status: 200, body: [true] }, { status: 401, body: {} }, { status: 500, body: { paused: true } }, { status: 0, body: null }]) {
      expect(statusResult(answer)).toBeUndefined();
    }
  });
});

describe("conversation (GET /api/conversation)", () => {
  it("reads the conversation, its state and the message in flight", () => {
    const body = { step: "clarify", state: "waiting", messages: [...asked, { id: "m2", author: "participant", text: "x", status: "flagged" }], pendingId: "m2" };
    expect(conversationResult({ status: 200, body })).toEqual({ kind: "conversation", conversation: body });
    expect(parseConversation({ step: "clarify", state: "open", messages: [] })).toEqual({ step: "clarify", state: "open", messages: [] });
  });

  it("keeps offersSpec only when true and drops unknown fields", () => {
    const body = { step: "clarify", state: "open", messages: [{ id: "a", author: "assistant", text: "t", offersSpec: true, extra: 1 }] };
    expect(parseConversation(body)?.messages).toEqual([{ id: "a", author: "assistant", text: "t", offersSpec: true }]);
  });

  it("refuses a malformed conversation, is signed out on 401 and reports failures", () => {
    for (const body of [null, {}, { step: "clarify", state: "odd", messages: [] }, { step: "clarify", state: "open", messages: [{ id: 1 }] }]) {
      expect(conversationResult({ status: 200, body }), JSON.stringify(body)).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
    }
    expect(conversationResult({ status: 401, body: null })).toEqual({ kind: "signed-out" });
    expect(conversationResult({ status: 0, body: null })).toEqual({ kind: "show", message: MESSAGES.offline, tone: "error" });
  });
});

describe("sending (POST /api/conversation/messages)", () => {
  it("gets the id on 202 and tells busy, waiting and no-nickname apart", () => {
    expect(sendResult({ status: 202, body: { id: "m9" } })).toEqual({ kind: "sent", id: "m9" });
    expect(sendResult({ status: 202, body: {} })).toMatchObject({ kind: "show" });
    for (const reason of ["busy", "waiting", "no-nickname"] as const) expect(sendResult({ status: 409, body: { reason, message: "m" } })).toEqual({ kind: reason });
    expect(sendResult({ status: 400, body: { message: "Send a JSON body with a text of 1 to 2000 characters." } })).toMatchObject({
      message: "Send a JSON body with a text of 1 to 2000 characters.",
    });
    expect(sendResult({ status: 401, body: null })).toEqual({ kind: "signed-out" });
    expect(sendResult({ status: 429, body: null })).toEqual({ kind: "show", message: MESSAGES.retry, tone: "info" });
  });
});

describe("polling (GET /api/conversation/messages/{id})", () => {
  it("polls every 2 seconds", () => {
    expect(POLL_INTERVAL_MS).toBe(2000);
  });

  it("keeps polling while pending or on a passing failure, and stops on a reply, a 404 or a 401", () => {
    expect(pollResult({ status: 200, body: { id: "m", status: "pending" } })).toEqual({ kind: "pending" });
    expect(pollResult({ status: 200, body: { id: "m", status: "flagged" } })).toEqual({ kind: "flagged" });
    for (const status of ["done", "declined", "failed"]) {
      expect(pollResult({ status: 200, body: { id: "m", status, reply: "r" } })).toEqual({ kind: "answered", status, reply: "r" });
    }
    expect(pollResult({ status: 200, body: { id: "m", status: "done" } })).toEqual({ kind: "retry" });
    for (const status of [0, 429, 500, 503]) expect(pollResult({ status, body: null })).toEqual({ kind: "retry" });
    expect(pollResult({ status: 404, body: null })).toEqual({ kind: "lost" });
    expect(pollResult({ status: 401, body: null })).toEqual({ kind: "signed-out" });
  });
});

describe("Write my spec", () => {
  it("appears after the first answered message and is highlighted once the AI offered", () => {
    expect(canWriteSpec([])).toBe(false);
    expect(canWriteSpec([{ id: "m", author: "participant", text: "x", status: "declined" }])).toBe(false);
    expect(canWriteSpec(asked)).toBe(true);
    expect(specOffered(asked)).toBe(false);
    const offered = [...asked, { id: "m2", author: "participant" as const, text: "me", status: "done" }, { id: "m2-r", author: "assistant" as const, text: "ok", offersSpec: true }];
    expect(specOffered(offered)).toBe(true);
    expect(specOffered([...offered, { id: "m3", author: "participant", text: "one more thing", status: "pending" }])).toBe(false);
  });

  it("moves on 200 and shows the API's reason on 409", () => {
    expect(writeSpecResult({ status: 200, body: { step: "spec" } })).toEqual({ kind: "moved" });
    expect(writeSpecResult({ status: 409, body: { reason: "busy", message: "Please wait for the answer to your last message." } })).toEqual({
      kind: "show",
      message: "Please wait for the answer to your last message.",
      tone: "error",
    });
    expect(writeSpecResult({ status: 401, body: null })).toEqual({ kind: "signed-out" });
    expect(writeSpecResult({ status: 500, body: null })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
  });
});

describe("behind the scenes", () => {
  it("highlights the AI's work while waiting, the facilitator for a flag, and the reply once there", () => {
    expect(stageOf("none", [])).toBe("idle");
    expect(stageOf("pending", asked)).toBe("working");
    expect(stageOf("flagged", asked)).toBe("facilitator");
    expect(stageOf("none", asked)).toBe("reply");
  });
});
