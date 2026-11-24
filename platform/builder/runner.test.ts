// Ticket 2.8: the runner, against the in-memory GitHub, table, deploy queue and a scripted agent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubLogEntry } from "../api/github/app.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub } from "../api/github/fakes.js";
import { BUILDER_COMMIT_EMAIL, BUILDER_COMMIT_NAME, BUILD_AGENT_TIMEOUT_MS, MODELS } from "../api/settings.js";
import { downloadArchive } from "../api/deploy/github.js";
import { loadTemplateFiles } from "../api/github/template.js";
import { settle } from "../api/sign-in/fakes.js";
import { FakeAgent, FakeBuildRecords, FakeDeployQueue, type AgentStep } from "./fakes.js";
import { BUILD_STEPS, type FeedEvent } from "./records.js";
import { BEHAVIOUR_COMMIT_MESSAGE, PAGE_COMMIT_MESSAGE, SINGLE_COMMIT_MESSAGE, planCommits } from "./repository.js";
import {
  AGENT_FAILED_REASON,
  HAND_OVER_REASON,
  NOTHING_CHANGED_REASON,
  TIME_UP_REASON,
  exitWhenDone,
  runBuild,
  type BuilderLogEntry,
  type RunnerDeps,
} from "./runner.js";
import { usageOfTokens } from "./usage.js";

const BUILD = "2026-11-24T10-00-00-000Z-0101010101010101";
const TOKEN = `${FAKE_TOKEN_PREFIX}builder0001xyz`;
const SPEC = "# Run Log\n\n## Screens\n- Home: this week's runs.\n\nQuestions to ada.lovelace@example.org\n";
const PAGE = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <title>Run Log</title>\n    <link rel="stylesheet" href="style.css">\n    <script src="workshop-data.js" defer></script>\n    <script src="app.js" defer></script>\n  </head>\n  <body><main><h1>Run Log</h1><h2>Home</h2></main></body>\n</html>\n';
const TOKENS = { input: 1_000, output: 20_000, cacheRead: 600_000, cacheWrite: 40_000 };

const workspaces: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const goodScript = (): AgentStep[] => [
  { tokens: { ...TOKENS, output: 5_000 } },
  { write: "index.html", content: PAGE },
  { write: "style.css", content: "main { max-width: 640px; }\n" },
  { write: "app.js", content: '"use strict";\n// Runs.\n' },
  { write: "index.html", content: PAGE },
  { tokens: TOKENS },
];

async function setup(script: AgentStep[], options: { status?: "queued" | "building" | "live" | "failed"; nickname?: string } = {}) {
  let clock = new Date("2026-11-24T10:00:00.000Z").getTime();
  const now = (): Date => new Date((clock += 3));
  const github = new FakeGitHub(now);
  github.addRepository("ssd-ada");
  const template = await loadTemplateFiles();
  const files = Object.fromEntries(template.map((file) => [file.path, new TextDecoder().decode(file.bytes)]));
  const start = github.seedCommit("ssd-ada", { ...files, "SPEC.md": SPEC.replace(/\S+@\S+/, "[email removed]") }, "Start from the workshop template and the approved spec");
  // The launcher's one-repository token (ticket 2.6's builderToken), as GitHub granted it.
  github.grants.set(TOKEN, { permissions: { contents: "write", metadata: "read" }, repositories: ["ssd-ada"] });
  const records = new FakeBuildRecords();
  records.builds.set(BUILD, { nickname: options.nickname ?? "Ada", participantId: "p-1", status: options.status ?? "queued" });
  const queue = new FakeDeployQueue();
  const agent = new FakeAgent(script);
  const logs: (BuilderLogEntry | GitHubLogEntry)[] = [];
  const deps: RunnerDeps = {
    records,
    github: { fetch: github.fetch, now, log: (entry) => logs.push(entry), sleep: async () => undefined },
    download: (url) => downloadArchive(url, { fetch: (address, init) => github.fetch(address, init ?? {}) }),
    agent,
    queue,
    makeWorkspace: async () => {
      const dir = await mkdtemp(join(tmpdir(), "ssd-builder-test-"));
      workspaces.push(dir);
      return dir;
    },
    removeWorkspace: (dir) => rm(dir, { recursive: true, force: true }),
    model: MODELS.build,
    now,
    log: (entry) => logs.push(entry),
  };
  return { github, records, queue, agent, logs, deps, start };
}

