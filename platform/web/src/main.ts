// Sign-in screens (ticket 1.6): email, code, nickname, then the step screen; step 1, Clarify (ticket
// 1.8), step 2, Spec and approval (ticket 1.9), step 3, Build (ticket 2.10), and step 4, Live (tickets 2.10 and 2.11) with
// its change requests (ticket 3.8). The rules for each API answer are in ./flow.ts, ./chat.ts, ./spec-view.ts,
// ./build-view.ts and ./live-view.ts; this file only wires them to the page. Steps 1, 2 and 4 share one conversation,
// polling and Send form logic, each on its own elements (`VIEWS`).
//
// Personal data: the email address lives only in `pendingEmail` (memory) between asking for a
// code and checking it. It never goes into the URL, storage, a cookie or the console.
import {
  MESSAGES,
  codeRequestResult,
  isPlausibleEmail,
  meResult,
  nicknameResult,
  normalizeCode,
  screenFor,
  signOutResult,
  verifyResult,
  type ApiAnswer,
  type Me,
  type Screen,
  type Tone,
} from "./flow.js";
import {
  CHAT_TEXTS,
  POLL_INTERVAL_MS,
  STATUS_POLL_INTERVAL_MS,
  WAITING_POLL_INTERVAL_MS,
  budgetLeftText,
  canWriteSpec,
  conversationResult,
  pollResult,
  sendResult,
  specOffered,
  stageOf,
  statusResult,
  writeSpecResult,
  type ChatMessage,
} from "./chat.js";
import type { DiagramApi } from "./diagram.js";
import { pictureUrl } from "./diagram-svg.js";
import { approveResult, SPEC_TEXTS, specResult, specView, stepTwoMessages, type SpecVersion } from "./spec-view.js";
import { qrModules, qrSvgPath } from "./qr.js";
import { BUILD_POLL_INTERVAL_MS, behindPart, buildResult, feedLines, isRunning, nowText, showsStepFour, stageStates, type Build } from "./build-view.js";
import { changeBuildFailedText, changeBuildingText, PHASE_3_TEXTS, proposalVersionText } from "../../api/workshop/texts.js";
import {
  CHANGE_LOOP_ALT,
  CHANGE_LOOP_DIAGRAM,
  changeActionResult,
  proposalResult,
  stepFourMessages,
  stepFourView,
  type Proposal,
} from "./live-view.js";
import type { Conversation } from "./chat.js";

type ScreenName = Screen | "loading";

let pendingEmail: string | null = null;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element as T;
}

