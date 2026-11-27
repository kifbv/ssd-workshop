// Step 4, change requests (ticket 3.6). Once the app is live, a participant asks for a change in plain English: after
// the guardrail, the AI writes the next version of the spec and a short "What changes" list. The participant then
// presses Build this change (the readiness check runs on that version and a change build is queued, counting one of
// their changes) or Not this one. The model sees the live spec (the version last sent to build) and, while one is open, the
// proposed version, so a later message refines the proposal; the list always compares with the live spec.
// Pure TypeScript: the worker, the eval and the tests share it.
import type { Exchange } from "./answer.js";
import { ANSWER_TEMPERATURE, buildTurns } from "./answer.js";
import type { ModelClient, ModelReply, ModelRequest } from "./model.js";
import { notReadyReasonsList } from "./readiness.js";
import { checkSpec, extractSpec, SPEC_FORMAT_AND_RULES } from "./spec.js";

// Ticket 3.20 (change-v3): only the shared spec rules changed (photos and voice messages, never videos).
export const CHANGE_PROMPT_VERSION = "change-v3";
/** A whole spec (about 300 words and the diagram), a few sentences and the list. */
export const CHANGE_MAX_TOKENS = 3500;
/** At most this many "What changes" lines are kept, each cut to CHANGE_LINE_CHARS characters on one line. */
export const MAX_CHANGE_LINES = 5;
export const CHANGE_LINE_CHARS = 160;

/**
 * The message Build this change stores for the AI worker (ticket 3.6), at step `building` and marked with
 * `request: "change-build"`, an attribute only that route writes (a participant's own message never has it): the worker
 * runs the readiness check on the proposed version for exactly this text with that mark, never for a participant's text.
 */
// Ticket 3.8: the text lives with the phase 3 texts, so the step 4 page can recognise the request in flight.
export { CHANGE_BUILD_REQUEST } from "../workshop/texts.js";

/** The reply when the check passes: the change build is queued in the same transaction. */
export const CHANGE_READY_REPLY = "Your change is ready to build. The build is starting now: the AI changes your app to match the new spec.";

/** The neutral reply when the check could not be made (model error, unreadable answer, a queue failure). */
export const CHANGE_FAILURE_REPLY = "Sorry, the check of your change did not work this time. Please press Build this change again.";

/** The reply when the check fails: its reasons as a short list, and what to do next (plain text). */
export function changeNotReadyReply(reasons: readonly string[]): string {
  return [
    "This change cannot be built yet:",
    ...notReadyReasonsList(reasons),
    "Ask me to change it (or answer the open question), then press Build this change again. Your live app stays as it is.",
  ].join("\n");
}

export const CHANGE_SYSTEM_PROMPT = `You are the friendly guide of a one-day workshop in which non-developers turn an idea into a small single-page web app. The participant's app is already live, and the live spec below is the version they last sent to build. This is step 4, Live: they ask for small changes in plain English. For each change you write the next version of the spec and a short list of what changes. They then press "Build this change" (or "Not this one"), and the app is changed to match the new spec, keeping everything else as it is. The workshop builds and hosts the app; never discuss servers, hosting, programming languages, frameworks or code.

How to reply:
- When the participant asks for a change (add, remove, rename, simplify, "make it...", "I'd like..."), make it: one or two short sentences saying what you changed, then the whole new spec, then the list of what changes. When there is a proposed spec, the participant is refining it: start from the proposed spec; otherwise start from the live spec. Keep everything they did not ask to change exactly as it was.
- The list of what changes compares the new spec with the live spec: one to five short lines, each starting with "- " and at most 15 words, in plain words for the participant, for example "- Adds a weekly chart to the home screen". Never list something that stays the same.
- Keep each change small: if they ask for several big things at once, make the first one and suggest sending the others one at a time after it is built.
- When they ask a question (what, why, how, explain), answer it in plain language in no more than about 120 words, without a spec or a list: nothing changes.
- If a change would make the app too big for a small single-page app, or needs something the workshop cannot build (a login or accounts, payments, a service that needs a key, an account or money, sending emails, texts or notifications, a server or programs running in the background), suggest a simpler version and ask whether that is fine, without a spec or a list.
- Small details they leave open (units, sorting, wording, colours) get sensible defaults; mention a default only when it matters.

${SPEC_FORMAT_AND_RULES}

The list of what changes goes right after the spec, between a line that is exactly <changes> and a line that is exactly </changes>:
<changes>
- Adds a weekly chart to the home screen
</changes>`;