const steps = (feed: readonly FeedEvent[] | undefined): string[] => (feed ?? []).flatMap((event) => (event.kind === "step" ? [event.step] : []));
const filesOf = (feed: readonly FeedEvent[] | undefined): string[] => (feed ?? []).flatMap((event) => (event.kind === "file" ? [event.path] : []));

describe("criterion 3: the feed holds the steps in order and every written file, and the repository at least two commits", () => {
  it("builds, commits in two commits on top of main, stores pushedCommit and hands exactly {buildId, nickname, commit} to the deployer", async () => {
    const t = await setup(goodScript());
    const outcome = await runBuild({ buildId: BUILD, token: TOKEN }, t.deps);
    expect(outcome).toBe("handed-over");
    const build = t.records.builds.get(BUILD);
    expect(build?.status).toBe("building");
    expect(steps(build?.feed)).toEqual([...BUILD_STEPS]);
    expect(steps(build?.feed)).toEqual(["preparing", "writing", "checking", "committing", "deploying"]);
    // Every file the agent wrote, once each, in the order written.
    expect(filesOf(build?.feed)).toEqual(["index.html", "style.css", "app.js"]);
    const history = t.github.history("ssd-ada");
    expect(history.map((commit) => commit.message)).toEqual([BEHAVIOUR_COMMIT_MESSAGE, PAGE_COMMIT_MESSAGE, "Start from the workshop template and the approved spec"]);
    expect(history[2]?.sha).toBe(t.start);
    const commits = (build?.feed ?? []).filter((event) => event.kind === "commit");
    expect(commits).toEqual([
      { kind: "commit", sha: history[1]?.sha, message: PAGE_COMMIT_MESSAGE, at: expect.any(String) },
      { kind: "commit", sha: history[0]?.sha, message: BEHAVIOUR_COMMIT_MESSAGE, at: expect.any(String) },
    ]);
    // The first commit holds the page and its look; the second the behaviour too.
    const first = t.github.filesAt("ssd-ada", history[1]?.sha ?? "");
    expect(first["index.html"]).toBe(PAGE);
    expect(first["app.js"]).not.toContain("Runs.");
    expect(t.github.filesAt("ssd-ada", history[0]?.sha ?? "")["app.js"]).toBe('"use strict";\n// Runs.\n');
    for (const commit of history.slice(0, 2)) {
      expect(commit.author).toMatchObject({ name: BUILDER_COMMIT_NAME, email: BUILDER_COMMIT_EMAIL });
      expect(commit.committer).toMatchObject({ name: BUILDER_COMMIT_NAME, email: BUILDER_COMMIT_EMAIL });
    }
    // The pushed commit is main's, stored on the build, and the only commit the message names.
    expect(build?.pushedCommit).toBe(t.github.repo("ssd-ada").main);
    expect(t.queue.sent).toEqual([{ buildId: BUILD, nickname: "Ada", commit: build?.pushedCommit }]);
    expect(Object.keys(t.queue.sent[0] ?? {}).sort()).toEqual(["buildId", "commit", "nickname"]);
    // The agent got the workspace, the build model and the prompt naming AGENTS.md and SPEC.md.
    expect(t.agent.runs[0]?.modelId).toBe("eu.anthropic.claude-sonnet-4-6");
    expect(t.agent.runs[0]?.prompt).toContain("AGENTS.md");
    expect(t.agent.runs[0]?.prompt).toContain("SPEC.md");
  });

  it("feed events carry times, and a single commit is made when only one kind of file changed", async () => {
    const t = await setup([{ write: "index.html", content: PAGE }]);
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("handed-over");
    expect(t.github.history("ssd-ada").map((commit) => commit.message)).toEqual([SINGLE_COMMIT_MESSAGE, "Start from the workshop template and the approved spec"]);
    for (const event of t.records.builds.get(BUILD)?.feed ?? []) expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });

  it("does nothing for a build that is missing, already finished, or already handed over", async () => {
    for (const status of ["live", "failed"] as const) {
      const t = await setup(goodScript(), { status });
      expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("no-build");
      expect(t.agent.runs).toEqual([]);
      expect(t.records.writes).toEqual([]);
    }
    const missing = await setup(goodScript());
    expect(await runBuild({ buildId: "another-build", token: TOKEN }, missing.deps)).toBe("no-build");
    const handed = await setup(goodScript(), { status: "building" });
    const stored = handed.records.builds.get(BUILD);
    if (stored) stored.pushedCommit = "0123456789abcdef0123456789abcdef01234567";
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, handed.deps)).toBe("no-build");
    expect(handed.agent.runs).toEqual([]);
  });

  it("fails with the check's reasons, and commits and sends nothing, when the app fails the deploy check", async () => {
    const t = await setup([{ write: "app.js", content: 'fetch("https://api.example.org/x");\n' }]);
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("failed");
    const build = t.records.builds.get(BUILD);
    expect(build?.status).toBe("failed");
    expect(build?.failureReasons?.[0]).toMatch(/^app\.js, line 1: /);
    expect(steps(build?.feed)).toEqual(["preparing", "writing", "checking"]);
    expect(t.github.history("ssd-ada")).toHaveLength(1);
    expect(t.queue.sent).toEqual([]);
  });

  it("fails plainly when the agent changed nothing or stopped on an error", async () => {
    const unchanged = await setup([]);
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, unchanged.deps)).toBe("failed");
    expect(unchanged.records.builds.get(BUILD)?.failureReasons).toEqual([NOTHING_CHANGED_REASON]);
    const broken = await setup([{ write: "app.js", content: "// x\n" }, { fail: true }]);
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, broken.deps)).toBe("failed");
    expect(broken.records.builds.get(BUILD)?.failureReasons).toEqual([AGENT_FAILED_REASON]);
    expect(broken.queue.sent).toEqual([]);
  });

  it("tries the deploy message three times, then marks the build failed", async () => {
    const flaky = await setup(goodScript());
    flaky.queue.failures = 2;
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, flaky.deps)).toBe("handed-over");
    expect(flaky.queue.sent).toHaveLength(1);
    const down = await setup(goodScript());
    down.queue.failures = 3;
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, down.deps)).toBe("failed");
    expect(down.records.builds.get(BUILD)?.failureReasons).toEqual([HAND_OVER_REASON]);
  });

  it("fails with GitHub's plain reason when the token does not reach the repository", async () => {
    const t = await setup(goodScript());
    t.github.grants.clear();
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("failed");
    expect(t.records.builds.get(BUILD)?.failureReasons).toEqual(['GitHub: GitHub answered 404 to the step "get-branch".']);
    expect(t.agent.runs).toEqual([]);
  });
});

