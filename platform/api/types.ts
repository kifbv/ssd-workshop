/**
 * Items of the single DynamoDB table `ssd-workshop-data` (ticket 1.1).
 *
 * Key scheme (string keys `pk` and `sk`; build them with keys.ts):
 *
 * | Item                 | pk                     | sk                 | Expires (TTL `expiresAt`) |
 * | -------------------- | ---------------------- | ------------------ | ------------------------- |
 * | Allow-list entry     | `EMAIL#<email>`        | `ALLOW`            | never                     |
 * | Sign-in code         | `EMAIL#<email>`        | `CODE`             | yes (10 minutes)          |
 * | Code requests        | `EMAIL#<email>`        | `CODE_REQUESTS`    | yes (1 hour after last)   |
 * | Session              | `SESSION#<token hash>` | `SESSION`          | yes (8 hours)             |
 * | Participant          | `PARTICIPANT#<id>`     | `PROFILE`          | never                     |
 * | Conversation message | `PARTICIPANT#<id>`     | `MSG#<message id>` | never                     |
 * | Usage                | `PARTICIPANT#<id>`     | `USAGE`            | never                     |
 *
 * - `<email>` is trimmed and lower-cased (`normalizeEmail`). Email addresses are
 *   personal data: they live only in `EMAIL#` keys and in `AllowListEntry.email`,
 *   and are never logged, shown to other participants or published.
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

/** The current sign-in code of one email (ticket 1.4). */
export interface CodeItem extends Keyed {
  type: "code";
  /** Hash of the 6-digit code; the code itself is never stored. */
  codeHash: string;
  /** Epoch seconds (TTL attribute). */
  expiresAt: number;
  /** Wrong tries so far; the code is burned at 5. */
  attempts: number;
  /** ISO 8601. */
  createdAt: string;
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

export type MessageAuthor = "participant" | "assistant";

/** One message of a participant's conversation with the AI (ticket 1.7). */
export interface ConversationMessage extends Keyed {
  type: "message";
  /** Time-ordered: ISO creation time first, then a random suffix. */
  id: string;
  participantId: string;
  author: MessageAuthor;
  /** The step the message belongs to. */
  step: Step;
  text: string;
  /** ISO 8601. */
  createdAt: string;
  /** Tokens and cost of the AI call that produced an assistant message. */
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** US dollars. */
  costUsd: number;
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
  | ConversationMessage
  | UsageItem;
