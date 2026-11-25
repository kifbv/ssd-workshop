// `npm run eval -- build` (ticket 2.8): one example spec through the real runner and the real coding agent (Claude Agent
// SDK on Bedrock through the runner's local Bedrock proxy, which signs with the caller's AWS credentials: the agent's
// process gets none), with GitHub, the table and the deploy queue in memory (no repository
// is created). The pushed commit is then checked as the deployer would (download, unpack, deploy check) and opened in
// Playwright's Chromium at 375 px, served under the apps' sandbox CSP with an in-memory data API.
// Ticket 2.14: the network stays open (only the app's own origin is routed), so an app that reads a free outside service
// reaches it; behind a session's HTTPS proxy, Chromium is sent through it (see `launchBrowser`).
// Ticket 2.15: the agent may read pages with WebFetch; the outcome counts them from the feed (hosts only). Behind a
// session's proxy the agent gets that proxy for its fetches (`webProxyEnvironment`); the builder task never does.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, type AgentOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { chromium, type Browser, type Route } from "playwright";
import { APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { checkApp, type AppFile } from "../../api/build/check.js";
import { contentTypeOf } from "../../api/deploy/deploy.js";
import { downloadArchive } from "../../api/deploy/github.js";
import { readTarGz } from "../../api/deploy/tar.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub } from "../../api/github/fakes.js";
import { FIRST_COMMIT_MESSAGE, withSpec } from "../../api/github/repository.js";
import { loadTemplateFiles } from "../../api/github/template.js";
import { appArchiveUrl, type ModelSetting } from "../../api/settings.js";
import { ClaudeAgent, webProxyEnvironment } from "../../builder/agent.js";
import type { BedrockProxyLogEntry } from "../../builder/bedrock-proxy.js";
import { FakeBuildRecords, FakeDeployQueue } from "../../builder/fakes.js";
import { runBuild, type BuilderLogEntry } from "../../builder/runner.js";
import { missingScreens, screenNames, specTitle, type BuildEvalOutcome } from "./logic.js";

const NICKNAME = "eval-app";
const REPOSITORY = "ssd-eval-app";
const BUILD_ID = "eval-build-1";
const PHONE = { width: 375, height: 740 };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept" };

/** Labels the title check reads: headings, buttons, tabs, links, labels, legends and aria-labels, hidden ones included. */
const LABELS_SCRIPT = `Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,button,[role=tab],[role=button],a,label,legend,summary,[aria-label]"))
  .flatMap((el) => [el.textContent || "", el.getAttribute("aria-label") || ""]).filter((t) => t.trim() !== "")`;

/** Opens the app's files at /apps/<nickname>/ in Chromium under the CSP and reads what the title check needs. */
async function openInBrowser(
  browser: Browser,
  files: readonly AppFile[],
): Promise<{ errors: string[]; overflow: number; title: string; labels: string[]; outsideHosts: string[] }> {
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
  const store = new Map<string, string>();
  const byPath = new Map(files.filter((file) => file.kind === "file").map((file) => [file.path, file]));
  await page.route(`${origin}/**`, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const dataPrefix = `/api/apps/${NICKNAME}/data/`;
    if (path.startsWith(dataPrefix)) {
      const key = path.slice(dataPrefix.length);
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (request.method() === "PUT") {
        store.set(key, request.postData() ?? "null");
        return route.fulfill({ status: 204, headers: CORS });
      }
      if (request.method() === "DELETE") {
        store.delete(key);
        return route.fulfill({ status: 204, headers: CORS });
      }
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: store.get(key) ?? "null" });
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
  try {
    await page.goto(`${origin}/apps/${NICKNAME}/`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate<number>(`Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth`);
    return {
      errors,
      overflow: Math.max(0, overflow),
      title: await page.title(),
      labels: await page.evaluate<string[]>(LABELS_SCRIPT),
      outsideHosts: [...outsideHosts].sort(),
    };
  } finally {
    await context.close();
  }
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
  const github = new FakeGitHub(() => new Date());
  github.addRepository(REPOSITORY);
  const files = withSpec(await loadTemplateFiles(), spec);
  const baseCommit = github.seedCommit(REPOSITORY, Object.fromEntries(files.map((file) => [file.path, new TextDecoder().decode(file.bytes)])), FIRST_COMMIT_MESSAGE);
  const token = `${FAKE_TOKEN_PREFIX}eval`;
  github.grants.set(token, { permissions: { contents: "write", metadata: "read" }, repositories: [REPOSITORY] });
  const records = new FakeBuildRecords();
  // As the launcher leaves it (ticket 2.9): building under one launch.
  const attemptId = randomUUID();
  records.builds.set(BUILD_ID, { nickname: NICKNAME, participantId: "eval-participant", status: "building", attemptId });
  const queue = new FakeDeployQueue();
  const fetchFake = (url: string, init?: RequestInit): Promise<Response> => github.fetch(url, init ?? {});
  const temporary: string[] = [];
  const started = Date.now();
  try {
    const outcome = await runBuild(
      { buildId: BUILD_ID, token, baseCommit, attemptId },
      {
        records,
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
            log,
          },
          // In a session, the agent's web fetches must go through the session's proxy (the builder task fetches directly).
          webProxyEnvironment(process.env),
        ),
        queue,
        makeWorkspace: () => mkdtemp(join(tmpdir(), "ssd-eval-build-")),
        removeWorkspace: (dir) => rm(dir, { recursive: true, force: true }),
        model,
        now: () => new Date(),
        log,
      },
    );
    const durationMs = Date.now() - started;
    const build = records.builds.get(BUILD_ID);
    const feed = build?.feed ?? [];
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
      durationMs,
      usage: records.usage.get("eval-participant") ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    const message = queue.sent[0];
    if (outcome !== "handed-over" || message === undefined || message.commit !== build?.pushedCommit) return base;
    // What the deployer would publish: the repository at the message's commit.
    const published = readTarGz(await downloadArchive(appArchiveUrl(NICKNAME, message.commit), { fetch: fetchFake }));
    const check = checkApp(published);
    const page = await openInBrowser(browser, published);
    return {
      ...base,
      checkPassed: check.ok,
      consoleErrors: page.errors,
      overflow: page.overflow,
      missing: missingScreens(specTitle(spec), screenNames(spec), page),
      outsideHosts: page.outsideHosts,
    };
  } finally {
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/** The HTTPS proxy a session sets for outbound traffic, if any (Chromium does not read it from the environment). */
const proxyServer = (): string | undefined => process.env.HTTPS_PROXY || process.env.https_proxy || undefined;

export const launchBrowser = (): Promise<Browser> => {
  const server = proxyServer();
  return chromium.launch(server === undefined ? {} : { proxy: { server } });
};
