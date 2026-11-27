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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, type AgentOptions } from "node:https";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { APP_MEDIA_CONTENT_SECURITY_POLICY, APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { inspectMedia, MEDIA_CONTENT_TYPES } from "../../api/app-media/formats.js";
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
import { MEDIA_WORDS, missingScreens, screenNames, SIGN_IN_SCRIPT, specTitle, type BuildEvalOutcome, type ChangeEvalOutcome, type MediaCase, type MediaCheck, type SignInCheck } from "./logic.js";

const NICKNAME = "eval-app";
const EVAL_ORIGIN = "https://workshop.test";
const REPOSITORY = "ssd-eval-app";
const BUILD_ID = "eval-build-1";
const CHANGE_BUILD_ID = "eval-build-2";
const PARTICIPANT = "eval-participant";
const PHONE = { width: 375, height: 740 };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" };
/** Ticket 3.25: what the in-memory data API answers a write without a valid token, as the real one does (3.24). */
const SIGN_IN_TO_SAVE = JSON.stringify({ message: APP_SIGN_IN_TEXTS.signInToSave });

/** Labels the title check reads: headings, buttons, tabs, links, labels, legends and aria-labels, hidden ones included. */
const LABELS_SCRIPT = `Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,button,[role=tab],[role=button],a,label,legend,summary,[aria-label]"))
  .flatMap((el) => [el.textContent || "", el.getAttribute("aria-label") || ""]).filter((t) => t.trim() !== "")`;

/** Ticket 3.19: the write token of the signed-in pass (a media case), and the nickname the in-memory API names for it. */
const EVAL_TOKEN = Buffer.alloc(32, 5).toString("base64url");
const EVAL_WRITER = "eval-writer";
const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;
const MEDIA_MESSAGES = { signInToSave: APP_SIGN_IN_TEXTS.signInToSave, unsupported: "Send a photo as a JPEG, or a voice recording as WebM, Ogg or MP4 audio." };

/**
 * The in-memory workshop an app is opened on: its files under the apps' CSP, the data API (ticket 2.4) and, since ticket
 * 3.19, the media API (ticket 3.18) and `/app-media/...`. Without a token (a visitor) every write is refused with 401 as
 * the real API refuses it; with `token`, writes are stored, read back, and files are judged by the real format check and
 * served back.
 */
interface EvalApi {
  data: Map<string, string>;
  media: Map<string, { bytes: Buffer; type: string }>;
  /** Every data and media write the app sent: method, path, status, and for data the body. */
  writes: { method: string; path: string; status: number; body: string }[];
}

async function routeApp(page: Page, files: readonly AppFile[], token: string | undefined): Promise<EvalApi> {
  const api: EvalApi = { data: new Map(), media: new Map(), writes: [] };
  const byPath = new Map(files.filter((file) => file.kind === "file").map((file) => [file.path, file]));
  const json = (route: Route, status: number, body: string) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body });
  await page.route(`${EVAL_ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const dataPrefix = `/api/apps/${NICKNAME}/data/`;
    const mediaPrefix = `/api/apps/${NICKNAME}/media/`;
    const signedIn = token !== undefined && request.headers().authorization === `Bearer ${token}`;
    if (path.startsWith(dataPrefix) || path.startsWith(mediaPrefix)) {
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const write = request.method() === "PUT" || request.method() === "DELETE";
      // Ticket 3.24: a visitor has no token, so every write is refused as the real API refuses it (Chromium logs the
      // 401, so an app that saves without the visitor doing anything fails the console check: apps work read-only).
      if (write && !signedIn) {
        api.writes.push({ method: request.method(), path, status: 401, body: "" });
        return json(route, 401, SIGN_IN_TO_SAVE);
      }
      if (path.startsWith(mediaPrefix)) {
        const id = path.slice(mediaPrefix.length);
        if (!MEDIA_ID.test(id) || !write) return json(route, 400, JSON.stringify({ message: "Bad request." }));
        if (request.method() === "DELETE") {
          api.media.delete(id);
          api.writes.push({ method: "DELETE", path, status: 204, body: "" });
          return route.fulfill({ status: 204, headers: CORS });
        }
        const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
        const found = inspectMedia(bytes);
        const status = found === undefined || api.media.has(id) ? 415 : 201;
        api.writes.push({ method: "PUT", path, status, body: "" });
        if (found === undefined || status !== 201) return json(route, 415, JSON.stringify({ message: MEDIA_MESSAGES.unsupported }));
        const stored = found.kind === "jpeg" ? found.photo : bytes;
        api.media.set(id, { bytes: stored, type: MEDIA_CONTENT_TYPES[found.kind] });
        return json(route, 201, JSON.stringify({ address: `${EVAL_ORIGIN}/app-media/${NICKNAME}/${id}`, contentType: MEDIA_CONTENT_TYPES[found.kind], bytes: stored.length }));
      }
      const key = path.slice(dataPrefix.length);
      if (url.searchParams.get("whoami") === "1") {
        return signedIn ? json(route, 200, JSON.stringify({ nickname: EVAL_WRITER })) : json(route, 401, SIGN_IN_TO_SAVE);
      }
      if (request.method() === "PUT") {
        const body = request.postData() ?? "";
        api.data.set(key, body);
        api.writes.push({ method: "PUT", path, status: 204, body });
        return route.fulfill({ status: 204, headers: CORS });
      }
      if (request.method() === "DELETE") {
        api.data.delete(key);
        api.writes.push({ method: "DELETE", path, status: 204, body: "" });
        return route.fulfill({ status: 204, headers: CORS });
      }
      // A visitor sees nothing stored (nobody could save): every key reads null, with `?info=1` too.
      const value = api.data.get(key) ?? "null";
      const by = api.data.has(key) ? JSON.stringify(EVAL_WRITER) : "null";
      const body = url.searchParams.get("info") === "1" ? `{"value":${value},"updatedBy":${by},"updatedAt":${by === "null" ? "null" : '"2026-11-27T10:00:00.000Z"'}}` : value;
      return json(route, 200, body);
    }
    const stored = path.startsWith(`/app-media/${NICKNAME}/`) ? api.media.get(path.slice(`/app-media/${NICKNAME}/`.length)) : undefined;
    if (stored !== undefined) {
      return route.fulfill({ status: 200, headers: { "content-type": stored.type, "content-security-policy": APP_MEDIA_CONTENT_SECURITY_POLICY, "x-content-type-options": "nosniff" }, body: stored.bytes });
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
  return api;
}

/** A context at phone width and a page that collects console errors and the outside hosts it asked. */
async function evalPage(browser: Browser): Promise<{ context: BrowserContext; page: Page; errors: string[]; outsideHosts: Set<string> }> {
  // Behind the session's proxy, HTTPS answers are re-signed by the proxy's own authority, which Chromium does not know.
  const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: proxyServer() !== undefined });
  const page = await context.newPage();
  const errors: string[] = [];
  const outsideHosts = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== EVAL_ORIGIN && url.protocol !== "data:") outsideHosts.add(url.host);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors, outsideHosts };
}

/**
 * Opens the app's files at /apps/<nickname>/ in Chromium under the CSP, as a visitor (no token: ticket 3.25), and reads
 * what the title check and the sign-in check need.
 */
async function openInBrowser(
  browser: Browser,
  files: readonly AppFile[],
): Promise<{ errors: string[]; overflow: number; title: string; labels: string[]; outsideHosts: string[]; signIn: SignInCheck }> {
  const { context, page, errors, outsideHosts } = await evalPage(browser);
  await routeApp(page, files, undefined);
  // The tab the sign-in button opens: a stand-in for the workshop's hand-off page (its address is what is checked).
  const handOff = `${EVAL_ORIGIN}/app-sign-in/?app=${NICKNAME}`;
  await context.route(`${EVAL_ORIGIN}/app-sign-in/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Sign in</title>" }));
  try {
    await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/`, { waitUntil: "load" });
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

/**
 * Ticket 3.19: a photo (a 2,000 x 1,500 JPEG) and a voice recording (about 1.5 s of a tone, MediaRecorder's WebM/Opus)
 * made in Chromium, on a page of the eval's origin WITHOUT the sandbox (an AudioContext needs no microphone).
 */
async function mediaSamples(browser: Browser): Promise<{ photo: Buffer; recording: Buffer }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${EVAL_ORIGIN}/eval-samples`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>samples</title>" }));
  try {
    await page.goto(`${EVAL_ORIGIN}/eval-samples`);
    const made = await page.evaluate<{ photo: string; recording: string }>(`(async () => {
      const base64 = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(text);
      };
      const canvas = new OffscreenCanvas(2000, 1500);
      const drawing = canvas.getContext("2d");
      const gradient = drawing.createLinearGradient(0, 0, 2000, 1500);
      gradient.addColorStop(0, "#f2c94c");
      gradient.addColorStop(1, "#2f5bd3");
      drawing.fillStyle = gradient;
      drawing.fillRect(0, 0, 2000, 1500);
      const photo = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      const audio = new AudioContext();
      await audio.resume();
      const tone = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      const recorder = new MediaRecorder(out.stream, { mimeType: "audio/webm;codecs=opus" });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      recorder.stop();
      await stopped;
      tone.stop();
      await audio.close();
      return { photo: await base64(photo), recording: await base64(new Blob(chunks)) };
    })()`);
    return { photo: Buffer.from(made.photo, "base64"), recording: Buffer.from(made.recording, "base64") };
  } finally {
    await context.close();
  }
}

/**
 * Marks (`data-eval-save`) the button that saves next to the element marked `data-eval-media`, after filling every empty
 * text field around it with `word` (a tag, a title): the closest form, dialog or section, else the page. Returns whether
 * one was found. Run in the page.
 */
const SAVE_NEXT_TO_MEDIA = `((word) => {
  const media = document.querySelector("[data-eval-media]");
  if (media === null) return false;
  const area = media.closest("form, dialog, [role=dialog], section, article") || document.body;
  const seen = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0;
  for (const field of area.querySelectorAll("input:not([type]), input[type=text], input[type=search], textarea")) {
    if (field.value.trim() === "" && seen(field)) {
      field.value = word;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  const buttons = Array.from(area.querySelectorAll("button, input[type=submit]")).filter((b) => !b.hasAttribute("data-workshop-sign-in") && !b.disabled && seen(b));
  const save = buttons.find((b) => /save|add|upload|post|send|keep|submit/i.test(b.textContent || b.value || ""));
  if (save === undefined) return false;
  save.setAttribute("data-eval-save", "");
  return true;
})`;

/**
 * Marks (`data-eval-open`) the tab, link or button that opens the screen holding the element marked `data-eval-media`,
 * when that screen is hidden (apps hide screens until chosen): one whose `aria-controls`, `href` or `data-*` names an
 * ancestor's id, else one whose text matches `words`. Returns whether one was marked. Run in the page.
 */
const OPENER_OF_MEDIA = `((words) => {
  const media = document.querySelector("[data-eval-media]");
  if (media === null) return false;
  const seen = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0;
  const area = media.closest("form, dialog, [role=dialog], [role=tabpanel], section, article") || media.parentElement || media;
  if (seen(area)) return false;
  const ids = [];
  for (let el = media; el !== null; el = el.parentElement) if (el.id) ids.push(el.id);
  const names = (el) => [el.getAttribute("aria-controls"), (el.getAttribute("href") || "").replace(/^#/, ""), ...Object.values(el.dataset)].filter(Boolean);
  const openers = Array.from(document.querySelectorAll("button, [role=tab], a")).filter((el) => el !== media && !area.contains(el) && !el.hasAttribute("data-workshop-sign-in") && seen(el));
  const pattern = new RegExp(words, "i");
  const opener = openers.find((el) => names(el).some((name) => ids.some((id) => id === name || id === "screen-" + name || id === name + "-screen"))) ||
    openers.find((el) => pattern.test(el.textContent || ""));
  if (opener === undefined) return false;
  opener.setAttribute("data-eval-open", "");
  return true;
})`;

/** Opens the screen holding the marked media element when it is hidden (OPENER_OF_MEDIA), with a real click. */
async function openMediaScreen(page: Page, kind: MediaCase): Promise<void> {
  const words = kind === "photo" ? "add|take|new|upload|photo" : "record|new|add";
  if (await page.evaluate<boolean>(`${OPENER_OF_MEDIA}(${JSON.stringify(words)})`)) {
    await page.click("[data-eval-open]", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

/**
 * Ticket 3.19: a media case, signed in (the app opened with a write token, as after the workshop's sign-in): finds the
 * photo button (a file input accepting images) or the Record button, picks the sample photo there (or, in the phone's
 * recorder that recordVoice() opens where Chromium refuses the microphone in the sandbox, the sample recording), presses
 * the save button next to it when the app saves only then, and checks that the media API stored a file, that a saved
 * value holds its address and that the page shows it from that address. `labels` adds the page's labels to the visitor's
 * for the case's words.
 */
export async function exerciseMedia(browser: Browser, files: readonly AppFile[], kind: MediaCase, visitorLabels: readonly string[]): Promise<MediaCheck> {
  const samples = await mediaSamples(browser);
  const { context, page, errors } = await evalPage(browser);
  const api = await routeApp(page, files, EVAL_TOKEN);
  const check: MediaCheck = { kind, button: false, uploaded: false, keptInData: false, shown: false, missingWords: [], errors };
  const uploadedAddresses = (): string[] =>
    api.writes.filter((w) => w.method === "PUT" && w.status === 201).map((w) => `${EVAL_ORIGIN}/app-media/${NICKNAME}/${w.path.split("/").pop() ?? ""}`);
  const waitForUpload = (ms: number) => waitUntil(() => uploadedAddresses().length > 0, ms);
  try {
    await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/#wt=${EVAL_TOKEN}`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(500);
    if (kind === "photo") {
      check.button = await page.evaluate<boolean>(`(() => {
        const input = Array.from(document.querySelectorAll("input[type=file]")).find((el) => /image/.test(el.accept || ""));
        if (input === undefined) return false;
        input.setAttribute("data-eval-media", "");
        return true;
      })()`);
      if (check.button) {
        // The photo screen may be hidden until chosen (live eval run 1): open it as a visitor would.
        await openMediaScreen(page, kind);
        await page.setInputFiles("[data-eval-media]", { name: "drawing.jpg", mimeType: "image/jpeg", buffer: samples.photo });
      }
    } else {
      check.button = await page.evaluate<boolean>(`(() => {
        const seen = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0;
        const reads = (el) => /record/i.test((el.textContent || "") + " " + (el.getAttribute("aria-label") || ""));
        // The button that records, not a tab or link that opens the Record screen (live eval run 1: a "Record" tab).
        const opens = (el) => el.getAttribute("role") === "tab" || el.hasAttribute("aria-controls") || el.closest("nav, [role=tablist]") !== null;
        const buttons = Array.from(document.querySelectorAll("button, [role=button]")).filter((el) => reads(el) && !opens(el));
        const button = buttons.find(seen) || buttons[0];
        if (button === undefined) return false;
        button.setAttribute("data-eval-media", "");
        return true;
      })()`);
      if (check.button) {
        // A Record button on a screen the app shows later: open the tab or button that names the screen first.
        await openMediaScreen(page, kind);
        const chooser = page.waitForEvent("filechooser", { timeout: 8_000 }).catch(() => undefined);
        await page.click("[data-eval-media]", { timeout: 5_000 }).catch(() => undefined);
        const picker = await chooser;
        if (picker !== undefined) await picker.setFiles({ name: "Voice 001.webm", mimeType: "audio/webm", buffer: samples.recording });
      }
    }
    if (check.button && !(await waitForUpload(3_000))) {
      if (await page.evaluate<boolean>(`${SAVE_NEXT_TO_MEDIA}(${JSON.stringify(kind === "photo" ? "cat" : "Ideas")})`)) {
        await page.click("[data-eval-save]", { timeout: 5_000 }).catch(() => undefined);
        await waitForUpload(8_000);
      }
    }
    check.uploaded = uploadedAddresses().length > 0;
    if (check.uploaded) {
      // The address saved with the item's other fields, then shown: wait for the app to save and draw it.
      const kept = () => api.writes.some((w) => w.status === 204 && w.method === "PUT" && uploadedAddresses().some((address) => w.body.includes(address)));
      if (!(await waitUntil(kept, 4_000))) {
        if (await page.evaluate<boolean>(`${SAVE_NEXT_TO_MEDIA}(${JSON.stringify(kind === "photo" ? "cat" : "Ideas")})`)) {
          await page.click("[data-eval-save]", { timeout: 5_000 }).catch(() => undefined);
          await waitUntil(kept, 6_000);
        }
      }
      check.keptInData = kept();
      const addresses = JSON.stringify(uploadedAddresses());
      const shownScript = kind === "photo"
        ? `Array.from(document.querySelectorAll("img")).some((el) => ${addresses}.includes(el.src))`
        : `Array.from(document.querySelectorAll("audio, audio source")).some((el) => ${addresses}.includes(el.src))`;
      check.shown = await waitUntil(() => page.evaluate<boolean>(shownScript), 3_000);
      if (!check.shown) {
        // Some apps draw the list again only when its screen is opened (live eval run 1): open the app afresh, as the
        // next visitor would, and look again (the in-memory workshop keeps what was saved).
        await page.goto("about:blank");
        await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/#wt=${EVAL_TOKEN}`, { waitUntil: "load" });
        check.shown = await waitUntil(() => page.evaluate<boolean>(shownScript), 6_000);
      }
    }
    const labels = [...visitorLabels, ...(await page.evaluate<string[]>(LABELS_SCRIPT)), ...(await page.evaluate<string[]>(`Array.from(document.querySelectorAll("option, [placeholder]")).map((el) => el.textContent + " " + (el.getAttribute("placeholder") || ""))`))];
    check.missingWords = MEDIA_WORDS[kind].filter((word) => !labels.some((label) => label.toLowerCase().includes(word)));
    return check;
  } finally {
    await context.close();
  }
}

/** Polls `test` every 200 ms until it holds or `ms` pass; answers whether it held. */
async function waitUntil(test: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
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

/**
 * Ticket 3.25 try 3: with `EVAL_DUMP_DIR` set (an absolute path), the files the deployer would publish are also written
 * to a new folder under it, to look at a failed app afterwards (the example specs hold no personal data).
 */
async function dumpPublished(files: readonly AppFile[]): Promise<void> {
  const root = process.env.EVAL_DUMP_DIR;
  if (root === undefined || root === "") return;
  if (!isAbsolute(root)) throw new Error("EVAL_DUMP_DIR must be an absolute path");
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, `app-${Date.now()}-`));
  console.log(`     . dumped to ${folder}`);
  for (const file of files) {
    if (file.kind !== "file" || file.path.split("/").includes("..")) continue;
    const path = join(folder, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
}

/** A first build of `spec` in `world`: the repository starts as the launcher prepares it (template and spec). */
async function firstBuild(world: EvalWorld, spec: string, browser: Browser, media?: MediaCase): Promise<{ outcome: BuildEvalOutcome; commit?: string }> {
  const files = withSpec(await loadTemplateFiles(), spec);
  const baseCommit = world.github.seedCommit(REPOSITORY, Object.fromEntries(files.map((file) => [file.path, new TextDecoder().decode(file.bytes)])), FIRST_COMMIT_MESSAGE);
  // As the launcher leaves it (ticket 2.9): building under one launch.
  const attemptId = randomUUID();
  world.records.builds.set(BUILD_ID, { nickname: NICKNAME, participantId: PARTICIPANT, status: "building", attemptId });
  const run = await runEvalBuild(world, BUILD_ID, baseCommit, attemptId);
  if (run.published === undefined) return { outcome: run.outcome };
  await dumpPublished(run.published);
  const checked = await checkPublished(browser, run.published, spec);
  // Ticket 3.19: a media case is also opened signed in, and a photo or recording uploaded through it.
  const mediaCheck = media === undefined ? undefined : await exerciseMedia(browser, run.published, media, checked.page.labels);
  return {
    outcome: {
      ...run.outcome,
      checkPassed: checked.checkPassed,
      consoleErrors: checked.consoleErrors,
      overflow: checked.overflow,
      missing: checked.missing,
      outsideHosts: checked.outsideHosts,
      signIn: checked.signIn,
      ...(mediaCheck === undefined ? {} : { media: mediaCheck }),
    },
    ...(run.commit === undefined ? {} : { commit: run.commit }),
  };
}

/**
 * Runs one spec end to end (`media`: a photo or voice case of platform/api/eval/build.json, ticket 3.19). `log` receives the runner's phase lines (counts only) and the Bedrock proxy's lines (a
 * path's shape and a status). The caller's AWS credentials stay in this process (the proxy signs with them); the
 * agent's process gets none.
 */
export async function evalBuild(
  spec: string,
  model: ModelSetting,
  browser: Browser,
  log: (entry: BuilderLogEntry | BedrockProxyLogEntry) => void,
  media?: MediaCase,
): Promise<BuildEvalOutcome> {
  return (await firstBuild(evalWorld(model, log), spec, browser, media)).outcome;
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
  // Ticket 3.19: a fake microphone with the prompt answered yes (the apps' sandbox refuses it anyway, so voice apps use
  // the phone's recorder there), and sound without a tap, for the media samples made with an AudioContext.
  const args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
  return chromium.launch(server === undefined ? { args } : { args, proxy: { server } });
};
