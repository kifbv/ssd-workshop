// Ticket 3.3 (AI budget enforced): the AI worker checks the participant's spend against the budget plus their extra
// budget before each AI call and before a build is queued, against the in-memory table, model and queues; the
// conversation answers `budgetLeft`; a running build is never stopped.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeTable } from "../fakes.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { BUDGET_REPLY } from "../workshop/budget.js";
import { APPROVE_ROUTE, BUILD_ROUTE, HISTORY_ROUTE, handleConversationRequest, POLL_ROUTE, SEND_ROUTE, STEP_ROUTE, type ConversationDeps } from "./conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, readinessReply, verdictReply } from "./fakes.js";
import { costOf } from "./model.js";
import { READINESS_REQUEST } from "./readiness.js";
import { WRITE_SPEC_REQUEST } from "./spec.js";
import { buildIdFor, jobBody, parseJob } from "./state.js";
import { processJob, type WorkerDeps, type WorkerLogEntry } from "./worker.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const START = new Date("2026-11-25T10:00:00.000Z");
const START_S = START.getTime() / 1000;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const ADA = token(1);
const BOB = token(2);
const SPEC = "# Run log\n\n## What it does\nA log of your runs.";
const ANSWER = { text: "Who is it for?", inputTokens: 1000, outputTokens: 100 };
const spend = (costUsd: number) => ({ inputTokens: 1, outputTokens: 1, costUsd });

/** Ada and Bob at `step` (with one spec version from step 2 on); Bob has spent $1.23 and has $2 extra. */
function setup(step: "clarify" | "spec" = "clarify") {
  const table = new FakeConversationTable();
  table.addParticipant("ada-1", "Ada-Runner", ADA, START_S + 3600, step);
  table.addParticipant("bob-2", "Bob", BOB, START_S + 3600, step);
  for (const id of ["ada-1", "bob-2"]) {
    table.conversations.set(id, { state: "open", ...(step === "spec" ? { latestSpecVersion: 1 } : {}) });
    if (step === "spec") table.specs.set(id, [{ version: 1, text: SPEC, messageId: "m", createdAt: "x" }]);
  }
  table.usage.set("bob-2", spend(1.23));
  table.profiles.set("bob-2", { ...must(table.profiles.get("bob-2")), extraBudget: 2 });
  const queue = new FakeQueue();
  const builds = new FakeBuildQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const workerLogs: WorkerLogEntry[] = [];
  const deps: ConversationDeps = { sessions: table, store: table, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, ++counter), log: () => undefined };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, builds, now: () => clock, log: (e) => workerLogs.push(e), sleep: async () => undefined };
  const delivered: string[] = [];
  const drain = async () => {
    const outcomes = [];
    while (queue.sent.length > 0) {
      const body = jobBody(must(queue.sent.shift()));
      delivered.push(body);
      outcomes.push(await processJob(parseJob(body), workerDeps));
    }
    clock = new Date(clock.getTime() + 5000);
    return outcomes;
  };
  const call = (request: HttpRequest) => handleConversationRequest(request, deps);
  /** Ada's spend so far. */
  const setSpend = (costUsd: number) => table.usage.set("ada-1", spend(costUsd));
  const spent = () => table.usage.get("ada-1")?.costUsd ?? 0;
  const redeliver = () => processJob(parseJob(must(delivered.at(-1))), workerDeps);
  return { table, queue, builds, model, workerLogs, drain, call, setSpend, spent, redeliver };
}

