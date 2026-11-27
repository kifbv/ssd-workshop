// Ticket 3.15, Rebuild with my edits: step 4's editor sends the caller's edited spec; the route stores it (cleaned) beside
// the marked request, and the AI worker runs Rebuild from my repository's pipeline on it: the same-spec check, the shape
// check, the guardrail, the readiness check, then one transaction that stores the next version, counts the change and
// queues the change build. Run end to end on the in-memory table, queue and model (no GitHub: nothing is read there).
import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { BUDGET_REPLY } from "../workshop/budget.js";
import { changesUsedText, EDIT_REQUEST, EDIT_WHAT_CHANGES, editNotReadyText, PHASE_3_TEXTS } from "../workshop/texts.js";
import { CHANGE_EDIT_ROUTE, EDIT_BODY_LIMITS, HISTORY_ROUTE, handleConversationRequest, POLL_ROUTE, type ConversationDeps } from "./conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, readinessReply, verdictReply } from "./fakes.js";
import { declineReply, GUARDRAIL_SYSTEM_PROMPT } from "./guardrail.js";
import { READINESS_SYSTEM_PROMPT } from "./readiness.js";
import { isEditRequest, isRebuildRequest } from "./rebuild.js";
import { MAX_SPEC_CHARS } from "./spec.js";
import { buildIdFor, jobBody, parseJob } from "./state.js";
import { processJob, type WorkerDeps, type WorkerLogEntry } from "./worker.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const START = new Date("2026-11-26T10:00:00.000Z");
const START_S = START.getTime() / 1000;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const MINE = token(1);
const THEIRS = token(2);
const EARLY = token(3);
const FIRST_BUILD = "2026-11-26T09-00-00-000Z-0101010101010101";
const BOB_BUILD = "2026-11-26T09-00-00-000Z-0202020202020202";

/** The live spec as stored (version 1 for both participants). */
const SPEC = `# Run log

\`\`\`mermaid
flowchart TD
  home[Home] -->|add a run| add[Add a run]
\`\`\`

## What it does
A log of your runs.

## Screens
- Home: this week's total and the list of runs.

## Data it keeps
- Runs: date, distance in km and time.`;
const EDITED = SPEC.replace("- Home: this week's total and the list of runs.", "- Home: this week's total and the list of runs.\n- Chart: the distance run each week.");
/** Bob's own live spec: another app. */
const BOB_SPEC = SPEC.replace("# Run log", "# Book list");

/** Ada (step 4, live, spec 1), Bob (the same, his own spec) and Cleo (still at step 2). */
function setup(options: { used?: number; firstStatus?: "live" | "failed" | "building" } = {}) {
  const table = new FakeConversationTable();
  table.addParticipant("me-1", "Ada-Runner", MINE, START_S + 3600, "building");
  table.addParticipant("other-2", "Bob", THEIRS, START_S + 3600, "building");
  table.addParticipant("early-3", "Cleo", EARLY, START_S + 3600, "spec");
  for (const [id, buildId, nickname, text] of [
    ["me-1", FIRST_BUILD, "Ada-Runner", SPEC],
    ["other-2", BOB_BUILD, "Bob", BOB_SPEC],
  ] as const) {
    table.conversations.set(id, { state: "open", latestSpecVersion: 1, approvedSpecVersion: 1, buildId });
    table.specs.set(id, [{ version: 1, text, messageId: "m", createdAt: "x", approvedAt: "x" }]);
    table.builds.set(buildId, { buildId, nickname, participantId: id, status: "live", createdAt: "x", updatedAt: "x" });
  }
  if (options.used !== undefined) table.profiles.set("me-1", { ...must(table.profiles.get("me-1")), changeRequestsUsed: options.used });
  if (options.firstStatus !== undefined) must(table.builds.get(FIRST_BUILD)).status = options.firstStatus;
  const queue = new FakeQueue();
  const builds = new FakeBuildQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const logs: unknown[] = [];
  const workerLogs: WorkerLogEntry[] = [];
  const deps: ConversationDeps = { sessions: table, store: table, editLinks: table.appTokens, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, ++counter), log: (e) => logs.push(e) };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, builds, held: queue, now: () => clock, log: (e) => workerLogs.push(e), sleep: async () => undefined };
  const aiDelivered: string[] = [];
  /** Runs the AI worker on every job its queue holds, in order. */
  const drain = async () => {
    const outcomes: string[] = [];
    while (queue.sent.length > 0) {
      const body = jobBody(must(queue.sent.shift()));
      aiDelivered.push(body);
      outcomes.push(await processJob(parseJob(body), workerDeps).catch((e: unknown) => `threw ${(e as Error).name}`));
    }
    clock = new Date(clock.getTime() + 5000);
    return outcomes;
  };
  const call = (request: HttpRequest) => handleConversationRequest(request, deps);
  const used = (id = "me-1") => table.profiles.get(id)?.changeRequestsUsed ?? 0;
  return { table, queue, builds, model, logs, workerLogs, deps, workerDeps, drain, call, used, aiDelivered };
}

