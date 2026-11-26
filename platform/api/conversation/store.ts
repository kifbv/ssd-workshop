// The conversation's table access (ticket 1.7). The calls stay thin; the rules live in
// ./conversation.ts, ./worker.ts and ./state.ts.
//
// Every write is an UpdateItem (inside a transaction where several items change together), never a
// PutItem: the functions' roles (infra/lib/api-stack.ts) may update only listed attribute names in
// `PARTICIPANT#*`, so they can never replace or empty another item of the partition. The lists are
// CONVERSATION_UPDATE_ATTRIBUTES and AI_WORKER_UPDATE_ATTRIBUTES in infra/lib/config.ts (tested). Every step change
// also sets the profile's `stepSince` to the same time, in the same update (ticket 3.2).
import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  buildKey,
  BUILD_ID_PATTERN,
  conversationKey,
  MESSAGE_PREFIX,
  messageKey,
  participantKey,
  replyId,
  REPLY_SUFFIX,
  SPEC_PREFIX,
  specKey,
  usageKey,
  type ItemKey,
} from "../keys.js";
import { isStep } from "../session/session.js";
import type { BuildStatus, ConversationState, MessageStatus, TokenUsage } from "../types.js";
import type { BudgetFacts } from "../workshop/budget.js";
import { limitsFromItem, type WorkshopSettings } from "../workshop/settings.js";
import { readSettings } from "../workshop/store.js";
import { countQueuedAhead } from "../build/slots.js";
import type { Exchange } from "./answer.js";
import { addUsage } from "./model.js";
import {
  finishStatus,
  STALE_PENDING_SECONDS,
  type ConversationStore,
  type CreateResult,
  type Finish,
  type ApproveResult,
  type ListedItem,
  type MoveResult,
  type StoredSpec,
  type NewMessage,
  type StoredConversation,
  type StoredMessage,
  type ParticipantInfo,
  type ReadinessFinish,
  type ReadinessRequestResult,
  type StoredBuild,
  type BuildFeedEvent,
  type ChangeBuildFinish,
  type ChangeRequestResult,
  type DiscardResult,
  type RebuildFinish,
  type RepositoryRead,
  REBUILD_REPLY_KINDS,
  REPOSITORY_READ_KINDS,
  rebuildSpent,
  rebuildStatus,
} from "./state.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface ConversationSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

const STATUSES: readonly MessageStatus[] = ["pending", "done", "declined", "flagged", "failed"];
const isStatus = (v: unknown): v is MessageStatus => typeof v === "string" && (STATUSES as string[]).includes(v);

/** Items read for the history: enough for 20 messages even with declines and failures between. */
export const HISTORY_READ_LIMIT = 30;

/** True when DynamoDB cancelled the transaction because a condition failed. */
export function conditionFailed(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code === "ConditionalCheckFailed");
}

/** An UpdateItem that sets (and removes, adds) the given attributes, names and values made from their names, under an optional condition. */
export function setItem(
  tableName: string,
  key: ItemKey,
  values: Record<string, AttributeValue>,
  condition: { expression: string; names?: Record<string, string>; values?: Record<string, AttributeValue> } | undefined,
  extra: { remove?: string[]; add?: Record<string, AttributeValue> } = {},
): TransactWriteItem {
  const names: Record<string, string> = { ...condition?.names };
  const exprValues: Record<string, AttributeValue> = { ...condition?.values };
  const sets = Object.entries(values).map(([name, value]) => {
    names[`#${name}`] = name;
    exprValues[`:${name}`] = value;
    return `#${name} = :${name}`;
  });
  const adds = Object.entries(extra.add ?? {}).map(([name, value]) => {
    names[`#${name}`] = name;
    exprValues[`:add_${name}`] = value;
    return `#${name} :add_${name}`;
  });
  for (const name of extra.remove ?? []) names[`#${name}`] = name;
  const parts = [
    sets.length > 0 ? `SET ${sets.join(", ")}` : "",
    (extra.remove ?? []).length > 0 ? `REMOVE ${(extra.remove ?? []).map((n) => `#${n}`).join(", ")}` : "",
    adds.length > 0 ? `ADD ${adds.join(", ")}` : "",
  ].filter((p) => p !== "");
  return {
    Update: {
      TableName: tableName,
      Key: keyOf(key),
      UpdateExpression: parts.join(" "),
      ...(condition === undefined ? {} : { ConditionExpression: condition.expression }),
      ExpressionAttributeNames: names,
      ...(Object.keys(exprValues).length > 0 ? { ExpressionAttributeValues: exprValues } : {}),
    },
  };
}

