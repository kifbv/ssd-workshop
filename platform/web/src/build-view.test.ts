// Ticket 2.10: the step 3 page's rules (build-view.ts).
import { describe, expect, it } from "vitest";
import {
  behindPart,
  BUILD_TEXTS,
  buildResult,
  commitUrl,
  currentStage,
  feedLines,
  isRunning,
  nowText,
  parseBuild,
  stageStates,
  type Build,
} from "./build-view.js";
import { MESSAGES, screenFor } from "./flow.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/ssd-workshop-apps/ssd-ada-l";
const at = "2026-11-25T10:00:00.000Z";

const build = (over: Partial<Build> = {}): Build => ({ buildId: "b-1", status: "building", feed: [], repositoryUrl: REPO, ...over });

describe("commitUrl", () => {
  it("WHEN a commit link is shown THEN it points to https://github.com/<owner>/ssd-<nickname>/commit/<sha>", () => {
    expect(commitUrl(REPO, SHA)).toBe(`https://github.com/ssd-workshop-apps/ssd-ada-l/commit/${SHA}`);
  });

  it("gives no link for an id or a repository the page does not trust", () => {
    expect(commitUrl(REPO, "../../evil")).toBeUndefined();
    expect(commitUrl(REPO, SHA.toUpperCase())).toBeUndefined();
    expect(commitUrl(undefined, SHA)).toBeUndefined();
    expect(commitUrl("https://evil.example/ssd-workshop-apps/ssd-ada-l", SHA)).toBeUndefined();
    expect(commitUrl("javascript:alert(1)//github.com/a/ssd-abc", SHA)).toBeUndefined();
    expect(commitUrl("https://github.com/ssd-workshop-apps/other", SHA)).toBeUndefined();
  });
});

