// The conversation's records and the store interface shared by the API routes, the AI worker and
// the flags command (ticket 1.7). The DynamoDB adapter is ./store.ts; tests use ./fakes.ts.
import { createHash } from "node:crypto";
import type { BuildItem, BuildStatus, ConversationState, GuardrailVerdict, MessageStatus, Step, TokenUsage } from "../types.js";
import type { BudgetFacts } from "../workshop/budget.js";
import type { WorkshopSettings } from "../workshop/settings.js";
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
  /**
   * Ticket 3.6: set (only by Build this change) on the request that runs the change's readiness check. Ticket 3.9:
   * `rebuild-from-repo`, set only by Rebuild from my repository.
   */
  request?: PlatformRequest;
  /**
   * Ticket 3.9: on a Rebuild from my repository request, what the launcher read of `SPEC.md` on `main`
   * (`repositoryRead`, and `repositorySpec` for a found file: attributes only the launcher may write).
   */
  repository?: RepositoryRead;
}

/** Ticket 3.9: the marks only the platform's own routes put on a message (a participant's message never has one). */
export type PlatformRequest = "change-build" | "rebuild-from-repo";

/**
 * Ticket 3.9: what the launcher found in the participant's repository for a Rebuild from my repository request: the
 * cleaned text (`found`, with the name of the repository it was read from, which the worker checks against the
 * profile's), or why there is none (`github-error`: GitHub or the App's key could not be used).
 */
export type RepositoryRead =
  | { kind: "found"; text: string; repository: string }
  | { kind: "missing" | "too-large" | "unreadable" | "empty" | "github-error" };

export const REPOSITORY_READ_KINDS = ["found", "missing", "too-large", "unreadable", "empty", "github-error"] as const;

export interface StoredConversation {
  state: ConversationState;
  pendingId?: string;
  /** The newest spec version (ticket 1.9). */
  latestSpecVersion?: number;
  /** The approved spec version (ticket 1.9): no more messages once set. */
  approvedSpecVersion?: number;
  /** The build the readiness check started (ticket 2.7), or the newest change build (ticket 3.6). */
  buildId?: string;
  /** Ticket 3.6: the version a change answer proposed, not yet built or put aside. */
  proposedSpecVersion?: number;
  /** Ticket 3.6: the three suggested changes, once written. */
  suggestions?: string[];
  /** Ticket 3.6: when the suggestions were last asked for (ISO 8601). */
  suggestionsRequestedAt?: string;
}

