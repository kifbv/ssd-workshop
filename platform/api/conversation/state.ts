// The conversation's records and the store interface shared by the API routes, the AI worker and
// the flags command (ticket 1.7). The DynamoDB adapter is ./store.ts; tests use ./fakes.ts.
import { createHash } from "node:crypto";
import type { ConversationState, GuardrailVerdict, MessageStatus, Step, TokenUsage } from "../types.js";
import type { Exchange } from "./answer.js";

/**
 * A pending message older than this counts as failed (shown so, and no longer blocking a new
 * message). A worker run takes at most 5 minutes, and SQS starts a crashed job again after the
 * queue's visibility timeout (330 s), at most 3 times in all: the last run starts by about
 * 2 x 330 s and ends by about 960 s, so only a job that crashed 3 times (or waited long in the
 * queue) leaves a message pending this long. infra/lib/app.test.ts checks the timings fit.
 */
export const STALE_PENDING_SECONDS = 1200;

/** The SHA-256 (hex) of a message text: what a facilitator's approval is tied to. */
export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The neutral reply when the AI call fails. */
export const FAILURE_REPLY = "Sorry, something went wrong. Please send your message again.";

/** A participant message as the API and the worker read it. */
export interface StoredMessage {
  id: string;
  step: Step;
  text: string;
  status: MessageStatus;
  /** Epoch seconds. */
  pendingSince: number;
  /** The SHA-256 of the text a facilitator approved (see textHash), if any. */
  approvedTextHash?: string;
  suggestion?: string;
  /** The guardrail's reason, for the facilitator. */
  verdictReason?: string;
}

export interface StoredConversation {
  state: ConversationState;
  pendingId?: string;
}

/** True when a pending message was left behind by a crashed worker (see STALE_PENDING_SECONDS). */
export function isStale(message: Pick<StoredMessage, "status" | "pendingSince">, nowSeconds: number): boolean {
  return message.status === "pending" && nowSeconds - message.pendingSince > STALE_PENDING_SECONDS;
}

export interface GuardrailRecord {
  verdict: GuardrailVerdict;
  reason: string;
  suggestion: string;
  usage: TokenUsage;
}

export interface AnswerRecord {
  /** The participant's text as sent to the model. */
  prompt: string;
  modelId: string;
  promptVersion: string;
  historyCount: number;
  usage: TokenUsage;
}

/** How a message ends (or, for `flagged`, pauses). */
export type Finish =
  | { kind: "done"; reply: string; answer: AnswerRecord; guardrail?: GuardrailRecord }
  | { kind: "declined"; reply: string; guardrail?: GuardrailRecord }
  | { kind: "failed"; reply: string; guardrail?: GuardrailRecord }
  | { kind: "flagged"; guardrail: GuardrailRecord };

export interface NewMessage {
  id: string;
  step: Step;
  text: string;
  /** ISO 8601. */
  createdAt: string;
  /** Epoch seconds. */
  nowSeconds: number;
}

export type CreateResult = "created" | "busy" | "waiting";

/**
 * The table, as the conversation needs it. Every write that changes a message's status names the
 * status it expects and the conversation's message in flight, all in one transaction, so a message
 * delivered twice (SQS is at-least-once) or decided twice is handled once.
 */
export interface ConversationStore {
  /**
   * Stores a pending message and makes it the conversation's message in flight, only if none is
   * (a stale pending one does not count); otherwise `busy`, or `waiting` for a facilitator.
   */
  createMessage(participantId: string, message: NewMessage): Promise<CreateResult>;
  getMessage(participantId: string, messageId: string): Promise<StoredMessage | undefined>;
  /** The text of the reply to a message, if there is one. */
  getReplyText(participantId: string, messageId: string): Promise<string | undefined>;
  getConversation(participantId: string): Promise<StoredConversation | undefined>;
  /** Answered exchanges before the message, oldest first (at most the last 30 items are read). */
  getHistory(participantId: string, beforeMessageId: string): Promise<Exchange[]>;
  /**
   * Ends a message that is `from` (pending, or flagged for a facilitator's rejection): sets its
   * status, writes the reply, frees or pauses the conversation and adds the tokens and cost to the
   * participant's usage, all at once. False when the message was no longer `from` or no longer the
   * conversation's message in flight (nothing written).
   */
  finish(participantId: string, messageId: string, outcome: Finish, from: "pending" | "flagged", nowIso: string): Promise<boolean>;
  /**
   * Adds tokens and cost to the participant's usage totals on their own: only when the final write
   * failed for good, so tokens already spent are still counted.
   */
  addUsage(participantId: string, usage: TokenUsage, nowIso: string): Promise<void>;
}

/** Hands a stored message to the AI worker: ids only, never the text. */
export interface MessageQueue {
  send(job: AiJob): Promise<void>;
}

export interface AiJob {
  participantId: string;
  messageId: string;
}

/** The queue message body as a job, or undefined when it is not one. */
export function parseJob(body: string | undefined): AiJob | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { participantId, messageId } = parsed as Record<string, unknown>;
  if (typeof participantId !== "string" || typeof messageId !== "string") return undefined;
  if (participantId === "" || messageId === "" || participantId.includes("#") || messageId.includes("#")) return undefined;
  return { participantId, messageId };
}

export function jobBody(job: AiJob): string {
  return JSON.stringify({ participantId: job.participantId, messageId: job.messageId });
}
