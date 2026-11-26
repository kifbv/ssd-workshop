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
  /** Ticket 3.9: SPEC.md is over 20 KB (refused before any AI call, never downloaded). */
  specTooLarge: "Your repository's SPEC.md is larger than 20 KB, so it was not read. Make it shorter, then press Rebuild from my repository again.",
  /** Ticket 3.9: no `main`, or no SPEC.md at its top. */
  specMissing: "There is no SPEC.md at the top of your repository's main branch. Put it back, then press Rebuild from my repository again.",
  /** Ticket 3.9: SPEC.md is not UTF-8 text. */
  specUnreadable: "Your repository's SPEC.md is not plain text, so it was not read. Save it as plain text (UTF-8), then press Rebuild from my repository again.",
  /** Ticket 3.9: SPEC.md holds nothing but spaces. */
  specEmpty: "Your repository's SPEC.md is empty. Write your spec in it, then press Rebuild from my repository again.",
  /** Ticket 3.9 try 2: SPEC.md (cleaned) is longer than the 8,000 characters every stored spec keeps to (checkSpec). */
  specTooLongForPlatform:
    "Your repository's SPEC.md is longer than 8,000 characters, the most the workshop can build from. Make it shorter, then press Rebuild from my repository again. Your live app stays as it is.",
  /** Ticket 3.9 try 2: SPEC.md lacks the spec's shape (title, one flowchart diagram, the three sections; checkSpec). */
  specWrongShape:
    "Your repository's SPEC.md does not have the shape of a spec, so it was not built. Keep the title line (# App name), one Mermaid diagram that starts with flowchart TD, then the headings ## What it does, ## Screens and ## Data it keeps, in this order and with nothing else. Fix it, then press Rebuild from my repository again. Your live app stays as it is.",
  /** Ticket 3.9: GitHub (or the platform's GitHub App) could not be used. */
  repositoryUnavailable: "Your repository could not be read just now. Please press Rebuild from my repository again in a minute.",
  /** Ticket 3.9: the guardrail or the readiness check gave no answer (a model error, a time limit). */
  rebuildFailed: "Sorry, the check of your repository's spec did not work this time. Please press Rebuild from my repository again.",
  /** Ticket 3.9: the guardrail flagged the repository's spec (it is not queued for a facilitator: nothing is built). */
  rebuildFlagged:
    "The safety check wants a person to look at your repository's spec, so it was not built. Talk to your facilitator, or change SPEC.md and press Rebuild from my repository again.",
  /** Ticket 3.9: the repository's spec passed the checks; the change build is queued in the same transaction. */
  rebuildReady: "Your repository's spec is ready to build. The build is starting now: the AI changes your app to match it.",
  /** Ticket 3.9: step 4's typing line while the platform reads and checks the repository's spec. */
  checkingRepository: "Reading and checking the spec in your repository…",
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

/**
 * Ticket 3.9: the text Rebuild from my repository stores as the participant's message (marked `rebuild-from-repo`, which
 * only that route writes); the step 4 page recognises it in flight.
 */
export const REBUILD_REQUEST = "Please rebuild my app from the SPEC.md in my repository.";

/** Ticket 3.9: the "What changes" line of a version read from the repository (the launcher builds only a version with one). */
export const REBUILD_WHAT_CHANGES = "Update the app to match SPEC.md as edited in your repository";

/** Ticket 3.9: the readiness check found problems in the repository's spec (reasons as "- " lines; plain text). */
export function rebuildNotReadyText(reasons: readonly string[]): string {
  return [
    "Your repository's spec cannot be built yet:",
    ...reasons.map((r) => `- ${r}`),
    "Change SPEC.md in your repository, then press Rebuild from my repository again. Your live app stays as it is.",
  ].join("\n");
}
