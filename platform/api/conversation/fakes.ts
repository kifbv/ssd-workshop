// In-memory stand-ins for the conversation's table, queue and model (ticket 1.7), shared by the
// tests (not bundled: no handler imports it). The table follows the DynamoDB adapter's conditions:
// a message is created only when the conversation has none in flight, and every status change
// names the status it expects and the message in flight, all or nothing.
import { FakeTable } from "../fakes.js";
import type { ConversationState, MessageStatus, ReplyKind, Step, TokenUsage } from "../types.js";
import type { Exchange } from "./answer.js";
import type { ModelClient, ModelReply, ModelRequest } from "./model.js";
import {
  STALE_PENDING_SECONDS,
  textHash,
  type AiJob,
  type ApproveResult,
  type ConversationStore,
  type CreateResult,
  type Finish,
  type ListedItem,
  type MessageQueue,
  type MoveResult,
  type NewMessage,
  type StoredConversation,
  type StoredMessage,
  type StoredSpec,
} from "./state.js";

export interface FakeMessage extends StoredMessage {
  createdAt: string;
  verdict?: string;
  verdictReason?: string;
  guardrailUsage?: TokenUsage;
}

export interface FakeReply {
  text: string;
  offersSpec?: boolean;
  specVersion?: number;
  kind: ReplyKind;
  createdAt: string;
  prompt?: string;
  modelId?: string;
  promptVersion?: string;
  historyCount?: number;
  usage?: TokenUsage;
}

export interface FakeConversation {
  state: ConversationState;
  pendingId?: string;
  pendingSince?: number;
  latestSpecVersion?: number;
  approvedSpecVersion?: number;
}

export interface FakeSpec {
  version: number;
  text: string;
  messageId: string;
  createdAt: string;
  approvedAt?: string;
}

type Method = keyof ConversationStore;

/** The conversation without its message in flight. */
function withoutInFlight(c: FakeConversation): FakeConversation {
  const copy = { ...c };
  delete copy.pendingId;
  delete copy.pendingSince;
  return copy;
}

export class FakeConversationTable extends FakeTable implements ConversationStore {
  /** Participant messages by participant id, then message id. */
  readonly messages = new Map<string, Map<string, FakeMessage>>();
  /** Replies by participant id, then the id of the message they answer. */
  readonly replies = new Map<string, Map<string, FakeReply>>();
  readonly conversations = new Map<string, FakeConversation>();
  readonly usage = new Map<string, TokenUsage>();
  /** Spec versions by participant id, oldest first (ticket 1.9). */
  readonly specs = new Map<string, FakeSpec[]>();
  conversationFailOn: Method | undefined;
  /** How many calls of `conversationFailOn` fail before it works again (undefined: every call). */
  conversationFailTimes: number | undefined;

  private fail(method: Method): void {
    if (this.conversationFailOn !== method) return;
    if (this.conversationFailTimes !== undefined) {
      if (this.conversationFailTimes <= 0) return;
      this.conversationFailTimes--;
    }
    throw Object.assign(new Error("table down"), { name: "InternalServerError" });
  }

  private messagesOf(participantId: string): Map<string, FakeMessage> {
    let map = this.messages.get(participantId);
    if (map === undefined) this.messages.set(participantId, (map = new Map()));
    return map;
  }

  private repliesOf(participantId: string): Map<string, FakeReply> {
    let map = this.replies.get(participantId);
    if (map === undefined) this.replies.set(participantId, (map = new Map()));
    return map;
  }