describe("a build marked failed by someone else while it runs (try 3): the runner stops, pushes and sends nothing", () => {
  /** Marks the build failed as another writer would (the launcher's stuck-build check, an operator). */
  const failElsewhere = (records: FakeBuildRecords) => () => {
    const build = records.builds.get(BUILD);
    if (build) build.status = "failed";
  };

  it("between writing and checking: no check step, no commit, no message, outcome no-build", async () => {
    const t = await setup([...goodScript()]);
    t.agent.script.push({ call: failElsewhere(t.records) });
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("no-build");
    const build = t.records.builds.get(BUILD);
    expect(build?.status).toBe("failed");
    expect(steps(build?.feed)).toEqual(["preparing", "writing"]);
    expect(build?.pushedCommit).toBeUndefined();
    expect(t.github.history("ssd-ada").map((commit) => commit.sha)).toEqual([t.start]);
    expect(t.queue.sent).toEqual([]);
    // The runner did not write over the other writer's failure.
    expect(t.records.writes.filter((write) => write.method === "markFailed")).toEqual([]);
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "builder", phase: "checking", outcome: "no-build" }));
  });

  it("mid-writing: the refused file event aborts the agent at once; no commit, no message, outcome no-build", async () => {
    const t = await setup([
      { write: "index.html", content: PAGE },
      { write: "style.css", content: "main { max-width: 640px; }\n" },
      { hang: true },
      { write: "app.js", content: '"use strict";\n' },
    ]);
    // Once index.html's event is stored, the build is finished elsewhere; style.css's event is then refused.
    t.agent.script.splice(1, 0, {
      call: async () => {
        await settle(() => filesOf(t.records.builds.get(BUILD)?.feed).length === 1);
        failElsewhere(t.records)();
      },
    });
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("no-build");
    expect(t.agent.runs[0]?.signal.aborted).toBe(true);
    const build = t.records.builds.get(BUILD);
    expect(build?.status).toBe("failed");
    expect(filesOf(build?.feed)).toEqual(["index.html"]);
    expect(steps(build?.feed)).toEqual(["preparing", "writing"]);
    expect(t.github.history("ssd-ada").map((commit) => commit.sha)).toEqual([t.start]);
    expect(t.queue.sent).toEqual([]);
    expect(t.records.writes.filter((write) => write.method === "markFailed")).toEqual([]);
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "builder", phase: "writing", outcome: "no-build" }));
  });

  it("mid-writing, with an agent that ignores its signal: the runner still stops without waiting for it", async () => {
    const t = await setup([]);
    let signal: AbortSignal | undefined;
    t.deps.agent = {
      run: (run) => {
        signal = run.signal;
        const target = t.records;
        const build = target.builds.get(BUILD);
        if (build) build.status = "failed";
        run.onFileWritten("index.html");
        return new Promise(() => undefined);
      },
    };
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("no-build");
    expect(signal?.aborted).toBe(true);
    expect(t.queue.sent).toEqual([]);
  });

  it("before writing (the writing step refused): the agent never starts", async () => {
    const t = await setup(goodScript());
    const original = t.records.addFeed.bind(t.records);
    t.records.addFeed = async (buildId, events, nowIso) => {
      failElsewhere(t.records)();
      return original(buildId, events, nowIso);
    };
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("no-build");
    expect(t.agent.runs).toEqual([]);
    expect(t.queue.sent).toEqual([]);
  });

  it("before committing (the committing step refused): nothing is pushed", async () => {
    const t = await setup(goodScript());
    const original = t.records.addFeed.bind(t.records);
    t.records.addFeed = async (buildId, events, nowIso) => {
      if (events.some((event) => event.kind === "step" && event.step === "committing")) failElsewhere(t.records)();
      return original(buildId, events, nowIso);
    };
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("no-build");
    expect(t.github.history("ssd-ada").map((commit) => commit.sha)).toEqual([t.start]);
    expect(t.queue.sent).toEqual([]);
  });
});

