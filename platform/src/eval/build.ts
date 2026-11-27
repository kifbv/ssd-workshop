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
// Ticket 3.22: the in-memory workshop also answers the AI route (ticket 3.21) with fixed answers (no Bedrock), and an AI
// case is checked with the edit link by `exerciseAi`. Ticket 3.28: every app is opened with its edit link and without it
// (`exerciseEditLink`).
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, type AgentOptions } from "node:https";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { APP_MEDIA_CONTENT_SECURITY_POLICY, APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { AI_PREFLIGHT_HEADERS } from "../../api/app-ai/ai.js";
import { parseAppAiRequest, type AppAiRequest } from "../../api/app-ai/tasks.js";
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
import { APP_AI_TEXTS, APP_EDIT_LINK_TEXTS } from "../../api/workshop/texts.js";
import { ClaudeAgent, webProxyEnvironment } from "../../builder/agent.js";
import type { BedrockProxyLogEntry } from "../../builder/bedrock-proxy.js";
import { FakeBuildRecords, FakeDeployQueue } from "../../builder/fakes.js";
import { runBuild, type BuilderLogEntry } from "../../builder/runner.js";
import { RECEIPT_CASES, receiptPhoto } from "./app-ai.js";
import {
  AI_HELPER,
  FILL_AND_MARK_SAVE_SCRIPT,
  SEARCH_BUTTON_SCRIPT,
  MEDIA_FILTER,
  missingScreens,
  SAVING_CONTROLS_SCRIPT,
  SCREEN_OPENERS_SCRIPT,
  screenNames,
  specTitle,
  type AiCase,
  type AiCheck,
  type BuildEvalOutcome,
  type ChangeEvalOutcome,
  type EditLinkCheck,
  type MediaCase,
  type MediaCheck,
} from "./logic.js";

const NICKNAME = "eval-app";
const EVAL_ORIGIN = "https://workshop.test";
const REPOSITORY = "ssd-eval-app";
const BUILD_ID = "eval-build-1";
const CHANGE_BUILD_ID = "eval-build-2";
const PARTICIPANT = "eval-participant";
const PHONE = { width: 375, height: 740 };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" };
/** What the in-memory data API answers a write without the app's edit secret, as the real one does (3.26). */
const VIEW_ONLY = JSON.stringify({ message: APP_EDIT_LINK_TEXTS.viewOnly });

/** Labels the title check reads: headings, buttons, tabs, links, labels, legends and aria-labels, hidden ones included. */
const LABELS_SCRIPT = `Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,button,[role=tab],[role=button],a,label,legend,summary,[aria-label]"))
  .flatMap((el) => [el.textContent || "", el.getAttribute("aria-label") || ""]).filter((t) => t.trim() !== "")`;

/** Ticket 3.28: the app's edit secret (ticket 3.26) the eval opens the app with, and the nickname the in-memory API names for it. */
const EVAL_TOKEN = Buffer.alloc(32, 5).toString("base64url");
const EDIT_LINK = `#edit=${EVAL_TOKEN}`;
const EVAL_WRITER = "eval-writer";
const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;
const MEDIA_MESSAGES = { unsupported: "Send a photo as a JPEG, or a voice recording as WebM, Ogg or MP4 audio." };

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
  /** Ticket 3.22: every AI request (POST) the app sent: its task, the stand-in's status and answer, and how many writes came before it. */
  ai: { task: string | undefined; status: number; answer: unknown; writesBefore: number }[];
}

/** Ticket 3.22: the stand-in AI route's fixed answers (no Bedrock): what the build check looks for afterwards. */
export const STAND_IN_TAGS = ["sunflower", "crayon"];
export const STAND_IN_RECEIPT = { text: "Bäckerei Sonnenschein", date: "2026-11-14", amount: 12.4, currency: "EUR" };
export const STAND_IN_TRANSCRIPT = { text: "An idea for the next team lunch.", language: "en-US" };