  async createMessage(participantId: string, message: NewMessage): Promise<CreateResult> {
    this.fail("createMessage");
    const conversation = this.conversations.get(participantId);
    if (conversation?.approvedSpecVersion !== undefined) return "approved";
    const free =
      conversation?.pendingId === undefined ||
      (conversation.state === "open" && (conversation.pendingSince ?? 0) < message.nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return conversation?.state === "waiting" ? "waiting" : "busy";
    if (this.messagesOf(participantId).has(message.id)) throw new Error("message id taken");
    this.conversations.set(participantId, { ...conversation, state: "open", pendingId: message.id, pendingSince: message.nowSeconds });
    this.messagesOf(participantId).set(message.id, {
      id: message.id,
      step: message.step,
      text: message.text,
      status: "pending",
      pendingSince: message.nowSeconds,
      createdAt: message.createdAt,
    });
    return "created";
  }

  async getMessage(participantId: string, messageId: string): Promise<StoredMessage | undefined> {
    this.fail("getMessage");
    const m = this.messages.get(participantId)?.get(messageId);
    if (m === undefined) return undefined;
    return {
      id: m.id,
      step: m.step,
      text: m.text,
      status: m.status,
      pendingSince: m.pendingSince,
      ...(m.approvedTextHash === undefined ? {} : { approvedTextHash: m.approvedTextHash }),
      ...(m.suggestion === undefined ? {} : { suggestion: m.suggestion }),
      ...(m.verdictReason === undefined ? {} : { verdictReason: m.verdictReason }),
    };
  }

  async getReplyText(participantId: string, messageId: string): Promise<string | undefined> {
    this.fail("getReplyText");
    return this.replies.get(participantId)?.get(messageId)?.text;
  }

  async getConversation(participantId: string): Promise<StoredConversation | undefined> {
    this.fail("getConversation");
    const c = this.conversations.get(participantId);
    return (
      c && {
        state: c.state,
        ...(c.pendingId === undefined ? {} : { pendingId: c.pendingId }),
        ...(c.latestSpecVersion === undefined ? {} : { latestSpecVersion: c.latestSpecVersion }),
        ...(c.approvedSpecVersion === undefined ? {} : { approvedSpecVersion: c.approvedSpecVersion }),
      }
    );
  }

  async getHistory(participantId: string, beforeMessageId: string): Promise<Exchange[]> {
    this.fail("getHistory");
    const replies = this.replies.get(participantId) ?? new Map<string, FakeReply>();
    return [...(this.messages.get(participantId)?.values() ?? [])]
      .filter((m) => m.id < beforeMessageId && m.status === "done" && replies.get(m.id)?.kind === "answer")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((m) => ({ question: m.text, answer: replies.get(m.id)?.text ?? "" }));
  }

  async finish(participantId: string, messageId: string, outcome: Finish, from: "pending" | "flagged", nowIso: string): Promise<boolean> {
    this.fail("finish");
    const message = this.messages.get(participantId)?.get(messageId);
    const conversation = this.conversations.get(participantId);
    if (message === undefined || message.status !== from || conversation?.pendingId !== messageId) return false;
    if (outcome.kind !== "flagged" && this.repliesOf(participantId).has(messageId)) return false;
    const spec = outcome.kind === "done" ? outcome.spec : undefined;
    const specs = this.specs.get(participantId) ?? [];
    if (spec !== undefined && specs.some((v) => v.version === spec.version)) return false;

    const status: MessageStatus = outcome.kind;
    const guardrail = outcome.guardrail;
    this.messagesOf(participantId).set(messageId, {
      ...message,
      status,
      ...(guardrail === undefined
        ? {}
        : { verdict: guardrail.verdict, verdictReason: guardrail.reason, suggestion: guardrail.suggestion, guardrailUsage: guardrail.usage }),
    });
    if (outcome.kind === "flagged") {
      this.conversations.set(participantId, { ...conversation, state: "waiting" });
    } else {
      const answer = outcome.kind === "done" ? outcome.answer : undefined;
      this.repliesOf(participantId).set(messageId, {
        text: outcome.reply,
        ...(outcome.kind === "done" && outcome.offersSpec === true ? { offersSpec: true } : {}),
        ...(spec === undefined ? {} : { specVersion: spec.version }),
        kind: outcome.kind === "done" ? "answer" : outcome.kind === "declined" ? "decline" : "failure",
        createdAt: nowIso,
        ...(answer === undefined
          ? {}
          : {
              prompt: answer.prompt,
              modelId: answer.modelId,
              promptVersion: answer.promptVersion,
              historyCount: answer.historyCount,
              usage: answer.usage,
            }),
      });
      this.conversations.set(participantId, { ...withoutInFlight(conversation), state: "open", ...(spec === undefined ? {} : { latestSpecVersion: spec.version }) });
      if (spec !== undefined) this.specs.set(participantId, [...specs, { version: spec.version, text: spec.text, messageId, createdAt: nowIso }]);
    }
    for (const u of [guardrail?.usage, outcome.kind === "done" ? outcome.answer.usage : undefined]) {
      if (u !== undefined) this.add(participantId, u);
    }
    return true;
  }

  async listItems(participantId: string, limit: number): Promise<ListedItem[]> {
    this.fail("listItems");
    const replies = this.replies.get(participantId) ?? new Map<string, FakeReply>();
    const items: { sk: string; item: ListedItem }[] = [];
    for (const m of this.messages.get(participantId)?.values() ?? []) {
      items.push({ sk: m.id, item: { author: "participant", id: m.id, step: m.step, text: m.text, status: m.status, pendingSince: m.pendingSince } });
      const r = replies.get(m.id);
      if (r !== undefined) {
        items.push({
          sk: `${m.id}-r`,
          item: { author: "assistant", replyTo: m.id, text: r.text, offersSpec: r.offersSpec === true, ...(r.specVersion === undefined ? {} : { specVersion: r.specVersion }) },
        });
      }
    }
    return items
      .sort((a, b) => (a.sk < b.sk ? -1 : 1))
      .slice(-limit)
      .map((i) => i.item);
  }

  async moveToSpec(participantId: string, nowSeconds: number): Promise<MoveResult> {
    this.fail("moveToSpec");
    const profile = this.profiles.get(participantId);
    if (profile?.step !== "clarify") return "wrong-step";
    const c = this.conversations.get(participantId);
    if (c === undefined) return "busy";
    const free = c.pendingId === undefined || (c.state === "open" && (c.pendingSince ?? 0) < nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return c.state === "waiting" ? "waiting" : "busy";
    this.profiles.set(participantId, { ...profile, step: "spec" });
    return "moved";
  }

  async getLatestSpec(participantId: string): Promise<StoredSpec | undefined> {
    this.fail("getLatestSpec");
    const spec = this.specs.get(participantId)?.at(-1);
    return spec && { version: spec.version, text: spec.text, createdAt: spec.createdAt, approved: spec.approvedAt !== undefined };
  }

  async getSpec(participantId: string, version: number): Promise<StoredSpec | undefined> {
    this.fail("getSpec");
    const spec = this.specs.get(participantId)?.find((v) => v.version === version);
    return spec && { version: spec.version, text: spec.text, createdAt: spec.createdAt, approved: spec.approvedAt !== undefined };
  }

  async approveSpec(participantId: string, version: number, nowSeconds: number, nowIso: string): Promise<ApproveResult> {
    this.fail("approveSpec");
    const profile = this.profiles.get(participantId);
    if (profile?.step !== "spec") return "wrong-step";
    const c = this.conversations.get(participantId);
    if (c?.latestSpecVersion === undefined) return "no-spec";
    if (c.latestSpecVersion !== version) return "stale";
    if (c.approvedSpecVersion !== undefined) return "busy";
    const free = c.pendingId === undefined || (c.state === "open" && (c.pendingSince ?? 0) < nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return c.state === "waiting" ? "waiting" : "busy";
    const spec = this.specs.get(participantId)?.find((v) => v.version === version);
    if (spec === undefined) return "no-spec";
    this.conversations.set(participantId, { ...withoutInFlight(c), approvedSpecVersion: version });
    this.profiles.set(participantId, { ...profile, step: "approved" });
    spec.approvedAt = nowIso;
    return "approved";
  }

  async addUsage(participantId: string, usage: TokenUsage): Promise<void> {
    this.fail("addUsage");
    if (usage.inputTokens + usage.outputTokens > 0) this.add(participantId, usage);
  }

  private add(participantId: string, u: TokenUsage): void {
    const total = this.usage.get(participantId) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.usage.set(participantId, {
      inputTokens: total.inputTokens + u.inputTokens,
      outputTokens: total.outputTokens + u.outputTokens,
      costUsd: total.costUsd + u.costUsd,
    });
  }

  /** Like the flags command's approval: the flagged message goes back to pending, approved for its text. */
  async approve(participantId: string, messageId: string, text: string, nowSeconds: number): Promise<boolean> {
    this.fail("finish");
    const message = this.messages.get(participantId)?.get(messageId);
    const conversation = this.conversations.get(participantId);
    if (message?.status !== "flagged" || conversation?.state !== "waiting" || conversation.pendingId !== messageId) return false;
    this.messagesOf(participantId).set(messageId, { ...message, status: "pending", approvedTextHash: textHash(text), pendingSince: nowSeconds });
    this.conversations.set(participantId, { ...conversation, state: "open", pendingId: messageId, pendingSince: nowSeconds });
    return true;
  }

  async findParticipantId(nickname: string): Promise<string | undefined> {
    return this.nicknames.get(nickname.toLowerCase())?.participantId;
  }

  async getNickname(participantId: string): Promise<string | undefined> {
    return this.profiles.get(participantId)?.nickname;
  }

  async listWaiting(): Promise<string[]> {
    return [...this.conversations.entries()].filter(([, c]) => c.state === "waiting").map(([id]) => id);
  }

  /** A participant with a nickname at the given step, signed in with the given token hash. */
  addParticipant(id: string, nickname: string | undefined, tokenHash: string, expiresAt: number, step: Step = "clarify"): void {
    this.profiles.set(id, { id, role: "participant", group: "blue", step, createdAt: "x", ...(nickname === undefined ? {} : { nickname }) });
    if (nickname !== undefined) this.nicknames.set(nickname.toLowerCase(), { nickname, participantId: id });
    this.sessions.set(tokenHash, { participantId: id, expiresAt, createdAt: "x" });
  }
}

export class FakeQueue implements MessageQueue {
  readonly sent: AiJob[] = [];
  failure: Error | undefined;

  async send(job: AiJob): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.sent.push({ ...job });
  }
}

/** A scripted model: answers in order from `replies` (an Error is thrown), recording every request. */
export class FakeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly replies: (ModelReply | Error | ((request: ModelRequest) => ModelReply))[] = []) {}

  push(...replies: (ModelReply | Error | ((request: ModelRequest) => ModelReply))[]): void {
    this.replies.push(...replies);
  }

  async converse(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    this.requests.push(request);
    if (signal?.aborted === true) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const next = this.replies.shift();
    if (next === undefined) throw new Error("unexpected model call");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(request) : next;
  }
}

/** A guardrail answer as the classifier would give it. */
export const verdictReply = (verdict: string, suggestion = "", reason = "r", tokens = { input: 400, output: 30 }): ModelReply => ({
  text: JSON.stringify({ verdict, reason, suggestion }),
  inputTokens: tokens.input,
  outputTokens: tokens.output,
});