describe("the token reaches one repository: the stored build's nickname decides where the runner works (finding 10)", () => {
  it("fails, and pushes nothing anywhere, when the stored build names another app than the repository the token reaches", async () => {
    const t = await setup(goodScript(), { nickname: "Bob" });
    // Bob's repository exists too; the token was minted for Ada's only.
    t.github.addRepository("ssd-bob");
    const bobStart = t.github.seedCommit("ssd-bob", { "README.md": "Bob's app\n" }, "Start");
    expect(await runBuild({ buildId: BUILD, token: TOKEN }, t.deps)).toBe("failed");
    const build = t.records.builds.get(BUILD);
    expect(build?.status).toBe("failed");
    expect(build?.failureReasons).toEqual(['GitHub: GitHub answered 404 to the step "get-branch".']);
    expect(build?.pushedCommit).toBeUndefined();
    expect(t.agent.runs).toEqual([]);
    expect(t.queue.sent).toEqual([]);
    expect(t.github.history("ssd-bob").map((commit) => commit.sha)).toEqual([bobStart]);
    expect(t.github.history("ssd-ada").map((commit) => commit.sha)).toEqual([t.start]);
  });
});

describe("the task's exit (finding 8): the process ends as soon as the outcome is recorded", () => {
  it("exits with the work's code, and with 1 after reporting an error the work threw", async () => {
    const exits: number[] = [];
    const errors: unknown[] = [];
    await exitWhenDone(async () => 0, (code) => exits.push(code), (error) => errors.push(error));
    await exitWhenDone(async () => 1, (code) => exits.push(code), (error) => errors.push(error));
    await exitWhenDone(async () => {
      throw new Error("boom");
    }, (code) => exits.push(code), (error) => errors.push(error));
    expect(exits).toEqual([0, 1, 1]);
    expect(errors).toHaveLength(1);
  });

  it("exits even while something else keeps the event loop busy (a stray child or timer)", async () => {
    const stray = setInterval(() => undefined, 1000);
    try {
      let exited: number | undefined;
      await exitWhenDone(async () => 0, (code) => {
        exited = code;
      }, () => undefined);
      expect(exited).toBe(0);
    } finally {
      clearInterval(stray);
    }
  });
});