const cookie = (t: string) => [`${SESSION_COOKIE}=${t}`];
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;
const edit = (text: string, options: { token?: string; version?: number; body?: string; contentType?: string } = {}): HttpRequest => ({
  routeKey: CHANGE_EDIT_ROUTE,
  ...(options.token === "" ? {} : { cookies: cookie(options.token ?? MINE) }),
  headers: { "content-type": options.contentType ?? "application/json" },
  body: options.body ?? JSON.stringify({ version: options.version ?? 1, text }),
});
const poll = (id: string, t: string = MINE): HttpRequest => ({ routeKey: POLL_ROUTE, cookies: cookie(t), pathParameters: { id } });

async function press(s: ReturnType<typeof setup>, text: string = EDITED): Promise<string> {
  const res = await s.call(edit(text));
  expect(res.statusCode).toBe(202);
  return json(res)["id"] as string;
}

async function replyOf(s: ReturnType<typeof setup>, id: string, t: string = MINE): Promise<{ status: unknown; reply: unknown }> {
  const body = json(await s.call(poll(id, t)));
  return { status: body["status"], reply: body["reply"] };
}

/** Nothing was queued, counted or stored as a new version for Ada. */
function nothingQueued(s: ReturnType<typeof setup>): void {
  expect(s.builds.sent).toEqual([]);
  expect(s.used()).toBe(0);
  expect(s.table.specs.get("me-1")?.map((v) => v.version)).toEqual([1]);
  expect(s.table.conversations.get("me-1")).toMatchObject({ buildId: FIRST_BUILD, approvedSpecVersion: 1 });
  expect(s.table.conversations.get("me-1")?.pendingId).toBeUndefined();
}

