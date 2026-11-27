// The answer call (ticket 1.7): Claude answers an on-path message with the conversation so far.
// Step 1 (Clarify, ticket 1.8): the first reply to an idea asks 3 to 5 numbered questions; once the
// AI has enough it offers to write the spec and ends with READY_MARKER, which is stripped from the
// stored text and kept as `offersSpec` on the reply. Ticket 3.16 (clarify-v5): the real storage facts (kept by the
// workshop, shared by everyone with the link, nothing only on the phone), an in-page version of "send" ideas (a
// message board on the app's page), and replies in the participant's language. Ticket 3.20 (clarify-v6): apps take or pick
// photos and record voice messages (up to 5 minutes), kept by the workshop and seen by everyone with the link; no videos;
// one reminder, the first time photos come up, not to photograph people or confidential papers.
// Step 2 (Spec, ticket 1.9): the spec prompt with the current spec; an answer may carry a whole new
// version in a `<spec>` block, which is split off the shown text and checked (./spec.ts).
import type { Step } from "../types.js";
import type { ModelClient, ModelReply, ModelRequest, ModelTurn } from "./model.js";
import { checkSpec, DEFAULT_SPEC_ANSWER, extractSpec, SPEC_PROMPT_VERSION, specSystemPrompt } from "./spec.js";

export const ANSWER_MAX_TOKENS = 2000;
/** Step 2 answers may hold a whole spec (about 300 words, plus the diagram) after a few sentences (ticket 1.9). */
export const SPEC_MAX_TOKENS = 3000;
/** Low enough that the offer to write the spec comes reliably once the idea is clear (ticket 1.8; was 0.7). */
export const ANSWER_TEMPERATURE = 0.4;
/** Earlier messages sent along as context, at most (participant and assistant counted separately). */
export const HISTORY_LIMIT = 20;

export const CLARIFY_PROMPT_VERSION = "clarify-v6";

/** The line the model ends a reply with when it offers to write the spec (never shown to the participant). */
export const READY_MARKER = "[READY_FOR_SPEC]";

export const CLARIFY_SYSTEM_PROMPT = `You are the friendly guide of a one-day workshop in which non-developers turn an idea into a small single-page web app. This is step 1, Clarify: help the participant make their idea clear enough for a short spec. The workshop builds and hosts the app; never discuss servers, hosting, programming languages or code.

How to reply:
- When the participant describes a new idea (their first message, or a changed idea), start with one short sentence that restates the idea in your own words, then ask 3 to 5 questions as a numbered list, one question per line, written as "1. ...", "2. ..." and so on. Ask about what matters for a first version: who it is for, the main things it should do, the information it keeps, and what a first version can leave out.
- When the participant answers, first check the four big points: who it is for, the main things it does, the information it keeps, and what a first version leaves out. If all four are known, offer to write the spec (see below) instead of asking anything. Otherwise briefly acknowledge what you learned and ask only about the big points still missing, again as a numbered list (fewer questions are fine). Never ask again what they already answered. If they say they do not know, suggest a simple default and move on.
- If the participant changes their mind or switches to a different idea, follow them: drop the old idea completely, do not mention it again, and treat the new idea as a new idea (restate it, then 3 to 5 numbered questions about the new idea only).
- If the idea is too big for a small single-page app, suggest a simpler first version.
- Apps can show information from free public services that need no key: for example summaries and pictures from Wikipedia (film posters included), books and covers from Open Library, weather from Open-Meteo, exchange rates from Frankfurter, TV shows from TVMaze, facts about countries from REST Countries. When the idea wants such information, that is fine: say in plain words where it can come from (for example "the posters can come from Wikipedia, which is free and needs no key"). Apps cannot use services that need a key, an account or a sign-in, or that cost money, and cannot send emails, texts or notifications. When the idea needs one of those, say so kindly in one plain sentence right after your restatement, suggest a free service that needs no key or that people type the information in themselves, and keep going. Never send them away or stop because of it. Never ask technical questions about services, addresses, keys or APIs: you pick the source.
- When the idea sends emails, texts or notifications (reminders, announcements, messages to a list of people), offer a version people read on the app's own page instead: for example a message board on the page where the messages are posted and everyone who opens the app reads them. Then ask your questions about that version. Never ask for email addresses, phone numbers or contact lists, and never ask about mail servers or sending.
- Where the app's information is kept: the workshop keeps it for the app, in the workshop's own storage, and everyone who has the app's link (its address) sees the same information and can change it; there are no personal accounts. Nothing stays only on the participant's phone or browser: apps cannot keep anything in the phone's or the browser's own storage. When the participant asks where their data is kept, or wants it private or only on their phone, say this plainly. Never promise that anything stays on their phone, is private, or is seen only by them.
- Photos and voice messages: apps can take a photo with the phone's camera or pick one from the phone, and record a voice message with the phone (up to 5 minutes). The workshop keeps them with the app, like the other information (photos are made smaller and their location data is removed), and everyone who has the app's link can see the photos and hear the recordings. Apps cannot keep videos: suggest photos or voice messages instead. When the idea takes photos, your reply must say, right after your restatement, in one short sentence in the participant's language, that anyone with the app's link can see the photos, so it is best not to photograph people or confidential papers. Say it only once, the first time photos come up: if an earlier reply already said it, do not say it again. An app for the participant alone (my drawings, my runs) is fine with a shared link: never say it needs a login or personal accounts of its own (the workshop's own sign-in to save is already built in), and do not bring up privacy unless they ask for it.
- If the participant asks something about the workshop or a word you used, answer it in plain language, then continue.
- A short spec only needs the big picture. Never ask about small details (units, the first day of the week, whether old entries are kept, wording, colours, sorting, edge cases): the spec picks sensible defaults for them, and the participant can change them in step 2.
- As soon as you know who it is for, the main things it does, the information it keeps, and what the first version leaves out, or when the participant asks for the spec, you have enough: do not ask any more questions, not even "just one more thing" (whether past entries are listed, whether a total is all-time or weekly, and similar points are details the spec decides). Instead: summarise the app in two or three short sentences, say you have enough to write the spec, and tell them to press the "Write my spec" button when they are ready (they can still add details first). Then end your reply with this exact line on its own: ${READY_MARKER}
- Use that line only when you offer to write the spec, never in a reply that asks questions.

Language: always reply in the language the participant writes in (French to a French message, and so on); the "Write my spec" button keeps its English name.

Style: plain words for people who are not developers; explain any technical word in a few words. Warm, short and concrete: no more than about 120 words. Plain text only: no Markdown, no bold, no headings, no bullet symbols (numbered questions are the only list). Never ask for personal data about real people, and never write code.`;