/** Same-origin JSON call; status 0 when there is no answer at all. */
async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<ApiAnswer> {
  const init: RequestInit = { method, credentials: "same-origin", cache: "no-store" };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(path, init);
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

function say(screen: Screen, message: string, tone: Tone): void {
  const element = byId(`message-${screen}`);
  element.dataset["tone"] = tone;
  element.textContent = message;
}

function clearMessage(screen: Screen): void {
  byId(`message-${screen}`).textContent = "";
}

/** The screens of a signed-in person: they show the Sign out link (ticket 3.1). */
const SIGNED_IN_SCREENS: readonly ScreenName[] = ["nickname", "step", "spec", "build", "live"];
let current: ScreenName = "loading";

/** Shows one screen and moves the focus to its first field, or to its heading. Leaving step 3 stops its polling. */
function show(name: ScreenName, focusId?: string): void {
  if (name !== "build") stopBuildPolling();
  if (name !== "live") stopSuggestionsReread();
  current = name;
  for (const section of document.querySelectorAll<HTMLElement>("[data-screen]")) {
    section.hidden = section.id !== `screen-${name}`;
  }
  byId("account").hidden = !SIGNED_IN_SCREENS.includes(name);
  renderPaused();
  syncStatusPolling();
  if (focusId) byId(focusId).focus();
}

/** Ticket 3.5: the workshop is paused (the admin's global Stop), as the last status, conversation, poll or build read said. */
let workshopPaused = false;

/** Shows the paused line above the signed-in screens while the last read said so; the next read without it clears it. */
function setPaused(paused: boolean): void {
  workshopPaused = paused;
  renderPaused();
}

/**
 * Sets the paused line from a conversation, poll or build answer: `paused: true` shows it, `pausedUnknown: true` (the
 * server could not read the settings) keeps it as it is, and neither clears it.
 */
function setPausedFrom(answer: { paused?: true; pausedUnknown?: true }): void {
  if (answer.pausedUnknown === true) return;
  setPaused(answer.paused === true);
}

function renderPaused(): void {
  const banner = byId("workshop-paused");
  banner.textContent = PHASE_3_TEXTS.workshopPaused;
  banner.hidden = !(workshopPaused && SIGNED_IN_SCREENS.includes(current));
}

/**
 * Ticket 3.5: every signed-in screen asks `GET /api/status` every 30 s, so an idle page (the nickname screen, step 1 or
 * 2 with nothing in flight, step 4) also shows and clears the paused line. It runs only while a signed-in screen shows
 * and the tab is visible: leaving those screens (signing out) or hiding the tab stops it; showing the tab starts it again.
 */
let statusActive = false;
let statusRound = 0;
let statusTimer: number | undefined;

function syncStatusPolling(): void {
  const wanted = SIGNED_IN_SCREENS.includes(current) && document.visibilityState !== "hidden";
  if (wanted === statusActive) return;
  statusActive = wanted;
  statusRound++;
  if (statusTimer !== undefined) window.clearTimeout(statusTimer);
  statusTimer = undefined;
  if (wanted) scheduleStatus(statusRound);
}

function scheduleStatus(round: number): void {
  statusTimer = window.setTimeout(() => void statusOnce(round), STATUS_POLL_INTERVAL_MS);
}

async function statusOnce(round: number): Promise<void> {
  statusTimer = undefined;
  const paused = statusResult(await call("GET", "/api/status"));
  if (round !== statusRound) return;
  if (paused !== undefined) setPaused(paused);
  scheduleStatus(round);
}

/** Disables a button while its request runs and shows its waiting label. */
async function whileBusy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  const label = button.textContent ?? "";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = button.dataset["busyLabel"] ?? label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

function showEmail(message?: string, tone: Tone = "info"): void {
  if (message) say("email", message, tone);
  else clearMessage("email");
  show("email", "email-input");
}

function showMe(me: Me): void {
  const screen = screenFor(me);
  nickname = me.nickname ?? "";
  if (screen === "nickname") {
    stopPolling();
    clearMessage("nickname");
    show("nickname", "nickname-input");
    return;
  }
  if (screen === "build") {
    openBuild();
    return;
  }
  openView(screen === "spec" ? "spec" : "step");
  void loadConversation();
}

// ---- Steps 1, 2 and 4: the conversation (tickets 1.8, 1.9 and 3.8) ----

/** The elements of one step's conversation. */
interface View {
  screen: "step" | "spec" | "live";
  chat: string;
  typing: string;
  waitingNotice: string;
  send: string;
  flow: string;
  form: string;
  input: string;
  /** Ticket 3.3: the AI budget left, under the form. */
  budget: string;
}

const VIEWS: Record<"step" | "spec" | "live", View> = {
  step: { screen: "step", chat: "chat", typing: "typing", waitingNotice: "waiting-notice", send: "chat-send", flow: "behind-flow", form: "chat-form", input: "chat-input", budget: "chat-budget" },
  spec: {
    screen: "spec",
    chat: "spec-chat",
    typing: "spec-typing",
    waitingNotice: "spec-waiting-notice",
    send: "spec-chat-send",
    flow: "spec-behind-flow",
    form: "spec-chat-form",
    input: "spec-chat-input",
    budget: "spec-chat-budget",
  },
  // Ticket 3.8: step 4's change conversation; its stage marks the change loop's figure.
  live: {
    screen: "live",
    chat: "live-chat",
    typing: "live-typing",
    waitingNotice: "live-waiting-notice",
    send: "live-chat-send",
    flow: "live-diagram",
    form: "live-chat-form",
    input: "live-chat-input",
    budget: "live-chat-budget",
  },
};

let nickname = "";
let view: View = VIEWS.step;

/** Shows a step's screen (once) with the person's nickname. */
function openView(screen: "step" | "spec"): void {
  const changed = view.screen !== screen || byId(`screen-${screen}`).hidden;
  view = VIEWS[screen];
  if (!changed) return;
  stopPolling();
  messages = [];
  byId(screen === "step" ? "step-nickname" : "spec-nickname").textContent = nickname;
  clearMessage(screen);
  show(screen, screen === "step" ? "step-heading" : "spec-heading");
}

/** The conversation as shown, oldest first. */
let messages: ChatMessage[] = [];
/** The message in flight and how the page waits for it. */
let waiting: { id: string; mode: "pending" | "flagged" } | null = null;
let pollTimer: number | undefined;
/** Bumped whenever polling starts or stops, so an answer to an older poll is ignored. */
let pollRound = 0;
/** Bumped on every local change (a message sent), so a conversation read that started earlier is ignored. */
let localVersion = 0;

/** Step 2 (ticket 1.9): the newest and approved versions, and the version on the page. */
let specInfo: { latest?: number; approved?: number; atApproved: boolean } = { atApproved: false };
/** Ticket 3.3: the AI budget left from the last conversation read (dollars), if the answer had it. */
let budgetLeft: number | undefined;
let shownSpec: SpecVersion | null = null;

function stopPolling(): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  pollRound++;
  waiting = null;
}

/** Shows the conversation, the waiting state and the behind-the-scenes stage, then the step's own controls. */
function render(): void {
  byId(view.chat).replaceChildren(
    ...messages.map((m) => {
      const item = document.createElement("li");
      item.className = "bubble";
      item.dataset["author"] = m.author;
      if (m.status !== undefined) item.dataset["status"] = m.status;
      item.textContent = m.text;
      // The reply that saved the shown spec version links back to it: the spec sits above a long conversation.
      // Older versions are not shown on the page, so older replies carry no link.
      if (m.author === "assistant" && m.specVersion !== undefined && m.specVersion === shownSpec?.version && view.screen === "spec") {
        const see = document.createElement("button");
        see.type = "button";
        see.className = "link see-spec";
        see.textContent = SPEC_TEXTS.seeVersion(m.specVersion);
        see.addEventListener("click", revealSpec);
        item.append(see);
      }
      return item;
    }),
  );
  byId(view.typing).hidden = waiting?.mode !== "pending";
  byId(view.waitingNotice).hidden = waiting?.mode !== "flagged";
  byId(view.flow).dataset["stage"] = stageOf(waiting?.mode ?? "none", messages);
  byId<HTMLButtonElement>(view.send).disabled = waiting !== null;
  const budget = byId(view.budget);
  budget.hidden = budgetLeft === undefined;
  budget.textContent = budgetLeft === undefined ? "" : budgetLeftText(budgetLeft);
  if (view.screen === "step") renderStepOne();
  else if (view.screen === "spec") renderStepTwo();
  else renderStepFour();
}