/** One version of a participant's spec (ticket 1.9). */
export interface StoredSpec {
  version: number;
  text: string;
  /** ISO 8601. */
  createdAt: string;
  approved: boolean;
  /** Ticket 3.6: a proposed change's "What changes" list. */
  whatChanges?: string[];
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

/**
 * How a message ends (or, for `flagged`, pauses). `over-budget` (ticket 3.3): the participant's AI budget is used, so
 * the (next) AI call was not made; the message ends `failed` (they can send again once a facilitator added budget)
 * with the budget text as a reply of kind `budget`.
 */
export type Finish =
  | { kind: "done"; reply: string; answer: AnswerRecord; guardrail?: GuardrailRecord; offersSpec?: boolean; spec?: NewSpec }
  | { kind: "declined"; reply: string; guardrail?: GuardrailRecord }
  | { kind: "failed"; reply: string; guardrail?: GuardrailRecord }
  | { kind: "over-budget"; reply: string; guardrail?: GuardrailRecord }
  /** Ticket 3.6: every change request is used; no AI call was made (reply kind `limit`, message `failed`). */
  | { kind: "over-limit"; reply: string; guardrail?: undefined }
  | { kind: "flagged"; guardrail: GuardrailRecord };

/**
 * The message status each way of ending stores (`over-budget` and `over-limit` end as `failed`: the participant may send
 * again once a facilitator added budget, or the admin raised the cap).
 */
export function finishStatus(kind: Finish["kind"]): MessageStatus {
  return kind === "over-budget" || kind === "over-limit" ? "failed" : kind;
}

/** A new spec version an answer made (ticket 1.9), stored with the answer in one transaction. */
export interface NewSpec {
  version: number;
  text: string;
  /**
   * Ticket 3.6: a change answer's "What changes" list. Its presence makes the version the conversation's proposed one
   * (`proposedSpecVersion`), waiting for Build this change or Not this one.
   */
  whatChanges?: string[];
}

export interface NewMessage {
  id: string;
  step: Step;
  text: string;
  /** ISO 8601. */
  createdAt: string;
  /** Epoch seconds. */
  nowSeconds: number;
  /** Ticket 3.6: only Build this change's own request carries it (ticket 3.9: or Rebuild from my repository's). */
  request?: PlatformRequest;
}

/** `approved`: the participant approved their spec, so no message is taken any more (ticket 1.9). */
export type CreateResult = "created" | "busy" | "waiting" | "approved";

/**
 * One item of the conversation as the history route reads it (ticket 1.8), oldest first: a
 * participant message (with its status and when it became pending) or a reply (`replyTo` set).
 */
export type ListedItem =
  | { author: "participant"; id: string; step: Step; text: string; status: MessageStatus; pendingSince: number }
  | { author: "assistant"; replyTo: string; text: string; offersSpec: boolean; specVersion?: number };

/** Items read for the page's history (ticket 1.8): the last 50 messages and replies. */
export const HISTORY_PAGE_LIMIT = 50;

export type MoveResult = "moved" | "busy" | "waiting" | "wrong-step";

/** How an approval ends (ticket 1.9). */
export type ApproveResult = "approved" | "busy" | "waiting" | "wrong-step" | "stale" | "no-spec";

/**
 * The table, as the conversation needs it. Every write that changes a message's status names the
 * status it expects and the conversation's message in flight, all in one transaction, so a message
 * delivered twice (SQS is at-least-once) or decided twice is handled once.
 */
export interface ConversationStore {
  /**
   * Stores a pending message and makes it the conversation's message in flight, only if none is
   * (a stale pending one does not count); otherwise `busy`, or `waiting` for a facilitator.
   * Ticket 3.6: with `afterBuild` (a change request at step 4) only while the conversation's build is still that one,
   * instead of only while no spec is approved (`busy` when it moved on).
   */
  createMessage(participantId: string, message: NewMessage, afterBuild?: string): Promise<CreateResult>;
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
  /** The last `limit` messages and replies, oldest first (ticket 1.8). */
  listItems(participantId: string, limit: number): Promise<ListedItem[]>;
  /**
   * Moves the participant from step 1 (clarify) to step 2 (spec), only while the profile is at
   * clarify and the conversation exists with no message in flight (a stale pending one does not
   * count), in one transaction (ticket 1.8). Otherwise `busy`, `waiting`, or `wrong-step`.
   */
  moveToSpec(participantId: string, nowSeconds: number, nowIso: string): Promise<MoveResult>;
  /** The newest version of the participant's spec (ticket 1.9). */
  getLatestSpec(participantId: string): Promise<StoredSpec | undefined>;
  /** One version of the participant's spec (ticket 1.9). */
  getSpec(participantId: string, version: number): Promise<StoredSpec | undefined>;
  /**
   * Approves version `version` (ticket 1.9), in one transaction: the profile's step from spec to
   * approved, the conversation's `approvedSpecVersion` (only while that version is the newest, none
   * was approved and no message is in flight; a stale pending one is let go), and `approvedAt` on the
   * version. Otherwise `wrong-step`, `stale` (a newer version exists), `no-spec`, `busy` or `waiting`.
   */
  approveSpec(participantId: string, version: number, nowSeconds: number, nowIso: string, readiness: NewMessage): Promise<ApproveResult>;
  /**
   * Ticket 2.7: the approval also stores the readiness request (`readiness`, a pending message at step
   * `approved` with READINESS_REQUEST as its text) as the conversation's message in flight, in the same
   * transaction. `requestReadiness` stores a new one for a participant still at step approved with that
   * version approved and nothing in flight (a stale pending one is let go): an approval from before 2.7, or
   * a check whose worker never finished. Otherwise `busy`, or `wrong-step`.
   */
  requestReadiness(participantId: string, version: number, message: NewMessage): Promise<ReadinessRequestResult>;
  /**
   * Ends the readiness message (ticket 2.7), only while it is pending, the conversation's message in flight
   * with `version` approved, and the profile at step approved: the message's status (done, or failed), the
   * reply, the conversation (no message in flight; `ready`: the build id; otherwise the approval removed),
   * the profile's step (building, or spec), `ready`: the new build record (only if absent), and the tokens.
   * False when a condition failed (nothing written).
   */
  finishReadiness(participantId: string, messageId: string, outcome: ReadinessFinish, nowIso: string): Promise<boolean>;
  /** The profile's step and nickname (ticket 2.7). */
  getParticipantInfo(participantId: string): Promise<ParticipantInfo | undefined>;
  /** A build (ticket 2.7), or undefined; the caller checks it belongs to the participant asking. */
  getBuild(buildId: string): Promise<StoredBuild | undefined>;
  /**
   * Ticket 3.4: how many queued builds wait ahead of the place `queueKey` (entries seen at or after `sinceIso`), a count
   * only (../build/slots.ts countQueuedAhead).
   */
  countQueuedAhead(queueKey: string, sinceIso: string): Promise<number>;
  /**
   * Adds tokens and cost to the participant's usage totals on their own: only when the final write
   * failed for good, so tokens already spent are still counted.
   */
  addUsage(participantId: string, usage: TokenUsage, nowIso: string): Promise<void>;
  /**
   * Ticket 3.3: what the AI budget check reads, all consistent: the workshop settings, the participant's own limit
   * fields (`extraBudget`) and their spend so far (`costUsd` of their `USAGE` item; none yet reads as 0).
   */
  getBudgetFacts(participantId: string): Promise<BudgetFacts>;
  /** Ticket 3.5: the workshop settings (consistent read), for the global Stop's `paused` on the page's reads. */
  getSettings(): Promise<WorkshopSettings>;
  /**
   * Ticket 3.5: while the global Stop is on, the AI worker holds a pending message instead of answering it: its
   * `pendingSince` and the conversation's are set to now (so a long Stop never makes it stale), in one transaction,
   * only while it is still pending and the conversation's message in flight. False when not (nothing written).
   */
  holdMessage(participantId: string, messageId: string, nowSeconds: number): Promise<boolean>;
  /**
   * Ticket 3.6, Build this change: stores the request (`message`, CHANGE_BUILD_REQUEST at step building, marked
   * `change-build`) as the conversation's message in flight and marks the version approved (`approvedAt`), in one
   * transaction, only while `version` is the proposed one, the conversation's build is still `buildId` and nothing is in
   * flight (a stale pending message is let go). Otherwise `stale` (no longer the proposal or the build moved), `busy` or
   * `waiting`.
   */
  requestChangeBuild(participantId: string, version: number, buildId: string, message: NewMessage): Promise<ChangeRequestResult>;
  /**
   * Ticket 3.6, Not this one: removes the proposal, only while `version` is the proposed one and nothing is in flight
   * (a stale pending message does not count). The version's item stays as history; nothing counts.
   */
  discardChange(participantId: string, version: number, nowSeconds: number, nowIso: string): Promise<DiscardResult>;
  /**
   * Ticket 3.6: ends the change-build request, only while it is pending and in flight, `version` still the proposed one
   * and the conversation's build still `previousBuildId` (the profile at step building): the message, the reply, the
   * conversation (no message in flight; `ready`: the new build id, `approvedSpecVersion` = version, the proposal
   * removed), and the tokens. `ready` also, in the same transaction: the previous build must be `live` or `failed`
   * (nothing of theirs running), the new build (kind `change`, its change number and spec version, only if absent) and
   * the profile's `changeRequestsUsed` from `used` to `used + 1`, only while it is `used` and below `cap`.
   * False when a condition failed (nothing written).
   */
  finishChangeBuild(participantId: string, messageId: string, outcome: ChangeBuildFinish, nowIso: string): Promise<boolean>;
  /**
   * Ticket 3.9: ends a Rebuild from my repository request, only while it is pending and in flight and the conversation's
   * build is still `previousBuildId`: the message (with the guardrail's result, when it ran), the reply, the conversation
   * (no message in flight) and the tokens. `ready` also, in the same transaction and like finishChangeBuild's: the
   * repository's spec as the next version (only if absent, approved, with its "What changes" line), the conversation's
   * `latestSpecVersion`, `approvedSpecVersion` and `buildId` set and any open proposal removed, the previous build
   * `live` or `failed`, the new change build (only if absent), and `changeRequestsUsed` from `used` to `used + 1` below
   * `cap`. False when a condition failed (nothing written).
   */
  finishRebuild(participantId: string, messageId: string, outcome: RebuildFinish, nowIso: string): Promise<boolean>;
  /**
   * Ticket 3.6: notes that the suggestions were asked for (`suggestionsRequestedAt` = now), only while none are stored
   * and they were not asked for since `askedBeforeIso`. False when not (nothing written).
   */
  markSuggestionsRequested(participantId: string, nowIso: string, askedBeforeIso: string): Promise<boolean>;
  /** Ticket 3.6: stores the suggestions once (only if none are stored) with their tokens. False when some were already there. */
  storeSuggestions(participantId: string, suggestions: readonly string[], usage: TokenUsage, nowIso: string): Promise<boolean>;
}

/** Ticket 3.6: `requestChangeBuild`'s outcomes. */
export type ChangeRequestResult = "created" | "stale" | "busy" | "waiting";
/** Ticket 3.6: `discardChange`'s outcomes. */
export type DiscardResult = "discarded" | "stale" | "busy" | "waiting";

/**
 * Ticket 3.6: how a change-build request ends. `ready` queues the change build (and counts the change); the others keep
 * the proposal, so the participant can ask for a fix or press Build this change again.
 */
export type ChangeBuildFinish =
  | {
      kind: "ready";
      reply: string;
      version: number;
      previousBuildId: string;
      answer: AnswerRecord;
      build: { buildId: string; nickname: string; changeNumber: number };
      /** `changeRequestsUsed` as read (the write requires it unchanged) and the cap it must stay below. */
      used: number;
      cap: number;
    }
  | { kind: "not-ready"; reply: string; version: number; previousBuildId: string; answer: AnswerRecord }
  | { kind: "failed" | "over-budget" | "over-limit"; reply: string; version: number; previousBuildId: string; usage?: TokenUsage };

/**
 * Ticket 3.9: how a Rebuild from my repository request ends. `ready` stores the repository's spec as a new version and
 * queues a change build (counting the change); `unchanged` (the same spec), `refused` (no readable SPEC.md),
 * `declined` (the guardrail), `not-ready` (the readiness check) and the failures change nothing else.
 */
export type RebuildFinish =
  | {
      kind: "ready";
      reply: string;
      previousBuildId: string;
      spec: { version: number; text: string; whatChanges: string[] };
      guardrail: GuardrailRecord;
      answer: AnswerRecord;
      build: { buildId: string; nickname: string; changeNumber: number };
      used: number;
      cap: number;
    }
  | { kind: "not-ready"; reply: string; previousBuildId: string; guardrail: GuardrailRecord; answer: AnswerRecord }
  | { kind: "declined"; reply: string; previousBuildId: string; guardrail: GuardrailRecord }
  | { kind: "unchanged" | "refused"; reply: string; previousBuildId: string }
  | { kind: "failed" | "over-budget" | "over-limit"; reply: string; previousBuildId: string; guardrail?: GuardrailRecord; usage?: TokenUsage };

/** Ticket 3.9: the message status each way of ending a rebuild request stores. */
export function rebuildStatus(kind: RebuildFinish["kind"]): MessageStatus {
  if (kind === "declined") return "declined";
  return kind === "failed" || kind === "over-budget" || kind === "over-limit" ? "failed" : "done";
}

/** Ticket 3.9: the reply kind of each way of ending a rebuild request. */
export const REBUILD_REPLY_KINDS = {
  ready: "answer",
  "not-ready": "answer",
  unchanged: "answer",
  refused: "answer",
  declined: "decline",
  failed: "failure",
  "over-budget": "budget",
  "over-limit": "limit",
} as const;

/** Ticket 3.9: the tokens a rebuild outcome carries (the guardrail's and the readiness check's, or what was spent). */
export function rebuildSpent(outcome: RebuildFinish): TokenUsage | undefined {
  const parts: (TokenUsage | undefined)[] = [];
  if ("guardrail" in outcome) parts.push(outcome.guardrail?.usage);
  if ("answer" in outcome) parts.push(outcome.answer.usage);
  if ("usage" in outcome) parts.push(outcome.usage);
  const present = parts.filter((u): u is TokenUsage => u !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd }));
}