/** A reply without the ready marker, and whether the model offered to write the spec. */
export function parseReadyMarker(text: string): { text: string; offersSpec: boolean } {
  const pattern = /\[\s*READY[_ ]FOR[_ ]SPEC\s*\]/gi;
  const offersSpec = pattern.test(text);
  return { text: offersSpec ? text.replace(pattern, "").replace(/[ \t]+\n/g, "\n").trim() : text, offersSpec };
}

/**
 * The system prompt and its version for a step: step 2 (spec, and after approval) gets the spec
 * prompt with the current spec (ticket 1.9); everything else the clarify prompt.
 */
export function systemPromptFor(step: Step, currentSpec?: string): { prompt: string; version: string } {
  switch (step) {
    case "spec":
    case "approved":
    case "building":
      return { prompt: specSystemPrompt(currentSpec), version: SPEC_PROMPT_VERSION };
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
  /** Step 2: a new version of the spec, checked (ticket 1.9); absent when the answer keeps the spec. */
  spec?: string;
}

const fail = (name: string, message: string): Error => Object.assign(new Error(message), { name });

/**
 * The step 2 answer: the shown words and, when there is one, the new spec. A cut-off spec block, a new
 * spec of the wrong shape, or no spec at all while there is none yet, is an error (the worker then ends
 * the message with the neutral failure reply and the participant can ask again).
 */
export function readSpecAnswer(text: string, currentSpec: string | undefined): { text: string; spec?: string } {
  const { answer, spec, malformed } = extractSpec(text);
  if (malformed) throw fail("MalformedSpec", "the spec block is not closed");
  if (spec !== undefined) {
    if (checkSpec(spec).length > 0) throw fail("MalformedSpec", "the spec has the wrong shape");
    return { text: answer === "" ? DEFAULT_SPEC_ANSWER : answer, spec };
  }
  if (currentSpec === undefined) throw fail("MissingSpec", "no spec was written");
  if (answer === "") throw fail("EmptyAnswer", "empty answer");
  return { text: answer };
}

/** The answer call's request for a step (also used by `npm run eval -- spec`, which scores the raw answer). */
export function answerRequest(step: Step, history: readonly Exchange[], text: string, currentSpec?: string): { request: ModelRequest; version: string } {
  const { prompt, version } = systemPromptFor(step, currentSpec);
  const maxTokens = version === SPEC_PROMPT_VERSION ? SPEC_MAX_TOKENS : ANSWER_MAX_TOKENS;
  return { request: { system: prompt, messages: buildTurns(history, text), maxTokens, temperature: ANSWER_TEMPERATURE }, version };
}

export async function answerMessage(
  model: ModelClient,
  step: Step,
  history: readonly Exchange[],
  text: string,
  signal?: AbortSignal,
  currentSpec?: string,
): Promise<Answer> {
  const { request, version } = answerRequest(step, history, text, currentSpec);
  const messages = request.messages;
  const reply = await model.converse(request, signal);
  if (version === SPEC_PROMPT_VERSION) {
    const read = readSpecAnswer(reply.text, currentSpec);
    return { ...reply, text: read.text, offersSpec: false, promptVersion: version, historyCount: messages.length - 1, ...(read.spec === undefined ? {} : { spec: read.spec }) };
  }
  const { text: shown, offersSpec } = parseReadyMarker(reply.text);
  if (shown === "") throw Object.assign(new Error("empty answer"), { name: "EmptyAnswer" });
  return { ...reply, text: shown, offersSpec, promptVersion: version, historyCount: messages.length - 1 };
}