/** A spec version number read from an item (a whole number from 1), or undefined. */
function versionOf(value: AttributeValue | undefined): number | undefined {
  const n = Number(value?.N);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

const SPEC_NAMES = {
  "#pk": "pk",
  "#sk": "sk",
  "#specVersion": "specVersion",
  "#text": "text",
  "#createdAt": "createdAt",
  "#approvedAt": "approvedAt",
  "#whatChanges": "whatChanges",
};
const SPEC_PROJECTION = "#sk, #specVersion, #text, #createdAt, #approvedAt, #whatChanges";

/** A list of strings as stored (`L` of `S`), keeping only the strings. */
function stringList(value: AttributeValue | undefined): string[] | undefined {
  return value?.L?.flatMap((v) => (v.S === undefined ? [] : [v.S]));
}

const strList = (values: readonly string[]): AttributeValue => ({ L: values.map((v) => ({ S: v })) });

/** A spec version from its item: only with `specVersion`, which no role but the AI worker's may write. */
function specOf(item: Record<string, AttributeValue> | undefined): StoredSpec | undefined {
  const version = versionOf(item?.["specVersion"]);
  const text = item?.["text"]?.S;
  if (item === undefined || version === undefined || text === undefined || !(item["sk"]?.S ?? "").startsWith(SPEC_PREFIX)) return undefined;
  const whatChanges = stringList(item["whatChanges"]);
  return {
    version,
    text,
    createdAt: item["createdAt"]?.S ?? "",
    approved: item["approvedAt"]?.S !== undefined,
    ...(whatChanges === undefined ? {} : { whatChanges }),
  };
}

/**
 * Ticket 3.9: what the launcher stored on a Rebuild from my repository request (`repositoryRead`, and `repositorySpec`
 * for a found file), or undefined while it has not read yet (or the values are not ones it writes).
 */
function repositoryReadOf(item: Record<string, AttributeValue>): RepositoryRead | undefined {
  const kind = item["repositoryRead"]?.S;
  if (kind === "found") {
    const text = item["repositorySpec"]?.S;
    return text === undefined ? undefined : { kind, text };
  }
  return kind !== undefined && (REPOSITORY_READ_KINDS as readonly string[]).includes(kind) ? { kind: kind as Exclude<RepositoryRead["kind"], "found"> } : undefined;
}

const BUILD_STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];
const isBuildStatus = (v: unknown): v is BuildStatus => typeof v === "string" && (BUILD_STATUSES as string[]).includes(v);

type FeedStep = Extract<BuildFeedEvent, { kind: "step" }>["step"];
const FEED_STEPS: readonly FeedStep[] = ["preparing", "writing", "checking", "committing", "deploying"];
const isFeedStep = (v: string | undefined): v is FeedStep => (FEED_STEPS as readonly (string | undefined)[]).includes(v);
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * A build's feed as stored (ticket 2.8) in the shape the step 3 page reads (ticket 2.10), oldest first. Only
 * well-formed events pass: a known step, a file path or a host as a string, a commit whose id is 40 hex
 * characters (the page puts it into a link); anything else is left out. Paths and hosts are anyone's text: the
 * page shows them with `textContent` only.
 */
export function readFeed(list: readonly AttributeValue[] | undefined): BuildFeedEvent[] {
  const events: BuildFeedEvent[] = [];
  for (const value of list ?? []) {
    const m = value.M;
    const kind = m?.["kind"]?.S;
    const at = m?.["at"]?.S;
    if (m === undefined || at === undefined) continue;
    if (kind === "step") {
      const step = m["step"]?.S;
      if (isFeedStep(step)) events.push({ kind, step, at });
    } else if (kind === "file") {
      const path = m["path"]?.S;
      if (path !== undefined) events.push({ kind, path, at });
    } else if (kind === "fetch") {
      const host = m["host"]?.S;
      if (host !== undefined) events.push({ kind, host, at });
    } else if (kind === "commit") {
      const sha = m["sha"]?.S;
      const message = m["message"]?.S;
      if (sha !== undefined && COMMIT_SHA.test(sha) && message !== undefined) events.push({ kind, sha, message, at });
    }
  }
  return events;
}

const REPLY_KINDS = { done: "answer", declined: "decline", failed: "failure", "over-budget": "budget", "over-limit": "limit" } as const;

/** Ticket 3.6: the reply kind of a change-build request's outcome. */
const CHANGE_REPLY_KINDS = { ready: "answer", "not-ready": "answer", failed: "failure", "over-budget": "budget", "over-limit": "limit" } as const;

export class DynamoConversationStore implements ConversationStore {
  constructor(
    private readonly client: ConversationSender,
    private readonly tableName: string,
  ) {}

