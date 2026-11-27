// Ticket 3.10: the facilitator routes, against the in-memory table, model and queues. The flag scenarios are the
// flags command's (platform/src/flags/command.test.ts), pressed on the dashboard instead.
import { describe, expect, it } from "vitest";
import { CLARIFY_SYSTEM_PROMPT } from "../conversation/answer.js";
import { BUILD_ROUTE, handleConversationRequest, HISTORY_ROUTE, POLL_ROUTE, SEND_ROUTE, STATUS_ROUTE, type ConversationDeps } from "../conversation/conversation.js";
import { FakeBuildQueue, FakeModel, FakeQueue, verdictReply } from "../conversation/fakes.js";
import { STOP_HOLD_SECONDS, textHash, type AiJob } from "../conversation/state.js";
import { processJob, type WorkerDeps } from "../conversation/worker.js";
import { FakeTable } from "../fakes.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import {
  APPROVE_ROUTE,
  BUDGET_ROUTE,
  CONVERSATION_ROUTE,
  FACILITATOR_ROUTES,
  FACILITATOR_TEXTS,
  handleFacilitatorRequest,
  LIST_ROUTE,
  PAUSE_ROUTE,
  REJECT_ROUTE,
  RESUME_ROUTE,
  RETRY_ROUTE,
  type FacilitatorDeps,
  type FacilitatorLogEntry,
  type ParticipantRow,
} from "./facilitator.js";
import { FakeFacilitatorTable } from "./fakes.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const NOW = new Date("2026-11-26T10:00:00.000Z");
const EXPIRES = NOW.getTime() / 1000 + 8 * 3600;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const ADA = token(1);
const BOB = token(2);
const CY = token(3);
const FACILITATOR = token(4);
const ADMIN = token(5);
const FLAGGED_TEXT = "An app that tells my colleagues which pills to take, mail me at ada@example.org";

function setup() {
  const table = new FakeFacilitatorTable();
  table.addParticipant("p-ada", "Ada", ADA, EXPIRES);
  table.addParticipant("p-bob", "bob", BOB, EXPIRES);
  table.addParticipant("p-cy", undefined, CY, EXPIRES, "nickname");
  // Bob is in group red (profile and allow-list, as sign-in copies the group).
  const bob = must(table.profiles.get("p-bob"));
  table.profiles.set("p-bob", { ...bob, group: "red" });
  table.allow.set(FakeTable.emailOf("p-bob"), { role: "participant", group: "red", participantId: "p-bob" });
  for (const [id, role, group, t] of [
    ["f-1", "facilitator", "red", FACILITATOR],
    ["a-1", "admin", "blue", ADMIN],
  ] as const) {
    table.profiles.set(id, { id, role, group, step: "nickname", createdAt: "2026-11-26T08:00:00.000Z" });
    table.addSession(t, id, EXPIRES);
  }
  const queue = new FakeQueue();
  const model = new FakeModel();
  let clock = NOW;
  let counter = 10;
  const logs: FacilitatorLogEntry[] = [];
  const deps: FacilitatorDeps = { sessions: table, store: table, queue: () => queue, now: () => clock, log: (e) => logs.push(e) };
  const api: ConversationDeps = { sessions: table, store: table, editLinks: table.appTokens, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, ++counter), log: () => undefined };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, builds: new FakeBuildQueue(), held: queue, now: () => clock, log: () => undefined, sleep: async () => undefined };
  const drain = async () => {
    const outcomes = [];
    while (queue.sent.length > 0) outcomes.push(await processJob(queue.sent.shift(), workerDeps));
    return outcomes;
  };
  const deliverHeld = async () => {
    const outcomes = [];
    for (const { job } of queue.later.splice(0)) outcomes.push(await processJob(job as AiJob, workerDeps));
    return outcomes;
  };
  const say = async (text: string, t = ADA) =>
    handleConversationRequest({ routeKey: SEND_ROUTE, cookies: [`${SESSION_COOKIE}=${t}`], headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }, api);
  const poll = async (id: string, t = ADA) => json(await handleConversationRequest({ routeKey: POLL_ROUTE, cookies: [`${SESSION_COOKIE}=${t}`], pathParameters: { id } }, api));
  const history = async (t = ADA) => json(await handleConversationRequest({ routeKey: HISTORY_ROUTE, cookies: [`${SESSION_COOKIE}=${t}`] }, api));
  /** A participant's own GET (`/api/build`, `/api/status`), as their page reads it. */
  const read = async (routeKey: string, t = ADA) => json(await handleConversationRequest({ routeKey, cookies: [`${SESSION_COOKIE}=${t}`] }, api));
  const call = (request: HttpRequest) => handleFacilitatorRequest(request, deps);
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  /** Ada's message, flagged by the guardrail (as in the flags command's tests). */
  const flag = async () => {
    const id = json(await say(FLAGGED_TEXT))["id"] as string;
    model.push(verdictReply("flag", "A medication reminder checklist", "medical advice for ada@example.org"));
    await drain();
    expect(table.conversations.get("p-ada")?.state).toBe("waiting");
    return id;
  };
  return { table, queue, model, logs, call, drain, deliverHeld, say, poll, history, read, advance, flag };
}

