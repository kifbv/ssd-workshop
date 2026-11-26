// Ticket 3.6 (change requests: API and spec update): at step 4 a sent message is a change request (guardrail, then the
// AI's next spec version with its "What changes" list); Build this change runs the readiness check and queues one build
// of kind `change`, counting the change in the same transaction; Not this one puts the proposal aside; changes are refused
// once all are used, while a build runs, and before the app was live; a facilitator's retry does not count again; the
// suggested changes are asked for once the app is live; and another participant's ids answer 404.
import type { ChangeBuildFinish } from "./state.js";
import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { BUDGET_REPLY } from "../workshop/budget.js";
import { changesUsedText, PHASE_3_TEXTS } from "../workshop/texts.js";
import {
  answerChange,
  CHANGE_BUILD_REQUEST,
  CHANGE_FAILURE_REPLY,
  CHANGE_PROMPT_VERSION,
  CHANGE_READY_REPLY,
  CHANGE_SYSTEM_PROMPT,
  changeNotReadyReply,
  extractChanges,
  readChangeAnswer,
} from "./change.js";
import {
  CHANGE_BUILD_ROUTE,
  CHANGE_DISCARD_ROUTE,
  BUILD_ROUTE,
  handleConversationRequest,
  HISTORY_ROUTE,
  POLL_ROUTE,
  SEND_ROUTE,
  SPEC_ROUTE,
  SUGGESTIONS_RETRY_MS,
  type ConversationDeps,
} from "./conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, readinessReply, verdictReply } from "./fakes.js";
import { declineReply } from "./guardrail.js";
import type { ModelReply } from "./model.js";
import { READINESS_SYSTEM_PROMPT } from "./readiness.js";
import { SPEC_FORMAT_AND_RULES, SPEC_SYSTEM_PROMPT } from "./spec.js";
import { buildIdFor, jobBody, parseJob, parseSuggestionsJob, suggestionsJobBody } from "./state.js";
import { parseSuggestions, SUGGESTIONS_PROMPT_VERSION, SUGGESTIONS_SYSTEM_PROMPT, suggestionsRequest } from "./suggestions.js";
import { runBuilds, type BuildsStore } from "../../src/builds/command.js";
import { REQUEUE_REMOVED } from "../../src/builds/store.js";
import { isChangeBuildRequest, processJob, processSuggestionsJob, type WorkerDeps, type WorkerLogEntry } from "./worker.js";

/** The retry command's store over the conversation's fake table (the same rules as FakeBuildsStore: only the build changes). */
function retryStoreOver(table: FakeConversationTable): BuildsStore {
  return {
    listBuilds: async () => [],
    findParticipantId: async (nickname) => table.nicknames.get(nickname.toLowerCase())?.participantId,
    readConversationBuildId: async (participantId) => table.conversations.get(participantId)?.buildId,
    readBuild: async (buildId) => {
      const b = table.builds.get(buildId);
      return b && { nickname: b.nickname, participantId: b.participantId, status: b.status };
    },
    requeue: async (buildId, from, nowIso) => {
      const b = table.builds.get(buildId);
      if (b?.status !== from) return false;
      // REQUEUE_REMOVED: the earlier run's attributes; never kind, changeNumber or specVersion.
      for (const name of REQUEUE_REMOVED) expect(["kind", "changeNumber", "specVersion"]).not.toContain(name);
      delete b.failureReasons;
      delete b.feed;
      delete b.queueKey;
      b.status = "queued";
      b.updatedAt = nowIso;
      return true;
    },
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const START = new Date("2026-11-26T10:00:00.000Z");
const START_S = START.getTime() / 1000;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const MINE = token(1);
const THEIRS = token(2);
const FIRST_BUILD = "2026-11-26T09-00-00-000Z-0101010101010101";
const BOB_BUILD = "2026-11-26T09-00-00-000Z-0202020202020202";

const SPEC = `# Run log

\`\`\`mermaid
flowchart TD
  home[Home] -->|add a run| add[Add a run]
  add -->|saves| runs[(Runs)]
  runs -->|weekly total| home
\`\`\`

## What it does
A log of your runs that shows this week's total distance.

## Screens
- Home: this week's total and the list of runs.
- Add a run: date, distance and time.

## Data it keeps
- Runs: date, distance in km and time.`;

const CHART_SPEC = SPEC.replace("- Add a run: date, distance and time.", "- Add a run: date, distance and time.\n- Chart: a bar chart of the distance run each week.");
const PACE_SPEC = CHART_SPEC.replace("- Runs: date, distance in km and time.", "- Runs: date, distance in km, time and pace.");

const changeReply = (spec: string, lines: string[], words = "I added a weekly chart."): ModelReply => ({
  text: `${words}\n\n<spec>\n${spec}\n</spec>\n\n<changes>\n${lines.map((l) => `- ${l}`).join("\n")}\n</changes>`,
  inputTokens: 2500,
  outputTokens: 600,
});

/** Ada (step 4, her first build live, spec 1 built) and Bob (the same, with his own build). */
function setup(options: { firstStatus?: "live" | "failed" | "building"; used?: number } = {}) {
  const table = new FakeConversationTable();
  table.addParticipant("me-1", "Ada-Runner", MINE, START_S + 3600, "building");
  table.addParticipant("other-2", "Bob", THEIRS, START_S + 3600, "building");
  for (const [id, buildId, nickname] of [
    ["me-1", FIRST_BUILD, "Ada-Runner"],
    ["other-2", BOB_BUILD, "Bob"],
  ] as const) {
    table.conversations.set(id, { state: "open", latestSpecVersion: 1, approvedSpecVersion: 1, buildId });
    table.specs.set(id, [{ version: 1, text: SPEC, messageId: "m", createdAt: "x", approvedAt: "x" }]);
    table.builds.set(buildId, { buildId, nickname, participantId: id, status: "live", createdAt: "x", updatedAt: "x" });
  }
  if (options.firstStatus !== undefined) must(table.builds.get(FIRST_BUILD)).status = options.firstStatus;
  if (options.used !== undefined) table.profiles.set("me-1", { ...must(table.profiles.get("me-1")), changeRequestsUsed: options.used });
  const queue = new FakeQueue();
  const builds = new FakeBuildQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const logs: unknown[] = [];
  const workerLogs: WorkerLogEntry[] = [];
  const deps: ConversationDeps = { sessions: table, store: table, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, ++counter), log: (e) => logs.push(e) };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, builds, held: queue, now: () => clock, log: (e) => workerLogs.push(e), sleep: async () => undefined };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  const delivered: string[] = [];
  /** Runs the worker on every queued job (through the JSON body), keeping each for a redelivery. */
  const drain = async () => {
    const outcomes = [];
    while (queue.sent.length > 0) {
      const body = jobBody(must(queue.sent.shift()));
      delivered.push(body);
      outcomes.push(await processJob(parseJob(body), workerDeps).catch((e: unknown) => `threw ${(e as Error).name}`));
    }
    advance(5);
    return outcomes;
  };
  const redeliver = () => processJob(parseJob(must(delivered.at(-1))), workerDeps).catch((e: unknown) => `threw ${(e as Error).name}`);
  const call = (request: HttpRequest) => handleConversationRequest(request, deps);
  const used = () => table.profiles.get("me-1")?.changeRequestsUsed ?? 0;
  return { table, queue, builds, model, logs, workerLogs, deps, workerDeps, advance, drain, redeliver, call, used };
}