/** What the AI worker reads of a profile for the readiness check (ticket 2.7). */
export interface ParticipantInfo {
  step: Step;
  /** As the participant typed it: the build record keeps it exactly so (the deployer compares it exactly). */
  nickname?: string;
}

/** One event of a build's live feed (ticket 2.8 writes it, 2.10's step 3 page shows it). */
export type BuildFeedEvent = NonNullable<BuildItem["feed"]>[number];

/** A build as `GET /api/build` reads it (ticket 2.7; ticket 2.10 adds the nickname and the feed). */
export interface StoredBuild {
  buildId: string;
  participantId: string;
  status: BuildStatus;
  /** As the participant typed it (the repository and the app's address are named after it, lower-cased). */
  nickname?: string;
  /** Oldest first; only well-formed events (see `readFeed` in ./store.ts). */
  feed?: BuildFeedEvent[];
  failureReasons?: string[];
  /** Ticket 3.4: its place in the waiting line, once the launcher saw it queued. */
  queueKey?: string;
  /** Ticket 3.6: `first` (also when absent) or `change`. */
  kind: "first" | "change";
  /** Ticket 3.6, change builds: which change it is. */
  changeNumber?: number;
}

/**
 * How the readiness check ends (ticket 2.7), stored in one transaction with the reply and the tokens:
 * `ready` moves the step to building and creates the build; `not-ready` and `failed` go back to step 2 with
 * the approval cleared, so the participant can approve again.
 */