/** The stand-in's answer to a checked request: as the real route's shapes (ticket 3.21), with fixed values. */
export function standInAnswer(request: AppAiRequest): Record<string, unknown> {
  if (request.task === "tag-photo") return { tags: request.tags.length > 0 ? request.tags.slice(0, 2) : STAND_IN_TAGS };
  if (request.task === "sort-text") return { categories: request.categories.slice(0, 1) };
  if (request.task === "transcribe") return { ...STAND_IN_TRANSCRIPT };
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of request.fields) {
    values[field.name] =
      field.type === "text" ? STAND_IN_RECEIPT.text : field.type === "date" ? STAND_IN_RECEIPT.date : field.type === "number" ? STAND_IN_RECEIPT.amount : { amount: STAND_IN_RECEIPT.amount, currency: STAND_IN_RECEIPT.currency };
  }
  return { values };
}

async function routeApp(page: Page, files: readonly AppFile[], token: string | undefined): Promise<EvalApi> {
  const api: EvalApi = { data: new Map(), media: new Map(), writes: [], ai: [] };
  const byPath = new Map(files.filter((file) => file.kind === "file").map((file) => [file.path, file]));
  const json = (route: Route, status: number, body: string) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body });
  await page.route(`${EVAL_ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const dataPrefix = `/api/apps/${NICKNAME}/data/`;
    const mediaPrefix = `/api/apps/${NICKNAME}/media/`;
    const signedIn = token !== undefined && request.headers().authorization === `Bearer ${token}`;
    if (path === `/api/apps/${NICKNAME}/ai`) {
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...AI_PREFLIGHT_HEADERS } });
      const call: EvalApi["ai"][number] = { task: undefined, status: 0, answer: undefined, writesBefore: api.writes.length };
      api.ai.push(call);
      const answer = (status: number, body: unknown) => {
        call.status = status;
        call.answer = body;
        return json(route, status, JSON.stringify(body));
      };
      if (request.method() !== "POST") return answer(404, { message: "Not found." });
      if (!signedIn) return answer(401, { message: APP_EDIT_LINK_TEXTS.viewOnly });
      let body: unknown;
      try {
        body = JSON.parse(request.postData() ?? "");
      } catch {
        body = undefined;
      }
      // The real route's parser judges the request (ticket 3.21): never a free prompt, within the limits, this app's files.
      const parsed = parseAppAiRequest(body, NICKNAME);
      if (!parsed.ok) return answer(400, { message: parsed.reason === "bad-request" ? APP_AI_TEXTS.badRequest : APP_AI_TEXTS.photoNotInApp });
      call.task = parsed.request.task;
      if (parsed.request.task !== "sort-text" && !api.media.has(parsed.request.mediaId)) return answer(400, { message: APP_AI_TEXTS.mediaNotFound });
      return answer(200, standInAnswer(parsed.request));
    }
    if (path.startsWith(dataPrefix) || path.startsWith(mediaPrefix)) {
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const write = request.method() === "PUT" || request.method() === "DELETE";
      // Without the edit secret every write is refused as the real API refuses it (workshop-data.js sends none then).
      if (write && !signedIn) {
        api.writes.push({ method: request.method(), path, status: 401, body: "" });
        return json(route, 401, VIEW_ONLY);
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
        return signedIn ? json(route, 200, JSON.stringify({ nickname: EVAL_WRITER })) : json(route, 401, VIEW_ONLY);
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
 * Opens the app's files at /apps/<nickname>/ in Chromium under the CSP, as a visitor (no edit link: ticket 3.28), and
 * reads what the title check needs.
 */
async function openInBrowser(
  browser: Browser,
  files: readonly AppFile[],
): Promise<{ errors: string[]; overflow: number; title: string; labels: string[]; outsideHosts: string[] }> {
  const { context, page, errors, outsideHosts } = await evalPage(browser);
  await routeApp(page, files, undefined);
  try {
    await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate<number>(OVERFLOW_SCRIPT);
    const title = await page.title();
    const labels = await page.evaluate<string[]>(LABELS_SCRIPT);
    return { errors, overflow: Math.max(0, overflow), title, labels, outsideHosts: [...outsideHosts].sort() };
  } finally {
    await context.close();
  }
}

const OVERFLOW_SCRIPT = `Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth`;
const VIEW_ONLY_SHOWN = `(document.body.innerText || "").includes(${JSON.stringify(APP_EDIT_LINK_TEXTS.viewOnly)})`;

/**
 * Ticket 3.28: looks at the page's first screen, then opens each screen the spec names (SCREEN_OPENERS_SCRIPT, with real
 * clicks) and looks again; `look` runs after each. Openers are found again before each click (a screen may hide them).
 */
async function aroundScreens(page: Page, screens: readonly string[], look: () => Promise<void>): Promise<void> {
  await look();
  for (let i = 0; i < screens.length; i += 1) {
    await page.evaluate<number>(`${SCREEN_OPENERS_SCRIPT}(${JSON.stringify(screens)})`);
    const opener = page.locator(`[data-eval-opener="${i}"]`);
    if ((await opener.count()) === 0) continue;
    await opener.first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    await look();
  }
}

/**
 * Ticket 3.28: console errors without those an outside service's failure causes: Chromium's CORS line for an https
 * address of another site, and as many "net::ERR_FAILED" lines as requests to other sites failed.
 */
export function withoutOutsideFailures(errors: readonly string[], outsideFailures: number): string[] {
  let failures = outsideFailures;
  return errors.filter((line) => {
    const cors = /^Access to fetch at 'https:\/\/([^/']+)\//.exec(line);
    if (cors !== null && `https://${cors[1] ?? ""}` !== EVAL_ORIGIN) return false;
    if (failures > 0 && line.startsWith("Failed to load resource: net::ERR_FAILED")) {
      failures -= 1;
      return false;
    }
    return true;
  });
}

