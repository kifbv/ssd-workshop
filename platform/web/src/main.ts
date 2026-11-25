// Sign-in screens (ticket 1.6): email, code, nickname, then the step screen; step 1, Clarify (ticket
// 1.8), step 2, Spec and approval (ticket 1.9), step 3, Build (ticket 2.10), and step 4, Live (tickets 2.10 and 2.11). The rules for each API answer are in ./flow.ts,
// ./chat.ts and ./spec-view.ts; this file only wires them to the page. Both steps share one
// conversation, polling and Send form logic, each on its own elements (`VIEWS`).
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
  WAITING_POLL_INTERVAL_MS,
  budgetLeftText,
  canWriteSpec,
  conversationResult,
  pollResult,
  sendResult,
  specOffered,
  stageOf,
  writeSpecResult,
  type ChatMessage,
} from "./chat.js";
import type { DiagramApi } from "./diagram.js";
import { pictureUrl } from "./diagram-svg.js";
import { approveResult, SPEC_TEXTS, specResult, specView, stepTwoMessages, type SpecVersion } from "./spec-view.js";
import { qrModules, qrSvgPath } from "./qr.js";
import { BUILD_POLL_INTERVAL_MS, behindPart, buildResult, feedLines, isRunning, nowText, stageStates, type Build } from "./build-view.js";

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
  current = name;
  for (const section of document.querySelectorAll<HTMLElement>("[data-screen]")) {
    section.hidden = section.id !== `screen-${name}`;
  }
  byId("account").hidden = !SIGNED_IN_SCREENS.includes(name);
  if (focusId) byId(focusId).focus();
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

// ---- Steps 1 and 2: the conversation (tickets 1.8 and 1.9) ----

/** The elements of one step's conversation. */
interface View {
  screen: "step" | "spec";
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

const VIEWS: Record<"step" | "spec", View> = {
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
  else renderStepTwo();
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
  if (result.kind === "pending" || result.kind === "flagged") {
    waiting.mode = result.kind;
    setStatus(id, result.kind);
  } else if (result.kind === "answered") {
    setStatus(id, result.status);
    messages.push({ id: `${id}-r`, author: "assistant", text: result.reply });
    stopPolling();
    // A new spec version saved by this reply is brought into view once it is read (live check, ticket 1.9).
    revealNextSpec = true;
    // The reload brings offersSpec, a new spec version and anything else the poll does not carry.
    await loadConversation();
    return;
  } else if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  } else if (result.kind === "lost") {
    stopPolling();
    await loadConversation();
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
  if (conversation.step !== "clarify" && conversation.step !== "spec" && conversation.step !== "approved" && conversation.step !== "building") {
    await goToOwnStep(view.screen);
    return;
  }
  // Ticket 2.10: once the readiness check passed, the build is on, and step 3 follows it.
  if (conversation.step === "building") {
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
  byId("spec-sections").replaceChildren(
    ...doc.sections.flatMap((section) => {
      const heading = document.createElement("h4");
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
    }),
  );
  void drawDiagram(doc.diagram, doc.title, ++drawing);
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
    renderBuild(result.build);
    if (result.build.status === "live") {
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

/**
 * Step 4 (tickets 2.10 and 2.11): the app's address as a link and as a QR code, and the repository link. Only the
 * addresses `parseBuild` validated reach the page, set with `href` and `textContent`; each part stays hidden
 * without its address.
 */
function showLive(build: Build): void {
  const link = byId<HTMLAnchorElement>("live-link");
  const code = byId("live-qr-code");
  if (build.appUrl !== undefined) {
    link.href = build.appUrl;
    link.textContent = build.appUrl;
    code.replaceChildren(qrSvg(build.appUrl));
  } else code.replaceChildren();
  byId("live-address").hidden = build.appUrl === undefined;
  byId("live-qr").hidden = build.appUrl === undefined;
  const repository = byId<HTMLAnchorElement>("live-repository-link");
  if (build.repositoryUrl !== undefined) {
    repository.href = build.repositoryUrl;
    repository.textContent = build.repositoryUrl;
  }
  byId("live-repository").hidden = build.repositoryUrl === undefined;
  clearMessage("live");
  show("live", "live-heading");
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
      messages.push({ id: result.id, author: "participant", text, status: "pending", step: screen === "spec" ? "spec" : "clarify" });
      startPolling(result.id, "pending");
    } else if (result.kind === "busy" || result.kind === "waiting" || result.kind === "approved") {
      await loadConversation();
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
show("loading");
// A returning person with a valid session goes straight to their step.
void goToOwnStep("email");
