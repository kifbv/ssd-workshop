// The facilitator dashboard (ticket 3.11), at /facilitator/: the list of participants every 5 seconds while the tab is
// visible, flagged messages first with Approve and Reject, then one card per participant with Retry, Pause or Resume,
// Add $2 and View conversation. The rules for each answer are in ./dashboard-view.ts; this file only wires them to the
// page. Every text is set with `textContent` (the pages' CSP has no inline script or style).
//
// Personal data: the API sends no participant id and no email address; nothing here stores or logs what it reads.
import {
  DASHBOARD_POLL_INTERVAL_MS,
  DECIDED_FLAG_HIDE_MS,
  EVERYONE,
  actionPath,
  actionResult,
  buildText,
  canRetry,
  conversationResult,
  groupsOf,
  hasActions,
  initialFilter,
  listResult,
  logLabel,
  rowAlert,
  shownRows,
  stepText,
  usageText,
  type ParticipantList,
  type Row,
} from "./dashboard-view.js";
import {
  CAP_FIELDS,
  RESUME_PATH,
  SETTINGS_PATH,
  STOP_PATH,
  capsBody,
  fieldValue,
  saveResult,
  settingsResult,
  stateText,
  switchResult,
  type AdminSettings,
  type CapField,
} from "./admin-view.js";
import type { ApiAnswer } from "./flow.js";
import { ADMIN_TEXTS, DASHBOARD_TEXTS, capErrorText, otherGroupFlagsText } from "../../api/workshop/texts.js";

/** Button labels (the web code's own; messages for people come from platform/api/workshop/texts.ts). */
const LABELS = {
  approve: "Approve",
  reject: "Reject",
  retry: "Retry",
  pause: "Pause",
  resume: "Resume",
  budget: "Add $2",
  view: "View conversation",
  hide: "Hide conversation",
  busy: "Working…",
  everyone: "Everyone",
  yours: (group: string) => `${group} (your group)`,
  count: (shown: number, all: number) => (shown === all ? `${all} ${all === 1 ? "participant" : "participants"}` : `Showing ${shown} of ${all} participants`),
  paused: "Paused",
} as const;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element as T;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

