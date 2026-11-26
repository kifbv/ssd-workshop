// Step 4, change requests (ticket 3.8): what the change answers mean for the page and which parts of step 4 show, as
// pure functions so every rule is unit tested without a browser. The DOM wiring is in ./main.ts.
//
// The "What changes" lines and the spec are the AI's text (guardrail-checked): the page shows them with `textContent`.
import { CHANGE_BUILD_REQUEST, changesLeftText, changesUsedText, PHASE_3_TEXTS } from "../../api/workshop/texts.js";
import { isChangeRefusal, isVersion, type ChatMessage, type ChangeRefusal, type Conversation } from "./chat.js";
import { MESSAGES, messageOf, type ApiAnswer, type Show, type Tone } from "./flow.js";

/** A proposed change as `GET /api/conversation/spec?version=n` returns it. */
export interface Proposal {
  version: number;
  text: string;
  whatChanges: string[];
}

/**
 * The change loop, drawn in step 4's "Behind the scenes" box (Mermaid, top to bottom so it reads on a phone). The same
 * loop as the phase 3 brief's diagram, in the participant's words, kept to one column with short labels and a single
 * return arrow: it is drawn about 300 px wide, so its 16 px labels stay at 11 px or more in a 375 px wide page
 * (tested in pages.test.ts). The facilitator's look at an unusual request and Not this one are in the paragraph under it.
 */
export const CHANGE_LOOP_DIAGRAM = [
  "flowchart TD",
  "  you[Your change request] --> check{Safety check}",
  "  check --> update[Claude updates the spec:<br/>What changes]",
  "  update -->|Build this change| ready[Readiness check]",
  "  ready --> queue[(Build queue)]",
  "  queue --> builder[Claude edits<br/>your app's files]",
  "  builder --> github[GitHub: one new commit]",
  "  github --> deployer[Deployer checks<br/>and publishes]",
  "  deployer --> live[New version live]",
  "  live -.->|next change| you",
].join("\n");

export const CHANGE_LOOP_ALT =
  "Diagram of the change loop: your change request goes through a safety check, Claude updates the spec, you press Build this change, then the readiness check, the build queue, Claude edits your app's files, GitHub saves one commit and the deployer checks and publishes the new version; the next change starts the loop again.";

const show = (message: string, tone: Tone = "error"): Show => ({ kind: "show", message, tone });

function common(answer: ApiAnswer): Show {
  if (answer.status === 429) return show(MESSAGES.retry, "info");
  if (answer.status === 0) return show(MESSAGES.offline);
  return show(MESSAGES.failed);
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** `GET /api/conversation/spec?version=n` for the proposed version: its "What changes" list (at most 5 lines kept). */
export function proposalResult(answer: ApiAnswer): { kind: "proposal"; proposal: Proposal } | { kind: "none" } | { kind: "signed-out" } | Show {
  if (answer.status === 200) {
    const b = record(answer.body);
    const version = b?.["version"];
    const text = b?.["text"];
    const list = b?.["whatChanges"];
    if (!isVersion(version) || typeof text !== "string") return show(MESSAGES.failed);
    const whatChanges = Array.isArray(list) ? list.filter((line): line is string => typeof line === "string" && line.trim() !== "").slice(0, 5) : [];
    return { kind: "proposal", proposal: { version, text, whatChanges } };
  }
  if (answer.status === 404) return { kind: "none" };
  if (answer.status === 401) return { kind: "signed-out" };
  return common(answer);
}

/**
 * `POST /api/conversation/change/build` (202 with the request's id) and `POST /api/conversation/change/discard` (200):
 * done; `gone` (404: not the open proposal any more); refused (409: busy, waiting, all used, a build running, not live);
 * signed out; or a message.
 */
export function changeActionResult(
  answer: ApiAnswer,
): { kind: "done" } | { kind: "gone" } | { kind: "refused"; reason?: ChangeRefusal; message: string } | { kind: "signed-out" } | Show {
  if (answer.status === 202 || answer.status === 200) return { kind: "done" };
  if (answer.status === 404) return { kind: "gone" };
  if (answer.status === 409) {
    const reason = record(answer.body)?.["reason"];
    return { kind: "refused", ...(isChangeRefusal(reason) ? { reason } : {}), message: messageOf(answer.body) ?? MESSAGES.failed };
  }
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 400) return show(messageOf(answer.body) ?? MESSAGES.failed);
  return common(answer);
}

/** The messages step 4 shows: the change conversation (step 1 and 2's stay on their steps). */
export function stepFourMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.step === "building");
}

/** What step 4 shows, from the last conversation read, the proposal read and the message in flight. */
export interface StepFourView {
  /** "Changes left: 3 of 5", or undefined when the answer had no count. */
  countText?: string;
  /** "You've used your 5 changes." once every change is used: no box, no suggestions, no proposal. */
  usedUpText?: string;
  showForm: boolean;
  showSuggestions: boolean;
  showProposal: boolean;
  typingText: string;
}

export function stepFourView(
  conversation: Pick<Conversation, "changeRequestsUsed" | "changeRequestsPerPerson" | "suggestions" | "proposedSpecVersion">,
  proposal: Proposal | null,
  pending: ChatMessage | undefined,
): StepFourView {
  const used = conversation.changeRequestsUsed;
  const cap = conversation.changeRequestsPerPerson;
  const counted = used !== undefined && cap !== undefined;
  const usedUp = counted && used >= cap;
  const open = proposal !== null && proposal.version === conversation.proposedSpecVersion;
  return {
    ...(counted ? { countText: changesLeftText(used, cap) } : {}),
    ...(usedUp ? { usedUpText: changesUsedText(cap) } : {}),
    showForm: !usedUp,
    // The ideas start a new change: hidden while a proposal is open (a message then adjusts it).
    showSuggestions: !usedUp && !open && (conversation.suggestions?.length ?? 0) > 0,
    showProposal: !usedUp && open,
    typingText: isBuildRequest(pending) ? PHASE_3_TEXTS.checkingChange : PHASE_3_TEXTS.writingChange,
  };
}

/** The message in flight is Build this change's request (its readiness check runs), not a change request. */
export const isBuildRequest = (message: ChatMessage | undefined): boolean => message?.author === "participant" && message.text === CHANGE_BUILD_REQUEST;
