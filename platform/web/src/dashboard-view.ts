// The facilitator dashboard (ticket 3.11): what each answer of the facilitator API (ticket 3.10) means for the page, as
// pure functions so every rule is unit tested without a browser. The DOM wiring is in ./facilitator.ts.
//
// Personal data: the list holds no participant id and no email address (the API never sends them); participants are
// named by their nickname, which is also the handle of every action route.
import { DASHBOARD_TEXTS, PHASE_3_TEXTS, budgetNowText } from "../../api/workshop/texts.js";
import { messageOf, type ApiAnswer, type Tone } from "./flow.js";

/** The brief: the dashboard asks for the list every 5 seconds while its tab is visible. */
export const DASHBOARD_POLL_INTERVAL_MS = 5_000;
/** A decided flag stays hidden this long even if a list read just before the decision still shows it (eventual reads). */
export const DECIDED_FLAG_HIDE_MS = 30_000;
/** The value of the group filter that shows everyone. */
export const EVERYONE = "";

export type BuildStatus = "queued" | "building" | "deploying" | "live" | "failed";

export interface RowBuild {
  status: BuildStatus;
  kind: "first" | "change";
  changeNumber?: number;
  stuck: boolean;
  minutesBuilding?: number;
  retryRequested: boolean;
}

export interface Flag {
  text: string;
  reason: string;
}

/** One participant, as `GET /api/facilitator/participants` sends it (fields the page does not use are dropped). */
export interface Row {
  nickname: string | null;
  group: string | null;
  step: string | null;
  minutesInStep: number | null;
  build: RowBuild | null;
  spentUsd: number;
  budgetUsd: number;
  extraBudgetUsd: number;
  changeRequestsUsed: number;
  changeRequestsPerPerson: number;
  paused: boolean;
  flags: Flag[];
}

export interface ParticipantList {
  viewer: { role: string; group: string };
  stopped: boolean;
  participants: Row[];
}

const BUILD_STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const amount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const textOrNull = (value: unknown): string | null | undefined => (value === null ? null : typeof value === "string" ? value : undefined);

function parseBuild(value: unknown): RowBuild | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { status, kind, changeNumber, stuck, minutesBuilding, retryRequested } = value;
  if (!BUILD_STATUSES.includes(status as BuildStatus) || (kind !== "first" && kind !== "change")) return undefined;
  if (typeof stuck !== "boolean" || typeof retryRequested !== "boolean") return undefined;
  const build: RowBuild = { status: status as BuildStatus, kind, stuck, retryRequested };
  const change = amount(changeNumber);
  if (change !== undefined) build.changeNumber = change;
  const minutes = amount(minutesBuilding);
  if (minutes !== undefined) build.minutesBuilding = minutes;
  return build;
}

function parseRow(value: unknown): Row | undefined {
  if (!isRecord(value)) return undefined;
  const nickname = textOrNull(value["nickname"]);
  const group = textOrNull(value["group"]);
  const step = textOrNull(value["step"]);
  const minutesInStep = value["minutesInStep"] === null ? null : amount(value["minutesInStep"]);
  const build = parseBuild(value["build"]);
  const numbers = ["spentUsd", "budgetUsd", "extraBudgetUsd", "changeRequestsUsed", "changeRequestsPerPerson"].map((k) => amount(value[k]));
  const paused = value["paused"];
  const flags = value["flags"];
  if (nickname === undefined || group === undefined || step === undefined || minutesInStep === undefined || build === undefined) return undefined;
  if (numbers.some((n) => n === undefined) || typeof paused !== "boolean" || !Array.isArray(flags)) return undefined;
  const parsedFlags: Flag[] = [];
  for (const flag of flags) {
    if (!isRecord(flag) || typeof flag["text"] !== "string" || typeof flag["reason"] !== "string") return undefined;
    parsedFlags.push({ text: flag["text"], reason: flag["reason"] });
  }
  const [spentUsd, budgetUsd, extraBudgetUsd, changeRequestsUsed, changeRequestsPerPerson] = numbers as number[];
  return {
    nickname,
    group,
    step,
    minutesInStep,
    build,
    spentUsd: spentUsd ?? 0,
    budgetUsd: budgetUsd ?? 0,
    extraBudgetUsd: extraBudgetUsd ?? 0,
    changeRequestsUsed: changeRequestsUsed ?? 0,
    changeRequestsPerPerson: changeRequestsPerPerson ?? 0,
    paused,
    flags: parsedFlags,
  };
}

