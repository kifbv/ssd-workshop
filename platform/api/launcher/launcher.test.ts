// Ticket 2.9: the build launcher and its stuck-build check, against the in-memory table, tasks, queues and GitHub.
import { describe, expect, it, vi } from "vitest";
import { parseGitHubSecret, type GitHubDeps, type GitHubLogEntry } from "../github/app.js";
import { FakeGitHub, TEST_PRIVATE_KEY_PEM, TEST_SECRET_TEXT } from "../github/fakes.js";
import { SPEC_FILE } from "../github/repository.js";
import { loadTemplateFiles } from "../github/template.js";
import { BUILD_TASK_MAX_MS, HANDED_OVER_GRACE_MS, LAUNCH_UNSTARTED_MS, QUEUE_SEEN_MS, QUEUE_WAIT_MAX_MS, SLOT_REPAIR_FORCE_AFTER } from "../settings.js";
import { runBuilds } from "../../src/builds/command.js";
import { FakeBuildsStore, FakeLaunchQueue, FakeTaskWatch } from "../../src/builds/fakes.js";
import { FakeBuildTable, FakeDeadLetters, FakeTasks, type FakeBuild } from "./fakes.js";
import { DynamoBuildRecords, type BuilderTableSender } from "../../builder/records.js";
import {
  DEPLOY_DEAD_REASON,
  QUEUED_DEAD_REASON,
  QUEUE_TIMEOUT_REASON,
  SPEC_MISSING_REASON,
  REBUILD_SPEC_UNCONFIRMED_REASON,
  START_FAILED_REASON,
  STOPPED_REASON,
  UNSTARTED_REASON,
  LAUNCH_SERVICE_REASON,
  parseLaunchMessage,
  ecsRefusal,
  processLaunch,
  runCheck,
  type CheckDeps,
  type LauncherDeps,
  type LauncherLogEntry,
  type LaunchEntry,
} from "./launcher.js";

const BUILD = "2026-11-24T10-00-00-000Z-0101010101010101";
const PARTICIPANT = "6f1c2a9e-0000-4000-8000-000000000001";
const NICKNAME = "Ada-L";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const message = (buildId = BUILD): string => JSON.stringify({ buildId });
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