const cookie = (t: string) => [`${SESSION_COOKIE}=${t}`];
const post = (routeKey: string, body: unknown, t: string = ADA): HttpRequest => ({
  routeKey,
  cookies: cookie(t),
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const get = (routeKey: string, t: string = ADA, id?: string): HttpRequest => ({ routeKey, cookies: cookie(t), ...(id === undefined ? {} : { pathParameters: { id } }) });
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;

describe("ticket 3.3 criterion 1: at or over the budget, no AI call and no build", () => {
  it("WHEN spend equals the $5 budget THEN a new message gets the budget answer and no Bedrock call is made", async () => {
    const s = setup();
    s.setSpend(5);
    const sent = await s.call(post(SEND_ROUTE, { text: "a run tracker for me" }));
    expect(sent.statusCode).toBe(202);
    const id = json(sent)["id"] as string;
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(0);
    expect(s.builds.sent).toEqual([]);
    // The page's polling flow: the message ends failed (send again later) with the budget text as its reply.
    expect(json(await s.call(get(POLL_ROUTE, ADA, id)))).toEqual({ id, status: "failed", reply: BUDGET_REPLY });
    expect(s.table.replies.get("ada-1")?.get(id)).toMatchObject({ text: BUDGET_REPLY, kind: "budget" });
    expect(s.table.conversations.get("ada-1")?.pendingId).toBeUndefined();
    expect(s.spent()).toBe(5);
    const history = json(await s.call(get(HISTORY_ROUTE)));
    expect(history["budgetLeft"]).toBe(0);
    expect(history["messages"]).toEqual([
      { id, author: "participant", text: "a run tracker for me", step: "clarify", status: "failed" },
      { id: `${id}-r`, author: "assistant", text: BUDGET_REPLY, step: "clarify" },
    ]);
    expect(s.workerLogs).toEqual([{ event: "ai-worker", outcome: "over-budget" }]);
  });

  it("WHEN spend is over the budget plus the extra budget THEN the same, and a budget reply never goes back to the model as history", async () => {
    const s = setup();
    s.table.profiles.set("ada-1", { ...must(s.table.profiles.get("ada-1")), extraBudget: 2 });
    s.setSpend(7.4);
    await s.call(post(SEND_ROUTE, { text: "a run tracker" }));
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(0);
    expect(await s.table.getHistory("ada-1", "zzzz")).toEqual([]);
  });

  it("WHEN the admin set the budget to $0 THEN a message of someone without extra budget does not reach the AI", async () => {
    const s = setup();
    s.table.settingsItem = { aiBudgetUsd: { N: "0" } };
    await s.call(post(SEND_ROUTE, { text: "a run tracker" }));
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(0);
    expect(json(await s.call(get(HISTORY_ROUTE)))["budgetLeft"]).toBe(0);
    // Bob's $2 extra budget still lets him use $2 (he has spent $1.23).
    expect(json(await s.call(get(HISTORY_ROUTE, BOB)))["budgetLeft"]).toBe(0.77);
  });

  it("WHEN the admin's budget is above the spend THEN the message is answered (the SETTINGS item is read)", async () => {
    const s = setup();
    s.setSpend(5);
    s.table.settingsItem = { aiBudgetUsd: { N: "10" } };
    await s.call(post(SEND_ROUTE, { text: "a run tracker" }));
    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.drain()).toEqual(["done"]);
    expect(json(await s.call(get(HISTORY_ROUTE)))["budgetLeft"]).toBe(4.99);
  });

  it("WHEN a facilitator approved a flagged message but the budget is used meanwhile THEN it gets the budget answer, not the AI", async () => {
    const s = setup();
    const id = json(await s.call(post(SEND_ROUTE, { text: "an app that reads my email" })))["id"] as string;
    s.model.push(verdictReply("flag"));
    expect(await s.drain()).toEqual(["flagged"]);
    s.setSpend(5.01);
    expect(await s.table.approve("ada-1", id, "an app that reads my email", START_S + 30)).toBe(true);
    s.queue.sent.push({ participantId: "ada-1", messageId: id });
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(1);
    expect(s.table.replies.get("ada-1")?.get(id)?.text).toBe(BUDGET_REPLY);
  });

  it("WHEN the guardrail call uses the last of the budget THEN the answer call is not made, and the guardrail's tokens are counted", async () => {
    const s = setup();
    const guardrailCost = costOf(400, 30);
    s.setSpend(5 - guardrailCost / 2);
    const id = json(await s.call(post(SEND_ROUTE, { text: "a run tracker" })))["id"] as string;
    s.model.push(verdictReply("on-path"));
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(1);
    expect(s.spent()).toBeCloseTo(5 + guardrailCost / 2, 10);
    expect(s.table.messages.get("ada-1")?.get(id)).toMatchObject({ status: "failed", verdict: "on-path" });
    expect(s.table.replies.get("ada-1")?.get(id)).toMatchObject({ text: BUDGET_REPLY, kind: "budget" });
    expect(s.workerLogs).toEqual([{ event: "ai-worker", outcome: "over-budget", verdict: "on-path" }]);
  });

  it("WHEN Write my spec is pressed over budget THEN the spec is not written and the button is offered again", async () => {
    const s = setup("spec");
    s.table.conversations.set("ada-1", { state: "open" });
    s.table.specs.delete("ada-1");
    s.setSpend(5);
    const moved = json(await s.call(post(STEP_ROUTE, { step: "spec" })));
    const id = must(moved["id"] as string | undefined);
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(0);
    expect(s.table.messages.get("ada-1")?.get(id)).toMatchObject({ text: WRITE_SPEC_REQUEST, status: "failed" });
    // Nothing in flight and still no spec: Write my spec asks again.
    expect(s.table.conversations.get("ada-1")).toEqual({ state: "open" });
  });

  it("WHEN Approve spec is pressed over budget THEN no readiness call is made, no build is queued, and the spec can be approved again later", async () => {
    const s = setup("spec");
    s.setSpend(5);
    const approved = json(await s.call(post(APPROVE_ROUTE, { version: 1 })));
    const id = must(approved["id"] as string | undefined);
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(0);
    expect(s.builds.sent).toEqual([]);
    expect(s.table.builds.size).toBe(0);
    expect(s.table.profiles.get("ada-1")?.step).toBe("spec");
    expect(s.table.conversations.get("ada-1")?.approvedSpecVersion).toBeUndefined();
    expect(s.table.messages.get("ada-1")?.get(id)).toMatchObject({ text: READINESS_REQUEST, status: "failed" });
    expect(s.table.replies.get("ada-1")?.get(id)).toMatchObject({ text: BUDGET_REPLY, kind: "budget" });
    expect((await s.call(get(BUILD_ROUTE))).statusCode).toBe(404);
  });

  it("WHEN the readiness call itself uses the last of the budget THEN no build is queued and its tokens are counted", async () => {
    const s = setup("spec");
    const checkCost = costOf(900, 60);
    s.setSpend(5 - checkCost / 2);
    await s.call(post(APPROVE_ROUTE, { version: 1 }));
    s.model.push(readinessReply("ready"));
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(s.model.requests).toHaveLength(1);
    expect(s.builds.sent).toEqual([]);
    expect(s.table.builds.size).toBe(0);
    expect(s.table.profiles.get("ada-1")?.step).toBe("spec");
    expect(s.spent()).toBeCloseTo(5 + checkCost / 2, 10);
  });

  it("WHEN spend is just under the budget THEN the readiness check runs and the build is queued", async () => {
    const s = setup("spec");
    s.setSpend(4.5);
    await s.call(post(APPROVE_ROUTE, { version: 1 }));
    s.model.push(readinessReply("ready"));
    expect(await s.drain()).toEqual(["building"]);
    expect(s.builds.sent).toHaveLength(1);
  });
});

describe("ticket 3.3 criterion 2: extra budget from a facilitator", () => {
  it("WHEN a facilitator adds $2 extra budget THEN the next message is answered", async () => {
    const s = setup();
    s.setSpend(5.3);
    await s.call(post(SEND_ROUTE, { text: "a run tracker" }));
    expect(await s.drain()).toEqual(["over-budget"]);
    expect(json(await s.call(get(HISTORY_ROUTE)))["budgetLeft"]).toBe(0);

    // Ticket 3.10's "Add $2" sets this field; here the fake profile gets it directly.
    s.table.profiles.set("ada-1", { ...must(s.table.profiles.get("ada-1")), extraBudget: 2 });
    expect(json(await s.call(get(HISTORY_ROUTE)))["budgetLeft"]).toBe(1.7);
    const id = json(await s.call(post(SEND_ROUTE, { text: "a run tracker, just for me" })))["id"] as string;
    s.model.push(verdictReply("on-path"), ANSWER);
    expect(await s.drain()).toEqual(["done"]);
    expect(s.model.requests).toHaveLength(2);
    expect(json(await s.call(get(POLL_ROUTE, ADA, id)))).toEqual({ id, status: "done", reply: ANSWER.text });
  });
});

describe("ticket 3.3 criterion 3: a running build always finishes", () => {
  it("WHEN a build is running as the cap is passed THEN it is not stopped, and a redelivered launch is sent again", async () => {
    const s = setup("spec");
    s.setSpend(4.8);
    await s.call(post(APPROVE_ROUTE, { version: 1 }));
    s.model.push(readinessReply("ready"));
    expect(await s.drain()).toEqual(["building"]);
    const buildId = must(s.table.conversations.get("ada-1")?.buildId);
    const build = must(s.table.builds.get(buildId));
    build.status = "building";

    // The builder adds the coding agent's $1.60 (as platform/builder/runner.ts does): spend passes the cap.
    await s.table.addUsage("ada-1", spend(1.6));
    expect(s.spent()).toBeGreaterThan(5);
    expect(json(await s.call(get(HISTORY_ROUTE)))["budgetLeft"]).toBe(0);

    // SQS delivers the readiness job again: the build id is sent again (no new check), the build keeps running.
    expect(await s.redeliver()).toBe("resent");
    expect(s.builds.sent).toEqual([
      { buildId, participantId: "ada-1" },
      { buildId, participantId: "ada-1" },
    ]);
    expect(buildIdFor(must(s.table.conversations.get("ada-1")?.buildId))).toBe(buildId);
    expect(s.table.builds.get(buildId)?.status).toBe("building");
    expect(s.table.profiles.get("ada-1")?.step).toBe("building");
    expect(json(await s.call(get(BUILD_ROUTE)))).toMatchObject({ buildId, status: "building" });
  });

  it("the launcher, the builder and the deployer never read the budget, so nothing stops a queued or running build", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const folders = [join(root, "api", "launcher"), join(root, "api", "deploy"), join(root, "builder")];
    const handlers = ["builds-launcher.ts", "deployer.ts"].map((f) => join(root, "api", "handlers", f));
    const files = [...folders.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(d, f))), ...handlers];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/getBudgetFacts|budgetOf|overBudget|workshop\/budget/);
  });
});