/** The change prompt with the live spec and, while one is open, the proposed version. */
export function changeSystemPrompt(liveSpec: string, proposedSpec: string | undefined): string {
  const live = `The live spec (the spec last sent to build):\n<live_spec>\n${liveSpec}\n</live_spec>`;
  const proposed =
    proposedSpec === undefined
      ? "There is no proposed spec: start from the live spec."
      : `The proposed spec (the participant has not built it yet and may be refining it):\n<proposed_spec>\n${proposedSpec}\n</proposed_spec>`;
  return `${CHANGE_SYSTEM_PROMPT}\n\n${live}\n\n${proposed}`;
}

/** The answer call's request (also used by tests and evals). */
export function changeRequest(history: readonly Exchange[], text: string, liveSpec: string, proposedSpec: string | undefined): ModelRequest {
  return { system: changeSystemPrompt(liveSpec, proposedSpec), messages: buildTurns(history, text), maxTokens: CHANGE_MAX_TOKENS, temperature: ANSWER_TEMPERATURE };
}

/** One line of plain text: control characters and runs of spaces become one space, cut to `max`. */
function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim().slice(0, max);
}

/** The `<changes>` block (the last one) taken out of a model answer: its lines and the text without it. */
export function extractChanges(text: string): { rest: string; lines?: string[]; malformed: boolean } {
  const open = /^[ \t]*<changes>[ \t]*$/gim;
  const close = /^[ \t]*<\/changes>[ \t]*$/gim;
  const lastOpen = [...text.matchAll(open)].at(-1);
  if (lastOpen === undefined) return { rest: text.replace(close, ""), malformed: false };
  const start = (lastOpen.index ?? 0) + lastOpen[0].length;
  close.lastIndex = start;
  const end = close.exec(text);
  if (end === null) return { rest: text.slice(0, lastOpen.index), malformed: true };
  const lines = text
    .slice(start, end.index)
    .split("\n")
    .map((line) => /^\s*[-*•]\s+(.*)$/.exec(line)?.[1])
    .filter((line): line is string => line !== undefined)
    .map((line) => oneLine(line, CHANGE_LINE_CHARS))
    .filter((line) => line !== "")
    .slice(0, MAX_CHANGE_LINES);
  const rest = `${text.slice(0, lastOpen.index)}\n${text.slice(end.index + end[0].length)}`.replace(open, "").replace(close, "");
  return { rest, lines, malformed: false };
}

export interface ChangeAnswer extends ModelReply {
  /** The shown words (no spec, no list). */
  text: string;
  promptVersion: string;
  historyCount: number;
  /** A new proposed version and its "What changes" list; absent when the answer changes nothing (a question). */
  spec?: string;
  whatChanges?: string[];
}

const fail = (name: string, message: string): Error => Object.assign(new Error(message), { name });

/**
 * A change answer: the shown words and, when there is one, the new spec with its list. A cut-off block, a spec of the
 * wrong shape, a spec without a list (or with an empty one), or no words at all is an error: the worker then ends the
 * message with the neutral failure reply and nothing changes. A list without a spec is dropped.
 */
export function readChangeAnswer(text: string): { text: string; spec?: string; whatChanges?: string[] } {
  const changes = extractChanges(text);
  if (changes.malformed) throw fail("MalformedChange", "the changes block is not closed");
  const { answer, spec, malformed } = extractSpec(changes.rest);
  if (malformed) throw fail("MalformedSpec", "the spec block is not closed");
  if (spec === undefined) {
    if (answer === "") throw fail("EmptyAnswer", "empty answer");
    return { text: answer };
  }
  if (checkSpec(spec).length > 0) throw fail("MalformedSpec", "the spec has the wrong shape");
  if (changes.lines === undefined || changes.lines.length === 0) throw fail("MalformedChange", "a new spec without its list of changes");
  return { text: answer === "" ? DEFAULT_CHANGE_ANSWER : answer, spec, whatChanges: changes.lines };
}

/** Shown when the model wrote a new version but no words around it. */
export const DEFAULT_CHANGE_ANSWER = "Here is your change. Press Build this change to build it, or Not this one to keep your app as it is.";

/** One change answer call: the live spec, the proposal (if open), the answered exchanges and the new message. */
export async function answerChange(
  model: ModelClient,
  history: readonly Exchange[],
  text: string,
  liveSpec: string,
  proposedSpec: string | undefined,
  signal?: AbortSignal,
): Promise<ChangeAnswer> {
  const request = changeRequest(history, text, liveSpec, proposedSpec);
  const reply = await model.converse(request, signal);
  const read = readChangeAnswer(reply.text);
  return {
    ...reply,
    text: read.text,
    promptVersion: CHANGE_PROMPT_VERSION,
    historyCount: request.messages.length - 1,
    ...(read.spec === undefined ? {} : { spec: read.spec }),
    ...(read.whatChanges === undefined ? {} : { whatChanges: read.whatChanges }),
  };
}