export type ReadinessFinish =
  | { kind: "ready"; reply: string; version: number; answer: AnswerRecord; build: { buildId: string; nickname: string } }
  | { kind: "not-ready"; reply: string; version: number; answer: AnswerRecord }
  | { kind: "failed"; reply: string; version: number; usage?: TokenUsage }
  /** Ticket 3.3: the AI budget is used, so no check (or no build): back to step 2 like `failed`, with the budget text. */
  | { kind: "over-budget"; reply: string; version: number; usage?: TokenUsage };

/** The build a readiness message starts: its id is made from the message id, so one approval can only ever make one build. */
export function buildIdFor(messageId: string): string {
  const id = messageId.replace(/[^A-Za-z0-9_-]/g, "-");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("message id makes no build id");
  return id;
}

/** `requestReadiness`: the check was asked for again, or something is still in flight. */
export type ReadinessRequestResult = "created" | "busy" | "wrong-step";

/** Hands a stored message to the AI worker: ids only, never the text. */
export interface MessageQueue {
  send(job: AiJob): Promise<void>;
}

export interface AiJob {
  participantId: string;
  messageId: string;
}

/**
 * Ticket 3.5: how long a job held by the global Stop waits before the AI worker sees it again. Resume is answered within
 * about this long; while Stop stays on, each held job costs one short worker run per this many seconds.
 */