describe("ticket 3.3 criterion 4: the budget answer holds nobody else's amount and no address", () => {
  it("WHEN a test reads the budget answer THEN it is the fixed text, and Ada's answers hold no amount of Bob's and no email", async () => {
    const s = setup();
    s.setSpend(6);
    const id = json(await s.call(post(SEND_ROUTE, { text: "a run tracker" })))["id"] as string;
    await s.drain();
    const answers = [await s.call(get(POLL_ROUTE, ADA, id)), await s.call(get(HISTORY_ROUTE))].map((r) => must(r.body));
    expect(json(await s.call(get(POLL_ROUTE, ADA, id)))["reply"]).toBe(BUDGET_REPLY);
    const bob = await s.table.getBudgetFacts("bob-2");
    expect(bob.spentUsd).toBe(1.23);
    for (const body of [...answers, JSON.stringify(s.table.replies.get("ada-1")?.get(id)), JSON.stringify(s.workerLogs)]) {
      expect(body).not.toContain("@");
      for (const email of [FakeTable.emailOf("ada-1"), FakeTable.emailOf("bob-2")]) expect(body).not.toContain(email);
      // Bob's spend and what he has left; no dollar amount at all in the text.
      for (const amount of ["1.23", "5.77", "$"]) expect(body).not.toContain(amount);
      expect(body).not.toContain("bob-2");
    }
    // Ada's own answer carries only her own budget left.
    expect(json(await s.call(get(HISTORY_ROUTE)))["budgetLeft"]).toBe(0);
    expect(json(await s.call(get(HISTORY_ROUTE, BOB)))["budgetLeft"]).toBe(5.77);
  });
});
