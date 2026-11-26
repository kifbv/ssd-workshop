// The AI budget (ticket 3.3): before each AI call (guardrail, clarify, spec, readiness and, from ticket 3.6, the
// suggestions) and before a build is queued, a participant's spend (their `USAGE` item's `costUsd`, which every AI
// call and every build adds to) is compared with the workshop's budget plus their extra budget. At or over it, the AI
// does not run and the participant gets BUDGET_REPLY. A build already queued or running is never stopped, so spend
// can pass the budget by at most one build. Pure: the reads are the stores' (`ConversationStore.getBudgetFacts`).
import { budgetFor, type ParticipantLimits, type WorkshopSettings } from "./settings.js";
import { PHASE_3_TEXTS } from "./texts.js";

/** The reply when the budget is used: plain text, no amount, no other participant, no address. */
export const BUDGET_REPLY = PHASE_3_TEXTS.budgetReached;

/** What the check reads: the settings, the participant's own limit fields, and their spend so far in dollars. */
export interface BudgetFacts {
  settings: WorkshopSettings;
  limits: ParticipantLimits;
  spentUsd: number;
}

export interface Budget {
  /** The workshop's budget plus the extra budget, in whole cents. */
  budgetUsd: number;
  /** Spend so far (0 when missing; the whole budget when broken, so a broken spend fails closed). */
  spentUsd: number;
  /** Dollars left, in whole cents rounded down, never below 0: what `budgetLeft` shows. */
  leftUsd: number;
  /** Spend at or over the budget: no AI call, no build. */
  reached: boolean;
}

export function budgetOf(facts: BudgetFacts): Budget {
  const budgetUsd = budgetFor(facts.settings, facts.limits);
  // A spend that is present but broken (not a number, infinite or negative) fails closed: the budget reads as used.
  // A missing spend is 0 already (the stores read no `USAGE` item, or no `costUsd`, as 0).
  if (!Number.isFinite(facts.spentUsd) || facts.spentUsd < 0) return { budgetUsd, spentUsd: budgetUsd, leftUsd: 0, reached: true };
  const spentUsd = facts.spentUsd;
  // Rounded down so the page never shows more than is left (a small epsilon keeps 0.7 from reading as 0.69).
  const leftUsd = Math.max(0, Math.floor((budgetUsd - spentUsd) * 100 + 1e-6) / 100);
  return { budgetUsd, spentUsd, leftUsd, reached: spentUsd >= budgetUsd };
}

/**
 * True when the spend read at the start of a job, plus what this job's earlier calls cost (`spentInJobUsd`, not yet
 * stored), is at or over the budget: the next AI call (or the build) must not start.
 */
export function overBudget(budget: Budget, spentInJobUsd = 0): boolean {
  return budget.spentUsd + Math.max(0, spentInJobUsd) >= budget.budgetUsd;
}

/**
 * Ticket 3.5 and 3.10: whether the AI must wait instead of running: the admin's global Stop, or a facilitator's Pause of
 * this participant. Either way the worker holds the job (no AI call; it comes back after STOP_HOLD_SECONDS) until it is
 * released.
 */
export function mustHold(facts: Pick<BudgetFacts, "settings" | "limits">): boolean {
  return facts.settings.stopped || facts.limits.paused;
}
