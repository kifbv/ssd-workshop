// Ticket 3.9, Rebuild from my repository: the route stores the marked request, the AI worker asks the launcher (the GitHub
// App key's only reader) to read SPEC.md on `main`, and then, on the read the launcher stored: no readable file, the same
// spec, the guardrail, the readiness check, or one transaction that stores the spec as a new version, counts the change
// and queues the change build. Run end to end on the in-memory table, queues, model and GitHub.
import { describe, expect, it } from "vitest";
import { parseGitHubSecret, type GitHubDeps } from "../github/app.js";
import { FakeGitHub, TEST_SECRET_TEXT } from "../github/fakes.js";
import { MAX_REPOSITORY_SPEC_BYTES, removeEmailAddresses } from "../github/repository.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { processSpecRead, type LauncherLogEntry, type SpecReadDeps } from "../launcher/launcher.js";
import { SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { BUDGET_REPLY } from "../workshop/budget.js";
import { changesUsedText, PHASE_3_TEXTS, REBUILD_REQUEST, REBUILD_WHAT_CHANGES, rebuildNotReadyText } from "../workshop/texts.js";
import { CHANGE_REBUILD_ROUTE, handleConversationRequest, POLL_ROUTE, type ConversationDeps } from "./conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, readinessReply, verdictReply } from "./fakes.js";
import { declineReply, GUARDRAIL_SYSTEM_PROMPT } from "./guardrail.js";
import { READINESS_SYSTEM_PROMPT } from "./readiness.js";
import { isRebuildRequest, sameSpec } from "./rebuild.js";
import { buildIdFor, jobBody, parseJob, parseSpecReadJob, specReadJobBody } from "./state.js";
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

/** The live spec as stored: with an email address the published SPEC.md shows as "[email removed]". */
const SPEC = `# Run log

\`\`\`mermaid
flowchart TD
  home[Home] -->|add a run| add[Add a run]
\`\`\`

## What it does
A log of your runs. Questions go to ada@example.org.

## Screens
- Home: this week's total and the list of runs.

## Data it keeps
- Runs: date, distance in km and time.`;
const EDITED = removeEmailAddresses(SPEC).replace("- Home: this week's total and the list of runs.", "- Home: this week's total and the list of runs.\n- Chart: the distance run each week.");

/** Ada (step 4, live, spec 1 built and published to her repository), Bob (the same) and Cleo (still at step 2). */
function setup(options: { repositorySpec?: string | Uint8Array; used?: number; firstStatus?: "live" | "failed" | "building" } = {}) {
  const table = new FakeConversationTable();
  table.addParticipant("me-1", "Ada-Runner", MINE, START_S + 3600, "building");
  table.addParticipant("other-2", "Bob", THEIRS, START_S + 3600, "building");
  table.addParticipant("early-3", "Cleo", EARLY, START_S + 3600, "spec");
  const github = new FakeGitHub(() => clock);
  for (const [id, buildId, nickname] of [
    ["me-1", FIRST_BUILD, "Ada-Runner"],
    ["other-2", BOB_BUILD, "Bob"],
  ] as const) {
    table.conversations.set(id, { state: "open", latestSpecVersion: 1, approvedSpecVersion: 1, buildId });
    table.specs.set(id, [{ version: 1, text: SPEC, messageId: "m", createdAt: "x", approvedAt: "x" }]);
    table.builds.set(buildId, { buildId, nickname, participantId: id, status: "live", createdAt: "x", updatedAt: "x" });
    github.addRepository(`ssd-${nickname.toLowerCase()}`);
    // As the builder publishes it: email-shaped text removed.
    github.seedCommit(`ssd-${nickname.toLowerCase()}`, { "SPEC.md": removeEmailAddresses(SPEC), "index.html": "<p>app</p>" }, "First");
  }
  if (options.repositorySpec !== undefined) github.seedCommit("ssd-ada-runner", { "SPEC.md": options.repositorySpec, "index.html": "<p>app</p>" }, "Edit SPEC.md");
  if (options.used !== undefined) table.profiles.set("me-1", { ...must(table.profiles.get("me-1")), changeRequestsUsed: options.used });
  if (options.firstStatus !== undefined) must(table.builds.get(FIRST_BUILD)).status = options.firstStatus;
  const queue = new FakeQueue();
  const builds = new FakeBuildQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const logs: unknown[] = [];
  const workerLogs: WorkerLogEntry[] = [];
  const launcherLogs: LauncherLogEntry[] = [];
  const deps: ConversationDeps = { sessions: table, store: table, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, ++counter), log: (e) => logs.push(e) };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, builds, held: queue, now: () => clock, log: (e) => workerLogs.push(e), sleep: async () => undefined };
  const githubDeps: GitHubDeps = { fetch: github.fetch, now: () => clock, log: () => undefined, sleep: async () => undefined };
  // The launcher's records over the same table (DynamoLaunchRecords reads and writes the same message item).
  const launcherDeps: SpecReadDeps = {
    records: {
      readRebuildRequest: async (participantId, messageId) => {
        const message = await table.getMessage(participantId, messageId);
        if (message === undefined || !isRebuildRequest(message)) return undefined;
        return { pending: message.status === "pending", read: message.repository !== undefined };
      },
      storeRepositoryRead: async (participantId, messageId, read) => table.storeRepositoryRead(participantId, messageId, read),
      readProfileNickname: async (participantId) => table.profiles.get(participantId)?.nickname,
    },
    credentials: async () => parseGitHubSecret(TEST_SECRET_TEXT),
    github: githubDeps,
    aiQueue: queue,
    now: () => clock,
    log: (e) => launcherLogs.push(e),
  };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  const aiDelivered: string[] = [];
  const readDelivered: string[] = [];
  /** Runs the AI worker and the launcher on every message their queues hold, in order, until both are empty. */
  const drain = async () => {
    const outcomes: string[] = [];
    while (queue.sent.length > 0 || builds.specReads.length > 0) {
      if (queue.sent.length > 0) {
        const body = jobBody(must(queue.sent.shift()));
        aiDelivered.push(body);
        outcomes.push(await processJob(parseJob(body), workerDeps).catch((e: unknown) => `threw ${(e as Error).name}`));
      } else {
        const body = specReadJobBody(must(builds.specReads.shift()));
        readDelivered.push(body);
        outcomes.push(`launcher ${await processSpecRead(body, launcherDeps)}`);
      }
    }
    advance(5);
    return outcomes;
  };
  const call = (request: HttpRequest) => handleConversationRequest(request, deps);
  const used = () => table.profiles.get("me-1")?.changeRequestsUsed ?? 0;
  /** GitHub calls that could change anything (every call but GETs and the token request). */
  const githubWrites = () => github.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/access_tokens"));
  return { table, github, queue, builds, model, logs, workerLogs, launcherLogs, deps, workerDeps, launcherDeps, advance, drain, call, used, githubWrites, aiDelivered, readDelivered };
}

