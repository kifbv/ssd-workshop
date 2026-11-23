/**
 * Items of the single DynamoDB table `ssd-workshop-data` (ticket 1.1).
 *
 * Key scheme (string keys `pk` and `sk`; build them with keys.ts):
 *
 * | Item                 | pk                     | sk                   | Expires (TTL `expiresAt`) |
 * | -------------------- | ---------------------- | -------------------- | ------------------------- |
 * | Allow-list entry     | `EMAIL#<email>`        | `ALLOW`              | never                     |
 * | Sign-in codes        | `EMAIL#<email>`        | `CODE`               | yes (latest code expiry)  |
 * | Code requests        | `EMAIL#<email>`        | `CODE_REQUESTS`      | yes (1 hour after last)   |
 * | Session              | `SESSION#<token hash>` | `SESSION`            | yes (8 hours)             |
 * | Participant          | `PARTICIPANT#<id>`     | `PROFILE`            | never                     |
 * | Conversation message | `PARTICIPANT#<id>`     | `MSG#<message id>`   | never                     |
 * | Assistant reply      | `PARTICIPANT#<id>`     | `MSG#<message id>-r` | never                     |
 * | Conversation state   | `PARTICIPANT#<id>`     | `CONVERSATION`       | never                     |
 * | Usage                | `PARTICIPANT#<id>`     | `USAGE`              | never                     |
 * | Nickname claim       | `NICK#<nickname>`      | `NICK`               | never                     |
 *
 * - `<email>` is trimmed and lower-cased (`normalizeEmail`). Email addresses are
 *   personal data: they live only in `EMAIL#` keys and in `AllowListEntry.email`,
 *   and are never logged, shown to other participants or published.
 * - `<nickname>` in a `NICK#` key is lower-cased, so a nickname is unique regardless of case.
 * - A participant's profile, conversation and usage share one partition, so every
 *   read by a participant names their own id and cannot reach another's items.
 * - Message ids sort by time (they start with the ISO creation time), so a query on
 *   `begins_with(sk, "MSG#")` returns the conversation in order, and a message is
 *   read with one GetItem on (participant id, message id).
 * - Codes and session tokens are stored only as hashes. `expiresAt` is in epoch
 *   seconds; DynamoDB deletes expired items within a few days, so readers still
 *   compare `expiresAt` with the clock.
 *
 * Later tickets add fields and item types as they need them (and a line in
 * docs/decisions.md).
 */

export type Role = "participant" | "facilitator" | "admin";

/** Where a participant is in the workshop (phase 1 covers clarify and spec). */
export type Step = "nickname" | "clarify" | "spec" | "approved";

interface Keyed {
  pk: string;
  sk: string;
}

/** Who may sign in (ticket 1.3). */
export interface AllowListEntry extends Keyed {
  type: "allow";
  /** Trimmed and lower-cased. Personal data: never logged or shown to others. */
  email: string;
  group: string;
  role: Role;
  /** Set once the person has signed in and has a participant record. */
  participantId?: string;
  /** ISO 8601. */
  createdAt: string;
}

/** One code sent by email (ticket 1.4). */
export interface CodeEntry {
  /** Hash of the 6-digit code; the code itself is never stored. */
  codeHash: string;
  /** Epoch seconds: the code is valid until then (10 minutes). */
  expiresAt: number;
}

/**
 * The live sign-in codes of one email (ticket 1.4). A new code does not cancel the earlier ones:
 * every unexpired code stays valid (at most 5; expired ones are pruned on write), so a stranger
 * asking for a code cannot cancel the one a participant is typing.
 */
export interface CodeItem extends Keyed {
  type: "code";
  /** Unexpired codes, oldest first, at most 5. */
  codes: CodeEntry[];
  /** Wrong tries so far, shared by all the codes; the whole item is burned at 5 (ticket 1.5). */
  attempts: number;
  /** Bumped on every write; a write names the version it read (two writers cannot lose a code). */
  version: number;
  /** Epoch seconds (TTL attribute): the latest code's expiry. */
  expiresAt: number;
}

/**
 * When codes were sent to one allow-listed email in the last hour (ticket 1.4): at most 5.
 * Only written for allow-listed emails, so no stranger's address is ever stored.
 */
export interface CodeRequestsItem extends Keyed {
  type: "code-requests";
  /** Epoch seconds of each code sent within the last hour, oldest first. */
  sentAt: number[];
  /** Bumped on every write; a write names the version it read (two requests at once cannot both pass). */
  version: number;
  /** Epoch seconds (TTL attribute): one hour after the newest send. */
  expiresAt: number;
}

/** A signed-in browser (ticket 1.5). */
export interface SessionItem extends Keyed {
  type: "session";
  /** Hash of the cookie's token; the token itself is never stored. */
  tokenHash: string;
  participantId: string;
  /** Epoch seconds (TTL attribute). */
  expiresAt: number;
  /** ISO 8601. */
  createdAt: string;
}