/** Same-origin JSON call; status 0 when there is no answer at all. Every write sends a JSON content type (else 415). */
async function call(method: "GET" | "POST" | "PUT", path: string, body: unknown = {}): Promise<ApiAnswer> {
  const init: RequestInit = { method, credentials: "same-origin", cache: "no-store" };
  if (method !== "GET") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(path, init);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

/** Signed out (401): the sign-in is on the main page, as for every other page of the site. */
function goToSignIn(): void {
  stopForGood();
  window.location.assign("/");
}

function say(id: string, message: string, tone: "info" | "error"): void {
  const target = byId(id);
  target.dataset["tone"] = tone;
  target.textContent = message;
}

/** Disables a button while its request runs and shows the waiting label. */
async function whileBusy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  const label = button.textContent ?? "";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = LABELS.busy;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

// ---- State ----

let list: ParticipantList | undefined;
let filter: string | undefined;
/** Flags decided on this page, hidden until a list read after the hiding time no longer needs it: "nickname\0text" -> until. */
const decided = new Map<string, number>();

// ---- Polling: every 5 s while the tab is visible; a hidden tab stops it, showing the tab reads at once. ----

let allowed = true;
let active = false;
let round = 0;
let timer: number | undefined;

function syncPolling(): void {
  const wanted = allowed && document.visibilityState !== "hidden";
  if (wanted === active) return;
  active = wanted;
  round++;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  if (wanted) void pollOnce(round);
}

function stopForGood(): void {
  allowed = false;
  syncPolling();
}

async function pollOnce(mine: number): Promise<void> {
  timer = undefined;
  const switchesBefore = switches;
  const result = listResult(await call("GET", "/api/facilitator/participants"));
  if (mine !== round) return;
  // A list read that started before a Stop or Resume answered may hold the old state: the admin's answer wins.
  if (result.kind === "list" && switchesBefore !== switches && knownStopped !== undefined) result.list.stopped = knownStopped;
  if (result.kind === "signed-out") return goToSignIn();
  if (result.kind === "not-facilitator") {
    stopForGood();
    showDenied(result.message);
    return;
  }
  if (result.kind === "error") {
    say("message-dashboard", result.message, "error");
    if (list === undefined) byId("dashboard-loading").textContent = result.message;
  } else {
    byId("message-dashboard").textContent = "";
    list = result.list;
    render();
  }
  timer = window.setTimeout(() => void pollOnce(mine), DASHBOARD_POLL_INTERVAL_MS);
}

/** A participant: one line and no data (the API answered the plain 404 and sent nothing). */
function showDenied(message: string): void {
  byId("dashboard-loading").hidden = true;
  byId("dashboard").hidden = true;
  byId("rows").replaceChildren();
  byId("flag-list").replaceChildren();
  hideAdmin("denied");
  byId("dashboard-denied-text").textContent = message;
  byId("dashboard-denied").hidden = false;
}

// ---- Rendering: cards are kept by nickname and updated in place, so an open conversation or a busy button survives a poll. ----

interface Card {
  item: HTMLLIElement;
  name: HTMLElement;
  group: HTMLElement;
  pausedBadge: HTMLElement;
  step: HTMLElement;
  build: HTMLElement;
  usage: HTMLElement;
  actions: HTMLElement;
  retry: HTMLButtonElement;
  pause: HTMLButtonElement;
  budget: HTMLButtonElement;
  view: HTMLButtonElement;
  message: HTMLElement;
  log: HTMLOListElement;
  row: Row;
}

const cards = new Map<string, Card>();
let anonymous = 0;

const keyOf = (row: Row): string => (row.nickname === null ? `\u0000${String(anonymous++)}` : row.nickname.toLowerCase());

function button(label: string, className: string): HTMLButtonElement {
  const made = element("button", className, label);
  made.type = "button";
  return made;
}

function makeCard(row: Row): Card {
  const item = element("li", "participant");
  const head = element("p", "participant-head");
  const name = element("strong", "participant-name");
  const group = element("span", "participant-group");
  const pausedBadge = element("span", "badge", LABELS.paused);
  head.append(name, " ", group, " ", pausedBadge);
  const step = element("p", "participant-line");
  const build = element("p", "participant-line participant-build");
  const usage = element("p", "participant-line help");
  const actions = element("div", "participant-actions");
  const retry = button(LABELS.retry, "secondary");
  const pause = button(LABELS.pause, "secondary");
  const budget = button(LABELS.budget, "secondary");
  const view = button(LABELS.view, "link");
  view.setAttribute("aria-expanded", "false");
  actions.append(retry, pause, budget, view);
  const message = element("p", "message");
  message.setAttribute("role", "status");
  const log = element("ol", "conversation-log");
  log.hidden = true;
  item.append(head, step, build, usage, actions, message, log);
  const card: Card = { item, name, group, pausedBadge, step, build, usage, actions, retry, pause, budget, view, message, log, row };
  retry.addEventListener("click", () => void act(card, card.retry, "retry"));
  pause.addEventListener("click", () => void act(card, card.pause, card.row.paused ? "resume" : "pause"));
  budget.addEventListener("click", () => void act(card, card.budget, "budget"));
  view.addEventListener("click", () => void toggleConversation(card));
  return card;
}

const isBusy = (b: HTMLButtonElement): boolean => b.getAttribute("aria-busy") === "true";

function fillCard(card: Card, row: Row): void {
  card.row = row;
  const alert = rowAlert(row);
  if (alert === null) delete card.item.dataset["alert"];
  else card.item.dataset["alert"] = alert;
  card.name.textContent = row.nickname ?? DASHBOARD_TEXTS.noNickname;
  card.group.textContent = row.group === null ? "" : `Group ${row.group}`;
  card.pausedBadge.hidden = !row.paused;
  card.step.textContent = stepText(row);
  card.build.textContent = buildText(row);
  card.build.hidden = row.build === null;
  card.usage.textContent = usageText(row);
  card.actions.hidden = !hasActions(row);
  card.retry.hidden = !canRetry(row);
  if (!isBusy(card.pause)) card.pause.textContent = row.paused ? LABELS.resume : LABELS.pause;
}

function renderFilter(current: ParticipantList): void {
  if (filter === undefined) filter = initialFilter(current);
  const groups = groupsOf(current.participants);
  if (filter !== EVERYONE && !groups.includes(filter)) groups.push(filter);
  const select = byId<HTMLSelectElement>("group-filter");
  const wanted = [...groups.map((g) => ({ value: g, label: g === current.viewer.group ? LABELS.yours(g) : g })), { value: EVERYONE, label: LABELS.everyone }];
  const same = select.options.length === wanted.length && wanted.every((w, i) => select.options[i]?.value === w.value && select.options[i]?.textContent === w.label);
  if (!same) {
    select.replaceChildren(
      ...wanted.map((w) => {
        const option = element("option", undefined, w.label);
        option.value = w.value;
        return option;
      }),
    );
  }
  select.value = filter;
}

function render(): void {
  const current = list;
  if (current === undefined) return;
  byId("dashboard-loading").hidden = true;
  byId("dashboard").hidden = false;
  renderStoppedBanner(current.stopped);
  renderAdmin(current);
  renderFilter(current);
  const chosen = filter ?? EVERYONE;
  const rows = shownRows(current.participants, chosen);
  byId("dashboard-count").textContent = LABELS.count(rows.length, current.participants.length);
  renderFlags(current.participants, rows);
  renderRows(rows);
}

function renderRows(rows: readonly Row[]): void {
  anonymous = 0;
  const list = byId<HTMLUListElement>("rows");
  const seen = new Set<string>();
  const items: HTMLLIElement[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    seen.add(key);
    let card = cards.get(key);
    if (!card) {
      card = makeCard(row);
      cards.set(key, card);
    }
    fillCard(card, row);
    items.push(card.item);
  }
  for (const [key, card] of cards) {
    if (!seen.has(key)) {
      card.item.remove();
      cards.delete(key);
    }
  }
  // Re-append in order: moves existing cards without rebuilding them.
  items.forEach((item, index) => {
    if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
  });
  const empty = byId("rows-empty");
  empty.textContent = DASHBOARD_TEXTS.noParticipants;
  empty.hidden = rows.length > 0;
}

// ---- Flags ----

const flagKey = (nickname: string, text: string): string => `${nickname.toLowerCase()}\u0000${text}`;

function isHidden(nickname: string, text: string): boolean {
  const until = decided.get(flagKey(nickname, text));
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  decided.delete(flagKey(nickname, text));
  return false;
}

const flagItems = new Map<string, HTMLLIElement>();

function renderFlags(all: readonly Row[], shown: readonly Row[]): void {
  const open = (rows: readonly Row[]) =>
    rows.flatMap((row) => (row.nickname === null ? [] : row.flags.filter((f) => !isHidden(row.nickname ?? "", f.text)).map((flag) => ({ row, flag, nickname: row.nickname ?? "" }))));
  const flags = open(shown);
  const elsewhere = open(all).length - flags.length;
  const listElement = byId<HTMLUListElement>("flag-list");
  const seen = new Set<string>();
  const items: HTMLLIElement[] = [];
  for (const { row, flag, nickname } of flags) {
    const key = flagKey(nickname, flag.text);
    seen.add(key);
    let item = flagItems.get(key);
    if (!item) {
      item = makeFlag(row, nickname, flag.text, flag.reason);
      flagItems.set(key, item);
    }
    items.push(item);
  }
  for (const [key, item] of flagItems) {
    if (!seen.has(key)) {
      item.remove();
      flagItems.delete(key);
    }
  }
  items.forEach((item, index) => {
    if (listElement.children[index] !== item) listElement.insertBefore(item, listElement.children[index] ?? null);
  });
  byId("flags").hidden = flags.length === 0;
  const other = byId("flags-elsewhere");
  other.textContent = elsewhere > 0 ? otherGroupFlagsText(elsewhere) : "";
  other.hidden = elsewhere <= 0;
}

function makeFlag(row: Row, nickname: string, text: string, reason: string): HTMLLIElement {
  const item = element("li", "flag");
  item.setAttribute("role", "alert");
  const head = element("p", "flag-head");
  head.append(element("strong", undefined, nickname), row.group === null ? "" : ` · Group ${row.group}`);
  const quote = element("blockquote", "flag-text", text);
  const why = element("p", "help", reason === "" ? "" : `Safety check: ${reason}`);
  why.hidden = reason === "";
  const buttons = element("div", "flag-buttons");
  const approve = button(LABELS.approve, "primary");
  const reject = button(LABELS.reject, "secondary");
  buttons.append(approve, reject);
  item.append(head, quote, why, buttons);
  const decide = (which: "approve" | "reject", pressed: HTMLButtonElement): void => {
    const other = which === "approve" ? reject : approve;
    other.disabled = true;
    void whileBusy(pressed, async () => {
      const result = actionResult(await call("POST", actionPath(nickname, `flag/${which}`)), which);
      if (result.kind === "signed-out") return goToSignIn();
      if (result.kind === "error") {
        say("message-flags", result.message, "error");
        return;
      }
      // Decided (now or meanwhile), or the participant is gone: the alert goes, and stays gone for a while even if a
      // list read from just before the decision still holds it.
      say("message-flags", result.message, result.kind === "done" ? result.tone : "error");
      decided.set(flagKey(nickname, text), Date.now() + DECIDED_FLAG_HIDE_MS);
      item.remove();
      flagItems.delete(flagKey(nickname, text));
      if (byId("flag-list").children.length === 0) byId("flags").hidden = true;
    }).finally(() => {
      other.disabled = false;
    });
  };
  approve.addEventListener("click", () => decide("approve", approve));
  reject.addEventListener("click", () => decide("reject", reject));
  return item;
}

// ---- Row actions ----

async function act(card: Card, pressed: HTMLButtonElement, which: "retry" | "pause" | "resume" | "budget"): Promise<void> {
  const nickname = card.row.nickname;
  if (nickname === null || isBusy(pressed)) return;
  card.message.textContent = "";
  await whileBusy(pressed, async () => {
    const result = actionResult(await call("POST", actionPath(nickname, which)), which);
    if (result.kind === "signed-out") return goToSignIn();
    card.message.dataset["tone"] = result.kind === "done" ? result.tone : "error";
    card.message.textContent = result.message;
    if (result.kind !== "done") return;
    if (result.paused !== undefined) card.row = { ...card.row, paused: result.paused };
    if (result.budgetUsd !== undefined) card.row = { ...card.row, budgetUsd: result.budgetUsd };
    if (result.extraBudgetUsd !== undefined) card.row = { ...card.row, extraBudgetUsd: result.extraBudgetUsd };
  });
  fillCard(card, card.row);
}

async function toggleConversation(card: Card): Promise<void> {
  const nickname = card.row.nickname;
  if (nickname === null || isBusy(card.view)) return;
  if (!card.log.hidden) {
    card.log.hidden = true;
    card.log.replaceChildren();
    card.view.setAttribute("aria-expanded", "false");
    card.view.textContent = LABELS.view;
    return;
  }
  card.message.textContent = "";
  const result = conversationResult(await whileBusy(card.view, () => call("GET", actionPath(nickname, "conversation"))));
  if (result.kind === "signed-out") return goToSignIn();
  if (result.kind !== "log") {
    card.message.dataset["tone"] = "error";
    card.message.textContent = result.message;
    return;
  }
  const lines =
    result.lines.length === 0
      ? [element("li", "help", DASHBOARD_TEXTS.conversationEmpty)]
      : result.lines.map((line) => {
          const item = element("li", `log-${line.author}`);
          item.append(element("span", "log-label", logLabel(line)), element("span", "log-text", line.text));
          return item;
        });
  card.log.replaceChildren(...lines);
  card.log.hidden = false;
  card.view.setAttribute("aria-expanded", "true");
  card.view.textContent = LABELS.hide;
}

// ---- The admin's controls (ticket 3.12): the caps and the global Stop. ----
//
// Shown only when the list says the viewer is the admin AND `GET /api/admin/settings` answers 200: the API decides
// (it answers 404 to anyone else), never the page. The caps' fields are filled once, from that read and from each save,
// so a list read never overwrites what the admin is typing; the Stop state follows every list read.

type AdminState = "unknown" | "loading" | "shown" | "denied";
let adminState: AdminState = "unknown";
/** The Stop state the admin routes last gave (undefined before the first read). */
let knownStopped: boolean | undefined;
/** Counts Stop and Resume presses that got an answer, so an older list read cannot undo the state they showed. */
let switches = 0;
let switching = false;

function renderStoppedBanner(stopped: boolean): void {
  const banner = byId("dashboard-stopped");
  banner.textContent = DASHBOARD_TEXTS.workshopStopped;
  banner.hidden = !stopped;
}

function hideAdmin(state: AdminState): void {
  adminState = state;
  byId("admin").hidden = true;
}

function renderAdmin(current: ParticipantList): void {
  if (current.viewer.role !== "admin") {
    if (adminState !== "unknown") hideAdmin("unknown");
    return;
  }
  if (adminState === "unknown") void loadAdmin();
  else if (adminState === "shown" && !switching) showStopped(current.stopped);
}

async function loadAdmin(): Promise<void> {
  adminState = "loading";
  const result = settingsResult(await call("GET", SETTINGS_PATH));
  if (adminState !== "loading") return;
  if (result.kind === "signed-out") return goToSignIn();
  if (result.kind === "not-admin") return hideAdmin("denied");
  if (result.kind === "error") {
    // Not shown yet: the next list read (5 s) tries again.
    adminState = "unknown";
    return;
  }
  fillCaps(result.settings);
  showStopped(result.settings.stopped);
  adminState = "shown";
  byId("admin").hidden = false;
}

const capInput = (name: CapField): HTMLInputElement => byId<HTMLInputElement>(`cap-${name}`);

function fillCaps(settings: AdminSettings): void {
  for (const name of CAP_FIELDS) capInput(name).value = fieldValue(name, settings);
}

function markInvalid(invalid: readonly CapField[]): void {
  for (const name of CAP_FIELDS) {
    const bad = invalid.includes(name);
    const error = byId(`cap-${name}-error`);
    error.textContent = bad ? capErrorText(name) : "";
    error.hidden = !bad;
    if (bad) capInput(name).setAttribute("aria-invalid", "true");
    else capInput(name).removeAttribute("aria-invalid");
  }
}

async function saveCaps(): Promise<void> {
  const save = byId<HTMLButtonElement>("caps-save");
  if (isBusy(save)) return;
  byId("message-caps").textContent = "";
  const values = Object.fromEntries(CAP_FIELDS.map((name) => [name, capInput(name).value])) as Record<CapField, string>;
  const result = saveResult(await whileBusy(save, () => call("PUT", SETTINGS_PATH, capsBody(values))));
  if (result.kind === "signed-out") return goToSignIn();
  if (result.kind === "not-admin") return hideAdmin("denied");
  if (result.kind === "invalid") {
    markInvalid(result.invalid);
    say("message-caps", result.message, "error");
    capInput(result.invalid[0] ?? "aiBudgetUsd").focus();
    return;
  }
  markInvalid([]);
  if (result.kind === "error") return say("message-caps", result.message, "error");
  fillCaps(result.settings);
  showStopped(result.settings.stopped);
  say("message-caps", result.message, "info");
}

/** Shows the Stop state: Stop (or its confirmation) while running, Resume while stopped; the banner follows. */
function showStopped(stopped: boolean): void {
  knownStopped = stopped;
  const box = byId("admin-stop-box");
  box.dataset["stopped"] = String(stopped);
  byId("workshop-state").textContent = stateText(stopped);
  const confirming = !byId("stop-confirm").hidden;
  byId<HTMLButtonElement>("stop-button").hidden = stopped || confirming;
  if (stopped) byId("stop-confirm").hidden = true;
  byId<HTMLButtonElement>("resume-button").hidden = !stopped;
  if (list !== undefined) list.stopped = stopped;
  renderStoppedBanner(stopped);
}

function askToStop(): void {
  byId("message-stop").textContent = "";
  byId("stop-question").textContent = ADMIN_TEXTS.stopQuestion;
  byId("stop-button").hidden = true;
  byId("stop-confirm").hidden = false;
  byId("stop-yes").focus();
}

function cancelStop(): void {
  byId("stop-confirm").hidden = true;
  byId("stop-button").hidden = false;
  byId("stop-button").focus();
}

/** Stop (after its confirmation) or Resume. After any answer but a good one, the settings are read again (3.5). */
async function switchWorkshop(which: "stop" | "resume", pressed: HTMLButtonElement): Promise<void> {
  if (switching) return;
  switching = true;
  byId("message-stop").textContent = "";
  const cancel = byId<HTMLButtonElement>("stop-cancel");
  cancel.disabled = true;
  try {
    const result = switchResult(await whileBusy(pressed, () => call("POST", which === "stop" ? STOP_PATH : RESUME_PATH)));
    if (result.kind === "signed-out") return goToSignIn();
    if (result.kind === "not-admin") return hideAdmin("denied");
    byId("stop-confirm").hidden = true;
    if (result.kind === "switched") {
      switches++;
      showStopped(result.settings.stopped);
      byId(result.settings.stopped ? "resume-button" : "stop-button").focus();
      return;
    }
    const reread = settingsResult(await call("GET", SETTINGS_PATH));
    if (reread.kind === "signed-out") return goToSignIn();
    if (reread.kind === "not-admin") return hideAdmin("denied");
    if (reread.kind === "settings") {
      switches++;
      showStopped(reread.settings.stopped);
      say("message-stop", ADMIN_TEXTS.switchFailed, "error");
    } else {
      showStopped(knownStopped ?? false);
      say("message-stop", ADMIN_TEXTS.switchUnknown, "error");
    }
  } finally {
    cancel.disabled = false;
    switching = false;
  }
}

byId("stop-button").addEventListener("click", askToStop);
byId("stop-cancel").addEventListener("click", cancelStop);
byId<HTMLButtonElement>("stop-yes").addEventListener("click", () => void switchWorkshop("stop", byId<HTMLButtonElement>("stop-yes")));
byId<HTMLButtonElement>("resume-button").addEventListener("click", () => void switchWorkshop("resume", byId<HTMLButtonElement>("resume-button")));
byId<HTMLFormElement>("caps-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveCaps();
});

// ---- Start ----

byId<HTMLSelectElement>("group-filter").addEventListener("change", (event) => {
  filter = (event.target as HTMLSelectElement).value;
  render();
});
document.addEventListener("visibilitychange", syncPolling);
syncPolling();
