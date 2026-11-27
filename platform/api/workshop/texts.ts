// Every participant-facing text of phase 3 (ticket 3.2), in one place so the API, the workers and the pages say the
// same thing (wording from docs/phases/phase-3.md). Plain text only: pages set it with `textContent`. No text here
// names an amount spent, another participant or an email address.
import { CAP_RANGES } from "./settings.js";

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
  /** Ticket 3.15: Rebuild with my edits on a text equal to the live spec (wording from the brief). */
  editUnchanged: "Your spec has not changed.",
  /** Ticket 3.15: the edited text is over 8,000 characters (refused by the route, or after cleaning by the worker; no AI call). */
  editTooLong:
    "Your spec is longer than 8,000 characters, the most the workshop can build from. Make it shorter, then press Rebuild with my edits again. Your live app stays as it is.",
  /** Ticket 3.15: the edited text lacks the spec's shape (checkSpec). */
  editWrongShape:
    "Your edited spec does not have the shape of a spec, so it was not built. Keep the title line (# App name), one Mermaid diagram that starts with flowchart TD, then the headings ## What it does, ## Screens and ## Data it keeps, in this order and with nothing else. Fix it, then press Rebuild with my edits again. Your live app stays as it is.",
  /** Ticket 3.15: the edited text is empty once cleaned (refused by the route). */
  editEmpty: "Your spec is empty. Write your spec in the box, then press Rebuild with my edits.",
  /** Ticket 3.15: the live spec changed since the editor was opened (another tab, a rebuild): 404 from the route. */
  editStale: "Your live spec changed since you opened it. Press Edit my spec again to start from the new one.",
  /** Ticket 3.15: the guardrail or the readiness check gave no answer. */
  editFailed: "Sorry, the check of your edited spec did not work this time. Please press Rebuild with my edits again.",
  /** Ticket 3.15: the guardrail flagged the edited spec (not queued for a facilitator: nothing is built). */
  editFlagged:
    "The safety check wants a person to look at your edited spec, so it was not built. Talk to your facilitator, or change your spec and press Rebuild with my edits again.",
  /** Ticket 3.15: the edited spec passed the checks; the change build is queued in the same transaction. */
  editReady: "Your edited spec is ready to build. The build is starting now: the AI changes your app to match it.",
  /** Ticket 3.15: step 4's typing line while the platform checks the edited spec. */
  checkingEdit: "Checking your edited spec…",
  /** Ticket 3.15: the live spec could not be read into the editor. */
  editLoadFailed: "Your spec could not be opened just now. Please press Edit my spec again.",
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

/**
 * Ticket 3.15: the text Rebuild with my edits stores as the participant's message (marked `edit-spec`, which only that
 * route writes, with the edited text beside it in `editedSpec`); the step 4 page recognises it in flight.
 */
export const EDIT_REQUEST = "Please rebuild my app from my edited spec.";

/** Ticket 3.15: the "What changes" line of a version edited on the page (the launcher builds only a version with one). */
export const EDIT_WHAT_CHANGES = "Update the app to match SPEC.md as edited on the page";

/** Ticket 3.15: the readiness check found problems in the edited spec (reasons as "- " lines; plain text). */
export function editNotReadyText(reasons: readonly string[]): string {
  return [
    "Your edited spec cannot be built yet:",
    ...reasons.map((r) => `- ${r}`),
    "Change it in the box, then press Rebuild with my edits again. Your live app stays as it is.",
  ].join("\n");
}

/** Ticket 3.9: the readiness check found problems in the repository's spec (reasons as "- " lines; plain text). */
export function rebuildNotReadyText(reasons: readonly string[]): string {
  return [
    "Your repository's spec cannot be built yet:",
    ...reasons.map((r) => `- ${r}`),
    "Change SPEC.md in your repository, then press Rebuild from my repository again. Your live app stays as it is.",
  ].join("\n");
}

/**
 * Ticket 3.11: the facilitator dashboard's own lines (its actions' answers come from the API, `FACILITATOR_TEXTS` in
 * platform/api/facilitator/facilitator.ts; a participant sees `PHASE_3_TEXTS.facilitatorsOnly`). No line names an
 * email address or a participant id.
 */
export const DASHBOARD_TEXTS = {
  loading: "Loading the participants…",
  loadFailed: "The list could not be read just now. It tries again in 5 seconds.",
  offline: "We couldn't reach the workshop. The list tries again in 5 seconds.",
  noParticipants: "No participants to show.",
  noNickname: "No nickname yet",
  gone: "This participant is no longer on the list.",
  actionFailed: "That did not work. Please try again in a moment.",
  actionOffline: "We couldn't reach the workshop. Check your connection and try again.",
  workshopStopped: "The workshop is stopped (the admin's Stop is on): messages and builds wait until Resume.",
  conversationEmpty: "No messages yet.",
} as const;

/** Ticket 3.11: after Add $2 ("Added $2 of AI budget. Budget now $7.00."). */
export function budgetNowText(added: string, budgetUsd: number): string {
  return `${added} Budget now $${budgetUsd.toFixed(2)}.`;
}

/** Ticket 3.11: flags the group filter hides ("1 flagged message in another group: choose Everyone to see it."). */
export function otherGroupFlagsText(count: number): string {
  return count === 1
    ? "1 flagged message in another group: choose Everyone to see it."
    : `${count} flagged messages in other groups: choose Everyone to see them.`;
}

/**
 * Ticket 3.12: the admin section of the dashboard (the three caps and the global Stop). Field labels and button texts
 * stay in the web code; these are the lines the admin reads.
 */