const cookie = (t: string) => [`${SESSION_COOKIE}=${t}`];
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;
const send = (text: string, t: string = MINE): HttpRequest => ({ routeKey: SEND_ROUTE, cookies: cookie(t), headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
const buildChange = (version: number, t: string = MINE): HttpRequest => ({
  routeKey: CHANGE_BUILD_ROUTE,
  cookies: cookie(t),
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ version }),
});
const discard = (version: number, t: string = MINE): HttpRequest => ({
  routeKey: CHANGE_DISCARD_ROUTE,
  cookies: cookie(t),
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ version }),
});
const history = (t: string = MINE): HttpRequest => ({ routeKey: HISTORY_ROUTE, cookies: cookie(t) });
const specOf = (version: number, t: string = MINE): HttpRequest => ({ routeKey: SPEC_ROUTE, cookies: cookie(t), queryStringParameters: { version: String(version) } });
const poll = (id: string, t: string = MINE): HttpRequest => ({ routeKey: POLL_ROUTE, cookies: cookie(t), pathParameters: { id } });
const buildOf = (t: string = MINE): HttpRequest => ({ routeKey: BUILD_ROUTE, cookies: cookie(t) });

/** Ada sends a change that the guardrail lets through and the AI turns into version `version`. */
async function proposeChart(s: ReturnType<typeof setup>): Promise<string> {
  s.model.push(verdictReply("on-path"), changeReply(CHART_SPEC, ["Adds a weekly chart screen"]));
  const res = await s.call(send("Add a weekly chart of my distance"));
  expect(res.statusCode).toBe(202);
  expect(await s.drain()).toEqual(["done"]);
  return json(res)["id"] as string;
}

describe("the change answer (change-v2)", () => {
  it("splits the words, the new spec and the What changes list; a question has neither; broken answers throw", () => {
    expect(readChangeAnswer(changeReply(CHART_SPEC, ["Adds a weekly chart screen", "  Keeps   everything\telse "]).text)).toEqual({
      text: "I added a weekly chart.",
      spec: CHART_SPEC,
      whatChanges: ["Adds a weekly chart screen", "Keeps everything else"],
    });
    expect(readChangeAnswer("A chart shows your weekly distance as bars.")).toEqual({ text: "A chart shows your weekly distance as bars." });
    // A list without a spec is dropped (nothing changes).
    expect(readChangeAnswer("Would a simpler version be fine?\n<changes>\n- x\n</changes>")).toEqual({ text: "Would a simpler version be fine?" });
    expect(readChangeAnswer(changeReply(CHART_SPEC, ["x"], "").text).text).toMatch(/Build this change/);
    for (const [text, name] of [
      [`<spec>\n${CHART_SPEC}\n</spec>`, "MalformedChange"],
      [`<spec>\n${CHART_SPEC}\n</spec>\n<changes>\n</changes>`, "MalformedChange"],
      [`<spec>\n${CHART_SPEC}\n</spec>\n<changes>\n- x`, "MalformedChange"],
      [`<spec>\n# Only a title\n</spec>\n<changes>\n- x\n</changes>`, "MalformedSpec"],
      [`<spec>\n${CHART_SPEC}`, "MalformedSpec"],
      ["", "EmptyAnswer"],
    ] as const) {
      expect(() => readChangeAnswer(text), text.slice(0, 30)).toThrow(expect.objectContaining({ name }) as Error);
    }
    const many = extractChanges(`<changes>\n${Array.from({ length: 9 }, (_, i) => `- line ${i} ${"y".repeat(300)}`).join("\n")}\n</changes>`);
    expect(many.lines).toHaveLength(5);
    expect(must(many.lines)[0]).toHaveLength(160);
  });

  it("sends the live spec and the open proposal with the change prompt, which shares the spec's format and rules", async () => {
    expect(SPEC_SYSTEM_PROMPT.endsWith(SPEC_FORMAT_AND_RULES)).toBe(true);
    expect(CHANGE_SYSTEM_PROMPT).toContain(SPEC_FORMAT_AND_RULES);
    const model = new FakeModel([changeReply(PACE_SPEC, ["Shows the pace of each run"])]);
    const answer = await answerChange(model, [{ question: "q", answer: "a" }], "also show my pace", SPEC, CHART_SPEC);
    const request = must(model.requests[0]);
    expect(request.system).toContain(`<live_spec>\n${SPEC}\n</live_spec>`);
    expect(request.system).toContain(`<proposed_spec>\n${CHART_SPEC}\n</proposed_spec>`);
    expect(request.messages.at(-1)).toEqual({ role: "user", text: "also show my pace" });
    expect(answer).toMatchObject({ promptVersion: CHANGE_PROMPT_VERSION, historyCount: 2, spec: PACE_SPEC, whatChanges: ["Shows the pace of each run"] });
    const none = new FakeModel([{ text: "Sure.", inputTokens: 1, outputTokens: 1 }]);
    await answerChange(none, [], "hi", SPEC, undefined);
    expect(must(none.requests[0]).system).toContain("There is no proposed spec: start from the live spec.");
  });
});