/** Step 1: Write my spec (ticket 1.8). */
function renderStepOne(): void {
  const offer = byId("spec-offer");
  offer.hidden = !canWriteSpec(messages);
  const offered = specOffered(messages);
  offer.dataset["offered"] = String(offered);
  byId("spec-offer-text").textContent = offered ? CHAT_TEXTS.specOffered : CHAT_TEXTS.specAnytime;
  byId<HTMLButtonElement>("write-spec-button").disabled = waiting !== null;
}

/**
 * Step 2 (ticket 1.9): the approved notice, the missing-spec button, the form and Approve spec. Ticket 2.7: while the
 * readiness check runs (step approved, its request in flight) the notice says so; once it passed (step building) the
 * page moves to step 3 (ticket 2.10). At step approved with nothing in flight (an approval from before 2.7, a check that never
 * finished) Approve spec shows again, to ask for the check.
 */
function renderStepTwo(): void {
  const checking = specInfo.atApproved && waiting !== null;
  const approved = checking;
  const notice = byId("spec-approved");
  notice.hidden = !approved;
  notice.textContent = SPEC_TEXTS.approved;
  byId("spec-doc").hidden = shownSpec === null;
  byId("spec-missing").hidden = approved || specInfo.atApproved || specInfo.latest !== undefined || waiting !== null;
  byId("spec-typing-text").textContent = specInfo.atApproved ? SPEC_TEXTS.checking : specInfo.latest === undefined ? SPEC_TEXTS.writing : SPEC_TEXTS.answering;
  byId("spec-chat-form").hidden = specInfo.atApproved;
  byId("spec-approve").hidden = approved || shownSpec === null;
  byId<HTMLButtonElement>("approve-spec-button").disabled = waiting !== null || shownSpec?.version !== specInfo.latest;
}

/** Waits for the reply to message `id`: a poll every 2 seconds (10 while a facilitator decides). */
function startPolling(id: string, mode: "pending" | "flagged"): void {
  stopPolling();
  waiting = { id, mode };
  const round = pollRound;
  const schedule = (): void => {
    if (waiting === null) return;
    pollTimer = window.setTimeout(() => void pollOnce(id, round, schedule), waiting.mode === "flagged" ? WAITING_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
  };
  render();
  schedule();
}

async function pollOnce(id: string, round: number, schedule: () => void): Promise<void> {
  pollTimer = undefined;
  const result = pollResult(await call("GET", `/api/conversation/messages/${encodeURIComponent(id)}`));
  if (round !== pollRound || waiting === null) return;
  if (result.kind === "pending" || result.kind === "flagged" || result.kind === "answered") setPausedFrom(result);
  if (result.kind === "pending" || result.kind === "flagged") {
    waiting.mode = result.kind;
    setStatus(id, result.kind);
  } else if (result.kind === "answered") {
    setStatus(id, result.status);
    messages.push({ id: `${id}-r`, author: "assistant", text: result.reply });
    stopPolling();
    // A new spec version saved by this reply is brought into view once it is read (live check, ticket 1.9).
    revealNextSpec = true;
    // The reload brings offersSpec, a new spec version and anything else the poll does not carry. At step 4 the
    // answer may have queued a change build (Build this change): the build is read first (ticket 3.8).
    if (view.screen === "live") await refreshLive();
    else await loadConversation();
    return;
  } else if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  } else if (result.kind === "lost") {
    stopPolling();
    if (view.screen === "live") await refreshLive();
    else await loadConversation();
    return;
  }
  render();
  schedule();
}

function setStatus(id: string, status: string): void {
  const message = messages.find((m) => m.id === id);
  if (message) message.status = status;
}

/**
 * Reads the conversation so far (a page load, a reload, or after a reply), shows the screen of the
 * person's step, resumes waiting if needed, and at step 2 reads the newest spec when it changed.
 */
async function loadConversation(): Promise<void> {
  const version = localVersion;
  const result = conversationResult(await call("GET", "/api/conversation"));
  // A message was sent while this read was on its way: the page already knows more than the answer.
  if (version !== localVersion) return;
  if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  }
  if (result.kind === "show") {
    say(view.screen, result.message, result.tone);
    return;
  }
  const { conversation } = result;
  setPausedFrom(conversation);
  if (conversation.step !== "clarify" && conversation.step !== "spec" && conversation.step !== "approved" && conversation.step !== "building") {
    await goToOwnStep(view.screen);
    return;
  }
  // Ticket 2.10: once the readiness check passed, the build is on, and step 3 follows it. Ticket 3.8: on step 4 (shown
  // only once the build was read live, or a change build failed) the conversation is the change conversation.
  if (conversation.step === "building") {
    if (view.screen === "live" && current === "live") {
      await fillStepFour(conversation);
      return;
    }
    stopPolling();
    openBuild();
    return;
  }
  openView(conversation.step === "clarify" ? "step" : "spec");
  messages = view.screen === "spec" ? stepTwoMessages(conversation.messages) : conversation.messages;
  specInfo = {
    ...(conversation.latestSpecVersion === undefined ? {} : { latest: conversation.latestSpecVersion }),
    ...(conversation.approvedSpecVersion === undefined ? {} : { approved: conversation.approvedSpecVersion }),
    atApproved: conversation.step === "approved",
  };
  budgetLeft = conversation.budgetLeft;
  stopPolling();
  const pending = conversation.pendingId;
  if (pending !== undefined) startPolling(pending, conversation.state === "waiting" ? "flagged" : "pending");
  else render();
  if (view.screen === "spec") await loadSpec();
}