const cookie = (t: string) => [`${SESSION_COOKIE}=${t}`];
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;
const rebuild = (t: string = MINE, body = "{}", contentType = "application/json"): HttpRequest => ({
  routeKey: CHANGE_REBUILD_ROUTE,
  ...(t === "" ? {} : { cookies: cookie(t) }),
  headers: { "content-type": contentType },
  body,
});
const poll = (id: string, t: string = MINE): HttpRequest => ({ routeKey: POLL_ROUTE, cookies: cookie(t), pathParameters: { id } });

async function press(s: ReturnType<typeof setup>): Promise<string> {
  const res = await s.call(rebuild());
  expect(res.statusCode).toBe(202);
  return json(res)["id"] as string;
}

async function replyOf(s: ReturnType<typeof setup>, id: string): Promise<{ status: unknown; reply: unknown }> {
  const body = json(await s.call(poll(id)));
  return { status: body["status"], reply: body["reply"] };
}

/** Nothing was queued, counted or stored as a new version. */
function nothingQueued(s: ReturnType<typeof setup>): void {
  expect(s.builds.sent).toEqual([]);
  expect(s.used()).toBe(0);
  expect(s.table.specs.get("me-1")?.map((v) => v.version)).toEqual([1]);
  expect(s.table.conversations.get("me-1")).toMatchObject({ buildId: FIRST_BUILD, approvedSpecVersion: 1 });
  expect(s.table.conversations.get("me-1")?.pendingId).toBeUndefined();
}