describe("criterion 1: an on-path change stores and returns a new spec version with its What changes list", () => {
  it("WHEN a participant with changes left sends an on-path change THEN version 2 and its list are stored, proposed and returned, and nothing counts", async () => {
    const s = setup();
    const id = await proposeChart(s);
    // The guardrail first (only the message), then the change prompt with the live spec.
    expect(must(s.model.requests[0]).messages).toEqual([{ role: "user", text: "<message>\nAdd a weekly chart of my distance\n</message>" }]);
    expect(must(s.model.requests[1]).system).toContain(`<live_spec>\n${SPEC}\n</live_spec>`);
    expect(s.table.specs.get("me-1")?.at(-1)).toMatchObject({ version: 2, text: CHART_SPEC, whatChanges: ["Adds a weekly chart screen"], messageId: id });
    expect(s.table.conversations.get("me-1")).toMatchObject({ latestSpecVersion: 2, proposedSpecVersion: 2, approvedSpecVersion: 1, buildId: FIRST_BUILD });
    expect(s.table.replies.get("me-1")?.get(id)).toMatchObject({ kind: "answer", text: "I added a weekly chart.", specVersion: 2, promptVersion: CHANGE_PROMPT_VERSION });
    // Returned: the poll answers the reply, the conversation names the proposal, the spec route the version and its list.
    expect(json(await s.call(poll(id)))).toMatchObject({ status: "done", reply: "I added a weekly chart." });
    const page = json(await s.call(history()));
    expect(page).toMatchObject({ step: "building", proposedSpecVersion: 2, latestSpecVersion: 2, approvedSpecVersion: 1, changeRequestsUsed: 0, changeRequestsPerPerson: 5 });
    expect(json(await s.call(specOf(2)))).toEqual({ version: 2, text: CHART_SPEC, createdAt: START.toISOString(), approved: false, whatChanges: ["Adds a weekly chart screen"] });
    expect(json(await s.call(specOf(1)))).toMatchObject({ version: 1, approved: true });
    expect(json(await s.call(specOf(1)))["whatChanges"]).toBeUndefined();
    expect(s.used()).toBe(0);
    expect(s.builds.sent).toEqual([]);
  });

  it("a question changes nothing; a later change refines the open proposal (the model sees it) and becomes the new proposal", async () => {
    const s = setup();
    s.model.push(verdictReply("on-path"), { text: "A chart draws your weekly distance as bars.", inputTokens: 900, outputTokens: 40 });
    await s.call(send("What would a chart look like?"));
    expect(await s.drain()).toEqual(["done"]);
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBeUndefined();
    expect(s.table.specs.get("me-1")).toHaveLength(1);
    await proposeChart(s);
    s.model.push(verdictReply("on-path"), changeReply(PACE_SPEC, ["Adds a weekly chart screen", "Shows the pace of each run"]));
    await s.call(send("Also show my pace"));
    expect(await s.drain()).toEqual(["done"]);
    expect(must(s.model.requests.at(-1)).system).toContain(`<proposed_spec>\n${CHART_SPEC}\n</proposed_spec>`);
    expect(s.table.conversations.get("me-1")).toMatchObject({ proposedSpecVersion: 3, latestSpecVersion: 3, approvedSpecVersion: 1 });
  });

  it("a broken change answer ends with the neutral failure reply and no new version", async () => {
    const s = setup();
    s.model.push(verdictReply("on-path"), { text: `<spec>\n${CHART_SPEC}\n</spec>`, inputTokens: 10, outputTokens: 10 });
    await s.call(send("Add a chart"));
    expect(await s.drain()).toEqual(["failed"]);
    expect(s.table.specs.get("me-1")).toHaveLength(1);
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBeUndefined();
  });
});

