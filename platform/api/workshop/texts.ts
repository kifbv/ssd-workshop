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
  /** Ticket 3.6: a change request (or Build this change) while one of their builds is queued or running. */
  changeWhileBuilding: "Your app is being built right now. You can ask for another change once it is live.",
  /** Ticket 3.6: a change request before the app was ever live (its first build is not live yet, or failed). */
  changeBeforeLive: "You can ask for changes once your app is live.",
  /** Ticket 3.8: Build this change or Not this one on a proposal that is no longer the open one (404). */
  proposalGone: "This proposed change is no longer open. The page now shows where your changes stand.",
  /** Ticket 3.8: above the suggested changes on step 4. */
  suggestionsIntro: "Ideas to start from (tap one to put it in the box, then change it as you like):",
  /** Ticket 3.8: under a spec update's buttons: a later message adjusts the proposal. */
  proposalHint: "Not quite right? Write what to adjust in the box below and press Send: the AI updates this proposal.",
  /** Ticket 3.8: step 4's typing line while the readiness check of a change runs. */
  checkingChange: "The AI is checking your change…",
  /** Ticket 3.8: step 4's typing line while the AI answers a change request. */
  writingChange: "The AI is writing…",
  /** Ticket 3.8: step 3's "Behind the scenes" text during a change build (it starts from the repository, not the template). */
  changeBuildBehind:
    "Your change passed the readiness check, so the build launcher started a builder: a container on AWS. In it, Claude, the coding agent running on Amazon Bedrock, edits your app's files from your GitHub repository to match the updated spec, and keeps everything else as it is. The builder checks the files and saves them to your repository in one commit. Then the deployer checks them again and publishes exactly what GitHub holds. Your current version stays online until then. This page asks for news every 2 seconds.",
  /** Ticket 3.8: the change loop diagram could not be drawn (its text stays under it). */
  changeLoopNoDiagram: "The diagram could not be drawn. Read it as text below.",
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

/** Ticket 3.8: the text Build this change stores as the participant's message (ticket 3.6's CHANGE_BUILD_REQUEST). */
export const CHANGE_BUILD_REQUEST = "Please build this change.";

/** Ticket 3.8: the heading line of a spec update on step 4 ("Version 3, not built yet"). */
export function proposalVersionText(version: number): string {
  return `Version ${version}, not built yet`;
}

/** Ticket 3.8: step 3's line during a change build ("Change 2: the AI is changing your app ..."). */
export function changeBuildingText(changeNumber: number | undefined): string {
  const name = changeNumber === undefined ? "Your change" : `Change ${changeNumber}`;
  return `${name}: the AI is changing your app to match your updated spec. Your current version stays online until the new one is live.`;
}

/** Ticket 3.8: step 4 after a failed change build (the count stays as it is: the change was queued, decision 3.6). */
export function changeBuildFailedText(changeNumber: number | undefined): string {
  const name = changeNumber === undefined ? "Your last change" : `Change ${changeNumber}`;
  return `${name} could not be built, so your app still shows the version before it. Your facilitator can try that build again, or you can ask for another change.`;
}

/** Ticket 3.4: a queued build's place ("Your build is in the queue: 3 builds ahead of you."). */
export function queuePositionText(ahead: number): string {
  if (ahead <= 0) return "Your build is next in the queue.";
  return `Your build is in the queue: ${ahead} ${ahead === 1 ? "build" : "builds"} ahead of you.`;
}