describe("Rebuild from my repository (ticket 3.9)", () => {
  it("WHEN SPEC.md on main differs from the stored spec THEN pressing the button stores it as a new spec version and queues a change build (GitHub fakes)", async () => {
    const s = setup({ repositorySpec: EDITED });
    s.model.push(verdictReply("on-path"), readinessReply("ready"));
    const id = await press(s);
    // The AI worker asks the launcher to read; the launcher reads, stores and hands the job back; the worker checks and builds.
    expect(await s.drain()).toEqual(["reading", "launcher read", "building"]);
    const buildId = buildIdFor(id);
    expect(s.builds.sent).toEqual([{ buildId, participantId: "me-1" }]);
    expect(s.used()).toBe(1);
    const version = must(s.table.specs.get("me-1")?.find((v) => v.version === 2));
    expect(version).toMatchObject({ text: `${EDITED}\n`, whatChanges: [REBUILD_WHAT_CHANGES] });
    expect(version.approvedAt).toBeDefined();
    expect(s.table.conversations.get("me-1")).toMatchObject({ buildId, approvedSpecVersion: 2, latestSpecVersion: 2 });
    expect(s.table.builds.get(buildId)).toMatchObject({ status: "queued", kind: "change", changeNumber: 1, specVersion: 2, nickname: "Ada-Runner", participantId: "me-1" });
    expect(await replyOf(s, id)).toEqual({ status: "done", reply: PHASE_3_TEXTS.rebuildReady });
    // The guardrail and then the readiness check saw the repository's spec.
    expect(s.model.requests.map((r) => r.system)).toEqual([GUARDRAIL_SYSTEM_PROMPT, READINESS_SYSTEM_PROMPT]);
    expect(s.model.requests[0]?.messages[0]?.text).toContain("Chart: the distance run each week.");
    expect(s.model.requests[1]?.messages[0]?.text).toContain("Chart: the distance run each week.");
    // Read-only: a contents read token for that one repository, and no GitHub write.
    expect(s.github.calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.body)).toEqual([{ repositories: ["ssd-ada-runner"], permissions: { contents: "read" } }]);
    expect(s.githubWrites()).toEqual([]);
    // Logs hold no text, nickname or id.
    const logged = JSON.stringify([s.logs, s.workerLogs, s.launcherLogs]);
    for (const secret of ["Chart", "Ada-Runner", "ada-runner", "me-1", id]) expect(logged).not.toContain(secret);
  });

  it("WHEN it is the same THEN the answer is \"Your repository's spec has not changed.\" and nothing is queued (whatever the line endings or trailing spaces)", async () => {
    const s = setup({ repositorySpec: `${removeEmailAddresses(SPEC).replaceAll("\n", "  \r\n")}\r\n\r\n` });
    const id = await press(s);
    expect(await s.drain()).toEqual(["reading", "launcher read", "unchanged"]);
    expect(await replyOf(s, id)).toEqual({ status: "done", reply: "Your repository's spec has not changed." });
    expect(PHASE_3_TEXTS.specUnchanged).toBe("Your repository's spec has not changed.");
    expect(s.model.requests).toEqual([]);
    nothingQueued(s);
    // Unchanged from what the builder published (email removed) is the same too.
    const t = setup();
    const again = await press(t);
    expect(await t.drain()).toEqual(["reading", "launcher read", "unchanged"]);
    expect((await replyOf(t, again)).reply).toBe(PHASE_3_TEXTS.specUnchanged);
    expect(sameSpec(removeEmailAddresses(SPEC), SPEC)).toBe(true);
    expect(sameSpec(EDITED, SPEC)).toBe(false);
  });

  it("WHEN the edited spec is off path THEN the guardrail's answer is shown and nothing is queued (decline, and flag)", async () => {
    const s = setup({ repositorySpec: EDITED });
    s.model.push(verdictReply("decline", "a habit tracker"));
    const id = await press(s);
    expect(await s.drain()).toEqual(["reading", "launcher read", "declined"]);
    expect(await replyOf(s, id)).toEqual({ status: "declined", reply: declineReply("a habit tracker") });
    expect(s.model.requests).toHaveLength(1);
    nothingQueued(s);
    // Its tokens count.
    expect(s.table.usage.get("me-1")?.inputTokens).toBe(400);

    const f = setup({ repositorySpec: EDITED });
    f.model.push(verdictReply("flag"));
    const flagged = await press(f);
    expect(await f.drain()).toEqual(["reading", "launcher read", "declined"]);
    expect(await replyOf(f, flagged)).toEqual({ status: "declined", reply: PHASE_3_TEXTS.rebuildFlagged });
    // Not left waiting for a facilitator: the participant can press again.
    expect(f.table.conversations.get("me-1")?.state).toBe("open");
    nothingQueued(f);
  });

  it("WHEN the edited spec is not ready THEN the readiness answer is shown and nothing is queued", async () => {
    const s = setup({ repositorySpec: EDITED });
    s.model.push(verdictReply("on-path"), readinessReply("not-ready", ["Your spec needs a login: keep one shared log instead."]));
    const id = await press(s);
    expect(await s.drain()).toEqual(["reading", "launcher read", "not-ready"]);
    expect(await replyOf(s, id)).toEqual({ status: "done", reply: rebuildNotReadyText(["Your spec needs a login: keep one shared log instead."]) });
    nothingQueued(s);
    // A model failure (no verdict) also queues nothing and says so.
    const f = setup({ repositorySpec: EDITED });
    f.model.push(verdictReply("on-path"), new Error("Bedrock down"));
    const failed = await press(f);
    expect(await f.drain()).toEqual(["reading", "launcher read", "failed"]);
    expect(await replyOf(f, failed)).toEqual({ status: "failed", reply: PHASE_3_TEXTS.rebuildFailed });
    nothingQueued(f);
  });

  it("WHEN SPEC.md is over 20 KB THEN it is refused without an AI call, without downloading it and without any GitHub write", async () => {
    const s = setup({ repositorySpec: `${EDITED}\n${"x".repeat(MAX_REPOSITORY_SPEC_BYTES)}` });
    const id = await press(s);
    expect(await s.drain()).toEqual(["reading", "launcher read", "refused"]);
    expect(await replyOf(s, id)).toEqual({ status: "done", reply: PHASE_3_TEXTS.specTooLarge });
    expect(PHASE_3_TEXTS.specTooLarge).toContain("larger than 20 KB");
    expect(s.model.requests).toEqual([]);
    expect(s.github.calls.some((c) => c.path.includes("/git/blobs/"))).toBe(false);
    expect(s.githubWrites()).toEqual([]);
    expect(s.launcherLogs.map((e) => e.read)).toEqual(["too-large"]);
    nothingQueued(s);
  });

  it("answers a missing, unreadable or empty SPEC.md and a GitHub failure with their texts, without an AI call", async () => {
    const cases: [string, (s: ReturnType<typeof setup>) => void, string][] = [
      ["missing", (s) => s.github.seedCommit("ssd-ada-runner", { "index.html": "x" }, "Removed"), PHASE_3_TEXTS.specMissing],
      ["unreadable", (s) => s.github.seedCommit("ssd-ada-runner", { "SPEC.md": new Uint8Array([0x23, 0xff, 0xfe]) }, "Binary"), PHASE_3_TEXTS.specUnreadable],
      ["empty", (s) => s.github.seedCommit("ssd-ada-runner", { "SPEC.md": "\n \n" }, "Blank"), PHASE_3_TEXTS.specEmpty],
      [
        "github-error",
        (s) => {
          s.launcherDeps.credentials = () => Promise.reject(new Error("secret not loaded"));
        },
        PHASE_3_TEXTS.repositoryUnavailable,
      ],
    ];
    for (const [kind, arrange, text] of cases) {
      const s = setup();
      arrange(s);
      const id = await press(s);
      expect(await s.drain(), kind).toEqual(["reading", "launcher read", "refused"]);
      expect(await replyOf(s, id), kind).toEqual({ status: "done", reply: text });
      expect(s.model.requests, kind).toEqual([]);
      expect(s.launcherLogs.map((e) => e.read), kind).toEqual([kind]);
      nothingQueued(s);
    }
  });

  it("answers 401 without a session, 415 without JSON, 404 before step 4, and the change gate's 409s", async () => {
    const s = setup({ repositorySpec: EDITED });
    expect((await s.call(rebuild(""))).statusCode).toBe(401);
    expect((await s.call(rebuild(MINE, "{}", "text/plain"))).statusCode).toBe(415);
    expect((await s.call(rebuild(MINE, "[1]"))).statusCode).toBe(400);
    // Cleo is still at step 2: the route does not exist for her.
    expect((await s.call(rebuild(EARLY))).statusCode).toBe(404);
    expect(s.queue.sent).toEqual([]);
    // Build running, never live, all changes used.
    for (const [options, reason] of [
      [{ firstStatus: "building" as const }, "build-running"],
      [{ used: 5 }, "no-changes-left"],
    ] as const) {
      const t = setup(options);
      const res = await t.call(rebuild());
      expect(res.statusCode).toBe(409);
      expect(json(res)["reason"]).toBe(reason);
      expect(t.queue.sent).toEqual([]);
    }
    const all = await setup({ used: 5 }).call(rebuild());
    expect(json(all)["message"]).toBe(changesUsedText(5));
    // Pressed twice: the second press waits for the first.
    const first = await s.call(rebuild());
    expect(first.statusCode).toBe(202);
    expect((await s.call(rebuild())).statusCode).toBe(409);
  });

  it("reads only the caller's own repository: Bob's press reads Bob's SPEC.md and leaves Ada's conversation alone", async () => {
    const s = setup({ repositorySpec: EDITED });
    const res = await s.call(rebuild(THEIRS));
    expect(res.statusCode).toBe(202);
    const id = json(res)["id"] as string;
    expect(await s.drain()).toEqual(["reading", "launcher read", "unchanged"]);
    expect(s.github.calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.body)).toEqual([{ repositories: ["ssd-bob"], permissions: { contents: "read" } }]);
    expect(s.table.messages.get("me-1")).toBeUndefined();
    // Ada cannot poll Bob's request.
    expect((await s.call(poll(id, MINE))).statusCode).toBe(404);
  });

  it("WHEN a job is delivered again THEN the change is counted and built once", async () => {
    const s = setup({ repositorySpec: EDITED });
    s.model.push(verdictReply("on-path"), readinessReply("ready"));
    const id = await press(s);
    // The first AI job delivered twice: two spec-read requests (SQS's FIFO deduplication would drop one; here both arrive).
    const job = must(s.queue.sent.shift());
    expect(await processJob(job, s.workerDeps)).toBe("reading");
    expect(await processJob(job, s.workerDeps)).toBe("reading");
    const [read1, read2] = s.builds.specReads.splice(0).map(specReadJobBody);
    expect(await processSpecRead(read1, s.launcherDeps)).toBe("read");
    // The second read finds the first one's result: it only hands the job back again (GitHub is not asked twice).
    const tokenAsks = s.github.calls.filter((c) => c.path.endsWith("/access_tokens")).length;
    expect(await processSpecRead(read2, s.launcherDeps)).toBe("resent");
    expect(s.github.calls.filter((c) => c.path.endsWith("/access_tokens")).length).toBe(tokenAsks);
    // Two AI jobs: the first builds, the second finds the request done and only re-sends the build id.
    expect(await s.drain()).toEqual(["building", "resent"]);
    expect(s.used()).toBe(1);
    expect(s.builds.sent).toEqual([
      { buildId: buildIdFor(id), participantId: "me-1" },
      { buildId: buildIdFor(id), participantId: "me-1" },
    ]);
    expect(s.table.specs.get("me-1")?.map((v) => v.version)).toEqual([1, 2]);
    // Every message delivered once more after the build was queued: the AI job only re-sends the build id, the read is skipped.
    expect(await processJob(parseJob(must(s.aiDelivered.at(-1))), s.workerDeps)).toBe("resent");
    expect(await processSpecRead(read1, s.launcherDeps)).toBe("skipped");
    expect(s.used()).toBe(1);
    expect(s.model.requests).toHaveLength(2);
    expect(s.githubWrites()).toEqual([]);
  });

  it("holds while the global Stop is on, stops at the budget and the cap before reading, and replaces an open proposal once built", async () => {
    const stopped = setup({ repositorySpec: EDITED });
    stopped.table.settingsItem = { stopped: { BOOL: true } };
    await press(stopped);
    expect(await stopped.drain()).toEqual(["held"]);
    expect(stopped.builds.specReads).toEqual([]);
    expect(stopped.queue.later).toHaveLength(1);

    const broke = setup({ repositorySpec: EDITED });
    broke.table.settingsItem = { aiBudgetUsd: { N: "0" } };
    const id = await press(broke);
    expect(await broke.drain()).toEqual(["over-budget"]);
    expect(await replyOf(broke, id)).toEqual({ status: "failed", reply: BUDGET_REPLY });
    expect(broke.github.calls).toEqual([]);

    const proposing = setup({ repositorySpec: EDITED });
    proposing.table.specs.get("me-1")?.push({ version: 2, text: "# Other", messageId: "m2", createdAt: "x", whatChanges: ["Other"] });
    must(proposing.table.conversations.get("me-1")).proposedSpecVersion = 2;
    must(proposing.table.conversations.get("me-1")).latestSpecVersion = 2;
    proposing.model.push(verdictReply("on-path"), readinessReply("ready"));
    await press(proposing);
    expect(await proposing.drain()).toEqual(["reading", "launcher read", "building"]);
    expect(proposing.table.conversations.get("me-1")?.proposedSpecVersion).toBeUndefined();
    expect(proposing.table.conversations.get("me-1")).toMatchObject({ approvedSpecVersion: 3, latestSpecVersion: 3 });
  });

  it("the worker acts only on the request with its mark and exact text; the launcher's body is exact", () => {
    expect(isRebuildRequest({ step: "building", text: REBUILD_REQUEST, request: "rebuild-from-repo" })).toBe(true);
    expect(isRebuildRequest({ step: "building", text: REBUILD_REQUEST })).toBe(false);
    expect(isRebuildRequest({ step: "building", text: "hi", request: "rebuild-from-repo" })).toBe(false);
    expect(isRebuildRequest({ step: "spec", text: REBUILD_REQUEST, request: "rebuild-from-repo" })).toBe(false);
    expect(parseSpecReadJob(specReadJobBody({ participantId: "p-1", messageId: "m-1" }))).toEqual({ participantId: "p-1", messageId: "m-1" });
    for (const body of ['{"buildId":"b"}', '{"readSpec":{"participantId":"p","messageId":"m","x":1}}', '{"readSpec":{"participantId":"p#x","messageId":"m"}}', "nope"]) {
      expect(parseSpecReadJob(body), body).toBeUndefined();
    }
  });

  it("a participant's own message with the same words is an ordinary change request, never a rebuild", async () => {
    const s = setup({ repositorySpec: EDITED });
    s.model.push(verdictReply("on-path"), { text: "Sure, what would you like to change?", inputTokens: 10, outputTokens: 10 });
    const res = await s.call({ routeKey: "POST /api/conversation/messages", cookies: cookie(MINE), headers: { "content-type": "application/json" }, body: JSON.stringify({ text: REBUILD_REQUEST }) });
    expect(res.statusCode).toBe(202);
    expect(await s.drain()).toEqual(["done"]);
    expect(s.builds.specReads).toEqual([]);
    expect(s.github.calls).toEqual([]);
    // A spec-read request for that ordinary message (or a malformed body) makes the launcher read nothing.
    const id = must([...(s.table.messages.get("me-1")?.keys() ?? [])].at(0));
    expect(await processSpecRead(specReadJobBody({ participantId: "me-1", messageId: id }), s.launcherDeps)).toBe("skipped");
    expect(await processSpecRead('{"buildId":"x"}', s.launcherDeps)).toBe("invalid");
    expect(s.github.calls).toEqual([]);
    expect(s.queue.sent).toEqual([]);
  });
});
