// Every participant-facing text of phase 3 (ticket 3.2), in one place so the API, the workers and the pages say the
// same thing (wording from docs/phases/phase-3.md). Plain text only: pages set it with `textContent`. No text here
// names an amount spent, another participant or an email address.

export const PHASE_3_TEXTS = {
  /** Ticket 3.3: spend at or over the budget plus extra budget; no AI call is made. */
  budgetReached: "You've used your AI budget for today. Your facilitator can add more.",
  /** Ticket 3.10: a facilitator's Pause holds the next AI call and build. */
  paused: "Your facilitator paused your session.",
  /** Ticket 3.5: the admin's global Stop; every participant page shows it. */
  workshopPaused: "The workshop is paused for a moment.",
  /** Ticket 3.9: the repository's SPEC.md equals the stored spec. */
  specUnchanged: "Your repository's spec has not changed.",
  /** Ticket 3.11: a participant opens the facilitator dashboard. */
  facilitatorsOnly: "This page is for facilitators.",
} as const;

/** Ticket 3.6: every change request is used ("You've used your 5 changes."). */
export function changesUsedText(cap: number): string {
  return `You've used your ${cap} ${cap === 1 ? "change" : "changes"}.`;
}

/** Ticket 3.8: "Changes left: 3 of 5". */
export function changesLeftText(used: number, cap: number): string {
  return `Changes left: ${Math.max(0, cap - used)} of ${cap}`;
}

/** Ticket 3.4: a queued build's place ("Your build is in the queue: 3 builds ahead of you."). */
export function queuePositionText(ahead: number): string {
  if (ahead <= 0) return "Your build is next in the queue.";
  return `Your build is in the queue: ${ahead} ${ahead === 1 ? "build" : "builds"} ahead of you.`;
}