/** The list's body, or undefined when it does not have the expected shape. */
export function parseList(body: unknown): ParticipantList | undefined {
  if (!isRecord(body) || !isRecord(body["viewer"]) || !Array.isArray(body["participants"])) return undefined;
  const { role, group } = body["viewer"];
  if (typeof role !== "string" || typeof group !== "string" || typeof body["stopped"] !== "boolean") return undefined;
  const participants: Row[] = [];
  for (const raw of body["participants"]) {
    const row = parseRow(raw);
    if (row === undefined) return undefined;
    participants.push(row);
  }
  return { viewer: { role, group }, stopped: body["stopped"], participants };
}

export type ListResult =
  | { kind: "list"; list: ParticipantList }
  | { kind: "signed-out" }
  /** A participant (the API's plain 404): the page shows "This page is for facilitators." and no data. */
  | { kind: "not-facilitator"; message: string }
  | { kind: "error"; message: string };

export function listResult(answer: ApiAnswer): ListResult {
  if (answer.status === 200) {
    const list = parseList(answer.body);
    return list ? { kind: "list", list } : { kind: "error", message: DASHBOARD_TEXTS.loadFailed };
  }
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 404) return { kind: "not-facilitator", message: PHASE_3_TEXTS.facilitatorsOnly };
  if (answer.status === 0) return { kind: "error", message: DASHBOARD_TEXTS.offline };
  return { kind: "error", message: DASHBOARD_TEXTS.loadFailed };
}

/** Why a row is highlighted: a failed build, or one in Build for over 15 minutes (the API's `stuck`). */
export function rowAlert(row: Row): "failed" | "stuck" | null {
  if (row.build?.status === "failed") return "failed";
  if (row.build?.stuck === true) return "stuck";
  return null;
}

/** Retry is offered only where the API accepts it (decision "(3.10) Retry through the launcher"): failed or stuck. */
export const canRetry = (row: Row): boolean => row.nickname !== null && rowAlert(row) !== null;

/** Every action needs the nickname (the route's handle); a participant without one yet has none. */
export const hasActions = (row: Row): boolean => row.nickname !== null;

/** Where the participant is, in the participant page's own words. */
export function stepText(row: Row): string {
  const minutes = row.minutesInStep === null ? "" : `, ${row.minutesInStep} min`;
  switch (row.step) {
    case "nickname":
      return `Picking a nickname${minutes}`;
    case "clarify":
      return `Step 1: Clarify${minutes}`;
    case "spec":
      return `Step 2: Spec${minutes}`;
    case "approved":
      return `Step 3: Build, readiness check${minutes}`;
    case "building":
      if (row.build?.status === "live" || row.build?.kind === "change") return `Step 4: Live${minutes}`;
      return `Step 3: Build${minutes}`;
    case null:
      return "Not started";
    default:
      return `${row.step}${minutes}`;
  }
}

/** The build's state in a few words, or "" without a build. */
export function buildText(row: Row): string {
  const build = row.build;
  if (build === null) return "";
  const name = build.kind === "change" ? `Change ${build.changeNumber ?? ""}`.trim() : "Build";
  let text: string;
  switch (build.status) {
    case "queued":
      text = `${name}: in the queue`;
      break;
    case "building":
      text =
        build.minutesBuilding === undefined
          ? `${name}: building`
          : build.stuck
            ? `${name}: stuck, building for ${build.minutesBuilding} min`
            : `${name}: building for ${build.minutesBuilding} min`;
      break;
    case "deploying":
      text = `${name}: publishing`;
      break;
    case "live":
      text = `${name}: live`;
      break;
    case "failed":
      text = `${name}: failed`;
      break;
  }
  return build.retryRequested ? `${text} (Retry requested)` : text;
}

const dollars = (value: number): string => `$${value.toFixed(2)}`;

/** "AI $1.20 of $7.00 (+$2.00 added) · Changes 2 of 5". */
export function usageText(row: Row): string {
  const extra = row.extraBudgetUsd > 0 ? ` (+${dollars(row.extraBudgetUsd)} added)` : "";
  return `AI ${dollars(row.spentUsd)} of ${dollars(row.budgetUsd)}${extra} · Changes ${row.changeRequestsUsed} of ${row.changeRequestsPerPerson}`;
}

