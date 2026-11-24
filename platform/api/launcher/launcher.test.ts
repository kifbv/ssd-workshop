// Ticket 2.9: the build launcher and its stuck-build check, against the in-memory table, tasks, queues and GitHub.
import { describe, expect, it } from "vitest";
import { parseGitHubSecret, type GitHubDeps, type GitHubLogEntry } from "../github/app.js";
import { FakeGitHub, TEST_PRIVATE_KEY_PEM, TEST_SECRET_TEXT } from "../github/fakes.js";
import { SPEC_FILE } from "../github/repository.js";
import { loadTemplateFiles } from "../github/template.js";
import { BUILD_TASK_MAX_MS, HANDED_OVER_GRACE_MS, LAUNCH_UNSTARTED_MS } from "../settings.js";
import { runBuilds } from "../../src/builds/command.js";
import { FakeBuildsStore, FakeLaunchQueue, FakeTaskWatch } from "../../src/builds/fakes.js";
import { FakeBuildTable, FakeDeadLetters, FakeTasks } from "./fakes.js";
import {
  DEPLOY_DEAD_REASON,
  QUEUED_DEAD_REASON,
  SPEC_MISSING_REASON,
  START_FAILED_REASON,
  STOPPED_REASON,
  UNSTARTED_REASON,
  LAUNCH_SERVICE_REASON,
  parseLaunchMessage,
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
  const check: CheckDeps = { records: table, tasks, launchDeadLetters, deployDeadLetters, now: clock, log: (entry) => logs.push(entry) };
  return {
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
    await s.table.claim(BUILD, NICKNAME, PARTICIPANT, "00000000-0000-4000-8000-000000000000", "2026-11-24T10:00:00.000Z");
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