describe("criterion 2: Build this change runs the readiness check and queues one change build, counting it", () => {
  it("WHEN they press Build this change THEN the check runs on the proposed version, one build of kind change is queued and changeRequestsUsed goes up by one", async () => {
    const s = setup();
    await proposeChart(s);
    const res = await s.call(buildChange(2));
    expect(res.statusCode).toBe(202);
    const requestId = json(res)["id"] as string;
    expect(json(res)).toEqual({ id: requestId, version: 2 });
    // The request is the platform's own text, marked so only this route makes it; Build this change approves the version.
    const stored = must(s.table.messages.get("me-1")?.get(requestId));
    expect(stored).toMatchObject({ step: "building", text: CHANGE_BUILD_REQUEST, request: "change-build", status: "pending" });
    expect(isChangeBuildRequest(stored)).toBe(true);
    expect(s.table.specs.get("me-1")?.find((v) => v.version === 2)?.approvedAt).toBe(new Date(START.getTime() + 5000).toISOString());
    const calls = s.model.requests.length;
    s.model.push(readinessReply("ready"));
    expect(await s.drain()).toEqual(["building"]);
    // The readiness check ran on the proposed version (one call, no guardrail).
    expect(s.model.requests.length).toBe(calls + 1);
    expect(must(s.model.requests.at(-1)).system).toBe(READINESS_SYSTEM_PROMPT);
    expect(must(s.model.requests.at(-1)).messages[0]?.text).toContain("Chart: a bar chart");
    const buildId = buildIdFor(requestId);
    expect(s.table.builds.get(buildId)).toMatchObject({ status: "queued", kind: "change", changeNumber: 1, specVersion: 2, nickname: "Ada-Runner", participantId: "me-1" });
    expect(s.builds.sent).toEqual([{ buildId, participantId: "me-1" }]);
    expect(s.used()).toBe(1);
    const conversation = s.table.conversations.get("me-1");
    expect(conversation).toMatchObject({ buildId, approvedSpecVersion: 2, latestSpecVersion: 2 });
    expect(conversation?.proposedSpecVersion).toBeUndefined();
    expect(conversation?.pendingId).toBeUndefined();
    expect(s.table.replies.get("me-1")?.get(requestId)).toMatchObject({ kind: "answer", text: CHANGE_READY_REPLY });
    expect(json(await s.call(poll(requestId)))).toMatchObject({ status: "done", reply: CHANGE_READY_REPLY });
    expect(json(await s.call(buildOf()))).toMatchObject({ buildId, status: "queued", kind: "change", changeNumber: 1 });
    // A redelivery only re-sends the build id: no second check, no second build, no second count.
    expect(await s.redeliver()).toBe("resent");
    expect(s.model.requests.length).toBe(calls + 1);
    expect(s.builds.sent).toHaveLength(2);
    expect(s.builds.sent[1]).toEqual({ buildId, participantId: "me-1" });
    expect(s.used()).toBe(1);
    expect([...s.table.builds.values()].filter((b) => b.kind === "change")).toHaveLength(1);
  });

  it("the second change gets number 2, built from the version the first change built", async () => {
    const s = setup({ used: 1 });
    await proposeChart(s);
    await s.call(buildChange(2));
    s.model.push(readinessReply("ready"));
    expect(await s.drain()).toEqual(["building"]);
    const buildId = must(s.table.conversations.get("me-1")?.buildId);
    expect(s.table.builds.get(buildId)).toMatchObject({ kind: "change", changeNumber: 2 });
    expect(s.used()).toBe(2);
  });

  it("not ready, no verdict, over budget: no build, nothing counts, the proposal stays (ask for a fix or press again)", async () => {
    const s = setup();
    await proposeChart(s);
    await s.call(buildChange(2));
    s.model.push(readinessReply("not-ready", ["Your change needs a login, which the template cannot build."]));
    expect(await s.drain()).toEqual(["not-ready"]);
    const notReadyId = must([...must(s.table.messages.get("me-1")).values()].at(-1)).id;
    expect(s.table.replies.get("me-1")?.get(notReadyId)?.text).toBe(changeNotReadyReply(["Your change needs a login, which the template cannot build."]));
    expect(s.table.conversations.get("me-1")).toMatchObject({ proposedSpecVersion: 2, buildId: FIRST_BUILD, approvedSpecVersion: 1 });
    await s.call(buildChange(2));
    s.model.push(new Error("throttled"));
    expect(await s.drain()).toEqual(["failed"]);
    const failedId = must([...must(s.table.messages.get("me-1")).values()].at(-1)).id;
    expect(s.table.replies.get("me-1")?.get(failedId)?.text).toBe(CHANGE_FAILURE_REPLY);
    // Over budget before the check: no AI call at all.
    s.table.usage.set("me-1", { inputTokens: 0, outputTokens: 0, costUsd: 5 });
    const calls = s.model.requests.length;
    await s.call(buildChange(2));
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests.length).toBe(calls);
    const budgetId = must([...must(s.table.messages.get("me-1")).values()].at(-1)).id;
    expect(s.table.replies.get("me-1")?.get(budgetId)).toMatchObject({ kind: "budget", text: BUDGET_REPLY });
    expect(s.used()).toBe(0);
    expect(s.builds.sent).toEqual([]);
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBe(2);
  });

  it("the count is written only from the value read and below the cap: a moved count, or a running previous build, writes nothing", async () => {
    const s = setup();
    await proposeChart(s);
    await s.call(buildChange(2));
    // Meanwhile the count moved (another writer) and the first build was queued again by a retry.
    const before = { ...must(s.table.profiles.get("me-1")) };
    s.table.profiles.set("me-1", { ...before, changeRequestsUsed: 3 });
    s.model.push(readinessReply("ready"));
    // The worker read 3 (below 5), so its write needs exactly 3: now make the previous build run again instead.
    must(s.table.builds.get(FIRST_BUILD)).status = "queued";
    expect(await s.drain()).toEqual(["skipped"]);
    expect(s.builds.sent).toEqual([]);
    expect(s.table.profiles.get("me-1")?.changeRequestsUsed).toBe(3);
    expect([...s.table.builds.values()].filter((b) => b.kind === "change")).toHaveLength(0);
    // The write itself: a count that moved since it was read, or one at the cap, is refused and nothing changes.
    const messageId = must(s.table.conversations.get("me-1")?.pendingId);
    must(s.table.builds.get(FIRST_BUILD)).status = "live";
    const answer = { prompt: "p", modelId: "m", promptVersion: "readiness-v1", historyCount: 0, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    const ready = (used: number, cap: number): ChangeBuildFinish => ({
      kind: "ready", reply: "r", version: 2, previousBuildId: FIRST_BUILD, answer, build: { buildId: "b-direct", nickname: "Ada-Runner", changeNumber: used + 1 }, used, cap,
    });
    expect(await s.table.finishChangeBuild("me-1", messageId, ready(2, 5), "2026-11-26T10:00:00.000Z")).toBe(false);
    s.table.profiles.set("me-1", { ...must(s.table.profiles.get("me-1")), changeRequestsUsed: 5 });
    expect(await s.table.finishChangeBuild("me-1", messageId, ready(5, 5), "2026-11-26T10:00:00.000Z")).toBe(false);
    expect(s.table.profiles.get("me-1")?.changeRequestsUsed).toBe(5);
    expect(s.table.builds.has("b-direct")).toBe(false);
  });

  it("a queue failure at Build this change ends the request at once (the proposal stays, nothing counts)", async () => {
    const s = setup();
    await proposeChart(s);
    s.queue.failure = Object.assign(new Error("down"), { name: "ServiceUnavailable" });
    expect((await s.call(buildChange(2))).statusCode).toBe(500);
    s.queue.failure = undefined;
    expect(s.table.conversations.get("me-1")).toMatchObject({ proposedSpecVersion: 2 });
    expect(s.table.conversations.get("me-1")?.pendingId).toBeUndefined();
    expect(s.used()).toBe(0);
    expect((await s.call(buildChange(2))).statusCode).toBe(202);
  });

  it("two presses at once make one request; Build this change twice after it was queued is not found (no proposal)", async () => {
    const s = setup();
    await proposeChart(s);
    const [a, b] = await Promise.all([s.call(buildChange(2)), s.call(buildChange(2))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    s.model.push(readinessReply("ready"));
    await s.drain();
    expect(s.builds.sent).toHaveLength(1);
    expect((await s.call(buildChange(2))).statusCode).toBe(404);
    expect(s.used()).toBe(1);
  });
});

describe("criterion 3: all changes used", () => {
  it("WHEN all 5 are used THEN sending a change answers \"You've used your 5 changes.\" and nothing is stored or queued", async () => {
    const s = setup({ used: 5 });
    const res = await s.call(send("Add a weekly chart"));
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ message: "You've used your 5 changes.", reason: "no-changes-left" });
    expect(changesUsedText(5)).toBe("You've used your 5 changes.");
    expect(s.queue.sent).toEqual([]);
    expect(s.table.messages.get("me-1")).toBeUndefined();
    expect(s.model.requests).toEqual([]);
    expect(s.builds.sent).toEqual([]);
  });

  it("the cap comes from the settings; Build this change is refused too; a message already in flight when the cap was reached gets the text without an AI call", async () => {
    const s = setup({ used: 2 });
    s.table.settingsItem = { changeRequestsPerPerson: { N: "3" } };
    await proposeChart(s);
    // The admin lowers the cap to 2: Build this change is refused, nothing queued.
    s.table.settingsItem = { changeRequestsPerPerson: { N: "2" } };
    const res = await s.call(buildChange(2));
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ message: "You've used your 2 changes.", reason: "no-changes-left" });
    expect(s.queue.sent).toEqual([]);
    // A change sent while one was left, answered after the cap went down: the limit text, no model call.
    s.table.settingsItem = { changeRequestsPerPerson: { N: "3" } };
    const sent = await s.call(send("Make it blue"));
    s.table.settingsItem = { changeRequestsPerPerson: { N: "2" } };
    const calls = s.model.requests.length;
    expect(await s.drain()).toEqual(["over-limit"]);
    expect(s.model.requests.length).toBe(calls);
    expect(s.table.replies.get("me-1")?.get(json(sent)["id"] as string)).toMatchObject({ kind: "limit", text: "You've used your 2 changes." });
    expect(json(await s.call(poll(json(sent)["id"] as string)))).toMatchObject({ status: "failed", reply: "You've used your 2 changes." });
    // The same for a Build this change request whose check would come after the cap went down.
    s.table.settingsItem = { changeRequestsPerPerson: { N: "3" } };
    await s.call(buildChange(2));
    s.table.settingsItem = { changeRequestsPerPerson: { N: "2" } };
    expect(await s.drain()).toEqual(["over-limit"]);
    expect(s.builds.sent).toEqual([]);
    expect(s.used()).toBe(2);
  });
});