function setup() {
  let now = Date.parse("2026-11-24T10:00:00.000Z");
  const clock = () => new Date(now);
  const table = new FakeBuildTable();
  table.addQueuedBuild({ buildId: BUILD, participantId: PARTICIPANT, nickname: NICKNAME, spec: "# Run log\n\nLog runs." });
  const tasks = new FakeTasks(clock);
  const github = new FakeGitHub(clock);
  const githubLogs: GitHubLogEntry[] = [];
  const githubDeps: GitHubDeps = { fetch: github.fetch, now: clock, log: (entry) => githubLogs.push(entry), sleep: async () => undefined };
  const logs: LauncherLogEntry[] = [];
  let secretReads = 0;
  const deps: LauncherDeps = {
    records: table,
    tasks,
    credentials: async () => {
      secretReads += 1;
      return parseGitHubSecret(TEST_SECRET_TEXT);
    },
    github: githubDeps,
    templateFiles: () => loadTemplateFiles(),
    now: clock,
    log: (entry) => logs.push(entry),
  };
  const launchDeadLetters = new FakeDeadLetters();
  const deployDeadLetters = new FakeDeadLetters();
  // Ticket 3.5: the check's own launches (as the handler's, with this launcher's deps), unless "no time" is set.
  const relaunch = { bodies: [] as string[], noTime: false };
  const check: CheckDeps = {
    records: table,
    tasks,
    launchDeadLetters,
    deployDeadLetters,
    relaunch: async (body) => {
      if (relaunch.noTime) return undefined;
      relaunch.bodies.push(body);
      return processLaunch(body, deps);
    },
    now: clock,
    log: (entry) => logs.push(entry),
  };
  return {
    relaunch,
    table,
    tasks,
    github,
    githubLogs,
    deps,
    check,
    logs,
    launchDeadLetters,
    deployDeadLetters,
    secretReads: () => secretReads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Everything a test can see printed: no token, key, nickname, repository, build or participant id may appear. */
function assertQuietLogs(s: ReturnType<typeof setup>): void {
  const printed = JSON.stringify([s.logs, s.githubLogs]);
  for (const token of s.github.bearers) expect(printed).not.toContain(token);
  for (const secret of [TEST_PRIVATE_KEY_PEM.slice(40, 80), NICKNAME, NICKNAME.toLowerCase(), BUILD, PARTICIPANT]) expect(printed).not.toContain(secret);
}

describe("the launch message", () => {
  it("is exactly {\"buildId\": <id>}", () => {
    expect(parseLaunchMessage(message())).toBe(BUILD);
    for (const body of [undefined, "", "not json", "null", "[]", '{"buildId":"../x"}', '{"buildId":1}', JSON.stringify({ buildId: BUILD, nickname: "Bob" }), "{}"]) {
      expect(parseLaunchMessage(body), String(body)).toBeUndefined();
    }
  });
});

describe("launching a build (ticket 2.9)", () => {
  it("prepares the repository, mints a one-repository token and starts exactly one task with it; the build is building with its task", async () => {
    const s = setup();
    expect(await processLaunch(message(), s.deps)).toBe("started");
    expect(s.tasks.started).toHaveLength(1);
    const [task] = s.tasks.started;
    expect(task?.buildId).toBe(BUILD);
    // The repository holds the template and the approved spec.
    const repo = s.github.repo("ssd-ada-l");
    expect(s.github.filesAt("ssd-ada-l", repo.main ?? "")[SPEC_FILE]).toBe("# Run log\n\nLog runs.");
    // Criterion 1 (overrides): the token in the override reaches only that repository, contents write: never the
    // organization-wide administration token, never the app's key.
    const grant = s.github.grants.get(task?.token ?? "");
    expect(grant?.repositories).toEqual(["ssd-ada-l"]);
    expect(grant?.permissions).toEqual({ contents: "write", metadata: "read" });
    expect(task?.token).not.toContain("PRIVATE KEY");
    // The task starts from the commit the launcher prepared, under the claim's attempt id, startedBy the build id.
    expect(task?.baseCommit).toBe(repo.main);
    expect(task?.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(task?.startedBy).toBe(BUILD);
    const build = s.table.builds.get(BUILD);
    expect(task?.attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(build).toMatchObject({ status: "building", taskArn: task?.taskArn, attemptId: task?.attemptId, launchedAt: "2026-11-24T10:00:00.000Z" });
    expect(s.table.launches.get(BUILD)).toEqual({ buildId: BUILD, claimedAt: "2026-11-24T10:00:00.000Z", taskArn: task?.taskArn });
    expect(s.logs.at(-1)).toMatchObject({ event: "launcher", outcome: "started" });
    assertQuietLogs(s);
  });

  it("treats a second delivery of the same message (and a build no longer queued) as a duplicate: never a second task", async () => {
    const s = setup();
    await processLaunch(message(), s.deps);
    expect(await processLaunch(message(), s.deps)).toBe("duplicate");
    expect(s.tasks.started).toHaveLength(1);
    for (const status of ["building", "deploying", "live", "failed"] as const) {
      const t = setup();
      const build = t.table.builds.get(BUILD);
      if (build) build.status = status;
      expect(await processLaunch(message(), t.deps), status).toBe("duplicate");
      expect(t.tasks.started).toEqual([]);
      expect(t.github.calls).toEqual([]);
      expect(t.table.builds.get(BUILD)?.status).toBe(status);
    }
  });

  it("drops a message that is not exactly {buildId} or names no build, without a write or a GitHub call", async () => {
    const s = setup();
    for (const body of ["not json", JSON.stringify({ buildId: BUILD, nickname: "Bob" }), '{"buildId":"x/y"}', undefined]) {
      expect(await processLaunch(body, s.deps)).toBe("invalid");
    }
    expect(await processLaunch(message("no-such-build"), s.deps)).toBe("duplicate");
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    expect(s.github.calls).toEqual([]);
    expect(s.tasks.started).toEqual([]);
    expect(s.secretReads()).toBe(0);
  });

  it("ignores a build whose nickname is not its participant's profile nickname (a changed build record): no repository, no token", async () => {
    const s = setup();
    const build = s.table.builds.get(BUILD);
    if (build) build.nickname = "Bob";
    expect(await processLaunch(message(), s.deps)).toBe("ignored");
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    expect(s.github.calls).toEqual([]);
    expect(s.secretReads()).toBe(0);
    expect(s.tasks.started).toEqual([]);
    // Letter case counts too: the deployer compares the nickname exactly.
    const t = setup();
    t.table.profiles.set(PARTICIPANT, NICKNAME.toLowerCase());
    expect(await processLaunch(message(), t.deps)).toBe("ignored");
    expect(t.tasks.started).toEqual([]);
  });

  it("ignores a build that is not its participant's conversation build (left queued by a conversation reset)", async () => {
    const s = setup();
    s.table.conversations.set(PARTICIPANT, { buildId: "another-build", approvedSpecVersion: 2 });
    expect(await processLaunch(message(), s.deps)).toBe("ignored");
    s.table.conversations.set(PARTICIPANT, { approvedSpecVersion: 2 });
    expect(await processLaunch(message(), s.deps)).toBe("ignored");
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    expect(s.tasks.started).toEqual([]);
  });

  it("throws a bare error on a failed read before the claim, so SQS delivers the message again; the redelivery starts the task", async () => {
    const s = setup();
    s.table.failOnce.add("readBuild");
    await expect(processLaunch(message(), s.deps)).rejects.toThrow(/^launch failed$/);
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    s.table.failOnce.add("claim");
    await expect(processLaunch(message(), s.deps)).rejects.toThrow(/^launch failed$/);
    expect(await processLaunch(message(), s.deps)).toBe("started");
    expect(s.tasks.started).toHaveLength(1);
  });

  it("marks the build failed, without a task, when the approved spec is missing", async () => {
    const s = setup();
    s.table.specs.clear();
    expect(await processLaunch(message(), s.deps)).toBe("failed");
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [SPEC_MISSING_REASON] });
    expect(s.tasks.started).toEqual([]);
    expect(s.table.launches.size).toBe(0);
  });

  it("marks the build failed with GitHub's plain reason when the repository cannot be prepared", async () => {
    const s = setup();
    s.github.installationAccount = "someone-else";
    expect(await processLaunch(message(), s.deps)).toBe("failed");
    const build = s.table.builds.get(BUILD);
    expect(build?.status).toBe("failed");
    expect(build?.failureReasons?.[0]).toMatch(/^GitHub: /);
    expect(s.tasks.started).toEqual([]);
    assertQuietLogs(s);
  });

  it("marks the build failed when ECS starts no task, or RunTask fails", async () => {
    const s = setup();
    s.tasks.failure = "RESOURCE:ENI";
    expect(await processLaunch(message(), s.deps)).toBe("failed");
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [START_FAILED_REASON] });
    const t = setup();
    t.tasks.startError = Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    expect(await processLaunch(message(), t.deps)).toBe("failed");
    expect(t.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [LAUNCH_SERVICE_REASON] });
    expect(t.logs.at(-1)).toMatchObject({ outcome: "failed", error: "ThrottlingException" });
  });

  it("logs AWS's reason when ECS refuses RunTask (cut to 300 characters), and only the name for other errors", async () => {
    const s = setup();
    const refusal = "ECS was unable to assume the role 'arn:aws:iam::123456789012:role/ssd-workshop/ssd-workshop-builder' that was provided for this task.";
    s.tasks.startError = Object.assign(new Error(refusal), { name: "ClientException", $metadata: { httpStatusCode: 400 } });
    expect(await processLaunch(message(), s.deps)).toBe("failed");
    expect(s.logs.at(-1)).toMatchObject({ outcome: "failed", error: "ClientException", detail: refusal });
    expect(ecsRefusal(Object.assign(new Error("x".repeat(400)), { name: "InvalidParameterException", $metadata: {} }))).toHaveLength(300);
    expect(ecsRefusal(Object.assign(new Error("secret value"), { name: "ThrottlingException", $metadata: {} }))).toBeUndefined();
    expect(ecsRefusal(new Error("not from AWS"))).toBeUndefined();
    expect(ecsRefusal(undefined)).toBeUndefined();
  });

  it("gives RunTask the launch's deadline signal; a RunTask cut off at the deadline marks the build failed", async () => {
    const s = setup();
    const deadline = new AbortController();
    s.deps.signal = deadline.signal;
    expect(await processLaunch(message(), s.deps)).toBe("started");
    expect(s.tasks.started[0]?.signal).toBe(deadline.signal);

    const t = setup();
    const cut = new AbortController();
    t.deps.signal = cut.signal;
    cut.abort();
    t.tasks.startError = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(await processLaunch(message(), t.deps)).toBe("failed");
    expect(t.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [LAUNCH_SERVICE_REASON] });
    expect(t.logs.at(-1)).toMatchObject({ outcome: "failed", error: "AbortError" });
  });

  it("gives every launch its own attempt id (a retried build's new task cannot be confused with the earlier one's)", async () => {
    const s = setup();
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    s.deps.newAttemptId = () => ids.shift() ?? "";
    expect(await processLaunch(message(), s.deps)).toBe("started");
    expect(s.table.builds.get(BUILD)?.attemptId).toBe("11111111-1111-4111-8111-111111111111");
    // It failed (freeing its slot, ticket 3.4), then was put back in the queue.
    await s.table.endBuild(BUILD, "failed", new Date().toISOString());
    const build = s.table.builds.get(BUILD);
    if (build) Object.assign(build, { status: "queued" });
    expect(await processLaunch(message(), s.deps)).toBe("started");
    expect(s.tasks.started.map((task) => task.attemptId)).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    expect(s.table.builds.get(BUILD)?.attemptId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("stops a started task it could not record, and marks the build failed (no task runs unwatched)", async () => {
    const s = setup();
    s.table.failOnce.add("recordTask");
    expect(await processLaunch(message(), s.deps)).toBe("failed");
    expect(s.tasks.stopCalls).toEqual([s.tasks.started[0]?.taskArn]);
    expect(s.table.builds.get(BUILD)?.status).toBe("failed");
  });
});

describe("launching a change build (ticket 3.7)", () => {
  const CHANGE = "2026-11-24T11-00-00-000Z-0202020202020202";
  const NEW_SPEC = "# Run log\n\nLog runs, with a weekly chart.";
  /** The first build is live: the repository's main holds the built app (two commits). */
  function changeSetup() {
    const s = setup();
    must(s.table.builds.get(BUILD)).status = "live";
    s.github.addRepository("ssd-ada-l");
    const start = s.github.seedCommit("ssd-ada-l", { "SPEC.md": "# Run log\n\nLog runs.", "index.html": "<h1>Run log</h1>" }, "Start from the workshop template and the approved spec");
    const built = s.github.seedCommit("ssd-ada-l", { "SPEC.md": "# Run log\n\nLog runs.", "index.html": "<h1>Run log</h1><h2>Home</h2>", "app.js": "// runs" }, "Build the app from the approved spec", [start]);
    s.table.addQueuedChangeBuild({ buildId: CHANGE, participantId: PARTICIPANT, nickname: NICKNAME, spec: NEW_SPEC, whatChanges: ["Adds a weekly chart to the home screen"], changeNumber: 2 });
    return { ...s, built };
  }

  it("WHEN a change build starts THEN the task's base commit is main's current commit (never the template), the repository is not written, and the build holds the version's text and list", async () => {
    const s = changeSetup();
    const before = s.github.history("ssd-ada-l").map((c) => c.sha);
    expect(await processLaunch(message(CHANGE), s.deps)).toBe("started");
    const [task] = s.tasks.started;
    expect(task?.buildId).toBe(CHANGE);
    expect(task?.baseCommit).toBe(s.built);
    expect(task?.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    // Nothing committed: main and the history are as they were (no template, no new SPEC.md commit).
    expect(s.github.history("ssd-ada-l").map((c) => c.sha)).toEqual(before);
    expect(s.github.repo("ssd-ada-l").main).toBe(s.built);
    expect(s.github.calls.some((c) => c.method !== "GET" && c.path.startsWith("/repos/"))).toBe(false);
    // The runner's input, copied from SPEC#0003 of this participant, and its one-repository token.
    expect(s.table.builds.get(CHANGE)).toMatchObject({ status: "building", changeSpec: NEW_SPEC, changeList: ["Adds a weekly chart to the home screen"], taskArn: task?.taskArn });
    expect(s.github.grants.get(task?.token ?? "")).toEqual({ permissions: { contents: "write", metadata: "read" }, repositories: ["ssd-ada-l"] });
    assertQuietLogs(s);
  });

  it("ignores a change build whose version is no longer the conversation's approved one, or that has no version or number", async () => {
    const edits: ((build: FakeBuild) => void)[] = [
      (build) => {
        build.specVersion = 2;
      },
      (build) => {
        delete build.specVersion;
      },
      (build) => {
        delete build.changeNumber;
      },
    ];
    for (const [i, edit] of edits.entries()) {
      const change = `edit ${i}`;
      const s = changeSetup();
      edit(must(s.table.builds.get(CHANGE)));
      expect(await processLaunch(message(CHANGE), s.deps), change).toBe("ignored");
      expect(s.tasks.started).toEqual([]);
      expect(s.table.builds.get(CHANGE)?.status).toBe("queued");
    }
  });

  it("access review of 3.7: WHEN the version's text or What changes list holds an email address THEN the build's stored input holds none", async () => {
    const s = changeSetup();
    const spec = must(s.table.specs.get(`${PARTICIPANT}#3`));
    spec.text = "# Run log\n\nQuestions go to ada.lovelace@example.org or coach&#64;club.example.com.";
    spec.whatChanges = ["Adds a weekly chart sent to ada.lovelace@example.org", "Shows the coach (coach@club.example.com) on the home screen"];
    expect(await processLaunch(message(CHANGE), s.deps)).toBe("started");
    const build = must(s.table.builds.get(CHANGE));
    const stored = JSON.stringify([build.changeSpec, build.changeList]);
    expect(stored).not.toMatch(/ada\.lovelace|coach@|coach&#64;|club\.example/);
    expect(build.changeSpec).toBe("# Run log\n\nQuestions go to [email removed] or [email removed].");
    expect(build.changeList).toEqual(["Adds a weekly chart sent to [email removed]", "Shows the coach ([email removed]) on the home screen"]);
  });

  it("access review of 3.7 (try 3): WHEN a control character sits inside an address in the text or the list THEN the build's stored input holds none", async () => {
    const s = changeSetup();
    const spec = must(s.table.specs.get(`${PARTICIPANT}#3`));
    spec.text = "# Run log\n\nQuestions go to ada@example\u0001.org or bob\u0000@example.org.\n\tThanks";
    spec.whatChanges = ["Adds a chart sent to ada@example\u0001.org", "Shows bob\u0000@example.org\non the home screen"];
    expect(await processLaunch(message(CHANGE), s.deps)).toBe("started");
    const build = must(s.table.builds.get(CHANGE));
    expect(JSON.stringify([build.changeSpec, build.changeList])).not.toMatch(/ada|bob|example\.org/);
    expect(build.changeSpec).toBe("# Run log\n\nQuestions go to [email removed] or [email removed].\n\tThanks");
    expect(build.changeList).toEqual(["Adds a chart sent to [email removed]", "Shows [email removed] on the home screen"]);
  });

  it("ignores a change build whose participant is not the conversation's owner: no spec read across participants, no task", async () => {
    const s = changeSetup();
    // Another participant with their own approved version 3 and the same nickname on their profile.
    const OTHER = "p-other";
    s.table.profiles.set(OTHER, NICKNAME);
    s.table.conversations.set(OTHER, { buildId: "another-build", approvedSpecVersion: 3 });
    s.table.specs.set(`${OTHER}#3`, { text: "# Their app", approved: true, whatChanges: ["Their change"] });
    must(s.table.builds.get(CHANGE)).participantId = OTHER;
    const read = vi.spyOn(s.table, "readApprovedSpec");
    expect(await processLaunch(message(CHANGE), s.deps)).toBe("ignored");
    expect(read).not.toHaveBeenCalled();
    expect(s.tasks.started).toEqual([]);
    expect(s.table.builds.get(CHANGE)).toMatchObject({ status: "queued" });
    expect(s.table.builds.get(CHANGE)?.changeSpec).toBeUndefined();
    expect(s.github.calls.filter((c) => c.path.startsWith("/repos/"))).toEqual([]);
  });

  it("marks a change build failed, without a task, when its version has no What changes list or the repository has no main", async () => {
    const s = changeSetup();
    must(s.table.specs.get(`${PARTICIPANT}#3`)).whatChanges = [];
    expect(await processLaunch(message(CHANGE), s.deps)).toBe("failed");
    expect(s.table.builds.get(CHANGE)).toMatchObject({ status: "failed", failureReasons: [SPEC_MISSING_REASON] });
    expect(s.tasks.started).toEqual([]);

    const t = setup();
    must(t.table.builds.get(BUILD)).status = "live";
    t.github.addRepository("ssd-ada-l");
    t.table.addQueuedChangeBuild({ buildId: CHANGE, participantId: PARTICIPANT, nickname: NICKNAME });
    expect(await processLaunch(message(CHANGE), t.deps)).toBe("failed");
    expect(t.table.builds.get(CHANGE)?.failureReasons?.[0]).toMatch(/^GitHub: The app's repository has no main branch/);
    expect(t.tasks.started).toEqual([]);
    expect(t.github.history("ssd-ada-l")).toEqual([]);
  });

  it("ticket 3.9 try 2: WHEN a version approved by Rebuild from my repository (not by the participant's conversation) is not exactly what the launcher read for that request THEN the build fails without a task", async () => {
    const REQUEST = "m-rebuild";
    const arrange = (s: ReturnType<typeof changeSetup>, read: { text: string; repository: string } | undefined) => {
      const spec = must(s.table.specs.get(`${PARTICIPANT}#3`));
      spec.rebuildRequestId = REQUEST;
      if (read !== undefined) s.table.rebuildRequests.set(`${PARTICIPANT}#${REQUEST}`, { pending: false, read: { kind: "found", ...read } });
    };
    // The read matches: it builds as any change.
    const ok = changeSetup();
    arrange(ok, { text: NEW_SPEC, repository: "ssd-ada-l" });
    expect(await processLaunch(message(CHANGE), ok.deps)).toBe("started");
    expect(ok.table.builds.get(CHANGE)).toMatchObject({ status: "building", changeSpec: NEW_SPEC });
    // Another text, another repository, or no read stored for that request: failed with its reason, no task.
    for (const [label, read] of [
      ["other text", { text: "# Something else\n", repository: "ssd-ada-l" }],
      ["other repository", { text: NEW_SPEC, repository: "ssd-bob" }],
      ["no read", undefined],
    ] as const) {
      const s = changeSetup();
      arrange(s, read);
      expect(await processLaunch(message(CHANGE), s.deps), label).toBe("failed");
      expect(s.table.builds.get(CHANGE), label).toMatchObject({ status: "failed", failureReasons: [REBUILD_SPEC_UNCONFIRMED_REASON] });
      expect(s.table.builds.get(CHANGE)?.changeSpec, label).toBeUndefined();
      expect(s.tasks.started, label).toEqual([]);
    }
  });

  it("a first build still starts from the template and the spec, with no change input", async () => {
    const s = setup();
    expect(await processLaunch(message(), s.deps)).toBe("started");
    const build = s.table.builds.get(BUILD);
    expect(build?.changeSpec).toBeUndefined();
    expect(build?.changeList).toBeUndefined();
    expect(s.github.history("ssd-ada-l")[0]?.message).toBe("Start from the workshop template and the approved spec");
  });
});

describe("the stuck-build check (ticket 2.9)", () => {
  async function launched() {
    const s = setup();
    await processLaunch(message(), s.deps);
    const taskArn = s.tasks.started[0]?.taskArn ?? "";
    return { ...s, taskArn };
  }

  it("criterion 3: WHEN a task stops without the build being finished THEN the next check (run every minute) marks the build failed", async () => {
    const s = await launched();
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("building");
    s.tasks.exit(s.taskArn);
    s.advance(60_000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [STOPPED_REASON], finishedAt: "2026-11-24T10:01:00.000Z" });
    expect(s.table.launches.size).toBe(0);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", failed: 1 });
  });

  it("also when ECS no longer knows the task", async () => {
    const s = await launched();
    s.tasks.states.clear();
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("failed");
  });

  it("WHEN a handed-over build's task stopped and no deploy started within HANDED_OVER_GRACE_MS THEN the check marks it failed, and retry recovers it (checker 1)", async () => {
    const s = await launched();
    const build = s.table.builds.get(BUILD);
    if (build) build.pushedCommit = COMMIT;
    s.tasks.exit(s.taskArn);
    // Within the grace period the deploy may still start: the build is left as it is and stays watched.
    await runCheck(s.check);
    s.advance(HANDED_OVER_GRACE_MS - 1000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "building", pushedCommit: COMMIT });
    expect(s.table.launches.size).toBe(1);
    // After it, no deploy will come.
    s.advance(2000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [DEPLOY_DEAD_REASON], pushedCommit: COMMIT });
    expect(s.table.launches.size).toBe(0);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", failed: 1 });
    // Retry takes it back: queued without the pushed commit, then a new task on the same repository.
    const out: string[] = [];
    const code = await runBuilds(["retry", NICKNAME], {
      connect: () => ({ store: new FakeBuildsStore(s.table), queue: new FakeLaunchQueue(), tasks: new FakeTaskWatch(s.tasks) }),
      now: () => new Date("2026-11-24T10:30:00.000Z"),
      out: (line) => out.push(line),
      err: (line) => out.push(line),
    });
    expect(code, out.join("\n")).toBe(0);
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    expect(s.table.builds.get(BUILD)?.pushedCommit).toBeUndefined();
    expect(await processLaunch(message(), s.deps)).toBe("started");
    expect(s.tasks.started).toHaveLength(2);
  });

  it("fails a handed-over build whose task ECS no longer knows (it stopped long ago) at the next check", async () => {
    const s = await launched();
    const build = s.table.builds.get(BUILD);
    if (build) build.pushedCommit = COMMIT;
    s.tasks.states.clear();
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [DEPLOY_DEAD_REASON] });
    expect(s.table.launches.size).toBe(0);
  });

  it("leaves a build the deployer took (deploying) or that was marked failed with its own reason, and stops watching it", async () => {
    const s = await launched();
    const build = s.table.builds.get(BUILD);
    if (build) Object.assign(build, { status: "deploying", pushedCommit: COMMIT });
    s.tasks.exit(s.taskArn);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "deploying", pushedCommit: COMMIT });
    expect(s.table.launches.size).toBe(0);

    const t = await launched();
    const other = t.table.builds.get(BUILD);
    if (other) Object.assign(other, { status: "failed", failureReasons: ["The build took too long."] });
    t.tasks.exit(t.taskArn);
    await runCheck(t.check);
    expect(t.table.builds.get(BUILD)?.failureReasons).toEqual(["The build took too long."]);
    expect(t.table.launches.size).toBe(0);
  });

  it("stops a task running longer than BUILD_TASK_MAX_MS; the next check marks the build failed", async () => {
    const s = await launched();
    s.advance(BUILD_TASK_MAX_MS - 1000);
    await runCheck(s.check);
    expect(s.tasks.stopCalls).toEqual([]);
    s.advance(2000);
    await runCheck(s.check);
    expect(s.tasks.stopCalls).toEqual([s.taskArn]);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [STOPPED_REASON] });
  });

  it("marks failed a claim that got no task within LAUNCH_UNSTARTED_MS (the launcher stopped half-way), not before", async () => {
    const s = setup();
    await s.table.claim(BUILD, NICKNAME, PARTICIPANT, "00000000-0000-4000-8000-000000000000", "2026-11-24T10:00:00.000Z", { cap: 15, queueKey: "q" });
    s.advance(LAUNCH_UNSTARTED_MS - 1000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("building");
    s.advance(2000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [UNSTARTED_REASON] });
    expect(s.table.launches.size).toBe(0);
  });

  it("fails a queued build whose launch message reached the dead-letter queue, and only a queued one; every dead letter is removed", async () => {
    const s = setup();
    s.table.addQueuedBuild({ buildId: "b-2", participantId: "p-2", nickname: "Bob" });
    const live = s.table.builds.get("b-2");
    if (live) live.status = "live";
    s.launchDeadLetters.add(message());
    s.launchDeadLetters.add(message("b-2"));
    s.launchDeadLetters.add("not json");
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [QUEUED_DEAD_REASON] });
    expect(s.table.builds.get("b-2")?.status).toBe("live");
    expect(s.launchDeadLetters.messages).toEqual([]);
    expect(s.logs.at(-1)).toMatchObject({ outcome: "checked", failed: 1, deadLetters: 3 });
  });

  it("fails a build left deploying (or handed over) whose deploy message reached the dead-letter queue, only for its pushed commit and app", async () => {
    const s = await launched();
    const build = s.table.builds.get(BUILD);
    if (build) Object.assign(build, { status: "deploying", pushedCommit: COMMIT });
    const other = "f".repeat(40);
    s.deployDeadLetters.add(JSON.stringify({ buildId: BUILD, nickname: NICKNAME, commit: other }));
    s.deployDeadLetters.add(JSON.stringify({ buildId: BUILD, nickname: "Bob", commit: COMMIT }));
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("deploying");
    s.deployDeadLetters.add(JSON.stringify({ buildId: BUILD, nickname: NICKNAME, commit: COMMIT }));
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [DEPLOY_DEAD_REASON] });
    expect(s.deployDeadLetters.messages).toEqual([]);
  });

  it("WHEN the launch recorded the task on its entry but neither on the build nor as failed THEN the check fails the build once the task stopped (try 3, checker 5)", async () => {
    const s = setup();
    s.table.failOnce.add("recordTaskBuild");
    s.table.failOnce.add("failUnstarted");
    expect(await processLaunch(message(), s.deps)).toBe("failed");
    const taskArn = s.tasks.started[0]?.taskArn ?? "";
    // The launcher stopped the task; the build is building without a task, its entry names the task.
    expect(s.tasks.stopCalls).toEqual([taskArn]);
    expect(s.table.builds.get(BUILD)?.status).toBe("building");
    expect(s.table.builds.get(BUILD)?.taskArn).toBeUndefined();
    expect(s.table.launches.get(BUILD)?.taskArn).toBe(taskArn);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [LAUNCH_SERVICE_REASON] });
    expect(s.table.launches.size).toBe(0);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", failed: 1 });
  });

  it("does the same when ECS no longer knows that task, and leaves such a build alone while its task runs", async () => {
    const s = setup();
    s.table.failOnce.add("recordTaskBuild");
    s.table.failOnce.add("failUnstarted");
    s.tasks.stop = async () => undefined; // The launcher's stop did not reach ECS.
    await processLaunch(message(), s.deps);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("building");
    expect(s.table.launches.size).toBe(1);
    s.tasks.states.clear();
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [LAUNCH_SERVICE_REASON] });
    expect(s.table.launches.size).toBe(0);
  });

  it("never fails a retry's new launch from the earlier launch's entry (another launchedAt)", async () => {
    const s = setup();
    s.table.failOnce.add("recordTaskBuild");
    s.table.failOnce.add("failUnstarted");
    await processLaunch(message(), s.deps);
    const entry = s.table.launches.get(BUILD);
    // A retry and a new claim happened after the check read the old entry: the build is building, no task yet.
    const build = s.table.builds.get(BUILD);
    if (build) Object.assign(build, { status: "building", launchedAt: "2026-11-24T10:05:00.000Z" });
    s.table.listLaunches = async () => [{ ...(entry as LaunchEntry) }];
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("building");
  });

  it("WHEN a watch entry names a task outside the builds cluster (or in another account or region) THEN the check removes it without asking ECS, and still checks the other builds (try 3, access review LOW 4)", async () => {
    const s = await launched();
    s.tasks.exit(s.taskArn);
    const hex = "0123456789abcdef0123456789abcdef";
    const bad = [
      "not-an-arn",
      "arn:aws:ecs:eu-central-1:360206963848:task/other-cluster/0123",
      "arn:aws:ecs:eu-central-1:360206963848:task/ssd-workshop-builds/../x",
      `arn:aws:ecs:eu-central-1:111122223333:task/ssd-workshop-builds/${hex}`,
      `arn:aws:ecs:us-east-1:360206963848:task/ssd-workshop-builds/${hex}`,
    ];
    bad.forEach((taskArn, i) => s.table.launches.set(`bad-${String(i)}`, { buildId: `bad-${String(i)}`, claimedAt: "2026-11-24T10:00:00.000Z", taskArn }));
    const asked: string[][] = [];
    const describe = s.tasks.describe.bind(s.tasks);
    s.tasks.describe = async (arns) => {
      asked.push([...arns]);
      for (const arn of arns) if (!/^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/ssd-workshop-builds\/[0-9a-f]+$/.test(arn)) throw Object.assign(new Error("bad arn"), { name: "InvalidParameterException" });
      return describe(arns);
    };
    await runCheck(s.check);
    expect(asked).toEqual([[s.taskArn]]);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [STOPPED_REASON] });
    expect(s.table.launches.size).toBe(0);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", failed: 1 });
  });

  it("throws a bare error when the table fails, after logging only its name", async () => {
    const s = setup();
    s.table.failOnce.add("listLaunches");
    await expect(runCheck(s.check)).rejects.toThrow(/^check failed$/);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "error", error: "InternalServerError" });
  });
});