/** `null`: no session cookie. */
const cookieOf = (who: string | null): Pick<HttpRequest, "cookies"> => (who === null ? {} : { cookies: [`${SESSION_COOKIE}=${who}`] });
const list = (who: string | null = FACILITATOR, group?: string): HttpRequest => ({
  routeKey: LIST_ROUTE,
  ...cookieOf(who),
  ...(group === undefined ? {} : { queryStringParameters: { group } }),
});
const action = (routeKey: string, nickname: string, who: string | null = FACILITATOR, body?: string): HttpRequest => ({
  routeKey,
  ...cookieOf(who),
  pathParameters: { nickname },
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body }),
});
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;
const rows = (res: HttpResponse): ParticipantRow[] => json(res)["participants"] as ParticipantRow[];

describe("GET /api/facilitator/participants (ticket 3.10)", () => {
  it("serves exactly the list, the conversation log and the six actions", () => {
    expect(FACILITATOR_ROUTES).toEqual([
      "GET /api/facilitator/participants",
      "GET /api/facilitator/participants/{nickname}/conversation",
      "POST /api/facilitator/participants/{nickname}/retry",
      "POST /api/facilitator/participants/{nickname}/pause",
      "POST /api/facilitator/participants/{nickname}/resume",
      "POST /api/facilitator/participants/{nickname}/budget",
      "POST /api/facilitator/participants/{nickname}/flag/approve",
      "POST /api/facilitator/participants/{nickname}/flag/reject",
    ]);
  });

  it("criterion 1: WHEN a facilitator lists participants THEN each row has nickname, group, step, time in step, build status, spend, changes used, paused and the open flag's text, and no email address or participant id appears", async () => {
    const s = setup();
    await s.flag();
    s.table.profiles.set("p-bob", { ...must(s.table.profiles.get("p-bob")), step: "building", stepSince: "2026-11-26T09:40:00.000Z", extraBudget: 2, changeRequestsUsed: 1, paused: true });
    s.table.conversations.set("p-bob", { state: "open", buildId: "b-bob" });
    s.table.builds.set("b-bob", { buildId: "b-bob", nickname: "bob", participantId: "p-bob", status: "building", createdAt: "x", updatedAt: "x", launchedAt: "2026-11-26T09:42:00.000Z", kind: "change", changeNumber: 1 });
    s.table.usage.set("p-bob", { inputTokens: 1, outputTokens: 1, costUsd: 1.23456 });
    const res = await s.call(list());
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body["viewer"]).toEqual({ role: "facilitator", group: "red" });
    expect(body["stopped"]).toBe(false);
    const [ada, cy, bob] = rows(res);
    expect(must(ada)).toMatchObject({ nickname: "Ada", group: "blue", step: "clarify", build: null, paused: false, spentUsd: expect.any(Number) as number, budgetUsd: 5, changeRequestsUsed: 0, changeRequestsPerPerson: 5 });
    expect(must(ada).flags).toHaveLength(1);
    expect(must(must(ada).flags[0]).text).toContain("An app that tells my colleagues which pills to take");
    expect(cy).toMatchObject({ nickname: null, group: "blue", step: "nickname" });
    expect(bob).toEqual({
      nickname: "bob",
      group: "red",
      step: "building",
      stepSince: "2026-11-26T09:40:00.000Z",
      minutesInStep: 20,
      build: { status: "building", kind: "change", changeNumber: 1, stuck: true, minutesBuilding: 18, retryRequested: false },
      spentUsd: 1.23,
      budgetUsd: 7,
      extraBudgetUsd: 2,
      changeRequestsUsed: 1,
      changeRequestsPerPerson: 5,
      paused: true,
      flags: [],
    });
    // Only participants: the facilitator and the admin are not rows.
    expect(rows(res)).toHaveLength(3);
    // No email address (the allow-list's, or one typed into a message) and no participant id anywhere in the answer.
    const text = res.body ?? "";
    expect(text).not.toContain("@");
    for (const id of ["p-ada", "p-bob", "p-cy", "f-1", "a-1"]) {
      expect(text).not.toContain(id);
      expect(text).not.toContain(FakeTable.emailOf(id));
    }
    expect(text).not.toContain("example.org");
    expect(s.logs).toContainEqual({ event: "facilitator", route: "list", outcome: "ok" });
  });

  it("criterion 3: WHEN ?group= is given THEN only that group's rows are listed; empty or absent lists everyone", async () => {
    const s = setup();
    expect(rows(await s.call(list(FACILITATOR, "red"))).map((r) => r.nickname)).toEqual(["bob"]);
    expect(rows(await s.call(list(FACILITATOR, "blue"))).map((r) => r.nickname)).toEqual(["Ada", null]);
    expect(rows(await s.call(list(FACILITATOR, "green")))).toEqual([]);
    expect(rows(await s.call(list(FACILITATOR, ""))).map((r) => r.nickname)).toEqual(["Ada", null, "bob"]);
    expect(rows(await s.call(list(ADMIN))).map((r) => r.nickname)).toEqual(["Ada", null, "bob"]);
  });

  it("shows a pending Retry and a build that is not stuck", async () => {
    const s = setup();
    s.table.conversations.set("p-ada", { state: "open", buildId: "b-ada" });
    s.table.builds.set("b-ada", { buildId: "b-ada", nickname: "Ada", participantId: "p-ada", status: "failed", createdAt: "x", updatedAt: "x" });
    s.table.retryRequests.set("b-ada", NOW.toISOString());
    expect(must(rows(await s.call(list()))[0]).build).toEqual({ status: "failed", kind: "first", stuck: false, retryRequested: true });
  });
});