describe("parseBuild and buildResult", () => {
  it("reads the build, keeps known feed events in order and drops the rest", () => {
    const body = {
      buildId: "b-1",
      status: "building",
      feed: [
        { kind: "step", step: "preparing", at },
        { kind: "step", step: "hacking", at },
        { kind: "file", path: "<b>index.html</b>", at },
        { kind: "fetch", host: "en.wikipedia.org", at },
        { kind: "commit", sha: SHA, message: "Add the home screen", at },
        { kind: "commit", sha: "nope", message: "x", at },
        "junk",
      ],
      repositoryUrl: REPO,
      appUrl: "https://workshop.rankly.games/apps/ada-l/",
    };
    expect(parseBuild(body)).toEqual({
      buildId: "b-1",
      status: "building",
      feed: [
        { kind: "step", step: "preparing", at },
        { kind: "file", path: "<b>index.html</b>", at },
        { kind: "fetch", host: "en.wikipedia.org", at },
        { kind: "commit", sha: SHA, message: "Add the home screen", at },
      ],
      repositoryUrl: REPO,
      appUrl: "https://workshop.rankly.games/apps/ada-l/",
    });
    // Links only to the expected places.
    expect(parseBuild({ ...body, repositoryUrl: "https://evil.example/x", appUrl: "https://evil.example/apps/ada-l/" })).not.toHaveProperty("appUrl");
    expect(parseBuild({ ...body, repositoryUrl: "https://evil.example/x" })).not.toHaveProperty("repositoryUrl");
    expect(parseBuild({ buildId: "b-1", status: "odd" })).toBeUndefined();
    expect(parseBuild({ buildId: "b-1", status: "queued" })).toEqual({ buildId: "b-1", status: "queued", feed: [] });
    expect(parseBuild({ buildId: "b-1", status: "failed", failureReasons: ["a", 3] })).toEqual({ buildId: "b-1", status: "failed", feed: [], failureReasons: ["a"] });
  });

  it("answers a build, missing (404: keep asking), signed out, or a message", () => {
    expect(buildResult({ status: 200, body: { buildId: "b-1", status: "queued" } })).toEqual({ kind: "build", build: { buildId: "b-1", status: "queued", feed: [] } });
    expect(buildResult({ status: 200, body: {} })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
    expect(buildResult({ status: 404, body: {} })).toEqual({ kind: "missing" });
    expect(buildResult({ status: 401, body: {} })).toEqual({ kind: "signed-out" });
    expect(buildResult({ status: 429, body: {} })).toEqual({ kind: "show", message: MESSAGES.retry, tone: "info" });
    expect(buildResult({ status: 0, body: null })).toEqual({ kind: "show", message: MESSAGES.offline, tone: "error" });
    expect(buildResult({ status: 500, body: {} })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
  });
});

describe("stages, lines and the behind-the-scenes part", () => {
  it("polls while queued, building or deploying, and stops on live or failed", () => {
    expect(["queued", "building", "deploying"].every((s) => isRunning(s as Build["status"]))).toBe(true);
    expect(isRunning("live")).toBe(false);
    expect(isRunning("failed")).toBe(false);
  });

  it("highlights the last step reached; deploying and live follow the status", () => {
    const steps = build({ feed: [{ kind: "step", step: "preparing", at }, { kind: "file", path: "a.js", at }, { kind: "step", step: "writing", at }] });
    expect(currentStage(build({ status: "queued" }))).toBeUndefined();
    expect(currentStage(steps)).toBe("writing");
    expect(stageStates(steps)).toEqual({ preparing: "done", writing: "current", checking: "todo", committing: "todo", deploying: "todo", live: "todo" });
    expect(currentStage({ ...steps, status: "deploying" })).toBe("deploying");
    expect(currentStage({ ...steps, status: "live" })).toBe("live");
    expect(Object.values(stageStates(build({ status: "queued" })))).toEqual(["todo", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("says what happens now, and the failure message when it failed", () => {
    expect(nowText(build({ status: "queued" }))).toBe(BUILD_TEXTS.now.queued);
    expect(nowText(build({ feed: [{ kind: "step", step: "checking", at }] }))).toBe(BUILD_TEXTS.now.checking);
    expect(nowText(build({ status: "failed" }))).toBe("Something went wrong with your build. Your facilitator can restart it.");
  });

  it("lists files, pages read (\"Read <host>\") and commits with their link, oldest first", () => {
    const lines = feedLines(
      build({
        feed: [
          { kind: "step", step: "writing", at },
          { kind: "file", path: "index.html", at },
          { kind: "fetch", host: "en.wikipedia.org", at },
          { kind: "commit", sha: SHA, message: "Add the home screen", at },
        ],
      }),
    );
    expect(lines).toEqual([
      { kind: "file", label: "Wrote", text: "index.html" },
      { kind: "fetch", label: "Read", text: "en.wikipedia.org" },
      { kind: "commit", label: "Saved", text: "Add the home screen", link: { href: `${REPO}/commit/${SHA}`, text: "0123456" } },
    ]);
    expect(feedLines({ buildId: "b-1", status: "building", feed: [{ kind: "commit", sha: SHA, message: "m", at }] })[0]).not.toHaveProperty("link");
  });

  it("follows the brief's flow in the behind-the-scenes box", () => {
    expect(behindPart(build({ status: "queued" }))).toBe("launcher");
    const part = (step: "preparing" | "writing" | "checking" | "committing" | "deploying") => behindPart(build({ feed: [{ kind: "step", step, at }] }));
    expect([part("preparing"), part("writing"), part("checking"), part("committing"), part("deploying")]).toEqual(["builder", "agent", "builder", "github", "deployer"]);
    expect(behindPart(build({ status: "live" }))).toBe("app");
    expect(behindPart(build({ status: "failed" }))).toBeUndefined();
  });

  it("sends a participant at step building to the step 3 screen", () => {
    expect(screenFor({ id: "p-1", nickname: "ada", role: "participant", group: "g1", step: "building" })).toBe("build");
  });
});