export const ADMIN_TEXTS = {
  /** The state line while the global Stop is on (criterion 3 reads "Workshop paused"). */
  workshopPaused: "Workshop paused: AI messages and builds wait until you press Resume.",
  workshopRunning: "Workshop running.",
  stopQuestion:
    "Stop the whole workshop? Every participant's AI messages and builds wait until you press Resume. Builds that are running start again after Resume.",
  saved: "Saved. The new caps apply from the next message or build.",
  invalid: "Some caps are not allowed. Fix the fields marked below, then press Save again.",
  readFailed: "The settings could not be read just now. They are read again in 5 seconds.",
  saveFailed: "The caps could not be saved just now. Please try again in a moment.",
  offline: "We couldn't reach the workshop. Check your connection and try again.",
  switchFailed: "That did not work, or its answer was lost. The state below was read again: check it before trying again.",
  switchUnknown: "That did not work, and the state could not be read again. Reload the page to see whether the workshop is paused.",
  /** Ticket 3.21: the state line beside the switch "Apps may use AI" (off by default; the global Stop also stops it). */
  appAiOn: "Apps may use AI tasks now (at most $1 per app and $10 for all apps each day).",
  appAiOff: "Apps may not use AI tasks. Their AI buttons answer that AI is switched off.",
  appAiStopped: "Apps may use AI tasks, but the workshop is stopped, so they are off until you press Resume.",
  appAiFailed: "The switch did not change, or its answer was lost. The state beside it was read again: check it before trying again.",
} as const;

/** Ticket 3.12: the error beside one cap's field, from the API's own ranges (decision "(3.2) PUT rules"). */
export function capErrorText(name: keyof typeof CAP_RANGES): string {
  const range = CAP_RANGES[name];
  if (name === "aiBudgetUsd") return `Enter an amount from $${range.min} to $${range.max}.`;
  return `Enter a whole number from ${range.min} to ${range.max}.`;
}

/**
 * Ticket 3.24: saving in apps needs the workshop's sign-in. The data API's 401 (and 3.18's and 3.21's), and the lines of
 * the hand-off page `/app-sign-in` and its token route. Button labels stay in the web code.
 */
export const APP_SIGN_IN_TEXTS = {
  signInToSave: "Sign in to the workshop to save in this app.",
  notLive: "This app is not live.",
  signInFirst: "Sign in to the workshop first, then you come back here.",
  noNickname: "Choose your workshop nickname first, then open this page again from the app.",
  tooMany: "You have signed in to save in many apps today. Sign out of the workshop and sign in again to start over.",
  conflict: "Something changed at the same moment. Please press Continue again.",
  failed: "Something went wrong. Please try again in a moment.",
  offline: "We couldn't reach the workshop. Check your connection and try again.",
  opening: "Opening the app…",
  /** Under the question: what Continue does. */
  explainer: "The app can then save as you for 12 hours, or until you sign out of the workshop. Everyone with the app's link sees what you save, with your nickname.",
} as const;

/** Ticket 3.24: on the workshop's sign-in when an app sent the person there ("Sign in to save in ada's app."). */
export function appSignInNoteText(app: string): string {
  return `Sign in to save in ${app}'s app. You come back to it afterwards.`;
}

/** Ticket 3.24: the hand-off page's question ("Save in ada's app as Bob?"). */
export function saveAsText(app: string, nickname: string): string {
  return `Save in ${app}'s app as ${nickname}?`;
}

/**
 * Ticket 3.21: the `message` of each answer of the AI tasks for apps (`POST /api/apps/{nickname}/ai`), which apps show
 * their visitors (3.22's helpers show it on a refusal). Plain text, no amount spent, no address.
 */
export const APP_AI_TEXTS = {
  /** The admin's switch "Apps may use AI" is off, or the global Stop is on (503, no AI call). */
  switchedOff: "AI is switched off for apps right now.",
  /** This app's $1 for the UTC day is used (429, no AI call). */
  appBudget: "This app has used its AI allowance for today. AI tasks work again tomorrow.",
  /** All apps' $10 for the UTC day is used (429, no AI call). */
  workshopBudget: "The workshop's AI allowance for apps is used up for today. AI tasks work again tomorrow.",
  /** The model's answer had none of what was asked in a usable form (502). */
  unreadable: "The AI could not read this.",
  badRequest:
    "Send JSON with a task: tag-photo (photo, and up to 20 tags or none), read-photo (photo and 1 to 12 fields, each with a name and a type: text, number, date or money), sort-text (text of up to 2,000 characters and 1 to 20 categories) or transcribe (recording). Nothing else.",
  photoNotInApp: "Send the address of a photo of this app: /app-media/<this app's nickname>/<id>.",
  recordingNotInApp: "Send the address of a voice recording of this app: /app-media/<this app's nickname>/<id>.",
  mediaNotFound: "This photo or recording is not in this app (it may have been deleted).",
  notAPhoto: "This file is not a photo.",
  notARecording: "This file is not a voice recording.",
  photoTooBig: "This photo is too big for the AI: send one of at most 3.75 MB.",
  recordingTooLong: "This recording is too long for the AI: at most 5 minutes.",
  /** transcribe: Amazon Transcribe is still working (202); asking again with the same recording gets the text. */
  working: "The recording is being turned into text. Ask again in a few seconds.",
  /** transcribe: the job failed (the format, silence). */
  transcribeFailed: "The recording could not be turned into text.",
  conflict: "Many AI tasks were asked at the same moment. Please try again.",
  failed: "The AI service had a problem. Please try again in a moment.",
} as const;