describe("build slots: at most N builds at once (ticket 3.4)", () => {
  /** `count` more queued builds, each of its own participant (one message group each), in this order. */
  function addBuilds(s: ReturnType<typeof setup>, count: number): string[] {
    return Array.from({ length: count }, (_, i) => {
      const buildId = `2026-11-24T10-00-00-000Z-${String(i + 1).padStart(16, "0")}`;
      s.table.addQueuedBuild({ buildId, participantId: `6f1c2a9e-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, nickname: `Runner-${String(i + 1)}` });
      return buildId;
    });
  }

  it("criterion 1: WHEN 16 builds are queued with the cap at 15 THEN 15 start and the 16th starts only after one finishes", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    s.table.buildsAtOnce = 15;
    const builds = addBuilds(s, 16);
    for (const buildId of builds.slice(0, 15)) {
      expect(await processLaunch(message(buildId), s.deps)).toBe("started");
      s.advance(1000);
    }
    const last = builds[15] ?? "";
    // No slot: it stays queued and waits (its message comes back), as often as it comes back.
    for (let i = 0; i < 3; i += 1) {
      expect(await processLaunch(message(last), s.deps)).toBe("waiting");
      s.advance(30_000);
    }
    expect(s.tasks.started).toHaveLength(15);
    expect(s.table.builds.get(last)?.status).toBe("queued");
    expect(s.table.slots.running).toBe(15);
    expect(s.logs.filter((entry) => entry.outcome === "waiting")).toHaveLength(3);
    // A running build that is still building does not free its slot; one that goes live does.
    await runCheck(s.check);
    expect(await processLaunch(message(last), s.deps)).toBe("waiting");
    await s.table.endBuild(builds[3] ?? "", "live", new Date().toISOString());
    expect(s.table.slots.running).toBe(14);
    expect(await processLaunch(message(last), s.deps)).toBe("started");
    expect(s.tasks.started).toHaveLength(16);
    expect(s.table.slots.running).toBe(15);
    // The started build left the waiting line.
    expect(s.table.queue.size).toBe(0);
    expect(s.table.builds.get(last)?.queueKey).toBeUndefined();
    assertQuietLogs(s);
  }, 30_000);

  it("criterion 2 (with the fakes): WHEN two launchers claim the last slot at the same time THEN one gets it, the other waits", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    s.table.buildsAtOnce = 3;
    const builds = addBuilds(s, 4);
    for (const buildId of builds.slice(0, 2)) expect(await processLaunch(message(buildId), s.deps)).toBe("started");
    const outcomes = await Promise.all(builds.slice(2).map((buildId) => processLaunch(message(buildId), s.deps)));
    expect([...outcomes].sort()).toEqual(["started", "waiting"]);
    expect(s.table.slots.running).toBe(3);
    expect(s.tasks.started).toHaveLength(3);
    // The lower layer alone: a claim at the cap is refused, whatever the build.
    const waiting = builds[2 + outcomes.indexOf("waiting")] ?? "";
    expect(await s.table.claim(waiting, `Runner-${String(builds.indexOf(waiting) + 1)}`, "x", "a", new Date().toISOString(), { cap: 3, queueKey: "q" })).toBe("taken");
    const build = s.table.builds.get(waiting);
    expect(build && (await s.table.claim(waiting, build.nickname, build.participantId, "a", new Date().toISOString(), { cap: 3, queueKey: "q" }))).toBe("no-slot");
  }, 30_000);

  it("starts waiting builds in their order: a later build waits while an earlier one waits for the free slot, unless that one's message is gone", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    s.table.buildsAtOnce = 1;
    const [first, second, third] = addBuilds(s, 3);
    expect(await processLaunch(message(first), s.deps)).toBe("started");
    s.advance(1000);
    expect(await processLaunch(message(second), s.deps)).toBe("waiting");
    s.advance(1000);
    expect(await processLaunch(message(third), s.deps)).toBe("waiting");
    await s.table.endBuild(first ?? "", "failed", new Date().toISOString());
    // The slot is free, but the second build waits ahead of the third: the third keeps waiting.
    expect(await processLaunch(message(third), s.deps)).toBe("waiting");
    expect(await processLaunch(message(second), s.deps)).toBe("started");
    await s.table.endBuild(second ?? "", "live", new Date().toISOString());
    expect(await processLaunch(message(third), s.deps)).toBe("started");

    // An earlier entry whose message stopped coming back (not seen for QUEUE_SEEN_MS) never blocks the line.
    const t = setup();
    t.table.builds.delete(BUILD);
    t.table.buildsAtOnce = 1;
    const [a, b] = addBuilds(t, 2);
    expect(await processLaunch(message(a), t.deps)).toBe("started");
    await t.table.endBuild(a ?? "", "live", new Date().toISOString());
    t.table.queue.set("2026-11-24T09:59:00.000Z#gone", { buildId: "gone", lastSeenAt: "2026-11-24T09:59:00.000Z" });
    // Seen 1 minute ago: still ahead.
    expect(await processLaunch(message(b), t.deps)).toBe("waiting");
    // Try 2: still ahead 2.5 minutes later (a message whose 30 s visibility could not be set comes back after the
    // queue's 150 s): a busy launcher does not let a later build pass an earlier one.
    t.advance(150_000);
    expect(await processLaunch(message(b), t.deps)).toBe("waiting");
    t.advance(QUEUE_SEEN_MS);
    expect(await processLaunch(message(b), t.deps)).toBe("started");
  }, 30_000);

  it("criterion 3: WHEN a build ends live, failed or stuck THEN its slot is freed, once", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    s.table.buildsAtOnce = 15;
    const [live, failed, stuck, unstarted, kept] = addBuilds(s, 5);
    for (const buildId of [live, failed, stuck, kept]) expect(await processLaunch(message(buildId), s.deps)).toBe("started");
    // A launch that stops after its claim (no task) fails its build and frees its slot.
    s.tasks.failure = "RESOURCE:ENI";
    expect(await processLaunch(message(unstarted), s.deps)).toBe("failed");
    s.tasks.failure = undefined;
    expect(s.table.slots.running).toBe(4);
    // The deployer: live and failed (its terminal write, then the release); a second release frees nothing.
    await s.table.endBuild(live ?? "", "live", new Date().toISOString());
    await s.table.endBuild(failed ?? "", "failed", new Date().toISOString());
    expect(await s.table.releaseSlot(live ?? "")).toBe(false);
    expect(s.table.slots.running).toBe(2);
    // Stuck: its task stopped while building; the minute check fails it and frees the slot.
    const task = s.tasks.started.find((t) => t.buildId === stuck);
    s.tasks.exit(task?.taskArn ?? "");
    await runCheck(s.check);
    expect(s.table.builds.get(stuck ?? "")).toMatchObject({ status: "failed", failureReasons: [STOPPED_REASON] });
    expect(s.table.slots.running).toBe(1);
    expect([...s.table.holders.keys()]).toEqual([kept]);
    // A running build keeps its slot; a release while it runs frees nothing.
    expect(await s.table.releaseSlot(kept ?? "")).toBe(false);
    await runCheck(s.check);
    expect(s.table.slots.running).toBe(1);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", freed: 0, repaired: false });
  }, 30_000);

  it("criterion 3: WHEN the counter is wrong THEN the minute check sets it to the number of builds building or deploying (freeing the slots of builds that ended)", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    const builds = addBuilds(s, 4);
    for (const buildId of builds) expect(await processLaunch(message(buildId), s.deps)).toBe("started");
    // One deploying, one building, two ended without their release (a writer's release failed).
    const [deploying, building, endedLive, endedFailed] = builds.map((id) => s.table.builds.get(id));
    if (deploying) deploying.status = "deploying";
    if (endedLive) endedLive.status = "live";
    if (endedFailed) endedFailed.status = "failed";
    expect(building?.status).toBe("building");
    s.table.slots.running = 9;
    await runCheck(s.check);
    expect(s.table.slots.running).toBe(2);
    expect([...s.table.holders.keys()].sort()).toEqual([builds[0], builds[1]].sort());
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", freed: 2, repaired: true });
    // Too low is repaired too (two launchers could otherwise pass the cap).
    s.table.slots.running = -3;
    await runCheck(s.check);
    expect(s.table.slots.running).toBe(2);
    // The repair waits when a claim or release moved the counter between the check's two reads (its version).
    expect(await s.table.repairSlots({ running: 2, version: s.table.slots.version - 1, misses: 0 }, 0, false)).toBe(false);
    expect(s.table.slots.running).toBe(2);
  }, 30_000);

  it("gives a retried build a new place at the end of the line, and the check removes waiting entries of builds no longer waiting there", async () => {
    const s = setup();
    s.table.buildsAtOnce = 1;
    const [other] = addBuilds(s, 1);
    expect(await processLaunch(message(other), s.deps)).toBe("started");
    s.advance(1000);
    expect(await processLaunch(message(), s.deps)).toBe("waiting");
    const place = s.table.builds.get(BUILD)?.queueKey;
    expect(place).toMatch(/^2026-11-24T10:00:01\.000Z#/);
    expect([...s.table.queue.keys()]).toEqual([place]);
    // Its launch message reached the dead-letter queue: failed, and its waiting entry goes at the next check.
    s.launchDeadLetters.add(message());
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("failed");
    expect(s.table.queue.size).toBe(0);
    expect(s.logs.at(-1)).toMatchObject({ unqueued: 1 });
    // Retried (queueKey removed): placed again, behind every build seen before.
    const store = new FakeBuildsStore(s.table);
    expect(await store.requeue(BUILD, "failed", new Date().toISOString())).toBe(true);
    expect(s.table.builds.get(BUILD)?.queueKey).toBeUndefined();
    s.advance(60_000);
    expect(await processLaunch(message(), s.deps)).toBe("waiting");
    expect(s.table.builds.get(BUILD)?.queueKey).toMatch(/^2026-11-24T10:01:01\.000Z#/);
  }, 30_000);
  it("try 2: WHEN the builder marks its build failed THEN it frees nothing itself, and the next minute check frees the slot", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    s.table.buildsAtOnce = 1;
    const [first, second] = addBuilds(s, 2);
    expect(await processLaunch(message(first), s.deps)).toBe("started");
    // The runner's failure write: the build only (platform/builder/records.ts), the slot still held.
    const build = s.table.builds.get(first ?? "");
    if (build) build.status = "failed";
    expect(s.table.slots.running).toBe(1);
    expect(await processLaunch(message(second), s.deps)).toBe("waiting");
    await runCheck(s.check);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", freed: 1 });
    expect(s.table.slots.running).toBe(0);
    expect(await processLaunch(message(second), s.deps)).toBe("started");
  }, 30_000);

  it("try 2: WHEN the counter is missing or negative THEN no build starts until the minute check sets it (unconditionally) from the holders", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    const [first, second] = addBuilds(s, 2);
    // As before the first check after the deploy: no counter at all reads as full.
    s.table.slots.running = undefined;
    s.table.slots.version = 0;
    expect(await processLaunch(message(first), s.deps)).toBe("waiting");
    const build = s.table.builds.get(first ?? "");
    expect(build && (await s.table.claim(first ?? "", build.nickname, build.participantId, "a", new Date().toISOString(), { cap: 15, queueKey: "q" }))).toBe("no-slot");
    await runCheck(s.check);
    expect(s.table.slots).toMatchObject({ running: 0, misses: 0 });
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", repaired: true, forced: true });
    expect(await processLaunch(message(first), s.deps)).toBe("started");
    // Negative (a release that found no counter creates it at -1): full, then reset to the holders even while the
    // version moves, since no race can explain it.
    s.table.slots.running = -2;
    s.table.versionKeepsMoving = true;
    expect(await processLaunch(message(second), s.deps)).toBe("waiting");
    await runCheck(s.check);
    expect(s.table.slots.running).toBe(1);
    expect(s.logs.at(-1)).toMatchObject({ repaired: true, forced: true });
    expect(await processLaunch(message(second), s.deps)).toBe("started");
  }, 30_000);

  it(`try 2: WHEN the counter's version keeps moving THEN the repair is forced after ${String(SLOT_REPAIR_FORCE_AFTER)} refused ones in a row`, async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    const builds = addBuilds(s, 2);
    for (const buildId of builds) expect(await processLaunch(message(buildId), s.deps)).toBe("started");
    s.table.slots.running = 9;
    s.table.versionKeepsMoving = true;
    for (let i = 1; i <= SLOT_REPAIR_FORCE_AFTER; i += 1) {
      await runCheck(s.check);
      expect(s.table.slots).toMatchObject({ running: 9, misses: i });
      expect(s.logs.at(-1)).toMatchObject({ repaired: false, forced: false });
    }
    await runCheck(s.check);
    expect(s.table.slots).toMatchObject({ running: 2, misses: 0 });
    expect(s.logs.at(-1)).toMatchObject({ repaired: true, forced: true });
    // A normal race: one refused repair, then the next minute's conditional repair succeeds and clears the count.
    s.table.slots.running = 5;
    await runCheck(s.check);
    expect(s.table.slots).toMatchObject({ running: 5, misses: 1 });
    s.table.versionKeepsMoving = false;
    await runCheck(s.check);
    expect(s.table.slots).toMatchObject({ running: 2, misses: 0 });
    expect(s.logs.at(-1)).toMatchObject({ repaired: true, forced: false });
  }, 30_000);

  it("try 2: WHEN a malformed item sits at a build's holder key, or a holder's build is queued again, THEN the check removes it and the build can start", async () => {
    const s = setup();
    s.table.builds.delete(BUILD);
    const [blocked, requeued] = addBuilds(s, 2);
    s.table.strays.add(`BUILD#${blocked ?? ""}`);
    s.table.strays.add("ELSE");
    // A holder left over from an earlier launch of a build that is queued again (its release failed, then a retry).
    s.table.holders.set(requeued ?? "", "2026-11-24T09:00:00.000Z");
    s.table.slots.running = 1;
    expect(await processLaunch(message(blocked), s.deps)).toBe("waiting");
    expect(await processLaunch(message(requeued), s.deps)).toBe("waiting");
    await runCheck(s.check);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", strays: 2, freed: 1 });
    expect(s.table.strays.size).toBe(0);
    expect(s.table.holders.size).toBe(0);
    expect(s.table.slots.running).toBe(0);
    expect(await processLaunch(message(blocked), s.deps)).toBe("started");
    expect(await processLaunch(message(requeued), s.deps)).toBe("started");
  }, 30_000);

  it("try 2: WHEN a build has waited in the line longer than QUEUE_WAIT_MAX_MS (waiting, or failing before its claim) THEN the minute check fails it with a plain reason", async () => {
    const s = setup();
    s.table.buildsAtOnce = 1;
    const [other] = addBuilds(s, 1);
    expect(await processLaunch(message(other), s.deps)).toBe("started");
    // BUILD waits behind it, then its launches keep failing before the claim (a passing table error each time).
    expect(await processLaunch(message(), s.deps)).toBe("waiting");
    const runningBuild = s.table.builds.get(other ?? "");
    if (runningBuild) runningBuild.status = "live";
    await runCheck(s.check);
    for (let i = 0; i < 3; i += 1) {
      s.advance(QUEUE_WAIT_MAX_MS / 4);
      s.table.failOnce.add("claim");
      await expect(processLaunch(message(), s.deps)).rejects.toThrow(/^launch failed$/);
      await runCheck(s.check);
      expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    }
    s.advance(QUEUE_WAIT_MAX_MS / 4 + 60_000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [QUEUE_TIMEOUT_REASON] });
    expect(s.table.queue.size).toBe(0);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", failed: 1, unqueued: 1 });
    // Its next delivery is a duplicate: consumed, nothing started.
    expect(await processLaunch(message(), s.deps)).toBe("duplicate");
    expect(s.tasks.started).toHaveLength(1);
    assertQuietLogs(s);
  }, 30_000);
});

describe("global Stop (ticket 3.5)", () => {
  /** Ada's build plus `count` more queued builds, each of its own participant, in this order. */
  function withBuilds(s: ReturnType<typeof setup>, count: number): string[] {
    const more = Array.from({ length: count }, (_, i) => {
      const buildId = `2026-11-24T10-00-00-000Z-${String(i + 1).padStart(16, "0")}`;
      s.table.addQueuedBuild({ buildId, participantId: `6f1c2a9e-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, nickname: `Runner-${String(i + 1)}` });
      return buildId;
    });
    return [BUILD, ...more];
  }
  it("criterion 1: WHEN Stop is on THEN the launcher starts no task: the build keeps its place in the line and waits", async () => {
    const s = setup();
    s.table.stopped = true;
    for (let i = 0; i < 3; i += 1) {
      expect(await processLaunch(message(), s.deps)).toBe("paused");
      s.advance(30_000);
    }
    expect(s.tasks.started).toEqual([]);
    expect(s.github.bearers.size).toBe(0);
    expect(s.secretReads()).toBe(0);
    const build = s.table.builds.get(BUILD);
    expect(build?.status).toBe("queued");
    expect(build?.queueKey).toBe(`2026-11-24T10:00:00.000Z#${BUILD}`);
    expect([...s.table.queue.keys()]).toEqual([build?.queueKey]);
    expect(s.table.slots.running).toBe(0);
    expect(s.logs.map((l) => l.outcome)).toEqual(["paused", "paused", "paused"]);
    assertQuietLogs(s);
  });

  it("criterion 2: WHEN Stop is pressed with builds running THEN the next minute check stops each task, puts its build back to queued from the beginning and frees its slot", async () => {
    const s = setup();
    const [ada, second, handedOver] = withBuilds(s, 2);
    for (const buildId of [ada, second, handedOver]) {
      expect(await processLaunch(message(buildId), s.deps)).toBe("started");
      s.advance(1000);
    }
    expect(s.table.slots.running).toBe(3);
    // The runner wrote its feed; the third pushed its commit and handed it over to the deployer.
    for (const buildId of [ada, second]) must(s.table.builds.get(buildId ?? "")).feed = [{ kind: "step", step: "writing", at: "x" }];
    must(s.table.builds.get(handedOver ?? "")).pushedCommit = COMMIT;
    const taskOf = (buildId: string | undefined) => must(s.tasks.started.find((t) => t.buildId === buildId));
    const claimedAt = must(s.table.launches.get(ada ?? "")).claimedAt;
    const secondClaimedAt = must(s.table.launches.get(second ?? "")).claimedAt;
    const beforeStop = new Map([ada, second].map((buildId) => [buildId, { ...must(s.table.launches.get(buildId ?? "")) }]));

    s.table.stopped = true;
    s.advance(20_000);
    await runCheck(s.check);
    // Each running task got StopTask, the one handed over did not (it finishes: no AI runs there).
    expect(s.tasks.stopCalls).toEqual([taskOf(ada).taskArn, taskOf(second).taskArn]);
    for (const buildId of [ada, second]) {
      const build = must(s.table.builds.get(buildId ?? ""));
      expect(build.status).toBe("queued");
      for (const gone of ["attemptId", "taskArn", "launchedAt", "feed"] as const) expect(build[gone], gone).toBeUndefined();
      expect(s.table.holders.has(buildId ?? "")).toBe(false);
      // Its watch entry stays, with the stopped task: it marks a build with no launch message.
      expect(s.table.launches.get(buildId ?? "")).toEqual(beforeStop.get(buildId));
    }
    // Its place in the line is its claim's time, ahead of anything queued after it.
    expect(s.table.builds.get(ada ?? "")?.queueKey).toBe(`${claimedAt}#${ada ?? ""}`);
    expect(s.table.builds.get(handedOver ?? "")).toMatchObject({ status: "building", taskArn: taskOf(handedOver).taskArn });
    expect(s.table.slots.running).toBe(1);
    expect([...s.table.holders.keys()]).toEqual([handedOver]);
    // Nothing is launched while Stop is on.
    expect(s.relaunch.bodies).toEqual([]);
    // Each holds its place in the waiting line at once.
    expect([...s.table.queue.keys()].sort()).toEqual([`${claimedAt}#${ada ?? ""}`, `${secondClaimedAt}#${second ?? ""}`]);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", requeued: 2, stopped: 2, failed: 0, relaunched: 0 });

    // The stopped tasks are gone; the next checks (Stop still on) fail nothing, launch nothing and keep their places.
    s.advance(60_000);
    await runCheck(s.check);
    expect(s.table.builds.get(ada ?? "")?.status).toBe("queued");
    expect(s.table.builds.get(second ?? "")?.status).toBe("queued");
    expect(s.table.launches.size).toBe(3);
    expect(Date.parse(must(s.table.queue.get(`${claimedAt}#${ada ?? ""}`)).lastSeenAt)).toBeGreaterThan(Date.parse(claimedAt) + 60_000);
    expect(s.relaunch.bodies).toEqual([]);
    expect(s.tasks.started).toHaveLength(3);
    assertQuietLogs(s);
  }, 30_000);

  it("criterion 3: WHEN Resume is pressed THEN the queued builds start again from the beginning (a new attempt), the stopped ones first", async () => {
    const s = setup();
    s.table.buildsAtOnce = 1;
    const [ada, later] = withBuilds(s, 1);
    expect(await processLaunch(message(ada), s.deps)).toBe("started");
    const first = must(s.tasks.started[0]);
    s.advance(60_000);
    // `later` arrives and waits for the one slot.
    expect(await processLaunch(message(later), s.deps)).toBe("waiting");
    s.table.stopped = true;
    await runCheck(s.check);
    expect(await processLaunch(message(later), s.deps)).toBe("paused");

    s.table.stopped = false;
    s.table.resumedAt = new Date(Date.parse("2026-11-24T10:05:00.000Z")).toISOString();
    s.advance(30_000);
    // The later build's message comes first: it still waits, behind the build that was running (an earlier place).
    expect(await processLaunch(message(later), s.deps)).toBe("waiting");
    // The next minute check launches the stopped build again.
    await runCheck(s.check);
    expect(s.relaunch.bodies).toEqual([message(ada)]);
    const second = must(s.tasks.started[1]);
    expect(second.buildId).toBe(ada);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(s.table.builds.get(ada ?? "")).toMatchObject({ status: "building", attemptId: second.attemptId, taskArn: second.taskArn });
    // Its watch entry is the new launch's (the old one, with the stopped task, was replaced by the claim).
    expect(s.table.launches.get(ada ?? "")?.taskArn).toBe(second.taskArn);
    expect(s.logs.find((l) => l.event === "build-check" && l.relaunched === 1)).toBeDefined();
    await s.table.endBuild(ada ?? "", "live", new Date().toISOString());
    expect(await processLaunch(message(later), s.deps)).toBe("started");
    expect(s.tasks.started).toHaveLength(3);
  }, 30_000);

  it("WHEN a stopped build cannot start at once after Resume (no slot, or too little time) THEN it keeps its watch entry and place, and a later check starts it", async () => {
    const s = setup();
    const [ada, second] = withBuilds(s, 1);
    for (const buildId of [ada, second]) {
      expect(await processLaunch(message(buildId), s.deps)).toBe("started");
      s.advance(1000);
    }
    s.table.stopped = true;
    await runCheck(s.check);
    expect(s.tasks.stopCalls).toHaveLength(2);
    s.table.stopped = false;
    // Too little time left in the check: nothing launched, nothing lost.
    s.relaunch.noTime = true;
    s.advance(60_000);
    await runCheck(s.check);
    expect(s.tasks.started).toHaveLength(2);
    expect(s.table.launches.size).toBe(2);
    expect(s.table.builds.get(ada ?? "")?.status).toBe("queued");
    // One slot only: the oldest place starts, the other waits for the next minute.
    s.relaunch.noTime = false;
    s.table.buildsAtOnce = 1;
    s.advance(60_000);
    await runCheck(s.check);
    expect(s.relaunch.bodies).toEqual([message(ada), message(second)]);
    expect(s.table.builds.get(ada ?? "")?.status).toBe("building");
    expect(s.table.builds.get(second ?? "")?.status).toBe("queued");
    expect(s.table.launches.has(second ?? "")).toBe(true);
    await s.table.endBuild(ada ?? "", "live", new Date().toISOString());
    s.advance(60_000);
    await runCheck(s.check);
    expect(s.table.builds.get(second ?? "")?.status).toBe("building");
    expect(s.tasks.started.map((t) => t.buildId)).toEqual([ada, second, ada, second]);
    assertQuietLogs(s);
  }, 30_000);

  it("WHEN Stop lasts longer than the queued time limit THEN no waiting build is failed, and after Resume the wait counts from Resume", async () => {
    const s = setup();
    s.table.buildsAtOnce = 1;
    const [ada, waiting] = withBuilds(s, 1);
    expect(await processLaunch(message(ada), s.deps)).toBe("started");
    s.advance(1000);
    expect(await processLaunch(message(waiting), s.deps)).toBe("waiting");
    s.table.stopped = true;
    await runCheck(s.check);
    for (let i = 0; i < 5; i += 1) {
      s.advance(QUEUE_WAIT_MAX_MS / 4);
      expect(await processLaunch(message(waiting), s.deps)).toBe("paused");
      await runCheck(s.check);
    }
    expect(s.table.builds.get(waiting ?? "")?.status).toBe("queued");
    expect(s.table.builds.get(ada ?? "")?.status).toBe("queued");
    s.table.stopped = false;
    s.table.resumedAt = new Date(Date.parse("2026-11-24T10:00:00.000Z") + (5 * QUEUE_WAIT_MAX_MS) / 4).toISOString();
    s.advance(60_000);
    // The limit still applies after Resume, counted from it: the stopped build starts again, the other waits for its slot.
    await runCheck(s.check);
    expect(s.table.builds.get(waiting ?? "")?.status).toBe("queued");
    expect(s.table.builds.get(ada ?? "")?.status).toBe("building");
    expect(await processLaunch(message(waiting), s.deps)).toBe("waiting");
    s.advance(QUEUE_WAIT_MAX_MS);
    await runCheck(s.check);
    expect(s.table.builds.get(waiting ?? "")).toMatchObject({ status: "failed", failureReasons: [QUEUE_TIMEOUT_REASON] });
  }, 30_000);

  /**
   * The builder's own record writes (`DynamoBuildRecords`), their real conditions checked against `buildId` as the
   * launcher's table holds it: the stub evaluates each `ConditionExpression` (only the clause forms the builder uses;
   * any other throws) and answers ConditionalCheckFailed when it does not hold. Nothing is written: only refusals count.
   */
  function builderWrites(s: ReturnType<typeof setup>, buildId: string) {
    const holds = (condition: string, names: Record<string, string>, values: Record<string, { S?: string }>): boolean => {
      const build = s.table.builds.get(buildId) as unknown as Record<string, unknown> | undefined;
      return condition.split(" AND ").every((clause) => {
        if (clause === "attribute_exists(pk)") return build !== undefined;
        const missing = /^attribute_not_exists\((#\w+)\)$/.exec(clause);
        if (missing) return build?.[names[missing[1] ?? ""] ?? ""] === undefined;
        const equal = /^(#\w+) = (:\w+)$/.exec(clause);
        if (equal) return build !== undefined && build[names[equal[1] ?? ""] ?? ""] === values[equal[2] ?? ""]?.S;
        throw new Error(`unexpected clause: ${clause}`);
      });
    };
    const client = {
      send: async (command: { input: { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, { S?: string }> } }) => {
        const { ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues } = command.input;
        if (ConditionExpression === undefined || !holds(ConditionExpression, ExpressionAttributeNames ?? {}, ExpressionAttributeValues ?? {})) {
          throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        }
        return {};
      },
    } as unknown as BuilderTableSender;
    const records = new DynamoBuildRecords(client, "ssd-workshop-test");
    const at = new Date().toISOString();
    const event = { kind: "step" as const, step: "writing" as const, at };
    /** claim, addFeed, handOver and markFailed under `attemptId`: true for each one the table would accept. */
    return async (attemptId: string): Promise<Record<string, boolean>> => ({
      claim: await records.claim(buildId, attemptId, NICKNAME, event, at),
      addFeed: await records.addFeed(buildId, attemptId, [event], at),
      handOver: await records.handOver(buildId, attemptId, COMMIT, [event], at),
      markFailed: await records.markFailed(buildId, attemptId, ["stale"], at),
    });
  }

  it("WHEN a running build was stopped THEN its old attempt's writes (claim, feed, hand-over, failure) are refused, right after the requeue and after the relaunch's claim", async () => {
    const s = setup();
    const writes = builderWrites(s, BUILD);
    const refused = { claim: false, addFeed: false, handOver: false, markFailed: false };
    expect(await processLaunch(message(), s.deps)).toBe("started");
    const old = must(s.tasks.started[0]).attemptId;
    // Control: while it runs, the stub accepts the running attempt's writes (so a refusal below is the condition's).
    expect(await writes(old)).toEqual({ claim: true, addFeed: true, handOver: true, markFailed: true });

    s.table.stopped = true;
    s.advance(20_000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    expect(await writes(old)).toEqual(refused);

    s.table.stopped = false;
    s.table.resumedAt = "2026-11-24T10:00:30.000Z";
    s.advance(60_000);
    await runCheck(s.check);
    const relaunched = must(s.tasks.started[1]);
    expect(relaunched.attemptId).not.toBe(old);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "building", attemptId: relaunched.attemptId });
    expect(await writes(old)).toEqual(refused);
    // The new attempt's writes are the ones accepted.
    expect(await writes(relaunched.attemptId)).toEqual({ claim: true, addFeed: true, handOver: true, markFailed: true });
  }, 30_000);
});

describe("facilitator Retry and Pause (ticket 3.10)", () => {
  const STUCK = 15 * 60 * 1000;

  it("criterion 4: WHEN Retry is pressed on a build that is building for over 15 minutes THEN the check stops its task and queues a new build on the same repository", async () => {
    const s = setup();
    expect(await processLaunch(message(), s.deps)).toBe("started");
    const first = must(s.tasks.started[0]);
    must(s.table.builds.get(BUILD)).feed = [{ kind: "step", step: "writing", at: "x" }];
    s.advance(STUCK + 60_000);
    // The facilitator function's request (it may not stop tasks or send to the launch queue itself).
    s.table.retryRequests.set(BUILD, new Date(Date.parse("2026-11-24T10:00:00.000Z") + STUCK + 60_000).toISOString());
    await runCheck(s.check);
    // The stuck task got StopTask; the build was put back in the queue and launched again, a new task on the same repository.
    expect(s.tasks.stopCalls).toEqual([first.taskArn]);
    expect(s.tasks.started).toHaveLength(2);
    const second = must(s.tasks.started[1]);
    expect(second.buildId).toBe(BUILD);
    expect(second.taskArn).not.toBe(first.taskArn);
    expect(second.attemptId).not.toBe(first.attemptId);
    const build = must(s.table.builds.get(BUILD));
    expect(build).toMatchObject({ status: "building", taskArn: second.taskArn, nickname: NICKNAME, participantId: PARTICIPANT });
    expect(build.feed).toBeUndefined();
    // Same repository: the only one the token and the preparation name is the participant's.
    expect([...s.github.repositories.keys()]).toEqual(["ssd-ada-l"]);
    expect(s.github.grants.get(second.token)?.repositories).toEqual(["ssd-ada-l"]);
    // One slot, held by the new run; the request is done.
    expect(s.table.slots.running).toBe(1);
    expect(s.table.retryRequests.size).toBe(0);
    expect(s.logs.at(-1)).toMatchObject({ event: "build-check", outcome: "checked", retried: 1, stopped: 1, relaunched: 1, failed: 0 });
    assertQuietLogs(s);
  });

  it("WHEN Retry is pressed on a failed build THEN the check queues it again and launches it; a build running under 15 minutes is left alone", async () => {
    const s = setup();
    expect(await processLaunch(message(), s.deps)).toBe("started");
    const first = must(s.tasks.started[0]);
    s.tasks.exit(first.taskArn);
    s.advance(60_000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "failed", failureReasons: [STOPPED_REASON] });
    s.table.retryRequests.set(BUILD, new Date(Date.parse("2026-11-24T10:01:00.000Z")).toISOString());
    s.advance(60_000);
    await runCheck(s.check);
    const build = must(s.table.builds.get(BUILD));
    expect(build.status).toBe("building");
    expect(build.failureReasons).toBeUndefined();
    expect(s.tasks.started).toHaveLength(2);
    expect(s.table.retryRequests.size).toBe(0);

    // Running for 2 minutes only: not stuck. The request waits (the build may still fail), nothing is stopped.
    s.advance(2 * 60_000);
    s.table.retryRequests.set(BUILD, new Date(Date.parse("2026-11-24T10:04:00.000Z")).toISOString());
    await runCheck(s.check);
    expect(s.tasks.stopCalls).toEqual([]);
    expect(s.table.builds.get(BUILD)?.status).toBe("building");
    expect(s.table.retryRequests.has(BUILD)).toBe(true);
    // A request older than RETRY_REQUEST_MAX_MS for a build that never failed is dropped.
    s.advance(31 * 60_000);
    s.tasks.states.set(must(s.tasks.started[1]).taskArn, { stopped: false, createdAt: new Date(Date.parse("2026-11-24T10:35:00.000Z")) });
    must(s.table.builds.get(BUILD)).pushedCommit = COMMIT;
    await runCheck(s.check);
    expect(s.table.retryRequests.size).toBe(0);
    expect(s.tasks.started).toHaveLength(2);
  });

  it("WHEN the participant is paused THEN their build waits (held, no place in the line, no slot, no GitHub call), and Resume releases it", async () => {
    const s = setup();
    s.table.paused.add(PARTICIPANT);
    for (let i = 0; i < 2; i += 1) {
      expect(await processLaunch(message(), s.deps)).toBe("held");
      s.advance(30_000);
    }
    expect(s.tasks.started).toEqual([]);
    expect(s.secretReads()).toBe(0);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "queued" });
    expect(s.table.builds.get(BUILD)?.queueKey).toBeUndefined();
    expect(s.table.queue.size).toBe(0);
    expect(s.table.slots.running).toBe(0);
    s.table.paused.delete(PARTICIPANT);
    expect(await processLaunch(message(), s.deps)).toBe("started");
    assertQuietLogs(s);
  });

  it("a paused participant's build already in the line is never failed for waiting, and builds after it still start", async () => {
    const s = setup();
    // Ada's build failed; a Retry puts it back while she is paused: it keeps its request and its place.
    must(s.table.builds.get(BUILD)).status = "failed";
    s.table.paused.add(PARTICIPANT);
    s.table.retryRequests.set(BUILD, "2026-11-24T10:00:00.000Z");
    s.table.addQueuedBuild({ buildId: "b-other", participantId: "6f1c2a9e-0000-4000-8000-000000000002", nickname: "Grace" });
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    expect(s.table.retryRequests.has(BUILD)).toBe(true);
    expect(s.tasks.started).toEqual([]);
    expect(await processLaunch(message("b-other"), s.deps)).toBe("started");
    s.advance(QUEUE_WAIT_MAX_MS + 60_000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    s.table.paused.delete(PARTICIPANT);
    s.advance(60_000);
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("building");
    expect(s.table.retryRequests.size).toBe(0);
  });
});
