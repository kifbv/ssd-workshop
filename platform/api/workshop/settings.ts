// Workshop settings and per-person limits (ticket 3.2): the caps the admin sets, their defaults and ranges, and the
// per-participant limit fields, as every phase 3 ticket reads them. Pure: no AWS client here (the table access is in
// ./store.ts), so workers, the launcher and pages can share it.
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

/** The caps in the one `SETTINGS` item (keys.ts `settingsKey`), plus the global Stop switch (ticket 3.5). */
export interface WorkshopSettings {
  /** US dollars of AI spend per participant (conversation and builds), before any extra budget. */
  aiBudgetUsd: number;
  /** Change requests each participant may have built (ticket 3.6). */
  changeRequestsPerPerson: number;
  /** Builds running at once (ticket 3.4). */
  buildsAtOnce: number;
  /** The admin's global Stop (ticket 3.5): AI calls and builds wait while it is on. */
  stopped: boolean;
  /**
   * Ticket 3.5: ISO 8601, when the admin last pressed Resume (absent before the first Resume). The launcher's check counts
   * a queued build's wait from its place in the line or from this time, whichever is later, so a Stop never makes
   * waiting builds run into the queued time limit.
   */
  resumedAt?: string;
}

/** The three caps the admin changes with `PUT /api/admin/settings` (Stop has its own routes, ticket 3.5). */
export type WorkshopCaps = Omit<WorkshopSettings, "stopped" | "resumedAt">;

/** What every reader gets when the item, or one of its values, is missing: $5, 5 changes, 15 builds, Stop off. */
export const DEFAULT_SETTINGS: Readonly<WorkshopSettings> = Object.freeze({
  aiBudgetUsd: 5,
  changeRequestsPerPerson: 5,
  buildsAtOnce: 15,
  stopped: false,
});

/** The allowed range of each cap (inclusive); the counts are whole numbers. */
export const CAP_RANGES = {
  aiBudgetUsd: { min: 0, max: 50, whole: false },
  changeRequestsPerPerson: { min: 0, max: 20, whole: true },
  buildsAtOnce: { min: 1, max: 30, whole: true },
} as const satisfies Record<keyof WorkshopCaps, { min: number; max: number; whole: boolean }>;

export const CAP_NAMES = Object.keys(CAP_RANGES) as (keyof WorkshopCaps)[];

function inRange(name: keyof WorkshopCaps, value: unknown): value is number {
  const range = CAP_RANGES[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (range.whole && !Number.isInteger(value)) return false;
  return value >= range.min && value <= range.max;
}

/** Dollars kept to whole cents (a budget of 4.999 is stored as 5). */
export const toCents = (dollars: number): number => Math.round(dollars * 100) / 100;

/**
 * The caps from a request body: all three present and in range, or the names of the ones that are not (missing, not a
 * number, a fraction where a whole number is needed, or out of range). Other fields are ignored. The budget is kept to
 * whole cents.
 */
export function parseCaps(body: Record<string, unknown>): { ok: true; caps: WorkshopCaps } | { ok: false; invalid: (keyof WorkshopCaps)[] } {
  const invalid = CAP_NAMES.filter((name) => !inRange(name, body[name]));
  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    caps: {
      aiBudgetUsd: toCents(body["aiBudgetUsd"] as number),
      changeRequestsPerPerson: body["changeRequestsPerPerson"] as number,
      buildsAtOnce: body["buildsAtOnce"] as number,
    },
  };
}

/**
 * The settings from the `SETTINGS` item as DynamoDB returns it: each value that is missing or out of range reads as its
 * default, so a missing item reads as DEFAULT_SETTINGS and nobody can be stopped or blocked by a malformed value.
 */
export function settingsFromItem(item: Record<string, AttributeValue> | undefined): WorkshopSettings {
  const cap = (name: keyof WorkshopCaps): number => {
    const raw = item?.[name]?.N;
    const value = raw === undefined ? undefined : Number(raw);
    return inRange(name, value) ? value : DEFAULT_SETTINGS[name];
  };
  // Ticket 3.5: a time that does not read as one is left out (a malformed value never delays or fails a build).
  const resumedRaw = item?.["resumedAt"]?.S;
  const resumedAt = resumedRaw !== undefined && Number.isFinite(Date.parse(resumedRaw)) ? resumedRaw : undefined;
  return {
    aiBudgetUsd: cap("aiBudgetUsd"),
    changeRequestsPerPerson: cap("changeRequestsPerPerson"),
    buildsAtOnce: cap("buildsAtOnce"),
    stopped: item?.["stopped"]?.BOOL === true,
    ...(resumedAt === undefined ? {} : { resumedAt }),
  };
}

/**
 * A participant's own limit fields on their profile (`PARTICIPANT#<id>` / `PROFILE`, ticket 3.2). Profiles from before
 * this ticket have none of them and read as no extra budget, not paused, no change used and no `stepSince`.
 */
export interface ParticipantLimits {
  /** US dollars a facilitator granted on top of the budget (ticket 3.10: $2 a press). */
  extraBudget: number;
  /** A facilitator's Pause (ticket 3.10): the next AI call and build wait. */
  paused: boolean;
  /** Change requests built so far (ticket 3.6). */
  changeRequestsUsed: number;
  /** ISO 8601: when `step` last changed (absent on profiles whose step has not changed since ticket 3.2). */
  stepSince?: string;
}

/** The profile attribute names of ParticipantLimits (each update that sets one names it in its role's list). */
export const PARTICIPANT_LIMIT_ATTRIBUTES = ["extraBudget", "paused", "changeRequestsUsed", "stepSince"] as const;

export function limitsFromItem(item: Record<string, AttributeValue> | undefined): ParticipantLimits {
  const count = (name: string): number => {
    const value = Number(item?.[name]?.N);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const stepSince = item?.["stepSince"]?.S;
  return {
    extraBudget: count("extraBudget"),
    paused: item?.["paused"]?.BOOL === true,
    changeRequestsUsed: Math.floor(count("changeRequestsUsed")),
    ...(stepSince === undefined ? {} : { stepSince }),
  };
}

/** The budget a participant may spend: the workshop's per-person budget plus their extra budget. */
export function budgetFor(settings: Pick<WorkshopSettings, "aiBudgetUsd">, limits: Pick<ParticipantLimits, "extraBudget">): number {
  return toCents(settings.aiBudgetUsd + limits.extraBudget);
}