/** A person taking the workshop, facilitators and admins included (ticket 1.5). */
export interface Participant extends Keyed {
  type: "participant";
  id: string;
  /** 3 to 20 letters, digits or dashes; unique regardless of case. Unset until chosen. */
  nickname?: string;
  role: Role;
  group: string;
  step: Step;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * The claim on a nickname (ticket 1.5), keyed by its lower-cased form, so a nickname is unique
 * regardless of case. Written in one transaction with the participant's nickname.
 */
export interface NicknameClaim extends Keyed {
  type: "nick";
  /** As the participant typed it. */
  nickname: string;
  participantId: string;
  /** ISO 8601. */
  createdAt: string;
}

export type MessageAuthor = "participant" | "assistant";

/**
 * Where a participant message is (ticket 1.7): `pending` until the AI worker is done, then `done`
 * (answered), `declined` (off the workshop's path, or rejected by a facilitator), `flagged`
 * (waiting for a facilitator) or `failed` (the AI call failed; the participant can send again).
 */
export type MessageStatus = "pending" | "done" | "declined" | "flagged" | "failed";

/** The guardrail check's verdict on a participant message (ticket 1.7). */
export type GuardrailVerdict = "on-path" | "decline" | "flag";

/** Tokens and US dollars of one or more AI calls. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** US dollars. */
  costUsd: number;
}

/**
 * A message the participant sent (ticket 1.7), at `MSG#<message id>`. The id and the participant
 * id are read from the keys (not stored twice). The guardrail call's tokens and cost are kept here;
 * the answer call's are on the reply.
 */
export interface ParticipantMessageItem extends Keyed {
  type: "message";
  author: "participant";
  /** The step the message belongs to. */
  step: Step;
  text: string;
  status: MessageStatus;
  /** ISO 8601. */
  createdAt: string;
  /** Epoch seconds when it (last) became pending: a pending message older than 20 minutes counts as failed. */
  pendingSince: number;
  /**
   * Set by a facilitator's approval of a flagged message: the SHA-256 (hex) of the approved text. The
   * worker answers without a new check only while the text still has this hash. No Lambda role may
   * write it (only the flags command, with the owner's credentials).
   */
  approvedTextHash?: string;
  verdict?: GuardrailVerdict;
  /** The guardrail's short reason (for facilitators; never logged). */
  verdictReason?: string;
  /** The guardrail's in-scope suggestion, used in a decline. */
  suggestion?: string;
  guardrailInputTokens?: number;
  guardrailOutputTokens?: number;
  guardrailCostUsd?: number;
}

/** How a reply came about: an AI answer, a decline, or the neutral failure text. */
export type ReplyKind = "answer" | "decline" | "failure";

/**
 * The assistant's reply to one participant message (ticket 1.7), at `MSG#<message id>-r`, so it
 * sorts right after the message. An `answer` also stores what was sent to the model and the answer
 * call's tokens and cost.
 */
export interface AssistantMessageItem extends Keyed {
  type: "message";
  author: "assistant";
  /** The step is the message's (the reply sorts right after it), so it is not stored twice. */
  text: string;
  kind: ReplyKind;
  /** The participant message this answers. */
  replyTo: string;
  /** Set (true) on an answer in which the AI offered to write the spec (ticket 1.8). */
  offersSpec?: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** The participant's text as sent to the model (answers only). */
  prompt?: string;
  modelId?: string;
  /** Version of the system prompt (answers only), e.g. `clarify-v1`. */
  promptVersion?: string;
  /** Earlier messages sent along as context (answers only). */
  historyCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type ConversationMessage = ParticipantMessageItem | AssistantMessageItem;

/**
 * `open`, or `waiting` for a facilitator's decision on a flagged message (ticket 1.7). The page
 * shows `waiting` as "waiting for your facilitator".
 */
export type ConversationState = "open" | "waiting";

/**
 * A participant's conversation (ticket 1.7), at `CONVERSATION`: its state and the one message in
 * flight (pending or flagged). Written only with conditions, so two sends at once cannot both pass.
 */
export interface ConversationItem extends Keyed {
  type: "conversation";
  state: ConversationState;
  /** The message in flight; absent when none. */
  pendingId?: string;
  /** Epoch seconds: when `pendingId` (last) became pending. */
  pendingSince?: number;
  /** ISO 8601. */
  updatedAt: string;
}

/** Running totals of a participant's AI use (ticket 1.7; the $5 cap is phase 3). */
export interface UsageItem extends Keyed, TokenUsage {
  type: "usage";
  participantId: string;
  /** ISO 8601. */
  updatedAt: string;
}

export type TableItem =
  | AllowListEntry
  | CodeItem
  | CodeRequestsItem
  | SessionItem
  | Participant
  | NicknameClaim
  | ConversationMessage
  | ConversationItem
  | UsageItem;