/** Reads the newest spec version when the page shows another one (or none), and shows it. */
async function loadSpec(): Promise<void> {
  const latest = specInfo.latest;
  const approved = specInfo.approved !== undefined;
  if (latest === undefined || (shownSpec?.version === latest && shownSpec.approved === approved)) {
    revealNextSpec = false;
    return;
  }
  const previous = shownSpec?.version;
  const result = specResult(await call("GET", "/api/conversation/spec"));
  if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  }
  if (result.kind === "show") {
    say("spec", result.message, result.tone);
    return;
  }
  if (result.kind === "none") return;
  const redraw = shownSpec?.text !== result.spec.text;
  shownSpec = result.spec;
  const reveal = revealNextSpec && previous !== undefined && previous !== result.spec.version;
  revealNextSpec = false;
  if (redraw) showSpecDocument(result.spec);
  else byId("spec-version").textContent = versionLabel(result.spec);
  render();
  if (reveal) revealSpec();
}

/** Set when a reply arrives: if it saved a new spec version, `loadSpec` scrolls the spec into view. */
let revealNextSpec = false;

/** Scrolls the spec to the top of the screen and moves the focus to it (screen readers announce it). */
function revealSpec(): void {
  const doc = byId("spec-doc");
  if (doc.hidden) return;
  doc.scrollIntoView({ block: "start" });
  doc.focus({ preventScroll: true });
}

const versionLabel = (spec: SpecVersion): string => `Version ${spec.version}${spec.approved ? " (approved)" : ""}`;

/** Bumped for every spec shown, so a slow drawing of an older version is dropped. */
let drawing = 0;

/** Shows a spec: the title, the diagram (drawn as a picture), and the sections. */
function showSpecDocument(spec: SpecVersion): void {
  const doc = specView(spec.text);
  byId("spec-version").textContent = versionLabel(spec);
  byId("spec-title").textContent = doc.title;
  byId("spec-diagram-text").textContent = doc.diagram;
  byId("spec-sections").replaceChildren(...sectionNodes(doc.sections, "h4"));
  void drawDiagram(doc.diagram, doc.title, ++drawing);
}

/** A spec's sections as headings, paragraphs and lists, every text set with `textContent`. */
function sectionNodes(sections: ReturnType<typeof specView>["sections"], headingTag: "h4" | "h5"): HTMLElement[] {
  return sections.flatMap((section) => {
    const heading = document.createElement(headingTag);
    heading.textContent = section.heading;
    const blocks = section.blocks.map((block) => {
      if (block.kind === "paragraph") {
        const p = document.createElement("p");
        p.textContent = block.text;
        return p;
      }
      const list = document.createElement("ul");
      list.append(
        ...block.items.map((text) => {
          const li = document.createElement("li");
          li.textContent = text;
          return li;
        }),
      );
      return list;
    });
    return [heading, ...blocks];
  });
}

let diagramScript: Promise<DiagramApi> | undefined;

/** Loads diagram.js (Mermaid) once, the first time a diagram is drawn. */
function diagramApi(): Promise<DiagramApi> {
  diagramScript ??= new Promise<DiagramApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "diagram.js";
    script.addEventListener("load", () => {
      const api = (window as unknown as { ssdDiagram?: DiagramApi }).ssdDiagram;
      if (api) resolve(api);
      else reject(new Error("diagram.js did not load"));
    });
    script.addEventListener("error", () => {
      diagramScript = undefined;
      reject(new Error("diagram.js did not load"));
    });
    document.head.append(script);
  });
  return diagramScript;
}

async function drawDiagram(source: string, title: string, round: number): Promise<void> {
  const status = byId("spec-diagram-status");
  const img = byId<HTMLImageElement>("spec-diagram-img");
  img.hidden = true;
  status.textContent = SPEC_TEXTS.drawing;
  try {
    const picture = await (await diagramApi()).render(source);
    if (round !== drawing) return;
    img.width = picture.width;
    img.height = picture.height;
    img.alt = `Diagram of ${title || "your app"}: its screens, the data it keeps and how they connect.`;
    img.src = pictureUrl(picture);
    await img.decode();
    if (round !== drawing) return;
    img.hidden = false;
    status.textContent = "";
  } catch {
    if (round !== drawing) return;
    img.hidden = true;
    status.textContent = SPEC_TEXTS.noDiagram;
  }
}

// ---- Step 3: the live build feed, and step 4 once live (tickets 2.10 and 2.11) ----

let buildTimer: number | undefined;
/** Bumped whenever build polling starts or stops, so an answer to an older poll is ignored. */
let buildRound = 0;

function stopBuildPolling(): void {
  if (buildTimer !== undefined) window.clearTimeout(buildTimer);
  buildTimer = undefined;
  buildRound++;
}

/** Shows step 3 (once) and asks for the build at once, then every 2 seconds while it runs. */
function openBuild(): void {
  if (!byId("screen-build").hidden && buildTimer !== undefined) return;
  stopPolling();
  byId("build-nickname").textContent = nickname;
  clearMessage("build");
  show("build", "build-heading");
  // Until the first answer: the build as it starts (no stage yet, nothing written).
  renderBuild({ buildId: "", status: "queued", feed: [] });
  stopBuildPolling();
  void pollBuild(buildRound);
}

