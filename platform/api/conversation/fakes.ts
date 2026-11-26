// In-memory stand-ins for the conversation's table, queue and model (ticket 1.7), shared by the
// tests (not bundled: no handler imports it). The table follows the DynamoDB adapter's conditions:
// a message is created only when the conversation has none in flight, and every status change
// names the status it expects and the message in flight, all or nothing.
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { FakeTable } from "../fakes.js";
import type { BudgetFacts } from "../workshop/budget.js";
import { limitsFromItem, settingsFromItem, type WorkshopSettings } from "../workshop/settings.js";
import type { BuildStatus, ConversationState, MessageStatus, ReplyKind, Step, TokenUsage } from "../types.js";
import type { Exchange } from "./answer.js";
import type { ModelClient, ModelReply, ModelRequest } from "./model.js";
import {
  finishStatus,
  STALE_PENDING_SECONDS,
  textHash,
  type AiJob,
  type ApproveResult,
  type ChangeBuildFinish,
  type ChangeRequestResult,
  type DiscardResult,
  type RebuildFinish,
  type RepositoryRead,
  REBUILD_REPLY_KINDS,
  rebuildSpent,
  rebuildStatus,
  type SuggestionsQueue,
  type BuildJob,
  type BuildQueue,
  type ConversationStore,
  type HeldJobs,
  type ParticipantInfo,
  type ReadinessFinish,
  type ReadinessRequestResult,
  type StoredBuild,
  type BuildFeedEvent,
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
  buildId?: string;
  proposedSpecVersion?: number;
  suggestions?: string[];
  suggestionsRequestedAt?: string;
}

/** A build record as the readiness check writes it (ticket 2.7). */
export interface FakeBuild {
  buildId: string;
  nickname: string;
  participantId: string;
  status: BuildStatus;
  createdAt: string;
  updatedAt: string;
  failureReasons?: string[];
  feed?: BuildFeedEvent[];
  queueKey?: string;
  /** Ticket 3.6: absent on first builds (as before 3.6). */
  kind?: "first" | "change";
  changeNumber?: number;
  specVersion?: number;
}

export interface FakeSpec {
  version: number;
  text: string;
  messageId: string;
  createdAt: string;
  approvedAt?: string;
  /** Ticket 3.9: set (instead of approvedAt) on the version Rebuild from my repository creates. */
  rebuildApprovedAt?: string;
  whatChanges?: string[];
}

type Method = keyof ConversationStore;