describe("criterion 4: at 12 minutes the agent is stopped and the build fails with \"The build took too long.\"", () => {
  it("aborts the agent's signal at the limit, not before, and records the failure, the tokens spent and no commit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await setup([{ write: "index.html", content: PAGE }, { tokens: TOKENS }, { hang: true }]);
    let outcome: string | undefined;
    void runBuild({ buildId: BUILD, token: TOKEN }, t.deps).then((value) => (outcome = value));
    await settle(() => t.agent.runs.length === 1 && filesOf(t.records.builds.get(BUILD)?.feed).length === 1);
    expect(BUILD_AGENT_TIMEOUT_MS).toBe(12 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(BUILD_AGENT_TIMEOUT_MS - 1);
    expect(t.agent.runs[0]?.signal.aborted).toBe(false);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.agent.runs[0]?.signal.aborted).toBe(true);
    await settle(() => outcome !== undefined);
    expect(outcome).toBe("failed");
    const build = t.records.builds.get(BUILD);
    expect(build?.status).toBe("failed");
    expect(build?.failureReasons).toEqual([TIME_UP_REASON]);
    expect(TIME_UP_REASON).toBe("The build took too long.");
    expect(t.github.history("ssd-ada")).toHaveLength(1);
    expect(t.queue.sent).toEqual([]);
    expect(t.records.usage.get("p-1")).toEqual(usageOfTokens(TOKENS, MODELS.build.price));
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "builder", phase: "writing", outcome: "timeout" }));
  });

  it("stops at the limit even when the agent ignores its signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await setup([]);
    t.deps.agent = { run: () => new Promise(() => undefined) };
    let outcome: string | undefined;
    void runBuild({ buildId: BUILD, token: TOKEN }, t.deps).then((value) => (outcome = value));
    await settle(() => steps(t.records.builds.get(BUILD)?.feed).includes("writing"));
    await vi.advanceTimersByTimeAsync(BUILD_AGENT_TIMEOUT_MS);
    await settle(() => outcome !== undefined);
    expect(t.records.builds.get(BUILD)?.failureReasons).toEqual([TIME_UP_REASON]);
  });
});