async function pollBuild(round: number): Promise<void> {
  buildTimer = undefined;
  const result = buildResult(await call("GET", "/api/build"));
  if (round !== buildRound) return;
  if (result.kind === "signed-out") {
    showEmail(MESSAGES.signedOut);
    return;
  }
  if (result.kind === "show") say("build", result.message, result.tone);
  else clearMessage("build");
  if (result.kind === "build") {
    setPausedFrom(result.build);
    renderBuild(result.build);
    // Live, or a change build that failed (the app before it is still live): back to step 4 (ticket 3.8).
    if (showsStepFour(result.build)) {
      showLive(result.build);
      return;
    }
    if (!isRunning(result.build.status)) return;
  }
  // Running, not there yet (404) or a passing problem: ask again in 2 seconds.
  buildTimer = window.setTimeout(() => void pollBuild(round), BUILD_POLL_INTERVAL_MS);
}

/** The stages (the current one highlighted), the line on what happens now, the feed and the behind-the-scenes part. */
function renderBuild(build: Build): void {
  // Ticket 3.8: a change build says which change it is, and Behind the scenes says it starts from the repository.
  const change = build.kind === "change";
  byId("build-intro").hidden = change;
  const changeLine = byId("build-change");
  changeLine.hidden = !change;
  changeLine.textContent = change ? changeBuildingText(build.changeNumber) : "";
  const behindText = byId("build-behind-text");
  firstBuildBehindText ??= behindText.textContent ?? "";
  behindText.textContent = change ? PHASE_3_TEXTS.changeBuildBehind : firstBuildBehindText;
  const states = stageStates(build);
  const failed = build.status === "failed";
  for (const item of byId("build-stages").querySelectorAll<HTMLElement>("li[data-stage]")) {
    const state = states[item.dataset["stage"] as keyof typeof states] ?? "todo";
    item.dataset["state"] = state;
    if (state === "current") item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    if (failed && state === "current") item.dataset["failed"] = "true";
    else delete item.dataset["failed"];
  }
  const now = byId("build-now");
  now.textContent = nowText(build);
  now.dataset["tone"] = failed ? "error" : "info";
  const reasons = byId("build-reasons");
  const shownReasons = failed ? (build.failureReasons ?? []) : [];
  reasons.hidden = shownReasons.length === 0;
  reasons.replaceChildren(
    ...shownReasons.map((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      return li;
    }),
  );
  const part = behindPart(build);
  for (const item of byId("build-behind-flow").querySelectorAll<HTMLElement>("li[data-part]")) {
    if (item.dataset["part"] === part) item.dataset["current"] = "true";
    else delete item.dataset["current"];
  }
  const lines = feedLines(build);
  byId("build-feed-empty").hidden = lines.length > 0;
  byId("build-feed").replaceChildren(
    ...lines.map((line) => {
      const li = document.createElement("li");
      li.dataset["kind"] = line.kind;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = line.label;
      const text = document.createElement(line.kind === "commit" ? "span" : "code");
      text.textContent = line.text;
      li.append(label, text);
      if (line.link !== undefined) {
        const a = document.createElement("a");
        a.href = line.link.href;
        a.rel = "noopener";
        a.target = "_blank";
        a.textContent = line.link.text;
        a.setAttribute("aria-label", `Commit ${line.link.text} on GitHub`);
        li.append(a);
      }
      return li;
    }),
  );
}

/** Step 3's first-build "Behind the scenes" text, as index.html has it (a change build shows another). */
let firstBuildBehindText: string | undefined;

/**
 * Step 4 (tickets 2.10 and 2.11): the app's address as a link and as a QR code, and the repository link. Only the
 * addresses `parseBuild` validated reach the page, set with `href` and `textContent`; each part stays hidden
 * without its address. Ticket 3.8: after a failed change build, the failure and its reasons above them; then the change
 * conversation, read from `GET /api/conversation`.
 */
function showLive(build: Build): void {
  const link = byId<HTMLAnchorElement>("live-link");
  const code = byId("live-qr-code");
  if (build.appUrl !== undefined) {
    link.href = build.appUrl;
    if (link.textContent !== build.appUrl) code.replaceChildren(qrSvg(build.appUrl));
    link.textContent = build.appUrl;
  } else code.replaceChildren();
  byId("live-address").hidden = build.appUrl === undefined;
  byId("live-qr").hidden = build.appUrl === undefined;
  const repository = byId<HTMLAnchorElement>("live-repository-link");
  if (build.repositoryUrl !== undefined) {
    repository.href = build.repositoryUrl;
    repository.textContent = build.repositoryUrl;
  }
  byId("live-repository").hidden = build.repositoryUrl === undefined;
  const failed = build.status === "failed";
  byId("live-failed").hidden = !failed;
  byId("live-failed-text").textContent = failed ? changeBuildFailedText(build.changeNumber) : "";
  byId("live-failed-reasons").replaceChildren(
    ...(failed ? (build.failureReasons ?? []) : []).map((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      return li;
    }),
  );
  view = VIEWS.live;
  if (current !== "live") {
    // Entering step 4 (a page load, or back from a change build): start from what the API says.
    stopPolling();
    messages = [];
    proposal = null;
    stepFour = {};
    suggestionsShown = "";
    suggestionsRereads = 0;
    byId<HTMLTextAreaElement>("live-chat-input").value = "";
    renderSuggestions([]);
    clearMessage("live");
    show("live", "live-heading");
    void drawChangeLoop();
  }
  void loadConversation();
}

// ---- Step 4: change requests (ticket 3.8) ----

/** The step 4 facts of the last conversation read: changes used and the cap, suggestions, the proposed version. */
let stepFour: Pick<Conversation, "changeRequestsUsed" | "changeRequestsPerPerson" | "suggestions" | "proposedSpecVersion"> = {};
/** The proposed change on the page (its "What changes" list), or none. */
let proposal: Proposal | null = null;