describe("criterion 4: declined and flagged changes", () => {
  it("WHEN a change is declined THEN the guardrail answers as in step 1 (one sentence with a suggestion) and the count does not change", async () => {
    const s = setup();
    s.model.push(verdictReply("decline", "a weekly running chart"));
    const res = await s.call(send("Add a page that tracks where my colleagues are"));
    expect(await s.drain()).toEqual(["declined"]);
    const id = json(res)["id"] as string;
    expect(json(await s.call(poll(id)))).toMatchObject({ status: "declined", reply: declineReply("a weekly running chart") });
    expect(s.model.requests).toHaveLength(1);
    expect(s.table.specs.get("me-1")).toHaveLength(1);
    expect(s.used()).toBe(0);
  });

  it("WHEN a change is flagged THEN it waits for a facilitator as in step 1, a rejection declines it, and the count does not change", async () => {
    const s = setup();
    s.model.push(verdictReply("flag", "", "medical advice"));
    const res = await s.call(send("Add advice on my heart rate zones"));
    expect(await s.drain()).toEqual(["flagged"]);
    const id = json(res)["id"] as string;
    expect(json(await s.call(poll(id)))["status"]).toBe("flagged");
    expect(s.table.conversations.get("me-1")?.state).toBe("waiting");
    // Nothing else can be sent meanwhile (as in step 1).
    expect(json(await s.call(send("Make it blue")))["reason"]).toBe("waiting");
    // The facilitator rejects it (the flags command's finish from flagged).
    expect(await s.table.finish("me-1", id, { kind: "declined", reply: declineReply(undefined) }, "flagged", START.toISOString())).toBe(true);
    expect(json(await s.call(poll(id)))["status"]).toBe("declined");
    expect(s.used()).toBe(0);
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBeUndefined();
  });

  it("an approved flagged change is answered by the change prompt without a new check (and still counts only when built)", async () => {
    const s = setup();
    s.model.push(verdictReply("flag"));
    const id = json(await s.call(send("Add my heart rate zones"))).id as string;
    await s.drain();
    expect(await s.table.approve("me-1", id, "Add my heart rate zones", START_S + 10)).toBe(true);
    s.queue.sent.push({ participantId: "me-1", messageId: id });
    s.model.push(changeReply(CHART_SPEC, ["Adds heart rate zones"]));
    expect(await s.drain()).toEqual(["done"]);
    expect(s.model.requests).toHaveLength(2);
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBe(2);
    expect(s.used()).toBe(0);
  });
});