describe("criterion 5: the build's tokens and their cost are added to the participant's usage", () => {
  it("adds every input kind and the output, priced at the build role's EU prices", async () => {
    const t = await setup(goodScript());
    await runBuild({ buildId: BUILD, token: TOKEN }, t.deps);
    const usage = t.records.usage.get("p-1");
    expect(usage).toEqual({ inputTokens: 641_000, outputTokens: 20_000, costUsd: 0.6963 });
    // 1,000 x 3.30 + 20,000 x 16.50 + 600,000 x 0.33 + 40,000 x 4.125, per million.
    expect(MODELS.build.price).toEqual({ input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 });
    expect(t.records.writes.filter((write) => write.method === "addUsage")).toHaveLength(1);
  });

  it("adds the tokens of a failed run too", async () => {
    const t = await setup([{ tokens: TOKENS }, { fail: true }]);
    await runBuild({ buildId: BUILD, token: TOKEN }, t.deps);
    expect(t.records.usage.get("p-1")?.costUsd).toBe(0.6963);
  });
});

describe("criterion 6: the runner's output and the feed hold no token and no email address", () => {
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  it("logs counts and names only, and keeps email-shaped text out of the feed's file names", async () => {
    const script: AgentStep[] = [...goodScript(), { write: "ada.lovelace@example.org.html", content: "<p>x</p>" }];
    const t = await setup(script);
    await runBuild({ buildId: BUILD, token: TOKEN }, t.deps);
    const output = t.logs.map((entry) => JSON.stringify(entry)).join("\n");
    const feed = JSON.stringify(t.records.builds.get(BUILD));
    for (const text of [output, feed]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(FAKE_TOKEN_PREFIX);
      expect(text).not.toMatch(EMAIL);
    }
    expect(filesOf(t.records.builds.get(BUILD)?.feed)).toContain("[email removed]");
    // No nickname, build id or file name in the logs either.
    expect(output).not.toContain("Ada");
    expect(output).not.toContain(BUILD);
    expect(output).not.toContain("index.html");
    // The token reached GitHub only (the authorization header).
    expect([...t.github.bearers]).toEqual([TOKEN]);
  });

  it("logs the same way on a successful build", async () => {
    const t = await setup(goodScript());
    await runBuild({ buildId: BUILD, token: TOKEN }, t.deps);
    const output = t.logs.map((entry) => JSON.stringify(entry)).join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toMatch(EMAIL);
    expect(JSON.stringify(t.records.builds.get(BUILD))).not.toMatch(EMAIL);
    expect(t.logs.filter((entry) => entry.event === "builder").map((entry) => (entry as BuilderLogEntry).phase)).toEqual([
      "start",
      "preparing",
      "writing",
      "usage",
      "checking",
      "committing",
      "deploying",
      "finish",
    ]);
  });
});

describe("planCommits", () => {
  const file = (path: string, text: string) => ({ path, bytes: new TextEncoder().encode(text) });
  const base = [file("index.html", "a"), file("app.js", "b"), file("README.md", "c")];

  it("splits the page and its look from the behaviour and notes, each commit holding the whole app", () => {
    const final = [file("index.html", "A"), file("style.css", "s"), file("app.js", "B"), file("README.md", "c")];
    const plan = planCommits(base, final);
    expect(plan.map((commit) => commit.message)).toEqual([PAGE_COMMIT_MESSAGE, BEHAVIOUR_COMMIT_MESSAGE]);
    expect(plan[0]?.files.map((f) => f.path).sort()).toEqual(["README.md", "app.js", "index.html", "style.css"]);
    expect(new TextDecoder().decode(plan[0]?.files.find((f) => f.path === "app.js")?.bytes)).toBe("b");
    expect(plan[1]?.files).toEqual(final);
  });

  it("makes one commit when one group changed, none when nothing did", () => {
    expect(planCommits(base, base)).toEqual([]);
    expect(planCommits(base, [file("index.html", "A"), file("app.js", "b"), file("README.md", "c")]).map((c) => c.message)).toEqual([SINGLE_COMMIT_MESSAGE]);
    expect(planCommits(base, [file("index.html", "a"), file("app.js", "B"), file("README.md", "c")]).map((c) => c.message)).toEqual([SINGLE_COMMIT_MESSAGE]);
  });
});