/** Shows the change conversation from a conversation read, resumes waiting for a reply, then reads the proposal. */
async function fillStepFour(conversation: Conversation): Promise<void> {
  messages = stepFourMessages(conversation.messages);
  budgetLeft = conversation.budgetLeft;
  stepFour = {
    ...(conversation.changeRequestsUsed === undefined ? {} : { changeRequestsUsed: conversation.changeRequestsUsed }),
    ...(conversation.changeRequestsPerPerson === undefined ? {} : { changeRequestsPerPerson: conversation.changeRequestsPerPerson }),
    ...(conversation.suggestions === undefined ? {} : { suggestions: conversation.suggestions }),
    ...(conversation.proposedSpecVersion === undefined ? {} : { proposedSpecVersion: conversation.proposedSpecVersion }),
  };
  renderSuggestions(conversation.suggestions ?? []);
  stopPolling();
  const pending = conversation.pendingId;
  if (pending !== undefined) startPolling(pending, conversation.state === "waiting" ? "flagged" : "pending");
  else render();
  await loadProposal();
  rereadForSuggestions();
}

/** Reads the proposed version when it is not the one on the page, and shows its "What changes" list. */
async function loadProposal(): Promise<void> {
  const version = stepFour.proposedSpecVersion;
  const reveal = revealNextSpec;
  revealNextSpec = false;
  if (version === undefined) {
    proposal = null;
    render();
    return;
  }
  if (proposal?.version === version) return;
  const result = proposalResult(await call("GET", `/api/conversation/spec?version=${version}`));
  if (current !== "live") return;
  if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  }
  if (result.kind === "show") {
    say("live", result.message, result.tone);
    return;
  }
  if (result.kind === "none" || stepFour.proposedSpecVersion !== version) return;
  proposal = result.proposal;
  showProposal(result.proposal);
  render();
  if (reveal) {
    const box = byId("proposal");
    box.scrollIntoView({ block: "start" });
    box.focus({ preventScroll: true });
  }
}

/** Fills the spec update: its version, the "What changes" list, and the whole spec under a fold. */
function showProposal(update: Proposal): void {
  byId("proposal-version").textContent = proposalVersionText(update.version);
  byId("proposal-changes").replaceChildren(
    ...update.whatChanges.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
  let nodes: HTMLElement[];
  try {
    const doc = specView(update.text);
    const title = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = doc.title;
    title.append(strong);
    nodes = [title, ...sectionNodes(doc.sections, "h5")];
  } catch {
    const pre = document.createElement("pre");
    pre.textContent = update.text;
    nodes = [pre];
  }
  byId("proposal-spec-body").replaceChildren(...nodes);
  byId("proposal-hint").textContent = PHASE_3_TEXTS.proposalHint;
}

/** The suggestions as shown (joined), so the buttons are made again only when they change (a press keeps its focus). */
let suggestionsShown = "";

function renderSuggestions(suggestions: readonly string[]): void {
  const key = suggestions.join("\n");
  if (key === suggestionsShown && byId("suggestions-list").childElementCount === suggestions.length) return;
  suggestionsShown = key;
  byId("suggestions-intro").textContent = PHASE_3_TEXTS.suggestionsIntro;
  byId("suggestions-list").replaceChildren(
    ...suggestions.map((text) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion";
      button.textContent = text;
      // Fills the box only: nothing is sent until Send.
      button.addEventListener("click", () => {
        const input = byId<HTMLTextAreaElement>("live-chat-input");
        input.value = text;
        clearMessage("live");
        input.focus();
      });
      li.append(button);
      return li;
    }),
  );
}

/** Step 4's own parts: changes left, the used-up line, the suggestions, the spec update and its buttons, the form. */
function renderStepFour(): void {
  const pending = waiting === null ? undefined : messages.find((m) => m.id === waiting?.id);
  const state = stepFourView(stepFour, proposal, pending);
  const count = byId("changes-left");
  count.hidden = state.countText === undefined;
  count.textContent = state.countText ?? "";
  const usedUp = byId("changes-used");
  usedUp.hidden = state.usedUpText === undefined;
  usedUp.textContent = state.usedUpText ?? "";
  byId("changes-intro").hidden = !state.showForm;
  byId("live-chat-form").hidden = !state.showForm;
  byId("suggestions").hidden = !state.showSuggestions;
  byId("proposal").hidden = !state.showProposal;
  byId<HTMLButtonElement>("build-change-button").disabled = waiting !== null;
  byId<HTMLButtonElement>("discard-change-button").disabled = waiting !== null;
  byId("live-typing-text").textContent = state.typingText;
}

/**
 * Re-reads the build, then shows what it says: step 3 while a build runs (Build this change queued one, ticket 3.8),
 * else step 4 with the conversation read again. A missing build or a passing problem keeps step 4.
 */
async function refreshLive(): Promise<void> {
  const result = buildResult(await call("GET", "/api/build"));
  if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  }
  if (result.kind === "build") {
    setPausedFrom(result.build);
    if (showsStepFour(result.build)) showLive(result.build);
    else openBuild();
    return;
  }
  if (result.kind === "show") say("live", result.message, result.tone);
  await loadConversation();
}

/** What Build this change and Not this one do with their answer. */
async function afterChangeAction(result: ReturnType<typeof changeActionResult>): Promise<void> {
  if (result.kind === "done") {
    await loadConversation();
  } else if (result.kind === "gone") {
    say("live", PHASE_3_TEXTS.proposalGone, "info");
    proposal = null;
    await loadConversation();
  } else if (result.kind === "refused") {
    say("live", result.message, "error");
    if (result.reason === "build-running" || result.reason === "not-live") await refreshLive();
    else await loadConversation();
  } else if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
  } else say("live", result.message, result.tone);
}

