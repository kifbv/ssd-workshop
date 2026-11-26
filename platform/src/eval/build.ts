// `npm run eval -- build` (ticket 2.8): one example spec through the real runner and the real coding agent (Claude Agent
// SDK on Bedrock through the runner's local Bedrock proxy, which signs with the caller's AWS credentials: the agent's
// process gets none), with GitHub, the table and the deploy queue in memory (no repository
// is created). The pushed commit is then checked as the deployer would (download, unpack, deploy check) and opened in
// Playwright's Chromium at 375 px, served under the apps' sandbox CSP with an in-memory data API.
// Ticket 2.14: the network stays open (only the app's own origin is routed), so an app that reads a free outside service
// reaches it; behind a session's HTTPS proxy, Chromium is sent through it (see `launchBrowser`).
// Ticket 2.15: the agent may read pages with WebFetch; the outcome counts them from the feed (hosts only). Behind a
// session's proxy the agent gets that proxy for its fetches (`webProxyEnvironment`); the builder task never does.
// Ticket 3.7: `evalChange` builds an example, then changes it with a change build (the live app on main, edited).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, type AgentOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { chromium, type Browser, type Route } from "playwright";
import { APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { checkApp, type AppFile } from "../../api/build/check.js";
import { contentTypeOf, DATA_CLIENT_PATH, withPlatformDataClient } from "../../api/deploy/deploy.js";
import { downloadArchive } from "../../api/deploy/github.js";
import { readTarGz } from "../../api/deploy/tar.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub } from "../../api/github/fakes.js";
import { FIRST_COMMIT_MESSAGE, removeEmailAddresses, SPEC_FILE, withSpec } from "../../api/github/repository.js";
import { answerChange } from "../../api/conversation/change.js";
import { usageOf, type ModelClient } from "../../api/conversation/model.js";
import { loadTemplateFiles } from "../../api/github/template.js";
import { appArchiveUrl, type ModelSetting } from "../../api/settings.js";
import { APP_SIGN_IN_TEXTS } from "../../api/workshop/texts.js";
import { ClaudeAgent, webProxyEnvironment } from "../../builder/agent.js";
import type { BedrockProxyLogEntry } from "../../builder/bedrock-proxy.js";
import { FakeBuildRecords, FakeDeployQueue } from "../../builder/fakes.js";
import { runBuild, type BuilderLogEntry } from "../../builder/runner.js";
import { missingScreens, screenNames, specTitle, type BuildEvalOutcome, type ChangeEvalOutcome, type SignInCheck } from "./logic.js";

const NICKNAME = "eval-app";
const REPOSITORY = "ssd-eval-app";
const BUILD_ID = "eval-build-1";
const CHANGE_BUILD_ID = "eval-build-2";
const PARTICIPANT = "eval-participant";
const PHONE = { width: 375, height: 740 };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" };
/** Ticket 3.25: what the in-memory data API answers a write without a valid token, as the real one does (3.24). */
const SIGN_IN_TO_SAVE = JSON.stringify({ message: APP_SIGN_IN_TEXTS.signInToSave });

/**
 * Ticket 3.25: the sign-in elements a visitor sees once the page settled. `shown`: not hidden and reading "Sign in" (text
 * or aria-label); `visible`: those also laid out on the first screen (marked so the harness can press the first one).
 */
const SIGN_IN_SCRIPT = `(() => {
  const shown = Array.from(document.querySelectorAll("[data-workshop-sign-in]"))
    .filter((el) => !el.hidden && /sign in/i.test((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")));
  const visible = shown.filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
  if (visible[0]) visible[0].setAttribute("data-eval-sign-in", "");
  return { shown: shown.length, visible: visible.length };
})()`;

/** Labels the title check reads: headings, buttons, tabs, links, labels, legends and aria-labels, hidden ones included. */
const LABELS_SCRIPT = `Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,button,[role=tab],[role=button],a,label,legend,summary,[aria-label]"))
  .flatMap((el) => [el.textContent || "", el.getAttribute("aria-label") || ""]).filter((t) => t.trim() !== "")`;

/**
 * Opens the app's files at /apps/<nickname>/ in Chromium under the CSP, as a visitor (no token: ticket 3.25), and reads
 * what the title check and the sign-in check need.
 */
async function openInBrowser(
  browser: Browser,
  files: readonly AppFile[],
): Promise<{ errors: string[]; overflow: number; title: string; labels: string[]; outsideHosts: string[]; signIn: SignInCheck }> {
  const origin = "https://workshop.test";
  // Behind the session's proxy, HTTPS answers are re-signed by the proxy's own authority, which Chromium does not know.
  const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: proxyServer() !== undefined });
  const page = await context.newPage();
  const errors: string[] = [];
  const outsideHosts = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && url.protocol !== "data:") outsideHosts.add(url.host);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const byPath = new Map(files.filter((file) => file.kind === "file").map((file) => [file.path, file]));
  await page.route(`${origin}/**`, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const dataPrefix = `/api/apps/${NICKNAME}/data/`;
    if (path.startsWith(dataPrefix)) {
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      // Ticket 3.24: a visitor has no token, so every write is refused as the real API refuses it (Chromium logs the
      // 401, so an app that saves without the visitor doing anything fails the console check: apps work read-only).
      if (request.method() === "PUT" || request.method() === "DELETE") {
        return route.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: SIGN_IN_TO_SAVE });
      }
      // Nothing is ever stored (a visitor cannot save): every key reads null, with `?info=1` too.
      const body = new URL(request.url()).searchParams.get("info") === "1" ? `{"value":null,"updatedBy":null,"updatedAt":null}` : "null";
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body });
    }
    const appPrefix = `/apps/${NICKNAME}/`;
    const relative = path.startsWith(appPrefix) ? path.slice(appPrefix.length) || "index.html" : "";
    const file = byPath.get(relative);
    if (file === undefined) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      status: 200,
      headers: { "content-type": contentTypeOf(relative), "content-security-policy": APPS_CONTENT_SECURITY_POLICY, "x-content-type-options": "nosniff" },
      body: Buffer.from(file.bytes),
    });
  });
  // The tab the sign-in button opens: a stand-in for the workshop's hand-off page (its address is what is checked).
  const handOff = `${origin}/app-sign-in/?app=${NICKNAME}`;
  await context.route(`${origin}/app-sign-in/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Sign in</title>" }));
  try {
    await page.goto(`${origin}/apps/${NICKNAME}/`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate<number>(`Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth`);
    const title = await page.title();
    const labels = await page.evaluate<string[]>(LABELS_SCRIPT);
    // Ticket 3.25: the visitor finds the sign-in button, and pressing it opens the hand-off page in a new tab.
    const found = await page.evaluate<{ shown: number; visible: number }>(SIGN_IN_SCRIPT);
    let opens: boolean | undefined;
    if (found.visible > 0) {
      const popup = context.waitForEvent("page", { timeout: 5_000 }).catch(() => undefined);
      await page.click("[data-eval-sign-in]", { timeout: 5_000 }).catch(() => undefined);
      const tab = await popup;
      opens = tab !== undefined && (await tab.waitForURL(handOff, { timeout: 5_000 }).then(() => true, () => false));
    }
    return { errors, overflow: Math.max(0, overflow), title, labels, outsideHosts: [...outsideHosts].sort(), signIn: { ...found, opens } };
  } finally {
    await context.close();
  }
}

/** What one build of the eval needs: the in-memory GitHub, table and queue, the model and the log. */
interface EvalWorld {
  github: FakeGitHub;
  records: FakeBuildRecords;
  queue: FakeDeployQueue;
  token: string;
  model: ModelSetting;
  log: (entry: BuilderLogEntry | BedrockProxyLogEntry) => void;
}

function evalWorld(model: ModelSetting, log: EvalWorld["log"]): EvalWorld {
  const github = new FakeGitHub(() => new Date());
  github.addRepository(REPOSITORY);
  const token = `${FAKE_TOKEN_PREFIX}eval`;
  github.grants.set(token, { permissions: { contents: "write", metadata: "read" }, repositories: [REPOSITORY] });
  return { github, records: new FakeBuildRecords(), queue: new FakeDeployQueue(), token, model, log };
}

const fetchFakeOf = (github: FakeGitHub) => (url: string, init?: RequestInit): Promise<Response> => github.fetch(url, init ?? {});

/**
 * Runs the real runner and coding agent on one build already stored in `world.records` (building under `attemptId`),
 * from `baseCommit`. Returns the outcome (usage: this build's only) and, when handed over, the files the deployer would
 * publish (the repository at the deploy message's commit).
 */
async function runEvalBuild(
  world: EvalWorld,
  buildId: string,
  baseCommit: string,
  attemptId: string,
): Promise<{ outcome: BuildEvalOutcome; published?: AppFile[]; commit?: string }> {
  const fetchFake = fetchFakeOf(world.github);
  const temporary: string[] = [];
  const usageBefore = world.records.usage.get(PARTICIPANT) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const sentBefore = world.queue.sent.length;
  const started = Date.now();
  try {
    const outcome = await runBuild(
      { buildId, token: world.token, baseCommit, attemptId },
      {
        records: world.records,
        github: { fetch: fetchFake, now: () => new Date(), log: () => undefined },
        download: (url) => downloadArchive(url, { fetch: fetchFake }),
        agent: new ClaudeAgent(
          process.env,
          async () => {
            const home = await mkdtemp(join(tmpdir(), "ssd-eval-agent-home-"));
            temporary.push(home);
            return home;
          },
          {
            credentials: defaultProvider(),
            ...(process.env.HTTPS_PROXY || process.env.https_proxy ? { agent: new Agent({ proxyEnv: process.env } as AgentOptions) } : {}),
            log: world.log,
          },
          // In a session, the agent's web fetches must go through the session's proxy (the builder task fetches directly).
          webProxyEnvironment(process.env),
        ),
        queue: world.queue,
        makeWorkspace: () => mkdtemp(join(tmpdir(), "ssd-eval-build-")),
        removeWorkspace: (dir) => rm(dir, { recursive: true, force: true }),
        model: world.model,
        now: () => new Date(),
        log: world.log,
      },
    );
    const durationMs = Date.now() - started;
    const build = world.records.builds.get(buildId);
    const feed = build?.feed ?? [];
    const total = world.records.usage.get(PARTICIPANT) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const base: BuildEvalOutcome = {
      outcome,
      failureReasons: build?.failureReasons ?? [],
      steps: feed.flatMap((event) => (event.kind === "step" ? [event.step] : [])),
      files: feed.filter((event) => event.kind === "file").length,
      commits: feed.filter((event) => event.kind === "commit").length,
      fetches: feed.filter((event) => event.kind === "fetch").length,
      fetchHosts: [...new Set(feed.flatMap((event) => (event.kind === "fetch" ? [event.host] : [])))].sort(),
      checkPassed: false,
      consoleErrors: [],
      overflow: 0,
      missing: [],
      outsideHosts: [],
      signIn: { shown: 0, visible: 0, opens: undefined },
      durationMs,
      usage: {
        inputTokens: total.inputTokens - usageBefore.inputTokens,
        outputTokens: total.outputTokens - usageBefore.outputTokens,
        costUsd: total.costUsd - usageBefore.costUsd,
      },
    };
    const message = world.queue.sent[sentBefore];
    if (outcome !== "handed-over" || message === undefined || message.commit !== build?.pushedCommit) return { outcome: base };
    // What the deployer would publish: the repository at the message's commit, with (ticket 3.25) the platform's current
    // workshop-data.js, whatever the repository holds.
    const dataClient = (await loadTemplateFiles()).find((file) => file.path === DATA_CLIENT_PATH)?.bytes ?? new Uint8Array();
    const published = withPlatformDataClient(readTarGz(await downloadArchive(appArchiveUrl(NICKNAME, message.commit), { fetch: fetchFake })), dataClient);
    return { outcome: base, published, commit: message.commit };
  } finally {
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/** The deploy check and the page at 375 px for the published files, scored against `spec`'s title and screens. */
async function checkPublished(browser: Browser, published: AppFile[], spec: string): Promise<Pick<BuildEvalOutcome, "checkPassed" | "consoleErrors" | "overflow" | "missing" | "outsideHosts" | "signIn"> & { page: { title: string; labels: string[] } }> {
  const check = checkApp(published);
  const page = await openInBrowser(browser, published);
  return {
    checkPassed: check.ok,
    consoleErrors: page.errors,
    overflow: page.overflow,
    missing: missingScreens(specTitle(spec), screenNames(spec), page),
    outsideHosts: page.outsideHosts,
    signIn: page.signIn,
    page: { title: page.title, labels: page.labels },
  };
}

/** A first build of `spec` in `world`: the repository starts as the launcher prepares it (template and spec). */
async function firstBuild(world: EvalWorld, spec: string, browser: Browser): Promise<{ outcome: BuildEvalOutcome; commit?: string }> {
  const files = withSpec(await loadTemplateFiles(), spec);
  const baseCommit = world.github.seedCommit(REPOSITORY, Object.fromEntries(files.map((file) => [file.path, new TextDecoder().decode(file.bytes)])), FIRST_COMMIT_MESSAGE);
  // As the launcher leaves it (ticket 2.9): building under one launch.
  const attemptId = randomUUID();
  world.records.builds.set(BUILD_ID, { nickname: NICKNAME, participantId: PARTICIPANT, status: "building", attemptId });
  const run = await runEvalBuild(world, BUILD_ID, baseCommit, attemptId);
  if (run.published === undefined) return { outcome: run.outcome };
  const checked = await checkPublished(browser, run.published, spec);
  return { outcome: { ...run.outcome, checkPassed: checked.checkPassed, consoleErrors: checked.consoleErrors, overflow: checked.overflow, missing: checked.missing, outsideHosts: checked.outsideHosts, signIn: checked.signIn }, ...(run.commit === undefined ? {} : { commit: run.commit }) };
}

/**
 * Runs one spec end to end. `log` receives the runner's phase lines (counts only) and the Bedrock proxy's lines (a
 * path's shape and a status). The caller's AWS credentials stay in this process (the proxy signs with them); the
 * agent's process gets none.
 */
export async function evalBuild(
  spec: string,
  model: ModelSetting,
  browser: Browser,
  log: (entry: BuilderLogEntry | BedrockProxyLogEntry) => void,
): Promise<BuildEvalOutcome> {
  return (await firstBuild(evalWorld(model, log), spec, browser)).outcome;
}

/**
 * Ticket 3.7, `npm run eval -- change`: builds `spec` (the first build), then asks the real change conversation
 * (`answerChange`, prompt change-v2) for `request` on it, and runs the change build as the launcher would start it:
 * the repository's current `main` as the base commit, the new version and its "What changes" list on the build. The
 * pushed commit is then checked as the deployer would (deploy check), opened at 375 px, and scored on the new spec's
 * title and screens and on the previous spec's screens (still there), its message ("Change 1: ...") and its SPEC.md.
 */
export async function evalChange(
  spec: string,
  request: string,
  model: ModelSetting,
  changeModel: ModelClient,
  browser: Browser,
  log: (entry: BuilderLogEntry | BedrockProxyLogEntry) => void,
): Promise<ChangeEvalOutcome> {
  const world = evalWorld(model, log);
  const first = await firstBuild(world, spec, browser);
  const empty = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (first.commit === undefined) return { first: first.outcome, specUsage: empty, whatChanges: [], previousMissing: [], specCommitted: false };
  const started = Date.now();
  const answer = await answerChange(changeModel, [], request, spec, undefined);
  const specUsage = { ...usageOf(answer), durationMs: Date.now() - started };
  if (answer.spec === undefined || answer.whatChanges === undefined) {
    return { first: first.outcome, specUsage, whatChanges: [], previousMissing: [], specCommitted: false, specProblem: "the change call wrote no new spec" };
  }
  const newSpec = answer.spec;
  const attemptId = randomUUID();
  // As 3.6's ready transaction and the launcher leave it: a change build of the new version, building under one launch.
  world.records.builds.set(CHANGE_BUILD_ID, {
    nickname: NICKNAME,
    participantId: PARTICIPANT,
    status: "building",
    attemptId,
    kind: "change",
    changeNumber: 1,
    changeSpec: newSpec,
    changeList: answer.whatChanges,
  });
  const main = world.github.repo(REPOSITORY).main ?? "";
  const run = await runEvalBuild(world, CHANGE_BUILD_ID, main, attemptId);
  const base = { first: first.outcome, specUsage, whatChanges: answer.whatChanges, newSpec };
  if (run.published === undefined || run.commit === undefined) return { ...base, change: run.outcome, previousMissing: [], specCommitted: false };
  const { page, ...checked } = await checkPublished(browser, run.published, newSpec);
  const commitMessage = world.github.history(REPOSITORY).find((commit) => commit.sha === run.commit)?.message;
  return {
    ...base,
    change: { ...run.outcome, ...checked },
    previousMissing: missingScreens(undefined, screenNames(spec), page),
    specCommitted: world.github.filesAt(REPOSITORY, run.commit)[SPEC_FILE] === removeEmailAddresses(newSpec),
    ...(commitMessage === undefined ? {} : { commitMessage }),
  };
}

/** The HTTPS proxy a session sets for outbound traffic, if any (Chromium does not read it from the environment). */
const proxyServer = (): string | undefined => process.env.HTTPS_PROXY || process.env.https_proxy || undefined;

export const launchBrowser = (): Promise<Browser> => {
  const server = proxyServer();
  return chromium.launch(server === undefined ? {} : { proxy: { server } });
};
