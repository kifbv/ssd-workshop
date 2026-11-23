// The answer call (ticket 1.7): Claude answers an on-path message with the conversation so far.
// The step 1 (Clarify) system prompt is a first version; ticket 1.8 refines how clarify behaves.
import type { Step } from "../types.js";
import type { ModelClient, ModelReply, ModelTurn } from "./model.js";

export const ANSWER_MAX_TOKENS = 2000;
/** Earlier messages sent along as context, at most (participant and assistant counted separately). */
export const HISTORY_LIMIT = 20;

export const CLARIFY_PROMPT_VERSION = "clarify-v1";

export const CLARIFY_SYSTEM_PROMPT = `You are the friendly guide of a one-day workshop in which non-developers turn an idea into a small single-page web app. This is step 1, Clarify: help the participant make their idea clear enough to write a short spec. Ask one or two short questions at a time about who the app is for, what it should do first and what a first version can leave out; suggest a simpler version when the idea is too big for a small single-page app. Explain any technical word you use in plain language. Keep answers short (a few sentences), warm and concrete. Never ask for personal data about real people, and never write code in this step.`;

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
  const reply = await model.converse({ system: prompt, messages, maxTokens: ANSWER_MAX_TOKENS, temperature: 0.7 }, signal);
  if (reply.text === "") throw Object.assign(new Error("empty answer"), { name: "EmptyAnswer" });
  return { ...reply, promptVersion: version, historyCount: messages.length - 1 };
}