/**
 * The suggestions are written by the AI once the app is first live, a few seconds after the page may have read the
 * conversation: while none are there (and changes are left), the page reads the conversation again every 5 s, at most
 * 12 times (a minute), only while step 4 shows and nothing is in flight.
 */
const SUGGESTIONS_REREAD_MS = 5000;
const SUGGESTIONS_REREADS = 12;
let suggestionsTimer: number | undefined;
let suggestionsRereads = 0;

function stopSuggestionsReread(): void {
  if (suggestionsTimer !== undefined) window.clearTimeout(suggestionsTimer);
  suggestionsTimer = undefined;
}

function rereadForSuggestions(): void {
  const missing = (stepFour.suggestions?.length ?? 0) === 0;
  const left = stepFour.changeRequestsUsed === undefined || stepFour.changeRequestsPerPerson === undefined || stepFour.changeRequestsUsed < stepFour.changeRequestsPerPerson;
  if (!missing || !left || current !== "live" || suggestionsTimer !== undefined || suggestionsRereads >= SUGGESTIONS_REREADS) return;
  suggestionsTimer = window.setTimeout(() => {
    suggestionsTimer = undefined;
    suggestionsRereads++;
    if (current === "live" && waiting === null) void loadConversation();
    else rereadForSuggestions();
  }, SUGGESTIONS_REREAD_MS);
}

/** Draws the change loop in step 4's Behind the scenes box, once per page (Mermaid's diagram.js, loaded the first time). */
let changeLoopDrawn = false;

async function drawChangeLoop(): Promise<void> {
  if (changeLoopDrawn) return;
  changeLoopDrawn = true;
  const status = byId("live-diagram-status");
  const img = byId<HTMLImageElement>("live-diagram-img");
  byId("live-diagram-text").textContent = CHANGE_LOOP_DIAGRAM;
  status.textContent = SPEC_TEXTS.drawing;
  try {
    const picture = await (await diagramApi()).render(CHANGE_LOOP_DIAGRAM);
    img.width = picture.width;
    img.height = picture.height;
    img.alt = CHANGE_LOOP_ALT;
    img.src = pictureUrl(picture);
    await img.decode();
    img.hidden = false;
    status.textContent = "";
  } catch {
    changeLoopDrawn = false;
    img.hidden = true;
    status.textContent = PHASE_3_TEXTS.changeLoopNoDiagram;
  }
}

/** The QR code for `text` as an SVG element: a white square and one black path (no markup, no style attribute). */
function qrSvg(text: string): SVGSVGElement {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const { size, d } = qrSvgPath(qrModules(text));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `QR code for ${text}`);
  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#ffffff");
  const modules = document.createElementNS(SVG_NS, "path");
  modules.setAttribute("d", d);
  modules.setAttribute("fill", "#000000");
  svg.append(background, modules);
  return svg;
}

/** Sends the message in the current step's form. */
function sendMessage(): void {
  const input = byId<HTMLTextAreaElement>(view.input);
  const sendButton = byId<HTMLButtonElement>(view.send);
  const screen = view.screen;
  const text = input.value.trim();
  if (text === "") {
    say(screen, CHAT_TEXTS.empty, "error");
    input.focus();
    return;
  }
  if (waiting !== null) return;
  clearMessage(screen);
  void whileBusy(sendButton, async () => {
    const result = sendResult(await call("POST", "/api/conversation/messages", { text }));
    if (result.kind === "sent") {
      input.value = "";
      localVersion++;
      messages.push({ id: result.id, author: "participant", text, status: "pending", step: screen === "spec" ? "spec" : screen === "live" ? "building" : "clarify" });
      startPolling(result.id, "pending");
    } else if (result.kind === "busy" || result.kind === "waiting" || result.kind === "approved") {
      await loadConversation();
    } else if (result.kind === "change-refused") {
      // Ticket 3.8: all changes used (the page shows it), or a build running or no live app (the build is read again).
      say(screen, result.message, "error");
      if (result.reason === "no-changes-left") await loadConversation();
      else await refreshLive();
    } else if (result.kind === "no-nickname") {
      await goToOwnStep(screen);
    } else if (result.kind === "signed-out") {
      showEmail(MESSAGES.signedOut);
    } else {
      say(screen, result.message, result.tone);
    }
  }).finally(() => {
    if (!byId(`screen-${screen}`).hidden) render();
  });
}

/** Reads the person's own record and goes where it says; signed out goes to the email screen. */
async function goToOwnStep(onFailure: Screen): Promise<void> {
  const result = meResult(await call("GET", "/api/me"));
  if (result.kind === "me") showMe(result.me);
  else if (result.kind === "signed-out") showEmail(onFailure === "email" ? undefined : MESSAGES.signedOut);
  else {
    if (onFailure === "email") show("email", "email-input");
    say(onFailure, result.message, result.tone);
  }
}

async function requestCode(email: string): Promise<boolean> {
  const result = codeRequestResult(await call("POST", "/api/sign-in/code", { email }));
  if (result.kind === "sent") return true;
  say(pendingEmail === email ? "code" : "email", result.message, result.tone);
  return false;
}

