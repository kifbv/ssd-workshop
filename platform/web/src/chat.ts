// Step 1, Clarify (ticket 1.8): what each conversation API answer means for the page, as pure
// functions so every rule is unit tested without a browser. The DOM wiring is in ./main.ts.
import { MESSAGES, messageOf, type ApiAnswer, type Show, type Tone } from "./flow.js";

/** The page asks for the reply to the message in flight this often. */
export const POLL_INTERVAL_MS = 2000;
/** While a message waits for the facilitator, the page checks less often for their decision. */
export const WAITING_POLL_INTERVAL_MS = 10_000;

export interface ChatMessage {
  id: string;
  author: "participant" | "assistant";
  text: string;
  /** Participant messages: pending, done, declined, flagged or failed. */
  status?: string;
  /** Replies: the AI offered to write the spec. */
  offersSpec?: boolean;
  /** The step the message belongs to: step 1 and step 2 each show their own (ticket 1.9). */
  step?: string;
  /** Replies: the spec version this answer saved (ticket 1.9). */
  specVersion?: number;
}

/** `GET /api/conversation`. */
export interface Conversation {
  step: string;
  state: "open" | "waiting";
  messages: ChatMessage[];
  pendingId?: string;
  /** The newest and the approved spec versions (ticket 1.9). */
  latestSpecVersion?: number;
  approvedSpecVersion?: number;
}

export const CHAT_TEXTS = {
  waiting: "Your message is waiting for your facilitator. You can write again once they have looked at it.",
  empty: "Please write a message first.",
  /** Shown above Write my spec once an exchange was answered and before the AI offers. */
  specAnytime: "Ready when you are: keep answering, or ask for your spec now.",
  /** Shown once the AI said it has enough. */
  specOffered: "The AI has enough to write your spec.",
} as const;

const show = (message: string, tone: Tone = "error"): Show => ({ kind: "show", message, tone });

function common(answer: ApiAnswer): Show {
  if (answer.status === 429) return show(MESSAGES.retry, "info");
  if (answer.status === 0) return show(MESSAGES.offline);
  return show(MESSAGES.failed);
}

/** A spec version number: a whole number from 1. */
export const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function parseMessage(value: unknown): ChatMessage | undefined {
  const m = record(value);
  if (m === undefined) return undefined;
  const { id, author, text, status, offersSpec, step, specVersion } = m;
  if (typeof id !== "string" || typeof text !== "string" || (author !== "participant" && author !== "assistant")) return undefined;
  return {
    id,
    author,
    text,
    ...(typeof status === "string" ? { status } : {}),
    ...(offersSpec === true ? { offersSpec: true } : {}),
    ...(typeof step === "string" ? { step } : {}),
    ...(isVersion(specVersion) ? { specVersion } : {}),
  };
}

/** A conversation from `GET /api/conversation`, or undefined when it is not one. */
export function parseConversation(body: unknown): Conversation | undefined {
  const b = record(body);
  if (b === undefined) return undefined;
  const { step, state, messages, pendingId, latestSpecVersion, approvedSpecVersion } = b;
  if (typeof step !== "string" || (state !== "open" && state !== "waiting") || !Array.isArray(messages)) return undefined;
  const parsed = messages.map(parseMessage);
  if (parsed.some((m) => m === undefined)) return undefined;
  return {
    step,
    state,
    messages: parsed as ChatMessage[],
    ...(typeof pendingId === "string" ? { pendingId } : {}),
    ...(isVersion(latestSpecVersion) ? { latestSpecVersion } : {}),
    ...(isVersion(approvedSpecVersion) ? { approvedSpecVersion } : {}),
  };
}

export function conversationResult(answer: ApiAnswer): { kind: "conversation"; conversation: Conversation } | { kind: "signed-out" } | Show {
  if (answer.status === 200) {
    const conversation = parseConversation(answer.body);
    return conversation ? { kind: "conversation", conversation } : show(MESSAGES.failed);
  }
  if (answer.status === 401) return { kind: "signed-out" };
  return common(answer);
}

const reasonOf = (body: unknown): unknown => record(body)?.["reason"];

/** `POST /api/conversation/messages`. */
export function sendResult(
  answer: ApiAnswer,
): { kind: "sent"; id: string } | { kind: "busy" } | { kind: "waiting" } | { kind: "no-nickname" } | { kind: "approved" } | { kind: "signed-out" } | Show {
  if (answer.status === 202) {
    const id = record(answer.body)?.["id"];
    return typeof id === "string" ? { kind: "sent", id } : show(MESSAGES.failed);
  }
  if (answer.status === 409) {
    const reason = reasonOf(answer.body);
    // Busy: a message is in flight that this page does not know (another tab): reload the conversation.
    if (reason === "busy") return { kind: "busy" };
    if (reason === "waiting") return { kind: "waiting" };
    if (reason === "no-nickname") return { kind: "no-nickname" };
    // Ticket 1.9: the spec was approved (in another tab): the page shows the approved state.
    if (reason === "approved") return { kind: "approved" };
  }
  if (answer.status === 400) return show(messageOf(answer.body) ?? MESSAGES.failed);
  if (answer.status === 401) return { kind: "signed-out" };
  return common(answer);
}

/** `GET /api/conversation/messages/{id}`. A passing failure (network, 429, 5xx) keeps polling. */
export function pollResult(
  answer: ApiAnswer,
):
  | { kind: "pending" }
  | { kind: "flagged" }
  | { kind: "answered"; status: string; reply: string }
  | { kind: "signed-out" }
  | { kind: "lost" }
  | { kind: "retry" } {
  if (answer.status === 200) {
    const b = record(answer.body);
    const status = b?.["status"];
    const reply = b?.["reply"];
    if (status === "pending") return { kind: "pending" };
    if (status === "flagged") return { kind: "flagged" };
    if ((status === "done" || status === "declined" || status === "failed") && typeof reply === "string") return { kind: "answered", status, reply };
    return { kind: "retry" };
  }
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 404) return { kind: "lost" };
  return { kind: "retry" };
}

/** `POST /api/conversation/step` (Write my spec). */
export function writeSpecResult(answer: ApiAnswer): { kind: "moved" } | { kind: "signed-out" } | Show {
  if (answer.status === 200) return { kind: "moved" };
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 409) return show(messageOf(answer.body) ?? MESSAGES.failed);
  return common(answer);
}

/** Write my spec appears once at least one message was answered (the participant steers). */
export function canWriteSpec(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => m.author === "participant" && m.status === "done");
}

/** The AI offered to write the spec in its latest message, and nothing was said since. */
export function specOffered(messages: readonly ChatMessage[]): boolean {
  const last = messages.at(-1);
  return last?.author === "assistant" && last.offersSpec === true;
}

/** What the behind-the-scenes box highlights. */
export type Stage = "idle" | "working" | "facilitator" | "reply";

export function stageOf(waiting: "none" | "pending" | "flagged", messages: readonly ChatMessage[]): Stage {
  if (waiting === "pending") return "working";
  if (waiting === "flagged") return "facilitator";
  return messages.at(-1)?.author === "assistant" ? "reply" : "idle";
}