/** The groups on the list, sorted, for the filter (a row without a group is not one). */
export function groupsOf(rows: readonly Row[]): string[] {
  return [...new Set(rows.map((r) => r.group).filter((g): g is string => g !== null))].sort((a, b) => a.localeCompare(b));
}

/**
 * The filter's first value: the viewer's own group when the list has participants in it, else Everyone (the admin's
 * group, or a facilitator whose group has nobody signed in yet, would show an empty page).
 */
export function initialFilter(list: ParticipantList): string {
  return list.participants.some((r) => r.group === list.viewer.group) ? list.viewer.group : EVERYONE;
}

export const shownRows = (rows: readonly Row[], filter: string): Row[] => (filter === EVERYONE ? [...rows] : rows.filter((r) => r.group === filter));

/** An action's answer: its message for the facilitator, and what changed. */
export type ActionResult =
  | { kind: "done"; message: string; tone: Tone; budgetUsd?: number; extraBudgetUsd?: number; paused?: boolean; settled: boolean }
  | { kind: "signed-out" }
  | { kind: "gone"; message: string }
  | { kind: "error"; message: string };

/**
 * One action's answer. `settled` says the flag (for Approve and Reject) is no longer waiting: decided now, decided
 * meanwhile, or nothing waiting (409), or approved but not handed on (500, decided all the same).
 */
export function actionResult(answer: ApiAnswer, which: "retry" | "pause" | "resume" | "budget" | "approve" | "reject"): ActionResult {
  const message = messageOf(answer.body);
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 404) return { kind: "gone", message: DASHBOARD_TEXTS.gone };
  if (answer.status === 0) return { kind: "error", message: DASHBOARD_TEXTS.actionOffline };
  if (answer.status === 200 || answer.status === 202) {
    const body = isRecord(answer.body) ? answer.body : {};
    const result: ActionResult = { kind: "done", message: message ?? "", tone: "info", settled: true };
    if (which === "budget") {
      const budget = amount(body["budgetUsd"]);
      if (budget !== undefined) {
        result.budgetUsd = budget;
        result.message = budgetNowText(message ?? "", budget).trim();
      }
      const extra = amount(body["extraBudgetUsd"]);
      if (extra !== undefined) result.extraBudgetUsd = extra;
    }
    if (which === "pause" || which === "resume") result.paused = which === "pause";
    return result;
  }
  if (answer.status === 409 && message !== undefined) return { kind: "done", message, tone: "error", settled: which === "approve" || which === "reject" };
  if (answer.status === 500 && which === "approve" && message !== undefined) return { kind: "done", message, tone: "error", settled: true };
  return { kind: "error", message: DASHBOARD_TEXTS.actionFailed };
}

export interface LogLine {
  author: "participant" | "assistant";
  text: string;
  step?: string;
  status?: string;
}

export type ConversationResult = { kind: "log"; lines: LogLine[] } | { kind: "signed-out" } | { kind: "gone"; message: string } | { kind: "error"; message: string };

/** `GET .../{nickname}/conversation`: the log, oldest first. */
export function conversationResult(answer: ApiAnswer): ConversationResult {
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 404) return { kind: "gone", message: DASHBOARD_TEXTS.gone };
  if (answer.status === 0) return { kind: "error", message: DASHBOARD_TEXTS.actionOffline };
  if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body["messages"])) return { kind: "error", message: DASHBOARD_TEXTS.actionFailed };
  const lines: LogLine[] = [];
  for (const item of answer.body["messages"]) {
    if (!isRecord(item) || (item["author"] !== "participant" && item["author"] !== "assistant") || typeof item["text"] !== "string") continue;
    const line: LogLine = { author: item["author"], text: item["text"] };
    if (typeof item["step"] === "string") line.step = item["step"];
    if (typeof item["status"] === "string") line.status = item["status"];
    lines.push(line);
  }
  return { kind: "log", lines };
}

/** The label of one log line ("Participant, step clarify, flagged" / "AI"). */
export function logLabel(line: LogLine): string {
  if (line.author === "assistant") return "AI";
  const parts = ["Participant"];
  if (line.step !== undefined) parts.push(`step ${line.step}`);
  if (line.status !== undefined && line.status !== "done") parts.push(line.status);
  return parts.join(", ");
}

/** An action route for a nickname (encoded: a nickname is letters, digits and dashes, but the page never trusts that). */
export const actionPath = (nickname: string, action: string): string => `/api/facilitator/participants/${encodeURIComponent(nickname)}/${action}`;