describe("criterion 5: a facilitator's retry of a failed change build does not count again", () => {
  it("WHEN a change build is retried by a facilitator THEN the count does not change", async () => {
    const s = setup();
    await proposeChart(s);
    await s.call(buildChange(2));
    s.model.push(readinessReply("ready"));
    await s.drain();
    const buildId = must(s.table.conversations.get("me-1")?.buildId);
    expect(s.used()).toBe(1);
    // The build fails; the facilitator runs the real retry command (npm run builds -- retry) over this table.
    must(s.table.builds.get(buildId)).status = "failed";
    const profileBefore = JSON.stringify(s.table.profiles.get("me-1"));
    const conversationBefore = JSON.stringify(s.table.conversations.get("me-1"));
    const launches: string[] = [];
    const out: string[] = [];
    const code = await runBuilds(["retry", "ada-runner"], {
      connect: () => ({ store: retryStoreOver(s.table), queue: { send: async (id: string) => void launches.push(id) }, tasks: { isStopped: async () => true, runningTasks: async () => 0 } }),
      now: () => START,
      out: (line) => out.push(line),
      err: (line) => out.push(line),
    });
    expect(code, out.join("\n")).toBe(0);
    expect(launches).toEqual([buildId]);
    // The same build, queued again with its kind, number and spec version; the participant's items untouched.
    expect(s.table.builds.get(buildId)).toMatchObject({ status: "queued", kind: "change", changeNumber: 1, specVersion: 2 });
    expect(JSON.stringify(s.table.profiles.get("me-1"))).toBe(profileBefore);
    expect(JSON.stringify(s.table.conversations.get("me-1"))).toBe(conversationBefore);
    expect(s.used()).toBe(1);
    // SQS may deliver the old change-build job again: it only re-sends the id, nothing counts.
    expect(await s.redeliver()).toBe("resent");
    expect(s.used()).toBe(1);
  });

  it("after a change build failed, the app before it is still live: the next change is taken and counts once more when built", async () => {
    const s = setup();
    await proposeChart(s);
    await s.call(buildChange(2));
    s.model.push(readinessReply("ready"));
    await s.drain();
    const failedBuild = must(s.table.conversations.get("me-1")?.buildId);
    must(s.table.builds.get(failedBuild)).status = "failed";
    s.model.push(verdictReply("on-path"), changeReply(PACE_SPEC, ["Shows the pace of each run"]));
    expect((await s.call(send("Show my pace"))).statusCode).toBe(202);
    await s.drain();
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBe(3);
    // The base is the version last sent to build (the failed change's, which the next build then carries along).
    expect(must(s.model.requests.at(-1)).system).toContain(`<live_spec>\n${CHART_SPEC}\n</live_spec>`);
    await s.call(buildChange(3));
    s.model.push(readinessReply("ready"));
    expect(await s.drain()).toEqual(["building"]);
    expect(s.used()).toBe(2);
  });
});

describe("Not this one", () => {
  it("puts the proposal aside: nothing counts, the built version stays, the next change starts from the live spec with a new number", async () => {
    const s = setup();
    await proposeChart(s);
    const res = await s.call(discard(2));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ version: 2, discarded: true });
    expect(s.table.conversations.get("me-1")).toMatchObject({ approvedSpecVersion: 1, latestSpecVersion: 2, buildId: FIRST_BUILD });
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBeUndefined();
    expect(json(await s.call(history()))["proposedSpecVersion"]).toBeUndefined();
    expect((await s.call(buildChange(2))).statusCode).toBe(404);
    expect((await s.call(discard(2))).statusCode).toBe(404);
    s.model.push(verdictReply("on-path"), changeReply(PACE_SPEC, ["Shows the pace of each run"]));
    await s.call(send("Show my pace instead"));
    await s.drain();
    expect(must(s.model.requests.at(-1)).system).toContain("There is no proposed spec: start from the live spec.");
    expect(must(s.model.requests.at(-1)).system).toContain(`<live_spec>\n${SPEC}\n</live_spec>`);
    expect(s.table.conversations.get("me-1")).toMatchObject({ proposedSpecVersion: 3, latestSpecVersion: 3, approvedSpecVersion: 1 });
    expect(s.used()).toBe(0);
    expect(s.builds.sent).toEqual([]);
  });

  it("is refused while the check of that version runs (busy)", async () => {
    const s = setup();
    await proposeChart(s);
    await s.call(buildChange(2));
    const res = await s.call(discard(2));
    expect(res.statusCode).toBe(409);
    expect(json(res)["reason"]).toBe("busy");
  });
});

