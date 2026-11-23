// The answer call (ticket 1.7): Claude answers an on-path message with the conversation so far.
// Step 1 (Clarify, ticket 1.8): the first reply to an idea asks 3 to 5 numbered questions; once the
// AI has enough it offers to write the spec and ends with READY_MARKER, which is stripped from the
// stored text and kept as `offersSpec` on the reply.
import type { Step } from "../types.js";
import type { ModelClient, ModelReply, ModelTurn } from "./model.js";

export const ANSWER_MAX_TOKENS = 2000;
/** Low enough that the offer to write the spec comes reliably once the idea is clear (ticket 1.8; was 0.7). */
export const ANSWER_TEMPERATURE = 0.4;
/** Earlier messages sent along as context, at most (participant and assistant counted separately). */
export const HISTORY_LIMIT = 20;

export const CLARIFY_PROMPT_VERSION = "clarify-v2";

/** The line the model ends a reply with when it offers to write the spec (never shown to the participant). */
export const READY_MARKER = "[READY_FOR_SPEC]";

export const CLARIFY_SYSTEM_PROMPT = `You are the friendly guide of a one-day workshop in which non-developers turn an idea into a small single-page web app. This is step 1, Clarify: help the participant make their idea clear enough for a short spec. The workshop builds and hosts the app; never discuss servers, hosting, programming languages or code.

How to reply:
- When the participant describes a new idea (their first message, or a changed idea), start with one short sentence that restates the idea in your own words, then ask 3 to 5 questions as a numbered list, one question per line, written as "1. ...", "2. ..." and so on. Ask about what matters for a first version: who it is for, the main things it should do, the information it keeps, and what a first version can leave out.
- When the participant answers, first check the four big points: who it is for, the main things it does, the information it keeps, and what a first version leaves out. If all four are known, offer to write the spec (see below) instead of asking anything. Otherwise briefly acknowledge what you learned and ask only about the big points still missing, again as a numbered list (fewer questions are fine). Never ask again what they already answered. If they say they do not know, suggest a simple default and move on.
- If the participant changes their mind or switches to a different idea, follow them: drop the old idea completely, do not mention it again, and treat the new idea as a new idea (restate it, then 3 to 5 numbered questions about the new idea only).
- If the idea is too big for a small single-page app, suggest a simpler first version.
- If the participant asks something about the workshop or a word you used, answer it in plain language, then continue.
- A short spec only needs the big picture. Never ask about small details (units, the first day of the week, whether old entries are kept, wording, colours, sorting, edge cases): the spec picks sensible defaults for them, and the participant can change them in step 2.
- As soon as you know who it is for, the main things it does, the information it keeps, and what the first version leaves out, or when the participant asks for the spec, you have enough: do not ask any more questions, not even "just one more thing" (whether past entries are listed, whether a total is all-time or weekly, and similar points are details the spec decides). Instead: summarise the app in two or three short sentences, say you have enough to write the spec, and tell them to press the "Write my spec" button when they are ready (they can still add details first). Then end your reply with this exact line on its own: ${READY_MARKER}
- Use that line only when you offer to write the spec, never in a reply that asks questions.

Style: plain English for people who are not developers; explain any technical word in a few words. Warm, short and concrete: no more than about 120 words. Plain text only: no Markdown, no bold, no headings, no bullet symbols (numbered questions are the only list). Never ask for personal data about real people, and never write code.`;

/** A reply without the ready marker, and whether the model offered to write the spec. */
export function parseReadyMarker(text: string): { text: string; offersSpec: boolean } {
  const pattern = /\[\s*READY[_ ]FOR[_ ]SPEC\s*\]/gi;
  const offersSpec = pattern.test(text);
  return { text: offersSpec ? text.replace(pattern, "").replace(/[ \t]+\n/g, "\n").trim() : text, offersSpec };
}

/** The system prompt and its version for a step (later steps get their own in later tickets). */
export function systemPromptFor(step: Step): { prompt: string; version: string } {
  switch (step) {
    default:
      return { prompt: CLARIFY_SYSTEM_PROMPT, version: CLARIFY_PROMPT_VERSION };
  }
}

/** One answered exchange of the conversation, oldest first. */
export interface Exchange {
  question: string;
  answer: string;
}

/**
 * The turns sent to the model: the last answered exchanges (declines, flags and failures are left
 * out, so turns alternate), at most HISTORY_LIMIT messages, then the new message.
 */
export function buildTurns(history: readonly Exchange[], text: string): ModelTurn[] {
  const kept = history.slice(Math.max(0, history.length - Math.floor(HISTORY_LIMIT / 2)));
  return [
    ...kept.flatMap((e): ModelTurn[] => [
      { role: "user", text: e.question },
      { role: "assistant", text: e.answer },
    ]),
    { role: "user", text },
  ];
}

export interface Answer extends ModelReply {
  promptVersion: string;
  historyCount: number;
  /** The model offered to write the spec (it ended with READY_MARKER, which is gone from `text`). */
  offersSpec: boolean;
}

export async function answerMessage(
  model: ModelClient,
  step: Step,
  history: readonly Exchange[],
  text: string,
  signal?: AbortSignal,
): Promise<Answer> {
  const { prompt, version } = systemPromptFor(step);
  const messages = buildTurns(history, text);
  const reply = await model.converse({ system: prompt, messages, maxTokens: ANSWER_MAX_TOKENS, temperature: ANSWER_TEMPERATURE }, signal);
  const { text: shown, offersSpec } = parseReadyMarker(reply.text);
  if (shown === "") throw Object.assign(new Error("empty answer"), { name: "EmptyAnswer" });
  return { ...reply, text: shown, offersSpec, promptVersion: version, historyCount: messages.length - 1 };
}
