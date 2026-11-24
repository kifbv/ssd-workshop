// Ticket 2.9: `npm run builds -- list | retry <nickname>`, against the launcher's in-memory table, tasks and GitHub;
// a retried build's launch message goes to the real launcher.
import { describe, expect, it } from "vitest";
import { parseGitHubSecret } from "../../api/github/app.js";
import { FakeGitHub, TEST_SECRET_TEXT } from "../../api/github/fakes.js";
import { loadTemplateFiles } from "../../api/github/template.js";
import { FakeBuildTable, FakeTasks } from "../../api/launcher/fakes.js";
import { processLaunch, runCheck, type LauncherDeps } from "../../api/launcher/launcher.js";
import { parseBuildsArgs, runBuilds, USAGE, type BuildsDeps } from "./command.js";
import { FakeBuildsStore, FakeLaunchQueue, FakeTaskWatch } from "./fakes.js";

const BUILD = "2026-11-24T10-00-00-000Z-0101010101010101";
const PARTICIPANT = "6f1c2a9e-0000-4000-8000-000000000001";

function setup() {
  const clock = () => new Date("2026-11-24T10:30:00.000Z");
  const table = new FakeBuildTable();
  table.addQueuedBuild({ buildId: BUILD, participantId: PARTICIPANT, nickname: "Ada-L" });
  const tasks = new FakeTasks(clock);
  const queue = new FakeLaunchQueue();
  const out: string[] = [];
  const err: string[] = [];
  let connected = 0;
  const deps: BuildsDeps = {
    connect: () => {
      connected += 1;
      return { store: new FakeBuildsStore(table), queue, tasks: new FakeTaskWatch(tasks) };
    },
    now: clock,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const github = new FakeGitHub(clock);
  const launcher: LauncherDeps = {
    records: table,
    tasks,
    credentials: async () => parseGitHubSecret(TEST_SECRET_TEXT),
    github: { fetch: github.fetch, now: clock, log: () => undefined, sleep: async () => undefined },
    templateFiles: () => loadTemplateFiles(),
    now: clock,
    log: () => undefined,
  };
  const check = { records: table, tasks, launchDeadLetters: { receive: async () => [], remove: async () => undefined }, deployDeadLetters: { receive: async () => [], remove: async () => undefined }, now: clock, log: () => undefined };
  return { table, tasks, queue, out, err, deps, github, launcher, check, connected: () => connected };
}

describe("npm run builds: arguments", () => {
  it("accepts list and retry <nickname> only, without touching AWS on a usage error", async () => {
    expect(parseBuildsArgs(["list"])).toEqual({ command: "list" });
    expect(parseBuildsArgs(["retry", "Ada-L"])).toEqual({ command: "retry", nickname: "Ada-L" });
    for (const args of [[], ["list", "x"], ["retry"], ["retry", "a b"], ["retry", "Ada", "Bob"], ["delete", "Ada"], ["retry", "../x"]]) {
      expect("error" in parseBuildsArgs(args), args.join(" ")).toBe(true);
    }
    const s = setup();
    expect(await runBuilds(["retry"], s.deps)).toBe(2);
    expect(s.err[0]).toContain(USAGE);
    expect(s.connected()).toBe(0);
  });
});

describe("npm run builds -- list", () => {
  it("prints every build, newest first: created time, status, nickname and id", async () => {
    const s = setup();
    s.table.addQueuedBuild({ buildId: "b-2", participantId: "p-2", nickname: "Bob" });
    const later = s.table.builds.get("b-2");
    if (later) Object.assign(later, { createdAt: "2026-11-24T11:00:00.000Z", status: "live" });
    expect(await runBuilds(["list"], s.deps)).toBe(0);
    expect(s.out).toEqual([`2026-11-24T11:00:00.000Z  live       Bob  b-2`, `2026-11-24T09:00:00.000Z  queued     Ada-L  ${BUILD}`]);
  });
});

describe("npm run builds -- retry <nickname> (criterion 4)", () => {
  it("criterion 4: WHEN retry runs on a failed build THEN a new task starts on the same repository", async () => {
    const s = setup();
    // A first launch, whose task then stops half-way: the check marks the build failed.
    await processLaunch(JSON.stringify({ buildId: BUILD }), s.launcher);
    const first = s.tasks.started[0];
    s.tasks.exit(first?.taskArn ?? "");
    await runCheck(s.check);
    expect(s.table.builds.get(BUILD)?.status).toBe("failed");
    const firstGrant = s.github.grants.get(first?.token ?? "");

    expect(await runBuilds(["retry", "ada-l"], s.deps)).toBe(0);
    expect(s.out).toEqual([`ada-l's build ${BUILD} is queued again; the launcher starts a new task on the same repository within a minute.`]);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "queued" });
    expect(s.table.builds.get(BUILD)?.failureReasons).toBeUndefined();
    expect(s.table.builds.get(BUILD)?.taskArn).toBeUndefined();
    expect(s.queue.sent).toEqual([{ body: JSON.stringify({ buildId: BUILD }), participantId: PARTICIPANT, deduplicationId: `${BUILD}-retry-${String(Date.parse("2026-11-24T10:30:00.000Z"))}` }]);

    // The launcher takes the message: a second task, same build, same repository.
    expect(await processLaunch(s.queue.sent[0]?.body, s.launcher)).toBe("started");
    expect(s.tasks.started).toHaveLength(2);
    const second = s.tasks.started[1];
    expect(second?.buildId).toBe(BUILD);
    expect(second?.taskArn).not.toBe(first?.taskArn);
    expect(s.github.grants.get(second?.token ?? "")?.repositories).toEqual(firstGrant?.repositories);
    expect(firstGrant?.repositories).toEqual(["ssd-ada-l"]);
    expect(s.table.builds.get(BUILD)).toMatchObject({ status: "building", taskArn: second?.taskArn });
  });

  it("re-sends a build left queued (its launch message lost), and refuses any other status", async () => {
    const s = setup();
    expect(await runBuilds(["retry", "Ada-L"], s.deps)).toBe(0);
    expect(s.queue.sent).toHaveLength(1);
    for (const status of ["building", "deploying", "live"] as const) {
      const t = setup();
      const build = t.table.builds.get(BUILD);
      if (build) build.status = status;
      expect(await runBuilds(["retry", "Ada-L"], t.deps), status).toBe(1);
      expect(t.err[0]).toContain(`is ${status}`);
      expect(t.queue.sent).toEqual([]);
      expect(t.table.builds.get(BUILD)?.status).toBe(status);
    }
  });

  it("never starts a second task while the earlier one still runs", async () => {
    const s = setup();
    await processLaunch(JSON.stringify({ buildId: BUILD }), s.launcher);
    const build = s.table.builds.get(BUILD);
    if (build) build.status = "failed";
    expect(await runBuilds(["retry", "Ada-L"], s.deps)).toBe(1);
    expect(s.err[0]).toContain("still running");
    expect(s.queue.sent).toEqual([]);
    expect(s.table.builds.get(BUILD)?.status).toBe("failed");
  });

  it("answers plainly for an unknown nickname or a participant without a build", async () => {
    const s = setup();
    expect(await runBuilds(["retry", "Nobody"], s.deps)).toBe(1);
    expect(s.err).toEqual(["No participant has the nickname Nobody."]);
    s.table.conversations.set(PARTICIPANT, {});
    expect(await runBuilds(["retry", "Ada-L"], s.deps)).toBe(1);
    expect(s.err[1]).toBe("Ada-L has no build yet. Nothing changed.");
  });

  it("says so when the launch message could not be sent; a second retry sends it", async () => {
    const s = setup();
    const build = s.table.builds.get(BUILD);
    if (build) build.status = "failed";
    s.queue.failures = 1;
    expect(await runBuilds(["retry", "Ada-L"], s.deps)).toBe(1);
    expect(s.err[0]).toContain("could not be sent (ServiceUnavailable)");
    expect(s.table.builds.get(BUILD)?.status).toBe("queued");
    expect(await runBuilds(["retry", "Ada-L"], s.deps)).toBe(0);
    expect(s.queue.sent).toHaveLength(1);
  });
});