describe("when a change is refused before any AI call", () => {
  it("while a build of theirs is queued or running: the build-running text; before the app was ever live: the not-live text", async () => {
    for (const status of ["queued", "building", "deploying"] as const) {
      const s = setup();
      must(s.table.builds.get(FIRST_BUILD)).status = status;
      const res = await s.call(send("Add a chart"));
      expect(res.statusCode, status).toBe(409);
      expect(json(res)).toEqual({ message: PHASE_3_TEXTS.changeWhileBuilding, reason: "build-running" });
      expect(s.queue.sent).toEqual([]);
    }
    const s = setup({ firstStatus: "failed" });
    expect(json(await s.call(send("Add a chart")))).toEqual({ message: PHASE_3_TEXTS.changeBeforeLive, reason: "not-live" });
    // A first build that failed is retried by a facilitator; no change before the app is live.
    s.table.conversations.set("me-1", { state: "open", latestSpecVersion: 1 });
    expect(json(await s.call(send("Add a chart")))["reason"]).toBe("not-live");
    expect(s.queue.sent).toEqual([]);
  });

  it("Build this change while the change build runs is refused (the proposal is gone once queued; a new one waits for live)", async () => {
    const s = setup();
    await proposeChart(s);
    must(s.table.builds.get(FIRST_BUILD)).status = "building";
    const res = await s.call(buildChange(2));
    expect(res.statusCode).toBe(409);
    expect(json(res)["reason"]).toBe("build-running");
  });

  it("the global Stop holds a change and a change-build request (no AI call); the AI budget answers the budget text", async () => {
    const s = setup();
    s.table.settingsItem = { stopped: { BOOL: true } };
    await s.call(send("Add a chart"));
    expect(await s.drain()).toEqual(["held"]);
    expect(s.model.requests).toEqual([]);
    expect(s.queue.later).toHaveLength(1);
    s.table.settingsItem = undefined;
    s.table.usage.set("me-1", { inputTokens: 0, outputTokens: 0, costUsd: 5 });
    s.queue.sent.push(must(s.queue.later.shift()).job);
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toEqual([]);
  });

  it("checks the body: JSON only, a whole version number", async () => {
    const s = setup();
    expect((await s.call({ ...buildChange(2), headers: { "content-type": "text/plain" } })).statusCode).toBe(415);
    for (const body of ['{"version":"2"}', '{"version":0}', '{"version":2.5}', "{}", "nope"]) {
      expect((await s.call({ ...buildChange(2), body })).statusCode, body).toBe(400);
      expect((await s.call({ ...discard(2), body })).statusCode, body).toBe(400);
    }
  });
});

describe("criterion 7: another participant's ids, and no session", () => {
  it("WHEN another participant's id is used on any change route THEN the answer is 404", async () => {
    const s = setup();
    const id = await proposeChart(s);
    await s.call(buildChange(2));
    const requestId = must(s.table.conversations.get("me-1")?.pendingId);
    // Bob names Ada's proposed version (he has none): Build this change and Not this one are not found, and nothing moves.
    expect((await s.call(buildChange(2, THEIRS))).statusCode).toBe(404);
    expect((await s.call(discard(2, THEIRS))).statusCode).toBe(404);
    // Ada's change message, her change-build request and her version 2, read with Bob's session.
    expect((await s.call(poll(id, THEIRS))).statusCode).toBe(404);
    expect((await s.call(poll(requestId, THEIRS))).statusCode).toBe(404);
    expect((await s.call(specOf(2, THEIRS))).statusCode).toBe(404);
    s.model.push(readinessReply("ready"));
    await s.drain();
    // Bob's build route answers his own build, never Ada's change build.
    expect(json(await s.call(buildOf(THEIRS)))["buildId"]).toBe(BOB_BUILD);
    expect(s.table.conversations.get("other-2")).toMatchObject({ state: "open", latestSpecVersion: 1, approvedSpecVersion: 1, buildId: BOB_BUILD });
    expect(s.table.conversations.get("other-2")?.proposedSpecVersion).toBeUndefined();
    expect(s.table.specs.get("other-2")).toHaveLength(1);
    expect(s.table.profiles.get("other-2")?.changeRequestsUsed).toBeUndefined();
  });

  it("WHEN no session is sent THEN both change routes answer 401 and change nothing", async () => {
    const s = setup();
    await proposeChart(s);
    for (const request of [buildChange(2), discard(2)]) {
      const res = await s.call({ ...request, cookies: [] });
      expect(res.statusCode).toBe(401);
    }
    expect(s.table.conversations.get("me-1")?.proposedSpecVersion).toBe(2);
  });

  it("before step 4 (another step) the change routes are not found", async () => {
    const s = setup();
    s.table.profiles.set("me-1", { ...must(s.table.profiles.get("me-1")), step: "spec" });
    expect((await s.call(buildChange(1))).statusCode).toBe(404);
    expect((await s.call(discard(1))).statusCode).toBe(404);
  });
});