export const STOP_HOLD_SECONDS = 30;

/** Ticket 3.5: the AI worker's own queue, for a job held by the global Stop (a new message, delivered after a delay). */
export interface HeldJobs {
  sendLater(job: AiJob, delaySeconds: number): Promise<void>;
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

/**
 * Ticket 3.6: the job that asks the AI worker for a participant's suggested changes (no message: the participant id
 * alone, and the mark), sent by the conversation function once the app is live, and by the worker to itself while the
 * global Stop holds it.
 */
export interface SuggestionsQueue {
  sendSuggestions(participantId: string, delaySeconds?: number): Promise<void>;
}

export function suggestionsJobBody(participantId: string): string {
  return JSON.stringify({ participantId, suggestions: true });
}

/** The participant id of a suggestions job body, or undefined when the body is not one. */
export function parseSuggestionsJob(body: string | undefined): string | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { participantId, suggestions, messageId } = parsed as Record<string, unknown>;
  if (suggestions !== true || messageId !== undefined || typeof participantId !== "string" || participantId === "" || participantId.includes("#")) return undefined;
  return participantId;
}

/** Hands a build to the build launcher (ticket 2.7; consumed from ticket 2.9): the build id only. */
export interface BuildQueue {
  /** `participantId` groups one participant's launches (FIFO message group); the body holds only the build id. */
  send(job: BuildJob): Promise<void>;
  /**
   * Ticket 3.9: asks the launcher (the one holder of the GitHub App's key) to read `SPEC.md` for a Rebuild from my
   * repository request; it stores what it found on the message and hands the job back to the AI worker.
   */
  sendSpecRead(job: AiJob): Promise<void>;
}

export interface BuildJob {
  buildId: string;
  participantId: string;
}

/** The launch message body: exactly `{"buildId": "<id>"}`. */
export function buildJobBody(job: BuildJob): string {
  return JSON.stringify({ buildId: job.buildId });
}

/** Ticket 3.9: the launch queue's spec-read message body: exactly `{"readSpec": {"participantId", "messageId"}}`. */
export function specReadJobBody(job: AiJob): string {
  return JSON.stringify({ readSpec: { participantId: job.participantId, messageId: job.messageId } });
}

/** Ticket 3.9: the job of a spec-read message body (exactly that shape, ids as parseJob takes them), else undefined. */
export function parseSpecReadJob(body: string | undefined): AiJob | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).join() !== "readSpec") return undefined;
  const inner = (parsed as { readSpec: unknown }).readSpec;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner) || Object.keys(inner).sort().join() !== "messageId,participantId") return undefined;
  return parseJob(JSON.stringify(inner));
}