  async createMessage(participantId: string, message: NewMessage, afterBuild?: string): Promise<CreateResult> {
    // Ticket 3.6: a change request is taken only while the conversation's build is still the one the route saw (live,
    // or a change build that failed); before it (steps 1 and 2), only while no spec is approved.
    const freeOf = "(attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))";
    const guard =
      afterBuild === undefined
        ? { expression: `attribute_not_exists(#approvedSpecVersion) AND ${freeOf}`, names: { "#approvedSpecVersion": "approvedSpecVersion" }, values: {} }
        : { expression: `#buildId = :afterBuild AND ${freeOf}`, names: { "#buildId": "buildId" }, values: { ":afterBuild": str(afterBuild) } };
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(
              this.tableName,
              conversationKey(participantId),
              {
                type: str("conversation"),
                state: str("open"),
                pendingId: str(message.id),
                pendingSince: num(message.nowSeconds),
                updatedAt: str(message.createdAt),
              },
              {
                // No message in flight, or only a stale pending one (a flagged one never goes stale), and
                // no approved spec (ticket 1.9: changes are closed once it is approved), or (ticket 3.6) still the build
                // the change request was sent after.
                expression: guard.expression,
                names: guard.names,
                values: { ...guard.values, ":open": str("open"), ":staleBefore": num(message.nowSeconds - STALE_PENDING_SECONDS) },
              },
            ),
            setItem(
              this.tableName,
              messageKey(participantId, message.id),
              {
                type: str("message"),
                author: str("participant"),
                step: str(message.step),
                text: str(message.text),
                status: str("pending"),
                createdAt: str(message.createdAt),
                pendingSince: num(message.nowSeconds),
                // Ticket 3.9: Rebuild from my repository's request carries its mark.
                ...(message.request === undefined ? {} : { request: str(message.request) }),
              },
              { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
            ),
          ],
        }),
      );
      return "created";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const conversation = await this.getConversation(participantId);
      if (afterBuild === undefined && conversation?.approvedSpecVersion !== undefined) return "approved";
      return conversation?.state === "waiting" ? "waiting" : "busy";
    }
  }

  async getMessage(participantId: string, messageId: string): Promise<StoredMessage | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(messageKey(participantId, messageId)), ConsistentRead: true }),
    );
    const item = output.Item;
    const step = item?.["step"]?.S;
    const status = item?.["status"]?.S;
    const text = item?.["text"]?.S;
    const pendingSince = Number(item?.["pendingSince"]?.N);
    if (item?.["author"]?.S !== "participant" || !isStep(step) || !isStatus(status) || text === undefined || !Number.isFinite(pendingSince)) {
      return undefined;
    }
    const suggestion = item["suggestion"]?.S;
    const verdictReason = item["verdictReason"]?.S;
    const approvedTextHash = item["approvedTextHash"]?.S;
    const request = item["request"]?.S;
    const repository = request === "rebuild-from-repo" ? repositoryReadOf(item) : undefined;
    return {
      id: messageId,
      step,
      text,
      status,
      pendingSince,
      ...(approvedTextHash === undefined ? {} : { approvedTextHash }),
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(verdictReason === undefined ? {} : { verdictReason }),
      ...(request === "change-build" || request === "rebuild-from-repo" ? { request } : {}),
      ...(repository === undefined ? {} : { repository }),
    };
  }

  async getReplyText(participantId: string, messageId: string): Promise<string | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(messageKey(participantId, replyId(messageId))),
        ConsistentRead: true,
        ProjectionExpression: "#text, #author",
        ExpressionAttributeNames: { "#text": "text", "#author": "author" },
      }),
    );
    return output.Item?.["author"]?.S === "assistant" ? output.Item["text"]?.S : undefined;
  }

  async getConversation(participantId: string): Promise<StoredConversation | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(conversationKey(participantId)), ConsistentRead: true }),
    );
    const state = output.Item?.["state"]?.S;
    if (state !== "open" && state !== "waiting") return undefined;
    const pendingId = output.Item?.["pendingId"]?.S;
    const latestSpecVersion = versionOf(output.Item?.["latestSpecVersion"]);
    const approvedSpecVersion = versionOf(output.Item?.["approvedSpecVersion"]);
    const buildId = output.Item?.["buildId"]?.S;
    const proposedSpecVersion = versionOf(output.Item?.["proposedSpecVersion"]);
    const suggestions = stringList(output.Item?.["suggestions"]);
    const suggestionsRequestedAt = output.Item?.["suggestionsRequestedAt"]?.S;
    return {
      state: state as ConversationState,
      ...(pendingId === undefined ? {} : { pendingId }),
      ...(latestSpecVersion === undefined ? {} : { latestSpecVersion }),
      ...(approvedSpecVersion === undefined ? {} : { approvedSpecVersion }),
      ...(buildId !== undefined && BUILD_ID_PATTERN.test(buildId) ? { buildId } : {}),
      ...(proposedSpecVersion === undefined ? {} : { proposedSpecVersion }),
      ...(suggestions === undefined ? {} : { suggestions }),
      ...(suggestionsRequestedAt === undefined ? {} : { suggestionsRequestedAt }),
    };
  }

  async getHistory(participantId: string, beforeMessageId: string): Promise<Exchange[]> {
    const key = messageKey(participantId, beforeMessageId);
    const output = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        // Newest first, from the messages before this one (`MSG#` sorts before every message id).
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#author": "author", "#text": "text", "#status": "status", "#kind": "kind" },
        ExpressionAttributeValues: { ":pk": str(key.pk), ":from": str(MESSAGE_PREFIX), ":to": str(key.sk) },
        ProjectionExpression: "#sk, #author, #text, #status, #kind",
        ScanIndexForward: false,
        Limit: HISTORY_READ_LIMIT,
      }),
    );
    const items = (output.Items ?? []).filter((i) => i["sk"]?.S !== key.sk);
    const answers = new Map<string, string>();
    for (const i of items) {
      const sk = i["sk"]?.S ?? "";
      if (i["author"]?.S === "assistant" && i["kind"]?.S === "answer" && sk.endsWith(REPLY_SUFFIX)) {
        answers.set(sk.slice(MESSAGE_PREFIX.length, -REPLY_SUFFIX.length), i["text"]?.S ?? "");
      }
    }
    const exchanges: Exchange[] = [];
    for (const i of items) {
      const id = (i["sk"]?.S ?? "").slice(MESSAGE_PREFIX.length);
      const answer = answers.get(id);
      const question = i["text"]?.S;
      if (i["author"]?.S === "participant" && i["status"]?.S === "done" && answer !== undefined && question !== undefined) {
        exchanges.push({ question, answer });
      }
    }
    return exchanges.reverse();
  }

  async listItems(participantId: string, limit: number): Promise<ListedItem[]> {
    const pk = conversationKey(participantId).pk;
    const output = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        // Newest first, then turned around: the last `limit` messages and replies, oldest first.
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#author": "author",
          "#text": "text",
          "#status": "status",
          "#pendingSince": "pendingSince",
          "#offersSpec": "offersSpec",
          "#step": "step",
          "#specVersion": "specVersion",
        },
        ExpressionAttributeValues: { ":pk": str(pk), ":prefix": str(MESSAGE_PREFIX) },
        ProjectionExpression: "#sk, #author, #text, #status, #pendingSince, #offersSpec, #step, #specVersion",
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const items: ListedItem[] = [];
    for (const i of output.Items ?? []) {
      const sk = i["sk"]?.S ?? "";
      const text = i["text"]?.S;
      if (!sk.startsWith(MESSAGE_PREFIX) || text === undefined) continue;
      const id = sk.slice(MESSAGE_PREFIX.length);
      const author = i["author"]?.S;
      if (author === "assistant" && id.endsWith(REPLY_SUFFIX)) {
        const specVersion = versionOf(i["specVersion"]);
        items.push({
          author,
          replyTo: id.slice(0, -REPLY_SUFFIX.length),
          text,
          offersSpec: i["offersSpec"]?.BOOL === true,
          ...(specVersion === undefined ? {} : { specVersion }),
        });
      } else if (author === "participant") {
        const status = i["status"]?.S;
        const step = i["step"]?.S;
        const pendingSince = Number(i["pendingSince"]?.N);
        if (isStatus(status) && isStep(step) && Number.isFinite(pendingSince)) items.push({ author, id, step, text, status, pendingSince });
      }
    }
    return items.reverse();
  }

  async moveToSpec(participantId: string, nowSeconds: number, nowIso: string): Promise<MoveResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(this.tableName, participantKey(participantId), { step: str("spec"), stepSince: str(nowIso) }, {
              expression: "#step = :clarify",
              values: { ":clarify": str("clarify") },
            }),
            setItem(this.tableName, conversationKey(participantId), { updatedAt: str(nowIso) }, {
              // The conversation exists and has no message in flight (or only a stale pending one).
              expression: "attribute_exists(#pk) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
              names: { "#pk": "pk", "#pendingId": "pendingId", "#state": "state", "#pendingSince": "pendingSince" },
              values: { ":open": str("open"), ":staleBefore": num(nowSeconds - STALE_PENDING_SECONDS) },
            }),
          ],
        }),
      );
      return "moved";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
      if (reasons[0]?.Code === "ConditionalCheckFailed") return "wrong-step";
      const conversation = await this.getConversation(participantId);
      return conversation?.state === "waiting" ? "waiting" : "busy";
    }
  }

  async getLatestSpec(participantId: string): Promise<StoredSpec | undefined> {
    const pk = conversationKey(participantId).pk;
    const output = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        // The newest version sorts last (4-digit version numbers).
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: SPEC_NAMES,
        ExpressionAttributeValues: { ":pk": str(pk), ":prefix": str(SPEC_PREFIX) },
        ProjectionExpression: SPEC_PROJECTION,
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }),
    );
    return specOf(output.Items?.[0]);
  }

  async getSpec(participantId: string, version: number): Promise<StoredSpec | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(specKey(participantId, version)),
        ConsistentRead: true,
        ProjectionExpression: SPEC_PROJECTION,
        ExpressionAttributeNames: {
          "#sk": "sk",
          "#specVersion": "specVersion",
          "#text": "text",
          "#createdAt": "createdAt",
          "#approvedAt": "approvedAt",
          "#whatChanges": "whatChanges",
        },
      }),
    );
    const spec = specOf(output.Item);
    return spec?.version === version ? spec : undefined;
  }

  async approveSpec(participantId: string, version: number, nowSeconds: number, nowIso: string, readiness: NewMessage): Promise<ApproveResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(this.tableName, participantKey(participantId), { step: str("approved"), stepSince: str(nowIso) }, {
              expression: "#step = :spec",
              values: { ":spec": str("spec") },
            }),
            setItem(
              this.tableName,
              conversationKey(participantId),
              {
                approvedSpecVersion: num(version),
                state: str("open"),
                // Ticket 2.7: the readiness request becomes the message in flight (a stale pending message is
                // let go: its late answer can no longer land, since pendingId changes).
                pendingId: str(readiness.id),
                pendingSince: num(readiness.nowSeconds),
                updatedAt: str(nowIso),
              },
              {
                // This version is the newest, none was approved, and nothing is in flight.
                expression:
                  "#latestSpecVersion = :version AND attribute_not_exists(#approvedSpecVersion) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
                names: { "#latestSpecVersion": "latestSpecVersion" },
                values: { ":version": num(version), ":open": str("open"), ":staleBefore": num(nowSeconds - STALE_PENDING_SECONDS) },
              },
            ),
            setItem(this.tableName, specKey(participantId, version), { approvedAt: str(nowIso) }, {
              expression: "attribute_exists(#pk)",
              names: { "#pk": "pk" },
            }),
            this.newMessageItem(participantId, readiness),
          ],
        }),
      );
      return "approved";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
      if (reasons[0]?.Code === "ConditionalCheckFailed") return "wrong-step";
      const conversation = await this.getConversation(participantId);
      if (conversation?.latestSpecVersion === undefined) return "no-spec";
      if (conversation.latestSpecVersion !== version) return "stale";
      if (conversation.state === "waiting") return "waiting";
      return "busy";
    }
  }

  async requestReadiness(participantId: string, version: number, message: NewMessage): Promise<ReadinessRequestResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(
              this.tableName,
              conversationKey(participantId),
              { state: str("open"), pendingId: str(message.id), pendingSince: num(message.nowSeconds), updatedAt: str(message.createdAt) },
              {
                // Still this approval, no build yet, and nothing in flight (or only a stale pending message).
                expression:
                  "#approvedSpecVersion = :version AND attribute_not_exists(#buildId) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
                names: { "#approvedSpecVersion": "approvedSpecVersion", "#buildId": "buildId" },
                values: { ":version": num(version), ":open": str("open"), ":staleBefore": num(message.nowSeconds - STALE_PENDING_SECONDS) },
              },
            ),
            this.newMessageItem(participantId, message),
          ],
        }),
      );
      return "created";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const conversation = await this.getConversation(participantId);
      return conversation?.approvedSpecVersion !== version || conversation.buildId !== undefined ? "wrong-step" : "busy";
    }
  }

  /** A new pending participant message, only if its key is free. */
  private newMessageItem(participantId: string, message: NewMessage): TransactWriteItem {
    return setItem(
      this.tableName,
      messageKey(participantId, message.id),
      {
        type: str("message"),
        author: str("participant"),
        step: str(message.step),
        text: str(message.text),
        status: str("pending"),
        createdAt: str(message.createdAt),
        pendingSince: num(message.nowSeconds),
        ...(message.request === undefined ? {} : { request: str(message.request) }),
      },
      { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
    );
  }

  async finishReadiness(participantId: string, messageId: string, outcome: ReadinessFinish, nowIso: string): Promise<boolean> {
    const ready = outcome.kind === "ready";
    const answered = outcome.kind === "ready" || outcome.kind === "not-ready";
    const answer = answered ? outcome.answer : undefined;
    const items: TransactWriteItem[] = [
      setItem(this.tableName, messageKey(participantId, messageId), { status: str(answered ? "done" : "failed") }, {
        expression: "#status = :pending",
        values: { ":pending": str("pending") },
      }),
      setItem(
        this.tableName,
        messageKey(participantId, replyId(messageId)),
        {
          type: str("message"),
          author: str("assistant"),
          text: str(outcome.reply),
          kind: str(answered ? "answer" : outcome.kind === "over-budget" ? "budget" : "failure"),
          replyTo: str(messageId),
          createdAt: str(nowIso),
          ...(answer === undefined
            ? {}
            : {
                prompt: str(answer.prompt),
                modelId: str(answer.modelId),
                promptVersion: str(answer.promptVersion),
                historyCount: num(answer.historyCount),
                inputTokens: num(answer.usage.inputTokens),
                outputTokens: num(answer.usage.outputTokens),
                costUsd: num(answer.usage.costUsd),
              }),
        },
        { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
      ),
      setItem(
        this.tableName,
        conversationKey(participantId),
        { state: str("open"), updatedAt: str(nowIso), ...(ready ? { buildId: str(outcome.build.buildId) } : {}) },
        {
          expression: "#pendingId = :messageId AND #approvedSpecVersion = :version",
          names: { "#pendingId": "pendingId", "#approvedSpecVersion": "approvedSpecVersion" },
          values: { ":messageId": str(messageId), ":version": num(outcome.version) },
        },
        // Not ready (or no verdict): the approval is cleared, so Approve spec works again.
        { remove: ready ? ["pendingId", "pendingSince"] : ["pendingId", "pendingSince", "approvedSpecVersion"] },
      ),
      setItem(this.tableName, participantKey(participantId), { step: str(ready ? "building" : "spec"), stepSince: str(nowIso) }, {
        expression: "#step = :approved",
        values: { ":approved": str("approved") },
      }),
    ];
    if (ready) {
      items.push(
        setItem(
          this.tableName,
          buildKey(outcome.build.buildId),
          {
            type: str("build"),
            buildId: str(outcome.build.buildId),
            nickname: str(outcome.build.nickname),
            participantId: str(participantId),
            status: str("queued"),
            createdAt: str(nowIso),
            updatedAt: str(nowIso),
          },
          { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
        ),
      );
    }
    const spent = answered ? outcome.answer.usage : outcome.usage;
    if (spent !== undefined && spent.inputTokens + spent.outputTokens > 0) items.push(this.usageItem(participantId, spent, nowIso));
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async getParticipantInfo(participantId: string): Promise<ParticipantInfo | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(participantKey(participantId)),
        ConsistentRead: true,
        ProjectionExpression: "#step, #nickname",
        ExpressionAttributeNames: { "#step": "step", "#nickname": "nickname" },
      }),
    );
    const step = output.Item?.["step"]?.S;
    const nickname = output.Item?.["nickname"]?.S;
    if (!isStep(step)) return undefined;
    return { step, ...(nickname === undefined ? {} : { nickname }) };
  }

  async getBuild(buildId: string): Promise<StoredBuild | undefined> {
    if (!BUILD_ID_PATTERN.test(buildId)) return undefined;
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(buildKey(buildId)),
        ConsistentRead: true,
        ProjectionExpression: "#type, #buildId, #participantId, #status, #failureReasons, #nickname, #feed, #queueKey, #kind, #changeNumber",
        ExpressionAttributeNames: {
          "#type": "type",
          "#buildId": "buildId",
          "#participantId": "participantId",
          "#status": "status",
          "#failureReasons": "failureReasons",
          "#nickname": "nickname",
          "#feed": "feed",
          "#queueKey": "queueKey",
          "#kind": "kind",
          "#changeNumber": "changeNumber",
        },
      }),
    );
    const item = output.Item;
    const participantId = item?.["participantId"]?.S;
    const status = item?.["status"]?.S;
    if (item?.["type"]?.S !== "build" || item["buildId"]?.S !== buildId || participantId === undefined || !isBuildStatus(status)) return undefined;
    const reasons = item["failureReasons"]?.L?.flatMap((r) => (r.S === undefined ? [] : [r.S]));
    const nickname = item["nickname"]?.S;
    const queueKey = item["queueKey"]?.S;
    const changeNumber = Number(item["changeNumber"]?.N);
    // Ticket 3.6: a build without a kind (every build from before 3.6) is a first build.
    const kind = item["kind"]?.S === "change" ? "change" : "first";
    return {
      buildId,
      participantId,
      status,
      kind,
      ...(kind === "change" && Number.isInteger(changeNumber) && changeNumber >= 1 ? { changeNumber } : {}),
      ...(nickname === undefined ? {} : { nickname }),
      feed: readFeed(item["feed"]?.L),
      ...(reasons === undefined ? {} : { failureReasons: reasons }),
      ...(queueKey === undefined ? {} : { queueKey }),
    };
  }

  countQueuedAhead(queueKey: string, sinceIso: string): Promise<number> {
    return countQueuedAhead(this.client, this.tableName, queueKey, sinceIso);
  }

  async finish(participantId: string, messageId: string, outcome: Finish, from: "pending" | "flagged", nowIso: string): Promise<boolean> {
    const guardrail = outcome.guardrail;
    const spec = outcome.kind === "done" ? outcome.spec : undefined;
    const items: TransactWriteItem[] = [
      setItem(
        this.tableName,
        messageKey(participantId, messageId),
        {
          status: str(finishStatus(outcome.kind)),
          ...(guardrail === undefined
            ? {}
            : {
                verdict: str(guardrail.verdict),
                verdictReason: str(guardrail.reason),
                suggestion: str(guardrail.suggestion),
                guardrailInputTokens: num(guardrail.usage.inputTokens),
                guardrailOutputTokens: num(guardrail.usage.outputTokens),
                guardrailCostUsd: num(guardrail.usage.costUsd),
              }),
        },
        { expression: "#status = :from", values: { ":from": str(from) } },
      ),
    ];
    const inFlight = { expression: "#pendingId = :messageId", names: { "#pendingId": "pendingId" }, values: { ":messageId": str(messageId) } };
    if (outcome.kind === "flagged") {
      items.push(setItem(this.tableName, conversationKey(participantId), { state: str("waiting"), updatedAt: str(nowIso) }, inFlight));
    } else {
      const answer = outcome.kind === "done" ? outcome.answer : undefined;
      if (spec !== undefined) {
        // Ticket 1.9: the new version, written once, with the answer that made it.
        items.push(
          setItem(
            this.tableName,
            specKey(participantId, spec.version),
            {
              type: str("spec"),
              specVersion: num(spec.version),
              text: str(spec.text),
              messageId: str(messageId),
              createdAt: str(nowIso),
              // Ticket 3.6: a change answer's version carries its list and becomes the proposal.
              ...(spec.whatChanges === undefined ? {} : { whatChanges: strList(spec.whatChanges) }),
            },
            { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
          ),
        );
      }
      items.push(
        setItem(
          this.tableName,
          messageKey(participantId, replyId(messageId)),
          {
            type: str("message"),
            author: str("assistant"),
            text: str(outcome.reply),
            ...(outcome.kind === "done" && outcome.offersSpec === true ? { offersSpec: { BOOL: true } } : {}),
            ...(spec === undefined ? {} : { specVersion: num(spec.version) }),
            kind: str(REPLY_KINDS[outcome.kind]),
            replyTo: str(messageId),
            createdAt: str(nowIso),
            ...(answer === undefined
              ? {}
              : {
                  prompt: str(answer.prompt),
                  modelId: str(answer.modelId),
                  promptVersion: str(answer.promptVersion),
                  historyCount: num(answer.historyCount),
                  inputTokens: num(answer.usage.inputTokens),
                  outputTokens: num(answer.usage.outputTokens),
                  costUsd: num(answer.usage.costUsd),
                }),
          },
          { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
        ),
        setItem(
          this.tableName,
          conversationKey(participantId),
          {
            state: str("open"),
            updatedAt: str(nowIso),
            ...(spec === undefined ? {} : { latestSpecVersion: num(spec.version) }),
            ...(spec?.whatChanges === undefined ? {} : { proposedSpecVersion: num(spec.version) }),
          },
          inFlight,
          { remove: ["pendingId", "pendingSince"] },
        ),
      );
    }
    const total = addUsage(guardrail?.usage, outcome.kind === "done" ? outcome.answer.usage : undefined);
    if (total.inputTokens + total.outputTokens > 0) items.push(this.usageItem(participantId, total, nowIso));
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async addUsage(participantId: string, usage: TokenUsage, nowIso: string): Promise<void> {
    if (usage.inputTokens + usage.outputTokens === 0) return;
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: [this.usageItem(participantId, usage, nowIso)] }));
  }

  async getBudgetFacts(participantId: string): Promise<BudgetFacts> {
    const [settings, profile, usage] = await Promise.all([
      readSettings(this.client, this.tableName),
      // Projected reads (the item is small either way): only what the budget needs.
      this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: keyOf(participantKey(participantId)),
          ConsistentRead: true,
          // Ticket 3.6: also the change requests used (the send route and the worker compare them with the cap).
          ProjectionExpression: "#extraBudget, #changeRequestsUsed",
          ExpressionAttributeNames: { "#extraBudget": "extraBudget", "#changeRequestsUsed": "changeRequestsUsed" },
        }),
      ),
      this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: keyOf(usageKey(participantId)),
          ConsistentRead: true,
          ProjectionExpression: "#costUsd",
          ExpressionAttributeNames: { "#costUsd": "costUsd" },
        }),
      ),
    ]);
    return { settings, limits: limitsFromItem(profile.Item), spentUsd: Number(usage.Item?.["costUsd"]?.N ?? 0) };
  }

  getSettings(): Promise<WorkshopSettings> {
    return readSettings(this.client, this.tableName);
  }

  async holdMessage(participantId: string, messageId: string, nowSeconds: number): Promise<boolean> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(this.tableName, conversationKey(participantId), { pendingSince: num(nowSeconds) }, {
              expression: "#pendingId = :messageId AND #state = :open",
              names: { "#pendingId": "pendingId", "#state": "state" },
              values: { ":messageId": str(messageId), ":open": str("open") },
            }),
            setItem(this.tableName, messageKey(participantId, messageId), { pendingSince: num(nowSeconds) }, {
              expression: "#status = :pending",
              names: { "#status": "status" },
              values: { ":pending": str("pending") },
            }),
          ],
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async requestChangeBuild(participantId: string, version: number, buildId: string, message: NewMessage): Promise<ChangeRequestResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(
              this.tableName,
              conversationKey(participantId),
              { state: str("open"), pendingId: str(message.id), pendingSince: num(message.nowSeconds), updatedAt: str(message.createdAt) },
              {
                // Still this proposal after this build, and nothing in flight (or only a stale pending message).
                expression:
                  "#proposedSpecVersion = :version AND #buildId = :buildId AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
                names: { "#proposedSpecVersion": "proposedSpecVersion", "#buildId": "buildId" },
                values: {
                  ":version": num(version),
                  ":buildId": str(buildId),
                  ":open": str("open"),
                  ":staleBefore": num(message.nowSeconds - STALE_PENDING_SECONDS),
                },
              },
            ),
            // Pressing Build this change approves the version (the launcher builds only an approved version).
            setItem(this.tableName, specKey(participantId, version), { approvedAt: str(message.createdAt) }, {
              expression: "attribute_exists(#pk)",
              names: { "#pk": "pk" },
            }),
            this.newMessageItem(participantId, message),
          ],
        }),
      );
      return "created";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const conversation = await this.getConversation(participantId);
      if (conversation?.proposedSpecVersion !== version || conversation.buildId !== buildId) return "stale";
      return conversation.state === "waiting" ? "waiting" : "busy";
    }
  }

  async discardChange(participantId: string, version: number, nowSeconds: number, nowIso: string): Promise<DiscardResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(
              this.tableName,
              conversationKey(participantId),
              { updatedAt: str(nowIso) },
              {
                expression: "#proposedSpecVersion = :version AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
                names: { "#proposedSpecVersion": "proposedSpecVersion", "#pendingId": "pendingId", "#state": "state", "#pendingSince": "pendingSince" },
                values: { ":version": num(version), ":open": str("open"), ":staleBefore": num(nowSeconds - STALE_PENDING_SECONDS) },
              },
              { remove: ["proposedSpecVersion"] },
            ),
          ],
        }),
      );
      return "discarded";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      const conversation = await this.getConversation(participantId);
      if (conversation?.proposedSpecVersion !== version) return "stale";
      return conversation.state === "waiting" ? "waiting" : "busy";
    }
  }

  async finishChangeBuild(participantId: string, messageId: string, outcome: ChangeBuildFinish, nowIso: string): Promise<boolean> {
    const ready = outcome.kind === "ready";
    const answered = outcome.kind === "ready" || outcome.kind === "not-ready";
    const answer = answered ? outcome.answer : undefined;
    const items: TransactWriteItem[] = [
      setItem(this.tableName, messageKey(participantId, messageId), { status: str(answered ? "done" : "failed") }, {
        expression: "#status = :pending",
        values: { ":pending": str("pending") },
      }),
      setItem(
        this.tableName,
        messageKey(participantId, replyId(messageId)),
        {
          type: str("message"),
          author: str("assistant"),
          text: str(outcome.reply),
          kind: str(CHANGE_REPLY_KINDS[outcome.kind]),
          replyTo: str(messageId),
          createdAt: str(nowIso),
          ...(answer === undefined
            ? {}
            : {
                prompt: str(answer.prompt),
                modelId: str(answer.modelId),
                promptVersion: str(answer.promptVersion),
                historyCount: num(answer.historyCount),
                inputTokens: num(answer.usage.inputTokens),
                outputTokens: num(answer.usage.outputTokens),
                costUsd: num(answer.usage.costUsd),
              }),
        },
        { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
      ),
      setItem(
        this.tableName,
        conversationKey(participantId),
        {
          state: str("open"),
          updatedAt: str(nowIso),
          ...(ready ? { buildId: str(outcome.build.buildId), approvedSpecVersion: num(outcome.version) } : {}),
        },
        {
          expression: "#pendingId = :messageId AND #proposedSpecVersion = :version AND #buildId = :previousBuildId",
          names: { "#pendingId": "pendingId", "#proposedSpecVersion": "proposedSpecVersion", ...(ready ? {} : { "#buildId": "buildId" }) },
          values: { ":messageId": str(messageId), ":version": num(outcome.version), ":previousBuildId": str(outcome.previousBuildId) },
        },
        // Not built: the proposal stays, so the participant can ask for a fix or press Build this change again.
        { remove: ready ? ["pendingId", "pendingSince", "proposedSpecVersion"] : ["pendingId", "pendingSince"] },
      ),
    ];
    if (ready) items.push(...this.changeBuildItems(participantId, outcome.previousBuildId, outcome.version, outcome.build, outcome.used, outcome.cap, nowIso));
    const spent = answered ? outcome.answer.usage : outcome.usage;
    if (spent !== undefined && spent.inputTokens + spent.outputTokens > 0) items.push(this.usageItem(participantId, spent, nowIso));
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  /**
   * Ticket 3.6 (shared with 3.9): the items that queue a change build: the change counted from exactly `used` (no lost
   * update) and only below the cap, the build it follows `live` or `failed`, and the new build (only if absent).
   */
  private changeBuildItems(
    participantId: string,
    previousBuildId: string,
    version: number,
    build: { buildId: string; nickname: string; changeNumber: number },
    used: number,
    cap: number,
    nowIso: string,
  ): TransactWriteItem[] {
    return [
      // The change counts here, in the transaction that queues its build: from exactly `used` (no lost update), and
      // only below the cap. A retry of the build (npm run builds -- retry) never writes the profile.
      setItem(this.tableName, participantKey(participantId), { changeRequestsUsed: num(used + 1) }, {
        expression:
          used === 0
            ? "#step = :building AND (attribute_not_exists(#changeRequestsUsed) OR (#changeRequestsUsed = :used AND #changeRequestsUsed < :cap))"
            : "#step = :building AND #changeRequestsUsed = :used AND #changeRequestsUsed < :cap",
        names: { "#step": "step" },
        values: { ":building": str("building"), ":used": num(used), ":cap": num(cap) },
      }),
      // Nothing of theirs is running: the build the change follows is live (or a change build that failed).
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: keyOf(buildKey(previousBuildId)),
          ConditionExpression: "#status IN (:live, :failed)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":live": str("live"), ":failed": str("failed") },
        },
      },
      setItem(
        this.tableName,
        buildKey(build.buildId),
        {
          type: str("build"),
          buildId: str(build.buildId),
          nickname: str(build.nickname),
          participantId: str(participantId),
          status: str("queued"),
          kind: str("change"),
          changeNumber: num(build.changeNumber),
          specVersion: num(version),
          createdAt: str(nowIso),
          updatedAt: str(nowIso),
        },
        { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
      ),
    ];
  }

  async finishRebuild(participantId: string, messageId: string, outcome: RebuildFinish, nowIso: string): Promise<boolean> {
    const ready = outcome.kind === "ready";
    const guardrail = "guardrail" in outcome ? outcome.guardrail : undefined;
    const answer = "answer" in outcome ? outcome.answer : undefined;
    const items: TransactWriteItem[] = [
      setItem(
        this.tableName,
        messageKey(participantId, messageId),
        {
          status: str(rebuildStatus(outcome.kind)),
          ...(guardrail === undefined
            ? {}
            : {
                verdict: str(guardrail.verdict),
                verdictReason: str(guardrail.reason),
                suggestion: str(guardrail.suggestion),
                guardrailInputTokens: num(guardrail.usage.inputTokens),
                guardrailOutputTokens: num(guardrail.usage.outputTokens),
                guardrailCostUsd: num(guardrail.usage.costUsd),
              }),
        },
        { expression: "#status = :pending", values: { ":pending": str("pending") } },
      ),
      setItem(
        this.tableName,
        messageKey(participantId, replyId(messageId)),
        {
          type: str("message"),
          author: str("assistant"),
          text: str(outcome.reply),
          kind: str(REBUILD_REPLY_KINDS[outcome.kind]),
          replyTo: str(messageId),
          createdAt: str(nowIso),
          ...(ready ? { specVersion: num(outcome.spec.version) } : {}),
          ...(answer === undefined
            ? {}
            : {
                prompt: str(answer.prompt),
                modelId: str(answer.modelId),
                promptVersion: str(answer.promptVersion),
                historyCount: num(answer.historyCount),
                inputTokens: num(answer.usage.inputTokens),
                outputTokens: num(answer.usage.outputTokens),
                costUsd: num(answer.usage.costUsd),
              }),
        },
        { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
      ),
      setItem(
        this.tableName,
        conversationKey(participantId),
        {
          state: str("open"),
          updatedAt: str(nowIso),
          ...(ready
            ? { buildId: str(outcome.build.buildId), approvedSpecVersion: num(outcome.spec.version), latestSpecVersion: num(outcome.spec.version) }
            : {}),
        },
        {
          expression: "#pendingId = :messageId AND #buildId = :previousBuildId",
          names: { "#pendingId": "pendingId", ...(ready ? {} : { "#buildId": "buildId" }) },
          values: { ":messageId": str(messageId), ":previousBuildId": str(outcome.previousBuildId) },
        },
        // Built from the repository: an open proposal is replaced by it. Otherwise the proposal (if any) stays.
        { remove: ready ? ["pendingId", "pendingSince", "proposedSpecVersion"] : ["pendingId", "pendingSince"] },
      ),
    ];
    if (ready) {
      items.push(
        // The repository's spec as the next version, approved by the participant's press (the launcher builds only an
        // approved version with a "What changes" list).
        setItem(
          this.tableName,
          specKey(participantId, outcome.spec.version),
          {
            type: str("spec"),
            specVersion: num(outcome.spec.version),
            text: str(outcome.spec.text),
            messageId: str(messageId),
            createdAt: str(nowIso),
            approvedAt: str(nowIso),
            whatChanges: strList(outcome.spec.whatChanges),
          },
          { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
        ),
        ...this.changeBuildItems(participantId, outcome.previousBuildId, outcome.spec.version, outcome.build, outcome.used, outcome.cap, nowIso),
      );
    }
    const spent = rebuildSpent(outcome);
    if (spent !== undefined && spent.inputTokens + spent.outputTokens > 0) items.push(this.usageItem(participantId, spent, nowIso));
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async markSuggestionsRequested(participantId: string, nowIso: string, askedBeforeIso: string): Promise<boolean> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(this.tableName, conversationKey(participantId), { suggestionsRequestedAt: str(nowIso) }, {
              expression: "attribute_exists(#pk) AND attribute_not_exists(#suggestions) AND (attribute_not_exists(#suggestionsRequestedAt) OR #suggestionsRequestedAt < :askedBefore)",
              names: { "#pk": "pk", "#suggestions": "suggestions" },
              values: { ":askedBefore": str(askedBeforeIso) },
            }),
          ],
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async storeSuggestions(participantId: string, suggestions: readonly string[], usage: TokenUsage, nowIso: string): Promise<boolean> {
    const items: TransactWriteItem[] = [
      setItem(this.tableName, conversationKey(participantId), { suggestions: strList(suggestions) }, {
        expression: "attribute_exists(#pk) AND attribute_not_exists(#suggestions)",
        names: { "#pk": "pk" },
      }),
    ];
    if (usage.inputTokens + usage.outputTokens > 0) items.push(this.usageItem(participantId, usage, nowIso));
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  /** The atomic ADD of tokens and cost to the participant's `USAGE` totals. */
  private usageItem(participantId: string, usage: TokenUsage, nowIso: string): TransactWriteItem {
    return setItem(
      this.tableName,
      usageKey(participantId),
      { type: str("usage"), participantId: str(participantId), updatedAt: str(nowIso) },
      undefined,
      { add: { inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), costUsd: num(usage.costUsd) } },
    );
  }
}