describe("Rebuild with my edits (ticket 3.15)", () => {
  it("criterion 1: WHEN a participant edits the spec on the page and presses Rebuild with my edits THEN it is stored as a new spec version and a change build is queued that counts against the 5", async () => {
    const s = setup({ used: 2 });
    s.model.push(verdictReply("on-path"), readinessReply("ready"));
    const id = await press(s);
    // The request is the platform's text with its mark; the edited spec rides beside it, cleaned (one final line feed).
    const request = must(s.table.messages.get("me-1")?.get(id));
    expect(request).toMatchObject({ text: EDIT_REQUEST, request: "edit-spec", step: "building", editedSpec: `${EDITED}\n` });
    // No launcher round trip: the worker checks the text at once.
    expect(await s.drain()).toEqual(["building"]);
    expect(s.builds.specReads).toEqual([]);
    const buildId = buildIdFor(id);
    expect(s.builds.sent).toEqual([{ buildId, participantId: "me-1" }]);
    // Counted against the 5: 2 used before, 3 now.
    expect(s.used()).toBe(3);
    const version = must(s.table.specs.get("me-1")?.find((v) => v.version === 2));
    expect(version).toMatchObject({ text: `${EDITED}\n`, whatChanges: [EDIT_WHAT_CHANGES], messageId: id });
    // Approved by the press as the AI worker's own mark, tied to the request whose editedSpec it equals (the launcher's check).
    expect(version.rebuildApprovedAt).toBeDefined();
    expect(version.approvedAt).toBeUndefined();
    expect(version.text).toBe(request.editedSpec);
    expect(s.table.conversations.get("me-1")).toMatchObject({ buildId, approvedSpecVersion: 2, latestSpecVersion: 2 });
    expect(s.table.builds.get(buildId)).toMatchObject({ status: "queued", kind: "change", changeNumber: 3, specVersion: 2, nickname: "Ada-Runner", participantId: "me-1" });
    expect(await replyOf(s, id)).toEqual({ status: "done", reply: PHASE_3_TEXTS.editReady });
    // The guardrail and then the readiness check saw the edited spec.
    expect(s.model.requests.map((r) => r.system)).toEqual([GUARDRAIL_SYSTEM_PROMPT, READINESS_SYSTEM_PROMPT]);
    for (const r of s.model.requests) expect(r.messages[0]?.text).toContain("Chart: the distance run each week.");
    // The page's history shows the request (never the edited text) and the reply.
    const history = json(await s.call({ routeKey: HISTORY_ROUTE, cookies: cookie(MINE) }));
    expect((history["messages"] as { text: string }[]).map((m) => m.text)).toEqual([EDIT_REQUEST, PHASE_3_TEXTS.editReady]);
    // Logs hold no text, nickname or id.
    const logged = JSON.stringify([s.logs, s.workerLogs]);
    for (const secret of ["Chart", "Run log", "Ada-Runner", "me-1", id]) expect(logged).not.toContain(secret);
    expect(s.logs).toContainEqual({ event: "conversation", route: "change-edit", outcome: "accepted" });
  });

  it("criterion 2: WHEN the edited text is unchanged THEN the answer is \"Your spec has not changed.\" and nothing is queued (whatever the line endings or trailing spaces)", async () => {
    expect(PHASE_3_TEXTS.editUnchanged).toBe("Your spec has not changed.");
    for (const text of [SPEC, `${SPEC.replaceAll("\n", "  \r\n")}\r\n\r\n`, `${SPEC}\u200b`]) {
      const s = setup();
      const id = await press(s, text);
      expect(await s.drain()).toEqual(["unchanged"]);
      expect(await replyOf(s, id)).toEqual({ status: "done", reply: "Your spec has not changed." });
      expect(s.model.requests).toEqual([]);
      expect(s.table.usage.get("me-1")).toBeUndefined();
      nothingQueued(s);
    }
  });

  it("criterion 3: WHEN the edited text fails the shape check THEN its answer is shown, without an AI call, nothing queued and nothing counted", async () => {
    const noDiagram = EDITED.replace(/```mermaid[\s\S]*?```\n\n/, "");
    const otherSections = EDITED.replace("## Screens", "## Pages");
    const noTitle = EDITED.replace("# Run log\n", "");
    // Under 8,000 characters as typed, over once each address reads "[email removed]" (the route's cleaning): the shape
    // check's own length text.
    const lengthened = EDITED.replace("## Data it keeps", `- Contacts: ${Array.from({ length: 700 }, (_, i) => `a${i}@b.io`).join(" ")}\n\n## Data it keeps`);
    expect(Array.from(lengthened).length).toBeLessThanOrEqual(MAX_SPEC_CHARS);
    for (const [label, text, answer] of [
      ["no diagram", noDiagram, PHASE_3_TEXTS.editWrongShape],
      ["other sections", otherSections, PHASE_3_TEXTS.editWrongShape],
      ["no title", noTitle, PHASE_3_TEXTS.editWrongShape],
      ["lengthened by cleaning", lengthened, PHASE_3_TEXTS.editTooLong],
    ] as const) {
      const s = setup();
      const id = await press(s, text);
      expect(await s.drain(), label).toEqual(["refused"]);
      expect(await replyOf(s, id), label).toEqual({ status: "done", reply: answer });
      expect(s.model.requests, label).toEqual([]);
      expect(s.table.usage.get("me-1"), label).toBeUndefined();
      nothingQueued(s);
    }
    // The stored text never holds an address.
    const s = setup();
    const id = await press(s, lengthened);
    expect(s.table.messages.get("me-1")?.get(id)?.editedSpec).not.toMatch(/a1@b\.io/);
  });

  it("criterion 3: WHEN the edited text is off path (decline, flag) or not ready THEN the answer is shown, nothing is queued and nothing counts", async () => {
    const declined = setup();
    declined.model.push(verdictReply("decline", "a habit tracker"));
    const d = await press(declined);
    expect(await declined.drain()).toEqual(["declined"]);
    expect(await replyOf(declined, d)).toEqual({ status: "declined", reply: declineReply("a habit tracker") });
    nothingQueued(declined);

    const flagged = setup();
    flagged.model.push(verdictReply("flag"));
    const f = await press(flagged);
    expect(await flagged.drain()).toEqual(["declined"]);
    expect(await replyOf(flagged, f)).toEqual({ status: "declined", reply: PHASE_3_TEXTS.editFlagged });
    // Not left waiting for a facilitator: the participant can press again.
    expect(flagged.table.conversations.get("me-1")?.state).toBe("open");
    nothingQueued(flagged);

    const notReady = setup();
    notReady.model.push(verdictReply("on-path"), readinessReply("not-ready", ["Your spec needs a login: keep one shared log instead."]));
    const n = await press(notReady);
    expect(await notReady.drain()).toEqual(["not-ready"]);
    expect(await replyOf(notReady, n)).toEqual({ status: "done", reply: editNotReadyText(["Your spec needs a login: keep one shared log instead."]) });
    nothingQueued(notReady);

    // A model failure also queues nothing and says so.
    const failed = setup();
    failed.model.push(verdictReply("on-path"), new Error("Bedrock down"));
    const x = await press(failed);
    expect(await failed.drain()).toEqual(["failed"]);
    expect(await replyOf(failed, x)).toEqual({ status: "failed", reply: PHASE_3_TEXTS.editFailed });
    nothingQueued(failed);
  });

  it("criterion 4: WHEN the edited text is over 8,000 characters THEN it is refused without an AI call (nothing stored or queued)", async () => {
    const over = `${EDITED}\n${"x".repeat(MAX_SPEC_CHARS)}`;
    // Counted in characters (code points): 8,000 emoji are 8,000 characters, not 16,000.
    const emoji = "🏃".repeat(MAX_SPEC_CHARS);
    for (const [label, request] of [
      ["over 8,000", edit(over)],
      ["8,001 emoji", edit(`${emoji}🏃`)],
      ["a body too large to read", edit("", { body: JSON.stringify({ version: 1, text: "x".repeat(EDIT_BODY_LIMITS.maxBodyBytes) }) })],
    ] as const) {
      const s = setup();
      const res = await s.call(request);
      expect(res.statusCode, label).toBe(400);
      expect(json(res), label).toEqual({ message: PHASE_3_TEXTS.editTooLong, reason: "too-long" });
      expect(s.queue.sent, label).toEqual([]);
      expect(s.table.messages.get("me-1"), label).toBeUndefined();
      expect(await s.drain(), label).toEqual([]);
      expect(s.model.requests, label).toEqual([]);
      nothingQueued(s);
    }
    expect(PHASE_3_TEXTS.editTooLong).toContain("8,000 characters");
    // Exactly 8,000 characters is taken (then answered by the pipeline: here the shape check, still without an AI call).
    const s = setup();
    const id = await press(s, emoji);
    expect(await s.drain()).toEqual(["refused"]);
    expect(s.model.requests).toEqual([]);
    expect((await replyOf(s, id)).reply).toBe(PHASE_3_TEXTS.editTooLong);
  });

  it("criterion 5: WHEN another participant's session is used THEN only the caller's own spec can be edited (another's request or version: 404)", async () => {
    const s = setup();
    // Ada's live spec is version 2 now; Bob's is still 1.
    s.table.specs.get("me-1")?.push({ version: 2, text: SPEC, messageId: "m2", createdAt: "x", approvedAt: "x" });
    must(s.table.conversations.get("me-1")).approvedSpecVersion = 2;
    must(s.table.conversations.get("me-1")).latestSpecVersion = 2;
    const adaRes = await s.call(edit(EDITED, { version: 2 }));
    expect(adaRes.statusCode).toBe(202);
    const adas = json(adaRes)["id"] as string;
    // Bob cannot poll Ada's request, nor name Ada's live version: 404, nothing stored for him.
    expect((await s.call(poll(adas, THEIRS))).statusCode).toBe(404);
    const bobRes = await s.call(edit(EDITED, { token: THEIRS, version: 2 }));
    expect(bobRes.statusCode).toBe(404);
    expect(s.table.messages.get("other-2")).toBeUndefined();
    // A participant id in the body is ignored: Bob's press edits Bob's own spec, never Ada's.
    s.model.push(verdictReply("on-path"), readinessReply("ready"), verdictReply("on-path"), readinessReply("ready"));
    const bobOwn = await s.call(edit("", { token: THEIRS, body: JSON.stringify({ version: 1, text: BOB_SPEC.replace("A log of your runs.", "A list of books."), participantId: "me-1" }) }));
    expect(bobOwn.statusCode).toBe(202);
    expect(await s.drain()).toEqual(["building", "building"]);
    expect(s.table.specs.get("other-2")?.map((v) => v.text.split("\n")[0])).toEqual(["# Book list", "# Book list"]);
    expect(s.table.specs.get("me-1")?.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(must(s.table.specs.get("me-1")?.at(-1)).text).toBe(`${EDITED}\n`);
    expect(s.used("me-1")).toBe(1);
    expect(s.used("other-2")).toBe(1);
    // Cleo (step 2) has no step 4 yet: 404.
    expect((await s.call(edit(EDITED, { token: EARLY }))).statusCode).toBe(404);
  });

  it("answers 401 without a session, 415 without JSON, 400 for a bad body or an empty text, 404 for a stale version, and the change gate's 409s", async () => {
    const s = setup();
    expect((await s.call(edit(EDITED, { token: "" }))).statusCode).toBe(401);
    expect((await s.call(edit(EDITED, { contentType: "text/plain" }))).statusCode).toBe(415);
    for (const body of ["[1]", "{}", JSON.stringify({ version: 1 }), JSON.stringify({ text: EDITED }), JSON.stringify({ version: "1", text: EDITED }), JSON.stringify({ version: 1, text: 5 })]) {
      expect((await s.call(edit("", { body }))).statusCode, body).toBe(400);
    }
    const empty = await s.call(edit(" \r\n\u200b\t\n"));
    expect(empty.statusCode).toBe(400);
    expect(json(empty)["message"]).toBe(PHASE_3_TEXTS.editEmpty);
    // The editor opened an older live version (a rebuild meanwhile): 404, so it never rebuilds over the newer spec.
    expect((await s.call(edit(EDITED, { version: 2 }))).statusCode).toBe(404);
    expect(s.queue.sent).toEqual([]);
    for (const [options, reason] of [
      [{ firstStatus: "building" as const }, "build-running"],
      [{ used: 5 }, "no-changes-left"],
    ] as const) {
      const t = setup(options);
      const res = await t.call(edit(EDITED));
      expect(res.statusCode).toBe(409);
      expect(json(res)["reason"]).toBe(reason);
      expect(t.queue.sent).toEqual([]);
    }
    expect(json(await setup({ used: 5 }).call(edit(EDITED)))["message"]).toBe(changesUsedText(5));
    // Pressed twice: the second press waits for the first.
    expect((await s.call(edit(EDITED))).statusCode).toBe(202);
    expect((await s.call(edit(EDITED))).statusCode).toBe(409);
  });

  it("holds while the global Stop is on, stops at the budget and the cap without an AI call, and is built once when delivered again", async () => {
    const stopped = setup();
    stopped.table.settingsItem = { stopped: { BOOL: true } };
    await press(stopped);
    expect(await stopped.drain()).toEqual(["held"]);
    expect(stopped.queue.later).toHaveLength(1);
    expect(stopped.model.requests).toEqual([]);

    const broke = setup();
    broke.table.settingsItem = { aiBudgetUsd: { N: "0" } };
    const b = await press(broke);
    expect(await broke.drain()).toEqual(["over-budget"]);
    expect(await replyOf(broke, b)).toEqual({ status: "failed", reply: BUDGET_REPLY });
    expect(broke.model.requests).toEqual([]);

    const again = setup();
    again.model.push(verdictReply("on-path"), readinessReply("ready"));
    const id = await press(again);
    const job = must(again.queue.sent.at(0));
    expect(await again.drain()).toEqual(["building"]);
    expect(await processJob(job, again.workerDeps)).toBe("resent");
    expect(again.used()).toBe(1);
    expect(again.builds.sent).toEqual([
      { buildId: buildIdFor(id), participantId: "me-1" },
      { buildId: buildIdFor(id), participantId: "me-1" },
    ]);
    expect(again.model.requests).toHaveLength(2);
  });

  it("the worker acts on the edit only with its mark and exact text; a participant's own message with the same words is an ordinary change request", async () => {
    expect(isEditRequest({ step: "building", text: EDIT_REQUEST, request: "edit-spec" })).toBe(true);
    expect(isEditRequest({ step: "building", text: EDIT_REQUEST })).toBe(false);
    expect(isEditRequest({ step: "building", text: "hi", request: "edit-spec" })).toBe(false);
    expect(isEditRequest({ step: "spec", text: EDIT_REQUEST, request: "edit-spec" })).toBe(false);
    expect(isRebuildRequest({ step: "building", text: EDIT_REQUEST, request: "edit-spec" })).toBe(false);
    const s = setup();
    s.model.push(verdictReply("on-path"), { text: "Sure, what would you like to change?", inputTokens: 10, outputTokens: 10 });
    const res = await s.call({ routeKey: "POST /api/conversation/messages", cookies: cookie(MINE), headers: { "content-type": "application/json" }, body: JSON.stringify({ text: EDIT_REQUEST }) });
    expect(res.statusCode).toBe(202);
    expect(await s.drain()).toEqual(["done"]);
    expect(s.builds.sent).toEqual([]);
    // A marked request whose edited text went missing fails without an AI call.
    const t = setup();
    const id = await press(t);
    const stored = must(t.table.messages.get("me-1")?.get(id));
    delete stored.editedSpec;
    expect(await t.drain()).toEqual(["failed"]);
    expect(t.model.requests).toEqual([]);
    expect(await replyOf(t, id)).toEqual({ status: "failed", reply: PHASE_3_TEXTS.editFailed });
  });
});
