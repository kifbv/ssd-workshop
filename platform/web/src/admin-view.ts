// The admin section of the facilitator dashboard (ticket 3.12): what each answer of the admin routes (tickets 3.2 and
// 3.5) means for the page, as pure functions so every rule is unit tested without a browser. The DOM wiring is in
// ./facilitator.ts. The page never decides who is the admin: it shows the section only when the list says the viewer
// is the admin AND `GET /api/admin/settings` answers 200 (the API answers 404 to everyone else).
import { ADMIN_TEXTS } from "../../api/workshop/texts.js";
import { messageOf, type ApiAnswer } from "./flow.js";

export const SETTINGS_PATH = "/api/admin/settings";
export const STOP_PATH = "/api/admin/stop";
export const RESUME_PATH = "/api/admin/resume";

/** The three caps, in the order the page shows them (the API's field names). */
export const CAP_FIELDS = ["aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce"] as const;
export type CapField = (typeof CAP_FIELDS)[number];

export interface AdminSettings {
  aiBudgetUsd: number;
  changeRequestsPerPerson: number;
  buildsAtOnce: number;
  stopped: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The settings as the admin routes answer them, or undefined when the body does not have that shape. */
export function parseSettings(body: unknown): AdminSettings | undefined {
  if (!isRecord(body)) return undefined;
  const { aiBudgetUsd, changeRequestsPerPerson, buildsAtOnce, stopped } = body;
  if (!isNumber(aiBudgetUsd) || !isNumber(changeRequestsPerPerson) || !isNumber(buildsAtOnce) || typeof stopped !== "boolean") return undefined;
  return { aiBudgetUsd, changeRequestsPerPerson, buildsAtOnce, stopped };
}

/** How a field shows a cap: the budget with two decimals ("5.00"), the counts as whole numbers. */
export const fieldValue = (name: CapField, settings: AdminSettings): string =>
  name === "aiBudgetUsd" ? settings.aiBudgetUsd.toFixed(2) : String(settings[name]);

/**
 * The PUT body from the fields as typed: a number where the text is one, else null, so the API (the one place that
 * knows the rules) answers 400 and names the field. The page does not check ranges itself.
 */
export function capsBody(values: Readonly<Record<CapField, string>>): Record<CapField, number | null> {
  const read = (text: string): number | null => {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  };
  return { aiBudgetUsd: read(values.aiBudgetUsd), changeRequestsPerPerson: read(values.changeRequestsPerPerson), buildsAtOnce: read(values.buildsAtOnce) };
}

export type SettingsResult =
  | { kind: "settings"; settings: AdminSettings }
  | { kind: "signed-out" }
  /** The API's plain 404: not the admin (whatever the list said). The section stays hidden. */
  | { kind: "not-admin" }
  | { kind: "error"; message: string };

/** `GET /api/admin/settings`. */
export function settingsResult(answer: ApiAnswer): SettingsResult {
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 404) return { kind: "not-admin" };
  if (answer.status === 0) return { kind: "error", message: ADMIN_TEXTS.offline };
  const settings = answer.status === 200 ? parseSettings(answer.body) : undefined;
  return settings ? { kind: "settings", settings } : { kind: "error", message: ADMIN_TEXTS.readFailed };
}

export type SaveResult =
  | { kind: "saved"; settings: AdminSettings; message: string }
  /** 400: the API's sentence, and the fields it named (each gets its own line beside it). */
  | { kind: "invalid"; message: string; invalid: CapField[] }
  | { kind: "signed-out" }
  | { kind: "not-admin" }
  | { kind: "error"; message: string };

/** `PUT /api/admin/settings`. */
export function saveResult(answer: ApiAnswer): SaveResult {
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 404) return { kind: "not-admin" };
  if (answer.status === 0) return { kind: "error", message: ADMIN_TEXTS.offline };
  if (answer.status === 400) {
    const named = isRecord(answer.body) && Array.isArray(answer.body["invalid"]) ? answer.body["invalid"] : [];
    const invalid = CAP_FIELDS.filter((name) => named.includes(name));
    return { kind: "invalid", message: messageOf(answer.body) ?? ADMIN_TEXTS.invalid, invalid };
  }
  const settings = answer.status === 200 ? parseSettings(answer.body) : undefined;
  return settings ? { kind: "saved", settings, message: ADMIN_TEXTS.saved } : { kind: "error", message: ADMIN_TEXTS.saveFailed };
}

export type SwitchResult =
  | { kind: "switched"; settings: AdminSettings }
  | { kind: "signed-out" }
  | { kind: "not-admin" }
  /**
   * Anything else (a 500, no answer, a body without the settings): the switch may have been applied all the same
   * (decision "(3.5) Stop and Resume routes"), so the page reads the settings again before showing a state.
   */
  | { kind: "reread" };

/** `POST /api/admin/stop` and `POST /api/admin/resume`. */
export function switchResult(answer: ApiAnswer): SwitchResult {
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 404) return { kind: "not-admin" };
  const settings = answer.status === 200 ? parseSettings(answer.body) : undefined;
  return settings ? { kind: "switched", settings } : { kind: "reread" };
}

/** The state line under the Stop button. */
export const stateText = (stopped: boolean): string => (stopped ? ADMIN_TEXTS.workshopPaused : ADMIN_TEXTS.workshopRunning);