function wire(): void {
  const emailForm = byId<HTMLFormElement>("email-form");
  const emailInput = byId<HTMLInputElement>("email-input");
  const codeForm = byId<HTMLFormElement>("code-form");
  const codeInput = byId<HTMLInputElement>("code-input");
  const nicknameForm = byId<HTMLFormElement>("nickname-form");
  const nicknameInput = byId<HTMLInputElement>("nickname-input");
  const resend = byId<HTMLButtonElement>("resend-button");
  const submitOf = (form: HTMLFormElement): HTMLButtonElement => form.querySelector("button[type=submit]") as HTMLButtonElement;

  emailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!isPlausibleEmail(email)) {
      say("email", MESSAGES.badEmail, "error");
      emailInput.focus();
      return;
    }
    clearMessage("email");
    void whileBusy(submitOf(emailForm), async () => {
      pendingEmail = null;
      if (!(await requestCode(email))) return;
      pendingEmail = email;
      codeInput.value = "";
      say("code", MESSAGES.neutral, "info");
      show("code", "code-input");
    });
  });

  codeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = pendingEmail;
    if (email === null) {
      showEmail();
      return;
    }
    const code = normalizeCode(codeInput.value);
    if (code === undefined) {
      say("code", MESSAGES.badCode, "error");
      codeInput.focus();
      return;
    }
    say("code", MESSAGES.checking, "info");
    void whileBusy(submitOf(codeForm), async () => {
      const result = verifyResult(await call("POST", "/api/sign-in/verify", { email, code }));
      if (result.kind === "show") {
        say("code", result.message, result.tone);
        codeInput.focus();
        return;
      }
      // Signed in: forget the address, then let GET /api/me say where to go.
      pendingEmail = null;
      emailInput.value = "";
      codeInput.value = "";
      await goToOwnStep("code");
    });
  });

  resend.addEventListener("click", () => {
    const email = pendingEmail;
    if (email === null) {
      showEmail();
      return;
    }
    void whileBusy(resend, async () => {
      if (await requestCode(email)) say("code", MESSAGES.neutral, "info");
    });
  });

  byId<HTMLButtonElement>("other-email-button").addEventListener("click", () => {
    pendingEmail = null;
    codeInput.value = "";
    showEmail();
  });

  for (const v of Object.values(VIEWS)) {
    byId<HTMLFormElement>(v.form).addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage();
    });
  }

  // Write my spec, on step 1 and (when the first try failed) on step 2: then step 2 shows the spec coming.
  for (const [id, screen] of [["write-spec-button", "step"], ["spec-write-button", "spec"]] as const) {
    const button = byId<HTMLButtonElement>(id);
    button.addEventListener("click", () => {
      clearMessage(screen);
      void whileBusy(button, async () => {
        const result = writeSpecResult(await call("POST", "/api/conversation/step", { step: "spec" }));
        if (result.kind === "moved") {
          openView("spec");
          await loadConversation();
        } else if (result.kind === "signed-out") showEmail(MESSAGES.signedOut);
        else say(screen, result.message, result.tone);
      }).finally(() => {
        if (!byId(`screen-${view.screen}`).hidden) render();
      });
    });
  }

  // Approve spec (ticket 1.9): the version on the page; a refusal says why and re-reads what changed.
  const approveButton = byId<HTMLButtonElement>("approve-spec-button");
  approveButton.addEventListener("click", () => {
    const spec = shownSpec;
    if (spec === null || waiting !== null) return;
    clearMessage("spec");
    void whileBusy(approveButton, async () => {
      const result = approveResult(await call("POST", "/api/conversation/spec/approve", { version: spec.version }));
      if (result.kind === "approved") {
        await loadConversation();
        byId("spec-approved").focus();
      } else if (result.kind === "refused") {
        say("spec", result.message, "error");
        await loadConversation();
      } else if (result.kind === "signed-out") showEmail(MESSAGES.signedOut);
      else say("spec", result.message, result.tone);
    }).finally(() => {
      if (!byId("screen-spec").hidden) render();
    });
  });

  // Ticket 3.8: Build this change and Not this one, on the version on the page.
  for (const [id, path] of [["build-change-button", "/api/conversation/change/build"], ["discard-change-button", "/api/conversation/change/discard"]] as const) {
    const button = byId<HTMLButtonElement>(id);
    button.addEventListener("click", () => {
      const update = proposal;
      if (update === null || waiting !== null) return;
      clearMessage("live");
      void whileBusy(button, async () => {
        const result = changeActionResult(await call("POST", path, { version: update.version }));
        if (result.kind === "done" && id === "discard-change-button") proposal = null;
        await afterChangeAction(result);
      }).finally(() => {
        if (current === "live") render();
      });
    });
  }

  // Sign out (ticket 3.1): the API deletes the session and clears the cookie; the page stops polling.
  const signOutButton = byId<HTMLButtonElement>("sign-out-button");
  signOutButton.addEventListener("click", () => {
    void whileBusy(signOutButton, async () => {
      const result = signOutResult(await call("POST", "/api/sign-out", {}));
      if (result.kind === "signed-out") {
        stopPolling();
        showEmail(MESSAGES.signOutDone);
      } else if (current !== "loading") say(current, result.message, result.tone);
    });
  });

  nicknameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const nickname = nicknameInput.value.trim();
    clearMessage("nickname");
    void whileBusy(submitOf(nicknameForm), async () => {
      const result = nicknameResult(await call("POST", "/api/me/nickname", { nickname }));
      if (result.kind === "saved") showMe(result.me);
      else if (result.kind === "refresh") await goToOwnStep("nickname");
      else if (result.kind === "signed-out") showEmail(MESSAGES.signedOut);
      else {
        say("nickname", result.message, result.tone);
        nicknameInput.focus();
      }
    });
  });
}

wire();
document.addEventListener("visibilitychange", syncStatusPolling);
show("loading");
// A returning person with a valid session goes straight to their step.
void goToOwnStep("email");