describe("who may call the facilitator routes (ticket 3.10)", () => {
  const every = (who: string | null): HttpRequest[] =>
    FACILITATOR_ROUTES.map((routeKey) => (routeKey === LIST_ROUTE ? list(who) : action(routeKey, "Ada", who, "{}")));

  it("criterion 2: WHEN a participant calls any facilitator route THEN the answer is 404 and nothing is read or changed", async () => {
    const s = setup();
    const flagged = await s.flag();
    const before = JSON.stringify([...s.table.profiles], null, 0);
    for (const request of every(BOB)) {
      const res = await s.call(request);
      expect(res.statusCode, request.routeKey).toBe(404);
    }
    expect(s.table.rosterCalls).toBe(0);
    expect(JSON.stringify([...s.table.profiles], null, 0)).toBe(before);
    expect(s.table.retryRequests.size).toBe(0);
    expect(s.table.messages.get("p-ada")?.get(flagged)?.status).toBe("flagged");
    expect(s.queue.sent).toEqual([]);
  });

  it("takes the role from the allow-list, not the profile: a profile saying facilitator does not open the routes", async () => {
    const s = setup();
    s.table.profiles.set("p-bob", { ...must(s.table.profiles.get("p-bob")), role: "facilitator" });
    expect((await s.call(list(BOB))).statusCode).toBe(404);
  });

  it("answers 401 without a session on every route, and 404 to an unknown route", async () => {
    const s = setup();
    for (const request of every(null)) expect((await s.call(request)).statusCode, request.routeKey).toBe(401);
    expect((await s.call({ routeKey: "GET /api/facilitator/whatever", cookies: [`${SESSION_COOKIE}=${FACILITATOR}`] })).statusCode).toBe(404);
  });

  it("criterion 3: WHEN a facilitator or the admin acts on any participant (any group) THEN it works", async () => {
    const s = setup();
    for (const [who, nickname] of [
      [FACILITATOR, "Ada"],
      [FACILITATOR, "bob"],
      [ADMIN, "BOB"],
      [ADMIN, "ada"],
    ] as const) {
      expect((await s.call(action(PAUSE_ROUTE, nickname, who))).statusCode).toBe(200);
      expect((await s.call(action(RESUME_ROUTE, nickname, who))).statusCode).toBe(200);
      expect((await s.call(action(CONVERSATION_ROUTE, nickname, who))).statusCode).toBe(200);
    }
  });

  it("WHEN a nickname is given in another letter case THEN it resolves to the same participant", async () => {
    const s = setup();
    expect((await s.call(action(PAUSE_ROUTE, "ADA"))).statusCode).toBe(200);
    expect(s.table.profiles.get("p-ada")?.paused).toBe(true);
    expect((await s.call(action(RESUME_ROUTE, "aDa"))).statusCode).toBe(200);
    expect(s.table.profiles.get("p-ada")?.paused).toBe(false);
    expect(json(await s.call(action(CONVERSATION_ROUTE, "BoB")))).toMatchObject({ nickname: "BoB" });
  });

  it("WHEN a facilitator is removed from the allow-list THEN every route answers 401", async () => {
    const s = setup();
    expect((await s.call(list())).statusCode).toBe(200);
    s.table.allow.delete(FakeTable.emailOf("f-1"));
    for (const request of every(FACILITATOR)) expect((await s.call(request)).statusCode, request.routeKey).toBe(401);
    expect(s.table.profiles.get("p-ada")?.paused).toBeUndefined();
  });

  it("WHEN a facilitator or the admin acts on a facilitator, the admin, themselves or a removed person THEN the answer is the plain 404 and nothing is written", async () => {
    const s = setup();
    // The facilitator and the admin have nicknames too (they chose one like anyone else).
    for (const [id, nickname] of [
      ["f-1", "Fran"],
      ["a-1", "Root"],
    ] as const) {
      s.table.profiles.set(id, { ...must(s.table.profiles.get(id)), nickname, step: "clarify" });
      s.table.nicknames.set(nickname.toLowerCase(), { nickname, participantId: id });
    }
    // Bob's allow-list entry was removed: `npm run allowlist -- remove` marks his profile.
    s.table.profiles.set("p-bob", { ...must(s.table.profiles.get("p-bob")), role: "removed" as never });
    const before = JSON.stringify([...s.table.profiles]);
    const actions = FACILITATOR_ROUTES.filter((routeKey) => routeKey !== LIST_ROUTE);
    for (const [who, nickname] of [
      [FACILITATOR, "Fran"],
      [FACILITATOR, "root"],
      [ADMIN, "Root"],
      [ADMIN, "FRAN"],
      [FACILITATOR, "bob"],
    ] as const) {
      for (const routeKey of actions) {
        const res = await s.call(action(routeKey, nickname, who, "{}"));
        expect(res.statusCode, `${routeKey} ${nickname}`).toBe(404);
        expect(json(res)).toEqual(json(await s.call(action(routeKey, "Nobody", who, "{}"))));
      }
    }
    expect(JSON.stringify([...s.table.profiles])).toBe(before);
    expect(s.table.retryRequests.size).toBe(0);
    expect(s.queue.sent).toEqual([]);
    // Ada, a participant, is still reachable.
    expect((await s.call(action(PAUSE_ROUTE, "Ada"))).statusCode).toBe(200);
  });

  it("answers 404 for an unknown or malformed nickname, 415 for a write without JSON, and 500 on a table failure (error name only)", async () => {
    const s = setup();
    expect((await s.call(action(PAUSE_ROUTE, "Nobody"))).statusCode).toBe(404);
    expect((await s.call(action(PAUSE_ROUTE, "p-ada"))).statusCode).toBe(404);
    expect((await s.call(action(PAUSE_ROUTE, "../x"))).statusCode).toBe(404);
    expect((await s.call({ ...action(PAUSE_ROUTE, "Ada"), headers: { "content-type": "text/plain" } })).statusCode).toBe(415);
    expect(s.table.profiles.get("p-ada")?.paused).toBeUndefined();
    s.table.failOn = "getSession";
    s.table.failure = Object.assign(new Error("ada@example.org"), { name: "ProvisionedThroughputExceededException" });
    const res = await s.call(list());
    expect(res.statusCode).toBe(500);
    expect(s.logs.at(-1)).toEqual({ event: "facilitator", route: "list", outcome: "failed", error: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(s.logs)).not.toContain("@");
  });
});

describe("facilitator actions (ticket 3.10)", () => {
  it("criterion 5: WHEN Approve is pressed THEN the flagged message continues exactly as `npm run flags -- approve` did: the AI answers it without a new check", async () => {
    const s = setup();
    const id = await s.flag();
    const res = await s.call(action(APPROVE_ROUTE, "ada"));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ message: FACILITATOR_TEXTS.approved });
    expect(s.queue.sent).toEqual([{ participantId: "p-ada", messageId: id }]);
    expect(s.table.messages.get("p-ada")?.get(id)?.approvedTextHash).toBe(textHash(FLAGGED_TEXT));
    expect(await s.poll(id)).toEqual({ id, status: "pending" });
    s.model.push({ text: "Let's keep it to reminders you set yourself.", inputTokens: 10, outputTokens: 10 });
    await s.drain();
    expect(s.model.requests.at(-1)?.system).toBe(CLARIFY_SYSTEM_PROMPT);
    expect(s.model.requests).toHaveLength(2);
    expect(await s.poll(id)).toEqual({ id, status: "done", reply: "Let's keep it to reminders you set yourself." });
    expect(s.table.conversations.get("p-ada")).toEqual({ state: "open" });
    // Decided once: a second press changes nothing.
    expect((await s.call(action(REJECT_ROUTE, "Ada"))).statusCode).toBe(409);
    expect(s.logs.map((l) => l.outcome)).toEqual(["approved", "refused"]);
  });

  it("criterion 5: WHEN Reject is pressed THEN the message is declined with one polite sentence and the participant can write again", async () => {
    const s = setup();
    const id = await s.flag();
    const res = await s.call(action(REJECT_ROUTE, "Ada", ADMIN));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ message: FACILITATOR_TEXTS.rejected });
    expect(await s.poll(id)).toEqual({
      id,
      status: "declined",
      reply: "Sorry, that's outside what we can build in this workshop, but how about a medication reminder checklist instead?",
    });
    expect(s.queue.sent).toHaveLength(0);
    expect(s.model.requests).toHaveLength(1);
    expect((await s.say("a new idea")).statusCode).toBe(202);
    // Nothing waits any more, and Bob never had anything waiting.
    expect(json(await s.call(action(APPROVE_ROUTE, "Ada")))).toEqual({ message: FACILITATOR_TEXTS.noFlag });
    expect((await s.call(action(REJECT_ROUTE, "bob"))).statusCode).toBe(409);
  });

  it("WHEN the AI queue refuses an approved message THEN the answer is 500 with what happens next, logging the error name only", async () => {
    const s = setup();
    await s.flag();
    s.queue.failure = Object.assign(new Error("queue down"), { name: "QueueDoesNotExist" });
    const res = await s.call(action(APPROVE_ROUTE, "Ada"));
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ message: FACILITATOR_TEXTS.approvedNotQueued });
    expect(s.logs.at(-1)).toEqual({ event: "facilitator", route: "approve", outcome: "approved-not-queued", error: "QueueDoesNotExist" });
  });

  it("criterion 6: WHEN a participant is paused THEN the next message waits (no AI call) and the page says the facilitator paused it; WHEN resumed THEN it is answered", async () => {
    const s = setup();
    const res = await s.call(action(PAUSE_ROUTE, "Ada"));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ message: FACILITATOR_TEXTS.paused, paused: true });
    expect(s.table.profiles.get("p-ada")?.paused).toBe(true);
    const id = json(await s.say("a run tracker for me"))["id"] as string;
    expect(await s.drain()).toEqual(["held"]);
    expect(s.model.requests).toHaveLength(0);
    expect(s.queue.later).toEqual([{ job: { participantId: "p-ada", messageId: id }, delaySeconds: STOP_HOLD_SECONDS }]);
    expect(await s.poll(id)).toEqual({ id, status: "pending", paused: true, pausedBy: "facilitator" });
    expect(await s.history()).toMatchObject({ paused: true, pausedBy: "facilitator" });
    // Bob is not paused: his message is answered.
    json(await s.say("a run log", BOB));
    s.model.push(verdictReply("on-path"), { text: "Who is it for?", inputTokens: 1, outputTokens: 1 });
    expect(await s.drain()).toEqual(["done"]);
    // Still held while paused.
    s.advance(STOP_HOLD_SECONDS * 1000);
    expect(await s.deliverHeld()).toEqual(["held"]);
    expect(json(await s.call(action(RESUME_ROUTE, "Ada")))).toEqual({ message: FACILITATOR_TEXTS.resumed, paused: false });
    expect(await s.poll(id)).toEqual({ id, status: "pending" });
    s.advance(STOP_HOLD_SECONDS * 1000);
    s.model.push(verdictReply("on-path"), { text: "Who runs with you?", inputTokens: 1, outputTokens: 1 });
    expect(await s.deliverHeld()).toEqual(["done"]);
    expect(await s.poll(id)).toEqual({ id, status: "done", reply: "Who runs with you?" });
  });

  it("criterion 6 (the build): WHEN a participant with a queued build is paused THEN GET /api/build and GET /api/status say the facilitator paused them; WHEN resumed THEN pausedBy is gone; a facilitator's Pause wins over the global Stop's text", async () => {
    const s = setup();
    s.table.profiles.set("p-ada", { ...must(s.table.profiles.get("p-ada")), step: "building" });
    s.table.conversations.set("p-ada", { state: "open", buildId: "b-ada" });
    s.table.builds.set("b-ada", { buildId: "b-ada", nickname: "Ada", participantId: "p-ada", status: "queued", createdAt: "x", updatedAt: "x" });
    expect(await s.read(BUILD_ROUTE)).toMatchObject({ buildId: "b-ada", status: "queued" });
    expect(await s.read(BUILD_ROUTE)).not.toHaveProperty("paused");
    expect(await s.read(STATUS_ROUTE)).toEqual({});

    expect((await s.call(action(PAUSE_ROUTE, "Ada"))).statusCode).toBe(200);
    expect(await s.read(BUILD_ROUTE)).toMatchObject({ buildId: "b-ada", status: "queued", paused: true, pausedBy: "facilitator" });
    expect(await s.read(STATUS_ROUTE)).toEqual({ paused: true, pausedBy: "facilitator" });
    // Only Ada: Bob's status is untouched.
    expect(await s.read(STATUS_ROUTE, BOB)).toEqual({});

    // The global Stop on as well: the facilitator's Pause still names itself (it lasts until that facilitator's Resume),
    // and everyone else sees the Stop's own line.
    s.table.settingsItem = { stopped: { BOOL: true } };
    expect(await s.read(BUILD_ROUTE)).toMatchObject({ paused: true, pausedBy: "facilitator" });
    expect(await s.read(STATUS_ROUTE)).toEqual({ paused: true, pausedBy: "facilitator" });
    expect(await s.read(STATUS_ROUTE, BOB)).toEqual({ paused: true });

    // Resume while the Stop is still on: the Stop's line (no pausedBy).
    expect((await s.call(action(RESUME_ROUTE, "Ada"))).statusCode).toBe(200);
    expect(await s.read(BUILD_ROUTE)).toMatchObject({ status: "queued", paused: true });
    expect(await s.read(BUILD_ROUTE)).not.toHaveProperty("pausedBy");
    expect(await s.read(STATUS_ROUTE)).toEqual({ paused: true });

    // The Stop off too: nothing.
    s.table.settingsItem = undefined;
    const build = await s.read(BUILD_ROUTE);
    expect(build).toMatchObject({ status: "queued" });
    expect(build).not.toHaveProperty("paused");
    expect(build).not.toHaveProperty("pausedBy");
    expect(await s.read(STATUS_ROUTE)).toEqual({});
  });

  it("WHEN Add budget is pressed THEN $2 is added each time, whatever the body says", async () => {
    const s = setup();
    const first = await s.call(action(BUDGET_ROUTE, "Ada", FACILITATOR, JSON.stringify({ dollars: 1000, amount: 1000 })));
    expect(first.statusCode).toBe(200);
    expect(json(first)).toEqual({ message: FACILITATOR_TEXTS.budgetAdded, extraBudgetUsd: 2, budgetUsd: 7 });
    expect(json(await s.call(action(BUDGET_ROUTE, "Ada", ADMIN, "not json")))).toMatchObject({ extraBudgetUsd: 4, budgetUsd: 9 });
    await Promise.all([s.call(action(BUDGET_ROUTE, "Ada")), s.call(action(BUDGET_ROUTE, "Ada"))]);
    expect(s.table.profiles.get("p-ada")?.extraBudget).toBe(8);
    expect(must(rows(await s.call(list()))[0])).toMatchObject({ extraBudgetUsd: 8, budgetUsd: 13 });
  });

  it("criterion 4 (the route): WHEN Retry is pressed on a failed build or one building for over 15 minutes THEN a Retry request is stored for the launcher; otherwise 409 and nothing is stored", async () => {
    const s = setup();
    expect(json(await s.call(action(RETRY_ROUTE, "Ada")))).toEqual({ message: FACILITATOR_TEXTS.noBuild });
    s.table.conversations.set("p-ada", { state: "open", buildId: "b-ada" });
    s.table.builds.set("b-ada", { buildId: "b-ada", nickname: "Ada", participantId: "p-ada", status: "building", createdAt: "x", updatedAt: "x", launchedAt: "2026-11-26T09:50:00.000Z" });
    const early = await s.call(action(RETRY_ROUTE, "Ada"));
    expect(early.statusCode).toBe(409);
    expect(json(early)).toEqual({ message: FACILITATOR_TEXTS.notRetryable });
    expect(s.table.retryRequests.size).toBe(0);
    s.advance(6 * 60_000);
    const res = await s.call(action(RETRY_ROUTE, "Ada"));
    expect(res.statusCode).toBe(202);
    expect(json(res)).toEqual({ message: FACILITATOR_TEXTS.retryRequested });
    expect([...s.table.retryRequests]).toEqual([["b-ada", "2026-11-26T10:06:00.000Z"]]);
    expect(s.table.conversationUpdatedAt.get("p-ada")).toBe("2026-11-26T10:06:00.000Z");
    // A failed build can be retried at once; a live or queued one cannot.
    s.table.retryRequests.clear();
    must(s.table.builds.get("b-ada")).status = "failed";
    expect((await s.call(action(RETRY_ROUTE, "ada", ADMIN))).statusCode).toBe(202);
    for (const status of ["live", "queued", "deploying"] as const) {
      must(s.table.builds.get("b-ada")).status = status;
      expect((await s.call(action(RETRY_ROUTE, "Ada"))).statusCode).toBe(409);
    }
    // Another participant's build named on the conversation is not this participant's.
    s.table.builds.set("b-ada", { ...must(s.table.builds.get("b-ada")), participantId: "p-bob", status: "failed" });
    expect(json(await s.call(action(RETRY_ROUTE, "Ada")))).toEqual({ message: FACILITATOR_TEXTS.noBuild });
    // A retry never counts a change.
    expect(s.table.profiles.get("p-ada")?.changeRequestsUsed).toBeUndefined();
  });

  it("WHEN a facilitator reads a conversation log THEN it shows who said what, with email addresses removed and no ids", async () => {
    const s = setup();
    await s.flag();
    await s.call(action(REJECT_ROUTE, "Ada"));
    const res = await s.call(action(CONVERSATION_ROUTE, "ADA", ADMIN));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body["nickname"]).toBe("ADA");
    const messages = body["messages"] as { author: string; text: string }[];
    expect(messages.map((m) => m.author)).toEqual(["participant", "assistant"]);
    expect(must(messages[0]).text).toContain("which pills to take");
    expect(res.body).not.toContain("@");
    expect(res.body).not.toContain("p-ada");
    expect(s.logs.at(-1)).toEqual({ event: "facilitator", route: "conversation", outcome: "ok" });
  });
});