/**
 * Ticket 3.28: the edit-link check (EditLinkCheck in ./logic.ts). With the edit link: canSave(), writes before anything
 * was done, the saving controls on every screen, sideways scroll and console errors, and (when `tryToSave`: not a media
 * or AI case, whose own pass saves) a save: on each screen in turn, the fields filled and Save or Add pressed, until the
 * data API stores a value (a search first, when the app finds an item before adding it). Then, without the edit link and
 * on the data saved: canSave(), the saving controls a visitor sees on every screen, and "This link is view only." shown.
 */
export async function exerciseEditLink(browser: Browser, files: readonly AppFile[], screens: readonly string[], tryToSave: boolean): Promise<EditLinkCheck> {
  const editor = await evalPage(browser);
  const api = await routeApp(editor.page, files, EVAL_TOKEN);
  const check: EditLinkCheck = {
    editorCanSave: false,
    editorControls: 0,
    savedOnOpen: 0,
    saved: tryToSave ? false : undefined,
    editorOverflow: 0,
    editorErrors: editor.errors,
    visitorCanSave: true,
    visitorControls: [],
    visitorRefused: false,
  };
  const stored = () => api.writes.some((w) => w.method === "PUT" && w.status === 204 && w.path.startsWith(`/api/apps/${NICKNAME}/data/`));
  // The eval's searches reach real outside services (live eval run 2: Wikipedia answered the session's shared address
  // 429 without CORS): those failures are the service's, not the app's, and Chromium logs them as console errors.
  let outsideFailures = 0;
  editor.page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin !== EVAL_ORIGIN) outsideFailures += 1;
  });
  try {
    const page = editor.page;
    await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/${EDIT_LINK}`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1_000);
    check.savedOnOpen = api.writes.length;
    check.editorCanSave = await page.evaluate<boolean>("workshopData.canSave()");
    const pressSave = async (): Promise<void> => {
      if (await page.evaluate<boolean>(`${FILL_AND_MARK_SAVE_SCRIPT}(${JSON.stringify(screens)})`)) {
        await page.click("[data-eval-save]", { timeout: 5_000 }).catch(() => undefined);
        await waitUntil(stored, 3_000);
      }
    };
    await aroundScreens(page, screens, async () => {
      check.editorControls = Math.max(check.editorControls, (await page.evaluate<string[]>(`${SAVING_CONTROLS_SCRIPT}(${JSON.stringify(screens)})`)).length);
      check.editorOverflow = Math.max(check.editorOverflow, await page.evaluate<number>(OVERFLOW_SCRIPT));
      if (!tryToSave || stored()) return;
      await pressSave();
      if (stored()) return;
      // An app that finds an item before adding it (a film by its title): search, wait for the answer, then add.
      if (await page.evaluate<boolean>(`${SEARCH_BUTTON_SCRIPT}(${JSON.stringify(screens)})`)) {
        await page.click("[data-eval-search]", { timeout: 5_000 }).catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(1_000);
        await pressSave();
      }
    });
    if (tryToSave) check.saved = stored();
  } finally {
    await editor.context.close();
  }
  check.editorErrors = withoutOutsideFailures(editor.errors, outsideFailures);
  // Without the edit link, on what was saved (so a list's items show with their own buttons).
  const visitor = await evalPage(browser);
  const visitorApi = await routeApp(visitor.page, files, undefined);
  for (const [key, value] of api.data) visitorApi.data.set(key, value);
  try {
    const page = visitor.page;
    await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1_000);
    check.visitorCanSave = await page.evaluate<boolean>("workshopData.canSave()");
    const seen = new Set<string>();
    await aroundScreens(page, screens, async () => {
      for (const label of await page.evaluate<string[]>(`${SAVING_CONTROLS_SCRIPT}(${JSON.stringify(screens)})`)) seen.add(label);
      if (await page.evaluate<boolean>(VIEW_ONLY_SHOWN)) check.visitorRefused = true;
    });
    check.visitorControls = [...seen];
  } finally {
    await visitor.context.close();
  }
  return check;
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

/**
 * Whether the page has a filter by `word` ("tag", "topic"): a `<select>`, a text or search field, or a button, link,
 * tab, radio or checkbox whose own words, the element just before it, or its group's words hold `word` together with
 * "filter", "show", "only", "browse" or "search", or a `<select>` whose first option starts with All/Any/Every and whose
 * words hold `word` (`MediaCheck` in ./logic.ts says it in full). A Tags field in the add form does not count. Hidden
 * controls count (the filter may sit on a screen the app has not opened). Run in the page.
 */
const HAS_FILTER = `((word) => {
  const text = (el) => (el === null || el === undefined ? "" : el.textContent || "");
  const own = (el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder"), el.id, el.getAttribute("name"), el.getAttribute("class"), ...Object.keys(el.dataset || {})]
    .filter(Boolean).join(" ") + " " + (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean).map((id) => text(document.getElementById(id))).join(" ");
  const groupOf = (el) => (el.parentElement && el.parentElement.closest("fieldset, [role=group], [role=radiogroup], [role=toolbar], [role=tablist], nav, menu")) || el.parentElement;
  const words = (el, withText) => {
    const group = groupOf(el);
    const legend = group === null ? null : group.querySelector(":scope > legend");
    return [own(el), withText ? text(el) : "", ...Array.from(el.labels || []).map(text), text(el.previousElementSibling),
      group === null ? "" : own(group) + " " + text(legend) + " " + text(group.previousElementSibling)].join(" ").toLowerCase();
  };
  const filtering = /filter|\\bshow|\\bonly\\b|\\bbrowse|search/;
  const controls = Array.from(document.querySelectorAll("select, input, button, a, [role=tab], [role=radio], [role=button], [role=option]"))
    .filter((el) => !el.hasAttribute("data-workshop-sign-in") && !/^(file|hidden|submit|image|reset|password|email|date|number)$/i.test(el.getAttribute("type") || ""));
  return controls.some((el) => {
    const said = words(el, el.tagName !== "SELECT" && el.tagName !== "INPUT");
    if (!said.includes(word)) return false;
    if (filtering.test(said)) return true;
    return el.tagName === "SELECT" && el.options.length > 0 && /^\\s*(all|any|every)/i.test(el.options[0].textContent || "");
  });
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
 * Ticket 3.19: a media case, with the edit link (ticket 3.28; the app opened with its secret in the address): finds the
 * photo button (a file input accepting images) or the Record button, picks the sample photo there (or, in the phone's
 * recorder that recordVoice() opens where Chromium refuses the microphone in the sandbox, the sample recording), presses
 * the save button next to it when the app saves only then, and checks that the media API stored a file, that a saved
 * value holds its address and that the page shows it from that address; then looks for the case's filter (HAS_FILTER),
 * once the saved item is drawn.
 */
export async function exerciseMedia(browser: Browser, files: readonly AppFile[], kind: MediaCase): Promise<MediaCheck> {
  const samples = await mediaSamples(browser);
  const { context, page, errors } = await evalPage(browser);
  const api = await routeApp(page, files, EVAL_TOKEN);
  const check: MediaCheck = { kind, button: false, uploaded: false, keptInData: false, shown: false, filter: false, errors };
  const uploadedAddresses = (): string[] =>
    api.writes.filter((w) => w.method === "PUT" && w.status === 201).map((w) => `${EVAL_ORIGIN}/app-media/${NICKNAME}/${w.path.split("/").pop() ?? ""}`);
  const waitForUpload = (ms: number) => waitUntil(() => uploadedAddresses().length > 0, ms);
  try {
    await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/${EDIT_LINK}`, { waitUntil: "load" });
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
        await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/${EDIT_LINK}`, { waitUntil: "load" });
        check.shown = await waitUntil(() => page.evaluate<boolean>(shownScript), 6_000);
      }
    }
    // Ticket 3.22 (live eval run 1): the app may still be drawing after its save (the check above can pass on a preview
    // showing the address while the save is under way), so give the filter a moment to appear.
    check.filter = await waitUntil(() => page.evaluate<boolean>(`${HAS_FILTER}(${JSON.stringify(MEDIA_FILTER[kind])})`), 3_000);
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

/**
 * Ticket 3.22: marks (`data-eval-suggest`) a visible button that asks the AI for a suggestion ("Suggest tags", "Read the
 * receipt", "Scan", "Auto-fill", "AI"), not the sign-in button. Returns whether one was marked. Run in the page.
 */
const SUGGEST_BUTTON = `(() => {
  const seen = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0;
  const said = (el) => ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.value || "")).trim();
  const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=button]")).filter((el) => !el.hasAttribute("data-workshop-sign-in") && !el.disabled && seen(el));
  const button = buttons.find((el) => /suggest|\\bread\\b|scan|detect|auto|\\bai\\b|fill|recogni|extract/i.test(said(el)));
  if (button === undefined) return false;
  button.setAttribute("data-eval-suggest", "");
  return true;
})()`;

/**
 * Ticket 3.22: whether the page shows one of `markers` (regular expression sources, any case): in a field's value, a
 * selected option, or the page's visible text. Run in the page.
 */
const SHOWS_MARKER = `((markers) => {
  const patterns = markers.map((m) => new RegExp(m, "i"));
  const values = Array.from(document.querySelectorAll("input, textarea")).map((el) => el.value || "");
  const options = Array.from(document.querySelectorAll("select")).map((el) => (el.selectedOptions[0] && el.selectedOptions[0].textContent) || "");
  const texts = [...values, ...options, document.body.innerText || ""];
  return texts.some((text) => patterns.some((p) => p.test(text)));
})`;

/**
 * Ticket 3.22: accepts the AI's suggestion as a visitor would when no field holds it yet: presses a visible Accept / Apply
 * / Use button, else taps each control whose text is one of the suggested `words` (a tag chip or a checkbox's label).
 * Returns what it pressed. Run in the page.
 */
const ACCEPT_SUGGESTION = `((markers, words) => {
  const patterns = markers.map((m) => new RegExp(m, "i"));
  const inFields = Array.from(document.querySelectorAll("input, textarea")).some((el) => patterns.some((p) => p.test(el.value || "")));
  if (inFields) return "fields";
  const seen = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0;
  const said = (el) => ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.value || "")).trim();
  const controls = Array.from(document.querySelectorAll("button, [role=button], [role=option], [role=checkbox], label, input[type=checkbox]")).filter((el) => !el.hasAttribute("data-workshop-sign-in") && seen(el));
  const accept = controls.find((el) => /accept|apply|\\buse\\b|confirm|keep (the |these |this )?(suggest|tag|value)/i.test(said(el)));
  if (accept !== undefined) {
    accept.click();
    return "accept";
  }
  let tapped = 0;
  for (const el of controls) {
    if (words.includes(said(el).replace(/^[+✓✔\\s]+|[×✕\\s]+$/g, "").toLowerCase())) {
      el.click();
      tapped += 1;
    }
  }
  return tapped > 0 ? "chips" : "none";
})`;

/**
 * Ticket 3.22: marks (`data-eval-save`) the button that saves: next to the photo button first (SAVE_NEXT_TO_MEDIA's area),
 * else anywhere on the page, one reading Save before one reading Add, Log or Submit; never a suggestion or sign-in button.
 * Fills empty text fields of that area with `word`. Returns whether one was marked. Run in the page.
 */
const SAVE_AFTER_SUGGESTION = `((word) => {
  const media = document.querySelector("[data-eval-media]");
  const seen = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0;
  const areas = [media && media.closest("form, dialog, [role=dialog], section, article"), document.body].filter(Boolean);
  for (const area of areas) {
    for (const field of area.querySelectorAll("input:not([type]), input[type=text], textarea")) {
      if (field.value.trim() === "" && seen(field) && !field.closest("[role=search]") && !/search|filter/i.test(field.id + " " + (field.getAttribute("placeholder") || ""))) {
        field.value = word;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const buttons = Array.from(area.querySelectorAll("button, input[type=submit]")).filter((b) => !b.hasAttribute("data-workshop-sign-in") && !b.hasAttribute("data-eval-suggest") && !b.disabled && seen(b));
    const text = (b) => b.textContent || b.value || "";
    const save = buttons.find((b) => /save/i.test(text(b))) || buttons.find((b) => /^\\s*(add|log|submit|keep|record|post)\\b/i.test(text(b)));
    if (save !== undefined) {
      document.querySelectorAll("[data-eval-save]").forEach((el) => el.removeAttribute("data-eval-save"));
      save.setAttribute("data-eval-save", "");
      return true;
    }
  }
  return false;
})`;

/**
 * Ticket 3.22: an AI case, with the edit link, on the in-memory workshop whose AI route answers with fixed values: picks a photo
 * in the photo button (a generated drawing, or for a receipt a synthetic receipt drawn in Chromium as the app-ai eval
 * does), waits for the app to ask the AI by itself (else presses a button that asks for a suggestion, else Save), checks
 * that the answer shows and that nothing holding it was saved yet, accepts it as a visitor would (fields already hold it;
 * else an Accept button or the suggested tags), presses Save and checks that a saved value holds it.
 */
/** Ticket 3.22: the app's own code (not the workshop's data client), all its JavaScript files joined. */
const appCode = (files: readonly AppFile[]): string =>
  files
    .filter((file) => file.kind === "file" && file.path.endsWith(".js") && file.path !== DATA_CLIENT_PATH)
    .map((file) => new TextDecoder().decode(file.bytes))
    .join("\n");

/** Ticket 3.22: whether the app's code uses the AI helpers (`workshopData.ai`), which only an AI case may. */
export const callsAi = (files: readonly AppFile[]): boolean => /\bai\s*\.\s*(tagPhoto|readPhoto|sortText|transcribe)\s*\(/.test(appCode(files));

export async function exerciseAi(browser: Browser, files: readonly AppFile[], kind: AiCase): Promise<AiCheck> {
  const { helper, task } = AI_HELPER[kind];
  const code = appCode(files);
  const photo = kind === "ai-receipt" ? await receiptPhoto(browser, RECEIPT_CASES[0] as (typeof RECEIPT_CASES)[number]) : (await mediaSamples(browser)).photo;
  const { context, page, errors } = await evalPage(browser);
  const api = await routeApp(page, files, EVAL_TOKEN);
  const check: AiCheck = { kind, button: false, helper: new RegExp(`\\bai\\s*\\.\\s*${helper}\\s*\\(`).test(code), uploaded: false, called: false, shown: false, savedEarly: false, saved: false, errors };
  const answered = () => api.ai.find((call) => call.task === task && call.status === 200);
  // What a saved value must hold: one of the suggested tags, or the receipt's total (12.4 written as 12.4, 12.40 or 12,40).
  const words = (): string[] => {
    const answer = answered()?.answer as { tags?: unknown } | undefined;
    return Array.isArray(answer?.tags) ? answer.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [];
  };
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const savedMarkers = (): string[] => (kind === "ai-tags" ? words().map(escape) : ["12[.,]40?(?![0-9])"]);
  const shownMarkers = (): string[] => (kind === "ai-tags" ? savedMarkers() : [...savedMarkers(), "Sonnenschein"]);
  const holds = (body: string) => savedMarkers().some((marker) => new RegExp(marker, "i").test(body));
  const dataWrites = () => api.writes.filter((w) => w.method === "PUT" && w.status === 204 && w.path.startsWith(`/api/apps/${NICKNAME}/data/`));
  try {
    await page.goto(`${EVAL_ORIGIN}/apps/${NICKNAME}/${EDIT_LINK}`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(500);
    check.button = await page.evaluate<boolean>(`(() => {
      const input = Array.from(document.querySelectorAll("input[type=file]")).find((el) => /image/.test(el.accept || ""));
      if (input === undefined) return false;
      input.setAttribute("data-eval-media", "");
      return true;
    })()`);
    if (!check.button) return check;
    await openMediaScreen(page, "photo");
    await page.setInputFiles("[data-eval-media]", { name: kind === "ai-receipt" ? "receipt.jpg" : "drawing.jpg", mimeType: "image/jpeg", buffer: photo });
    // The app asks by itself once the photo is saved, else from a button that asks for a suggestion, else after Save.
    if (!(await waitUntil(() => answered() !== undefined, 6_000))) {
      if (await page.evaluate<boolean>(SUGGEST_BUTTON)) {
        await page.click("[data-eval-suggest]", { timeout: 5_000 }).catch(() => undefined);
        await waitUntil(() => answered() !== undefined, 8_000);
      }
    }
    if (answered() === undefined && (await page.evaluate<boolean>(`${SAVE_AFTER_SUGGESTION}("cat")`))) {
      await page.click("[data-eval-save]", { timeout: 5_000 }).catch(() => undefined);
      await waitUntil(() => answered() !== undefined, 8_000);
    }
    check.uploaded = api.writes.some((w) => w.method === "PUT" && w.status === 201);
    check.called = answered() !== undefined;
    if (!check.called) return check;
    check.shown = await waitUntil(() => page.evaluate<boolean>(`${SHOWS_MARKER}(${JSON.stringify(shownMarkers())})`), 4_000);
    // Give an app that would save by itself the time to do it, then look: nothing holding the suggestion is saved yet.
    await page.waitForTimeout(1_500);
    check.savedEarly = dataWrites().some((w) => holds(w.body));
    const before = api.writes.length;
    await page.evaluate<string>(`${ACCEPT_SUGGESTION}(${JSON.stringify(savedMarkers())}, ${JSON.stringify(words())})`);
    await page.waitForTimeout(300);
    const savedAfter = () => api.writes.slice(before).some((w) => w.method === "PUT" && w.status === 204 && holds(w.body));
    if (await page.evaluate<boolean>(`${SAVE_AFTER_SUGGESTION}("cat")`)) {
      await page.click("[data-eval-save]", { timeout: 5_000 }).catch(() => undefined);
      await waitUntil(savedAfter, 6_000);
    }
    check.saved = savedAfter();
    return check;
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
async function checkPublished(
  browser: Browser,
  published: AppFile[],
  spec: string,
  tryToSave = true,
): Promise<Pick<BuildEvalOutcome, "checkPassed" | "consoleErrors" | "overflow" | "missing" | "outsideHosts"> & { editLink: EditLinkCheck; page: { title: string; labels: string[] } }> {
  const check = checkApp(published);
  const page = await openInBrowser(browser, published);
  const editLink = await exerciseEditLink(browser, published, screenNames(spec), tryToSave);
  return {
    checkPassed: check.ok,
    consoleErrors: page.errors,
    overflow: page.overflow,
    missing: missingScreens(specTitle(spec), screenNames(spec), page),
    outsideHosts: page.outsideHosts,
    editLink,
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
async function firstBuild(world: EvalWorld, spec: string, browser: Browser, media?: MediaCase, ai?: AiCase): Promise<{ outcome: BuildEvalOutcome; commit?: string }> {
  const files = withSpec(await loadTemplateFiles(), spec);
  const baseCommit = world.github.seedCommit(REPOSITORY, Object.fromEntries(files.map((file) => [file.path, new TextDecoder().decode(file.bytes)])), FIRST_COMMIT_MESSAGE);
  // As the launcher leaves it (ticket 2.9): building under one launch.
  const attemptId = randomUUID();
  world.records.builds.set(BUILD_ID, { nickname: NICKNAME, participantId: PARTICIPANT, status: "building", attemptId });
  const run = await runEvalBuild(world, BUILD_ID, baseCommit, attemptId);
  if (run.published === undefined) return { outcome: run.outcome };
  await dumpPublished(run.published);
  // Ticket 3.28: a media or AI case saves with the edit link in its own pass below.
  const checked = await checkPublished(browser, run.published, spec, media === undefined && ai === undefined);
  // Ticket 3.19: a media case is also opened with the edit link, and a photo or recording uploaded through it.
  const mediaCheck = media === undefined ? undefined : await exerciseMedia(browser, run.published, media);
  // Ticket 3.22: an AI case is opened with the edit link too, and its suggestion asked, shown, accepted and saved.
  const aiCheck = ai === undefined ? undefined : await exerciseAi(browser, run.published, ai);
  return {
    outcome: {
      ...run.outcome,
      checkPassed: checked.checkPassed,
      consoleErrors: checked.consoleErrors,
      overflow: checked.overflow,
      missing: checked.missing,
      outsideHosts: checked.outsideHosts,
      editLink: checked.editLink,
      ...(mediaCheck === undefined ? {} : { media: mediaCheck }),
      ...(aiCheck === undefined ? {} : { ai: aiCheck }),
      usesAi: callsAi(run.published),
    },
    ...(run.commit === undefined ? {} : { commit: run.commit }),
  };
}

/**
 * Runs one spec end to end (`media`: a photo or voice case of platform/api/eval/build.json, ticket 3.19; `ai`: an AI
 * case of that file, ticket 3.22). `log` receives the runner's phase lines (counts only) and the Bedrock proxy's lines (a
 * path's shape and a status). The caller's AWS credentials stay in this process (the proxy signs with them); the
 * agent's process gets none.
 */
export async function evalBuild(
  spec: string,
  model: ModelSetting,
  browser: Browser,
  log: (entry: BuilderLogEntry | BedrockProxyLogEntry) => void,
  media?: MediaCase,
  ai?: AiCase,
): Promise<BuildEvalOutcome> {
  return (await firstBuild(evalWorld(model, log), spec, browser, media, ai)).outcome;
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