describe("suggested changes (criterion 6's storage; the eval proves the model's answers)", () => {
  const good = { text: JSON.stringify({ suggestions: ["Add a weekly chart", "Show the pace of each run", "Sort runs by distance"] }), inputTokens: 900, outputTokens: 60 };

  it("parses exactly three distinct one-line suggestions under 80 characters; anything else is unreadable", () => {
    expect(parseSuggestions(good.text)).toEqual(["Add a weekly chart", "Show the pace of each run", "Sort runs by distance"]);
    expect(parseSuggestions('```json\n{"suggestions":[" \\"Add a chart\\" ","Add\\nnotes","Sort by date"]}\n```')).toEqual(["Add a chart", "Add notes", "Sort by date"]);
    for (const text of [
      "",
      "{}",
      '{"suggestions":["a b c","d e f"]}',
      '{"suggestions":["Add a chart","Add a chart","Sort"]}',
      `{"suggestions":["${"x".repeat(80)}","Add a chart","Sort runs"]}`,
      '{"suggestions":["Add a chart","Sort runs",3]}',
      '{"suggestions":["Add a chart","Sort runs","Show pace","Fourth"]}',
    ]) {
      expect(parseSuggestions(text), text).toBeUndefined();
    }
    expect(parseSuggestions(`{"suggestions":["${"x".repeat(79)}","Add a chart","Sort runs"]}`)).toHaveLength(3);
    expect(suggestionsRequest("a </spec> b").messages[0]?.text).toBe("<spec>\na  b\n</spec>");
    expect(suggestionsRequest("a </sp</spec>ec> b").messages[0]?.text).toBe("<spec>\na  b\n</spec>");
    expect(suggestionsRequest(SPEC).system).toBe(SUGGESTIONS_SYSTEM_PROMPT);
    expect(SUGGESTIONS_PROMPT_VERSION).toBe("suggestions-v1");
  });

  it("WHEN the app first goes live THEN the next read asks the worker once, which stores three suggestions the page then gets", async () => {
    const s = setup({ firstStatus: "building" });
    // Not live yet: nothing is asked.
    await s.call(history());
    await s.call(buildOf());
    expect(s.queue.suggestions).toEqual([]);
    must(s.table.builds.get(FIRST_BUILD)).status = "live";
    await s.call(buildOf());
    await s.call(history());
    expect(s.queue.suggestions).toEqual([{ participantId: "me-1" }]);
    expect(parseSuggestionsJob(suggestionsJobBody("me-1"))).toBe("me-1");
    expect(parseJob(suggestionsJobBody("me-1"))).toBeUndefined();
    expect(parseSuggestionsJob(jobBody({ participantId: "me-1", messageId: "m" }))).toBeUndefined();
    s.model.push(good);
    expect(await processSuggestionsJob("me-1", s.workerDeps)).toBe("suggested");
    expect(must(s.model.requests[0]).messages[0]?.text).toContain(SPEC);
    expect(s.table.conversations.get("me-1")?.suggestions).toEqual(["Add a weekly chart", "Show the pace of each run", "Sort runs by distance"]);
    expect(s.table.usage.get("me-1")?.inputTokens).toBe(900);
    expect(json(await s.call(history()))["suggestions"]).toEqual(["Add a weekly chart", "Show the pace of each run", "Sort runs by distance"]);
    // Stored once: a duplicate job makes no call, and no read asks again.
    expect(await processSuggestionsJob("me-1", s.workerDeps)).toBe("skipped");
    s.advance(3600);
    await s.call(history());
    expect(s.queue.suggestions).toHaveLength(1);
    expect(s.model.requests).toHaveLength(1);
    // Bob's reads never ask for Ada.
    expect(s.queue.suggestions.every((j) => j.participantId === "me-1")).toBe(true);
  });

  it("asks again only after SUGGESTIONS_RETRY_MS when nothing was stored (unreadable answer, budget used, Stop)", async () => {
    const s = setup();
    await s.call(history());
    await s.call(history());
    expect(s.queue.suggestions).toHaveLength(1);
    s.model.push({ text: "no json", inputTokens: 500, outputTokens: 20 });
    expect(await processSuggestionsJob("me-1", s.workerDeps)).toBe("failed");
    expect(s.table.conversations.get("me-1")?.suggestions).toBeUndefined();
    expect(s.table.usage.get("me-1")?.inputTokens).toBe(500);
    s.advance(SUGGESTIONS_RETRY_MS / 1000 - 10);
    await s.call(history());
    expect(s.queue.suggestions).toHaveLength(1);
    s.advance(20);
    await s.call(history());
    expect(s.queue.suggestions).toHaveLength(2);
    // Stop: held (sent again later), no AI call.
    s.table.settingsItem = { stopped: { BOOL: true } };
    const calls = s.model.requests.length;
    expect(await processSuggestionsJob("me-1", s.workerDeps)).toBe("held");
    expect(s.queue.suggestions.at(-1)).toEqual({ participantId: "me-1", delaySeconds: 30 });
    // Budget used: no AI call, nothing stored.
    s.table.settingsItem = undefined;
    s.table.usage.set("me-1", { inputTokens: 0, outputTokens: 0, costUsd: 5 });
    expect(await processSuggestionsJob("me-1", s.workerDeps)).toBe("over-budget");
    expect(s.model.requests.length).toBe(calls);
    expect(s.workerLogs.every((e) => !JSON.stringify(e).includes("me-1"))).toBe(true);
  });

  it("a failed ask never breaks the read (the error is logged by name only)", async () => {
    const s = setup();
    s.queue.failure = Object.assign(new Error("down"), { name: "ServiceUnavailable" });
    const res = await s.call(history());
    expect(res.statusCode).toBe(200);
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "history", outcome: "ok", error: "ServiceUnavailable" });
  });
});