/** A spec version as the stores read it. */
function specOf(spec: FakeSpec): StoredSpec {
  return {
    version: spec.version,
    text: spec.text,
    createdAt: spec.createdAt,
    approved: spec.approvedAt !== undefined || spec.rebuildApprovedAt !== undefined,
    ...(spec.whatChanges === undefined ? {} : { whatChanges: [...spec.whatChanges] }),
  };
}

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
  /** Build records by build id (ticket 2.7). */
  readonly builds = new Map<string, FakeBuild>();
  /** Ticket 3.4: the waiting line (`BUILD_QUEUE`), queueKey -> when its message was last seen. */
  readonly queueEntries = new Map<string, string>();
  /** Every countQueuedAhead call (its queueKey), so a test can prove the count was never computed. */
  readonly countQueuedAheadCalls: string[] = [];
  /** The `SETTINGS` item as DynamoDB would return it (ticket 3.3 reads the budget from it); none: the defaults. */
  settingsItem: Record<string, AttributeValue> | undefined;
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

  async createMessage(participantId: string, message: NewMessage, afterBuild?: string): Promise<CreateResult> {
    this.fail("createMessage");
    const conversation = this.conversations.get(participantId);
    if (afterBuild === undefined && conversation?.approvedSpecVersion !== undefined) return "approved";
    if (afterBuild !== undefined && conversation?.buildId !== afterBuild) return conversation?.state === "waiting" ? "waiting" : "busy";
    const free =
      conversation?.pendingId === undefined ||
      (conversation.state === "open" && (conversation.pendingSince ?? 0) < message.nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return conversation?.state === "waiting" ? "waiting" : "busy";
    if (this.messagesOf(participantId).has(message.id)) throw new Error("message id taken");
    this.conversations.set(participantId, { ...conversation, state: "open", pendingId: message.id, pendingSince: message.nowSeconds });
    this.storeMessage(participantId, message);
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
      ...(m.request === undefined ? {} : { request: m.request }),
      ...(m.request === "rebuild-from-repo" && m.repository !== undefined ? { repository: { ...m.repository } } : {}),
    };
  }

  /** Ticket 3.9: what the launcher stores on a Rebuild from my repository request (DynamoLaunchRecords.storeRepositorySpec). */
  storeRepositoryRead(participantId: string, messageId: string, read: RepositoryRead): boolean {
    const message = this.messages.get(participantId)?.get(messageId);
    if (message === undefined || message.repository !== undefined) return false;
    this.messagesOf(participantId).set(messageId, { ...message, repository: { ...read } });
    return true;
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
        ...(c.buildId === undefined ? {} : { buildId: c.buildId }),
        ...(c.proposedSpecVersion === undefined ? {} : { proposedSpecVersion: c.proposedSpecVersion }),
        ...(c.suggestions === undefined ? {} : { suggestions: [...c.suggestions] }),
        ...(c.suggestionsRequestedAt === undefined ? {} : { suggestionsRequestedAt: c.suggestionsRequestedAt }),
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

    const status: MessageStatus = finishStatus(outcome.kind);
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
        kind:
          outcome.kind === "done"
            ? "answer"
            : outcome.kind === "declined"
              ? "decline"
              : outcome.kind === "over-budget"
                ? "budget"
                : outcome.kind === "over-limit"
                  ? "limit"
                  : "failure",
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
      this.conversations.set(participantId, {
        ...withoutInFlight(conversation),
        state: "open",
        ...(spec === undefined ? {} : { latestSpecVersion: spec.version }),
        ...(spec?.whatChanges === undefined ? {} : { proposedSpecVersion: spec.version }),
      });
      if (spec !== undefined) {
        this.specs.set(participantId, [
          ...specs,
          { version: spec.version, text: spec.text, messageId, createdAt: nowIso, ...(spec.whatChanges === undefined ? {} : { whatChanges: [...spec.whatChanges] }) },
        ]);
      }
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

  async moveToSpec(participantId: string, nowSeconds: number, nowIso: string): Promise<MoveResult> {
    this.fail("moveToSpec");
    const profile = this.profiles.get(participantId);
    if (profile?.step !== "clarify") return "wrong-step";
    const c = this.conversations.get(participantId);
    if (c === undefined) return "busy";
    const free = c.pendingId === undefined || (c.state === "open" && (c.pendingSince ?? 0) < nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return c.state === "waiting" ? "waiting" : "busy";
    this.profiles.set(participantId, { ...profile, step: "spec", stepSince: nowIso });
    return "moved";
  }

  async getLatestSpec(participantId: string): Promise<StoredSpec | undefined> {
    this.fail("getLatestSpec");
    const spec = this.specs.get(participantId)?.at(-1);
    return spec && specOf(spec);
  }

  async getSpec(participantId: string, version: number): Promise<StoredSpec | undefined> {
    this.fail("getSpec");
    const spec = this.specs.get(participantId)?.find((v) => v.version === version);
    return spec && specOf(spec);
  }

  async approveSpec(participantId: string, version: number, nowSeconds: number, nowIso: string, readiness: NewMessage): Promise<ApproveResult> {
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
    if (this.messagesOf(participantId).has(readiness.id)) throw new Error("message id taken");
    this.conversations.set(participantId, { ...c, state: "open", approvedSpecVersion: version, pendingId: readiness.id, pendingSince: readiness.nowSeconds });
    this.profiles.set(participantId, { ...profile, step: "approved", stepSince: nowIso });
    spec.approvedAt = nowIso;
    this.storeMessage(participantId, readiness);
    return "approved";
  }

  async requestReadiness(participantId: string, version: number, message: NewMessage): Promise<ReadinessRequestResult> {
    this.fail("requestReadiness");
    const c = this.conversations.get(participantId);
    if (c?.approvedSpecVersion !== version || c.buildId !== undefined) return "wrong-step";
    const free = c.pendingId === undefined || (c.state === "open" && (c.pendingSince ?? 0) < message.nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return "busy";
    if (this.messagesOf(participantId).has(message.id)) throw new Error("message id taken");
    this.conversations.set(participantId, { ...c, state: "open", pendingId: message.id, pendingSince: message.nowSeconds });
    this.storeMessage(participantId, message);
    return "created";
  }

  private storeMessage(participantId: string, message: NewMessage): void {
    this.messagesOf(participantId).set(message.id, {
      id: message.id,
      step: message.step,
      text: message.text,
      status: "pending",
      pendingSince: message.nowSeconds,
      createdAt: message.createdAt,
      ...(message.request === undefined ? {} : { request: message.request }),
    });
  }

  async finishReadiness(participantId: string, messageId: string, outcome: ReadinessFinish, nowIso: string): Promise<boolean> {
    this.fail("finishReadiness");
    const message = this.messages.get(participantId)?.get(messageId);
    const conversation = this.conversations.get(participantId);
    const profile = this.profiles.get(participantId);
    // The same conditions as the DynamoDB transaction, all or nothing.
    if (message?.status !== "pending" || this.repliesOf(participantId).has(messageId)) return false;
    if (conversation?.pendingId !== messageId || conversation.approvedSpecVersion !== outcome.version) return false;
    if (profile?.step !== "approved") return false;
    if (outcome.kind === "ready" && this.builds.has(outcome.build.buildId)) return false;

    const answered = outcome.kind === "ready" || outcome.kind === "not-ready";
    const answer = answered ? outcome.answer : undefined;
    this.messagesOf(participantId).set(messageId, { ...message, status: answered ? "done" : "failed" });
    this.repliesOf(participantId).set(messageId, {
      text: outcome.reply,
      kind: answered ? "answer" : outcome.kind === "over-budget" ? "budget" : "failure",
      createdAt: nowIso,
      ...(answer === undefined
        ? {}
        : { prompt: answer.prompt, modelId: answer.modelId, promptVersion: answer.promptVersion, historyCount: answer.historyCount, usage: answer.usage }),
    });
    const rest = withoutInFlight(conversation);
    if (outcome.kind === "ready") {
      this.conversations.set(participantId, { ...rest, state: "open", buildId: outcome.build.buildId });
      this.profiles.set(participantId, { ...profile, step: "building", stepSince: nowIso });
      this.builds.set(outcome.build.buildId, {
        buildId: outcome.build.buildId,
        nickname: outcome.build.nickname,
        participantId,
        status: "queued",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      delete rest.approvedSpecVersion;
      this.conversations.set(participantId, { ...rest, state: "open" });
      this.profiles.set(participantId, { ...profile, step: "spec", stepSince: nowIso });
    }
    const spent = answered ? outcome.answer.usage : outcome.usage;
    if (spent !== undefined && spent.inputTokens + spent.outputTokens > 0) this.add(participantId, spent);
    return true;
  }

  async getParticipantInfo(participantId: string): Promise<ParticipantInfo | undefined> {
    this.fail("getParticipantInfo");
    const p = this.profiles.get(participantId);
    return p && { step: p.step, ...(p.nickname === undefined ? {} : { nickname: p.nickname }) };
  }

  async getBuild(buildId: string): Promise<StoredBuild | undefined> {
    this.fail("getBuild");
    const b = this.builds.get(buildId);
    return (
      b && {
        buildId: b.buildId,
        participantId: b.participantId,
        status: b.status,
        nickname: b.nickname,
        feed: (b.feed ?? []).map((e) => ({ ...e })),
        ...(b.failureReasons === undefined ? {} : { failureReasons: [...b.failureReasons] }),
        ...(b.queueKey === undefined ? {} : { queueKey: b.queueKey }),
        kind: b.kind === "change" ? "change" : "first",
        ...(b.kind === "change" && b.changeNumber !== undefined ? { changeNumber: b.changeNumber } : {}),
      }
    );
  }

  async countQueuedAhead(queueKey: string, sinceIso: string): Promise<number> {
    this.countQueuedAheadCalls.push(queueKey);
    this.fail("countQueuedAhead");
    return [...this.queueEntries].filter(([key, seen]) => key < queueKey && seen >= sinceIso).length;
  }

  async addUsage(participantId: string, usage: TokenUsage): Promise<void> {
    this.fail("addUsage");
    if (usage.inputTokens + usage.outputTokens > 0) this.add(participantId, usage);
  }

  async getBudgetFacts(participantId: string): Promise<BudgetFacts> {
    this.fail("getBudgetFacts");
    const profile = this.profiles.get(participantId);
    const item: Record<string, AttributeValue> = {};
    if (profile?.extraBudget !== undefined) item["extraBudget"] = { N: String(profile.extraBudget) };
    if (profile?.changeRequestsUsed !== undefined) item["changeRequestsUsed"] = { N: String(profile.changeRequestsUsed) };
    return {
      settings: settingsFromItem(this.settingsItem),
      limits: limitsFromItem(item),
      spentUsd: this.usage.get(participantId)?.costUsd ?? 0,
    };
  }

  async getSettings(): Promise<WorkshopSettings> {
    this.fail("getSettings");
    return settingsFromItem(this.settingsItem);
  }

  async holdMessage(participantId: string, messageId: string, nowSeconds: number): Promise<boolean> {
    this.fail("holdMessage");
    const message = this.messages.get(participantId)?.get(messageId);
    const conversation = this.conversations.get(participantId);
    if (message?.status !== "pending" || conversation?.pendingId !== messageId || conversation.state !== "open") return false;
    this.messagesOf(participantId).set(messageId, { ...message, pendingSince: nowSeconds });
    this.conversations.set(participantId, { ...conversation, pendingSince: nowSeconds });
    return true;
  }

  async requestChangeBuild(participantId: string, version: number, buildId: string, message: NewMessage): Promise<ChangeRequestResult> {
    this.fail("requestChangeBuild");
    const c = this.conversations.get(participantId);
    if (c?.proposedSpecVersion !== version || c.buildId !== buildId) return "stale";
    const free = c.pendingId === undefined || (c.state === "open" && (c.pendingSince ?? 0) < message.nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return c.state === "waiting" ? "waiting" : "busy";
    const spec = this.specs.get(participantId)?.find((v) => v.version === version);
    if (spec === undefined) return "stale";
    if (this.messagesOf(participantId).has(message.id)) throw new Error("message id taken");
    this.conversations.set(participantId, { ...c, state: "open", pendingId: message.id, pendingSince: message.nowSeconds });
    spec.approvedAt = message.createdAt;
    this.storeMessage(participantId, message);
    return "created";
  }

  async discardChange(participantId: string, version: number, nowSeconds: number): Promise<DiscardResult> {
    this.fail("discardChange");
    const c = this.conversations.get(participantId);
    if (c?.proposedSpecVersion !== version) return "stale";
    const free = c.pendingId === undefined || (c.state === "open" && (c.pendingSince ?? 0) < nowSeconds - STALE_PENDING_SECONDS);
    if (!free) return c.state === "waiting" ? "waiting" : "busy";
    const rest = { ...c };
    delete rest.proposedSpecVersion;
    this.conversations.set(participantId, rest);
    return "discarded";
  }

  async finishChangeBuild(participantId: string, messageId: string, outcome: ChangeBuildFinish, nowIso: string): Promise<boolean> {
    this.fail("finishChangeBuild");
    const message = this.messages.get(participantId)?.get(messageId);
    const conversation = this.conversations.get(participantId);
    const profile = this.profiles.get(participantId);
    // The same conditions as the DynamoDB transaction, all or nothing.
    if (message?.status !== "pending" || this.repliesOf(participantId).has(messageId)) return false;
    if (conversation?.pendingId !== messageId || conversation.proposedSpecVersion !== outcome.version || conversation.buildId !== outcome.previousBuildId) return false;
    if (outcome.kind === "ready") {
      const used = profile?.changeRequestsUsed;
      if (profile?.step !== "building") return false;
      if (!((used === undefined && outcome.used === 0) || used === outcome.used) || outcome.used >= outcome.cap) return false;
      const previous = this.builds.get(outcome.previousBuildId)?.status;
      if (previous !== "live" && previous !== "failed") return false;
      if (this.builds.has(outcome.build.buildId)) return false;
    }
    const answered = outcome.kind === "ready" || outcome.kind === "not-ready";
    const answer = answered ? outcome.answer : undefined;
    this.messagesOf(participantId).set(messageId, { ...message, status: answered ? "done" : "failed" });
    const kinds = { ready: "answer", "not-ready": "answer", failed: "failure", "over-budget": "budget", "over-limit": "limit" } as const;
    this.repliesOf(participantId).set(messageId, {
      text: outcome.reply,
      kind: kinds[outcome.kind],
      createdAt: nowIso,
      ...(answer === undefined
        ? {}
        : { prompt: answer.prompt, modelId: answer.modelId, promptVersion: answer.promptVersion, historyCount: answer.historyCount, usage: answer.usage }),
    });
    const rest = withoutInFlight(conversation);
    if (outcome.kind === "ready" && profile !== undefined) {
      delete rest.proposedSpecVersion;
      this.conversations.set(participantId, { ...rest, state: "open", buildId: outcome.build.buildId, approvedSpecVersion: outcome.version });
      this.profiles.set(participantId, { ...profile, changeRequestsUsed: outcome.used + 1 });
      this.builds.set(outcome.build.buildId, {
        buildId: outcome.build.buildId,
        nickname: outcome.build.nickname,
        participantId,
        status: "queued",
        kind: "change",
        changeNumber: outcome.build.changeNumber,
        specVersion: outcome.version,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      this.conversations.set(participantId, { ...rest, state: "open" });
    }
    const spent = answered ? outcome.answer.usage : outcome.usage;
    if (spent !== undefined && spent.inputTokens + spent.outputTokens > 0) this.add(participantId, spent);
    return true;
  }

  async finishRebuild(participantId: string, messageId: string, outcome: RebuildFinish, nowIso: string): Promise<boolean> {
    this.fail("finishRebuild");
    const message = this.messages.get(participantId)?.get(messageId);
    const conversation = this.conversations.get(participantId);
    const profile = this.profiles.get(participantId);
    // The same conditions as the DynamoDB transaction, all or nothing.
    if (message?.status !== "pending" || this.repliesOf(participantId).has(messageId)) return false;
    if (conversation?.pendingId !== messageId || conversation.buildId !== outcome.previousBuildId) return false;
    const specs = this.specs.get(participantId) ?? [];
    if (outcome.kind === "ready") {
      const used = profile?.changeRequestsUsed;
      if (profile?.step !== "building") return false;
      if (!((used === undefined && outcome.used === 0) || used === outcome.used) || outcome.used >= outcome.cap) return false;
      const previous = this.builds.get(outcome.previousBuildId)?.status;
      if (previous !== "live" && previous !== "failed") return false;
      if (this.builds.has(outcome.build.buildId)) return false;
      if (specs.some((v) => v.version === outcome.spec.version)) return false;
    }
    const guardrail = "guardrail" in outcome ? outcome.guardrail : undefined;
    const answer = "answer" in outcome ? outcome.answer : undefined;
    this.messagesOf(participantId).set(messageId, {
      ...message,
      status: rebuildStatus(outcome.kind),
      ...(guardrail === undefined
        ? {}
        : { verdict: guardrail.verdict, verdictReason: guardrail.reason, suggestion: guardrail.suggestion, guardrailUsage: guardrail.usage }),
    });
    this.repliesOf(participantId).set(messageId, {
      text: outcome.reply,
      kind: REBUILD_REPLY_KINDS[outcome.kind],
      createdAt: nowIso,
      ...(outcome.kind === "ready" ? { specVersion: outcome.spec.version } : {}),
      ...(answer === undefined
        ? {}
        : { prompt: answer.prompt, modelId: answer.modelId, promptVersion: answer.promptVersion, historyCount: answer.historyCount, usage: answer.usage }),
    });
    const rest = withoutInFlight(conversation);
    if (outcome.kind === "ready" && profile !== undefined) {
      delete rest.proposedSpecVersion;
      const version = outcome.spec.version;
      this.specs.set(participantId, [
        ...specs,
        { version, text: outcome.spec.text, messageId, createdAt: nowIso, rebuildApprovedAt: nowIso, whatChanges: [...outcome.spec.whatChanges] },
      ]);
      this.conversations.set(participantId, { ...rest, state: "open", buildId: outcome.build.buildId, approvedSpecVersion: version, latestSpecVersion: version });
      this.profiles.set(participantId, { ...profile, changeRequestsUsed: outcome.used + 1 });
      this.builds.set(outcome.build.buildId, {
        buildId: outcome.build.buildId,
        nickname: outcome.build.nickname,
        participantId,
        status: "queued",
        kind: "change",
        changeNumber: outcome.build.changeNumber,
        specVersion: version,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      this.conversations.set(participantId, { ...rest, state: "open" });
    }
    const spent = rebuildSpent(outcome);
    if (spent !== undefined && spent.inputTokens + spent.outputTokens > 0) this.add(participantId, spent);
    return true;
  }

  async markSuggestionsRequested(participantId: string, nowIso: string, askedBeforeIso: string): Promise<boolean> {
    this.fail("markSuggestionsRequested");
    const c = this.conversations.get(participantId);
    if (c === undefined || c.suggestions !== undefined) return false;
    if (c.suggestionsRequestedAt !== undefined && !(c.suggestionsRequestedAt < askedBeforeIso)) return false;
    this.conversations.set(participantId, { ...c, suggestionsRequestedAt: nowIso });
    return true;
  }

  async storeSuggestions(participantId: string, suggestions: readonly string[], usage: TokenUsage): Promise<boolean> {
    this.fail("storeSuggestions");
    const c = this.conversations.get(participantId);
    if (c === undefined || c.suggestions !== undefined) return false;
    this.conversations.set(participantId, { ...c, suggestions: [...suggestions] });
    if (usage.inputTokens + usage.outputTokens > 0) this.add(participantId, usage);
    return true;
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

  /** A participant with a nickname at the given step, signed in with the given session token (and allow-listed). */
  addParticipant(id: string, nickname: string | undefined, token: string, expiresAt: number, step: Step = "clarify"): void {
    this.profiles.set(id, { id, role: "participant", group: "blue", step, createdAt: "x", ...(nickname === undefined ? {} : { nickname }) });
    if (nickname !== undefined) this.nicknames.set(nickname.toLowerCase(), { nickname, participantId: id });
    this.addSession(token, id, expiresAt);
  }
}

export class FakeQueue implements MessageQueue, HeldJobs, SuggestionsQueue {
  readonly sent: AiJob[] = [];
  /** Ticket 3.6: suggestions jobs (participant ids), with their delay when held. */
  readonly suggestions: { participantId: string; delaySeconds?: number }[] = [];
  /** Ticket 3.5: jobs held by the global Stop, with their delay, in order. */
  readonly later: { job: AiJob; delaySeconds: number }[] = [];
  failure: Error | undefined;

  async send(job: AiJob): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.sent.push({ ...job });
  }

  async sendLater(job: AiJob, delaySeconds: number): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.later.push({ job: { ...job }, delaySeconds });
  }

  async sendSuggestions(participantId: string, delaySeconds?: number): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.suggestions.push({ participantId, ...(delaySeconds === undefined ? {} : { delaySeconds }) });
  }
}

export class FakeBuildQueue implements BuildQueue {
  readonly sent: BuildJob[] = [];
  /** Ticket 3.9: spec-read requests (Rebuild from my repository), in order. */
  readonly specReads: AiJob[] = [];
  failure: Error | undefined;
  /** How many sends fail before it works again (undefined: every send while `failure` is set). */
  failTimes: number | undefined;

  async send(job: BuildJob): Promise<void> {
    if (this.failure !== undefined) {
      if (this.failTimes === undefined) throw this.failure;
      if (this.failTimes > 0) {
        this.failTimes--;
        throw this.failure;
      }
    }
    this.sent.push({ ...job });
  }

  async sendSpecRead(job: AiJob): Promise<void> {
    if (this.failure !== undefined && this.failTimes === undefined) throw this.failure;
    this.specReads.push({ ...job });
  }
}

/** A readiness answer as the model would give it (ticket 2.7). */
export const readinessReply = (verdict: string, reasons: string[] = [], tokens = { input: 900, output: 60 }): ModelReply => ({
  text: JSON.stringify({ verdict, reasons }),
  inputTokens: tokens.input,
  outputTokens: tokens.output,
});

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
