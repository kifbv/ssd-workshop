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
import type { Exchange } from "./answer.js";
import { addUsage } from "./model.js";
import {
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

const SPEC_NAMES = { "#pk": "pk", "#sk": "sk", "#specVersion": "specVersion", "#text": "text", "#createdAt": "createdAt", "#approvedAt": "approvedAt" };
const SPEC_PROJECTION = "#sk, #specVersion, #text, #createdAt, #approvedAt";

/** A spec version from its item: only with `specVersion`, which no role but the AI worker's may write. */
function specOf(item: Record<string, AttributeValue> | undefined): StoredSpec | undefined {
  const version = versionOf(item?.["specVersion"]);
  const text = item?.["text"]?.S;
  if (item === undefined || version === undefined || text === undefined || !(item["sk"]?.S ?? "").startsWith(SPEC_PREFIX)) return undefined;
  return { version, text, createdAt: item["createdAt"]?.S ?? "", approved: item["approvedAt"]?.S !== undefined };
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

const REPLY_KINDS = { done: "answer", declined: "decline", failed: "failure" } as const;

export class DynamoConversationStore implements ConversationStore {
  constructor(
    private readonly client: ConversationSender,
    private readonly tableName: string,
  ) {}

  async createMessage(participantId: string, message: NewMessage): Promise<CreateResult> {
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
                // no approved spec (ticket 1.9: changes are closed once it is approved).
                expression:
                  "attribute_not_exists(#approvedSpecVersion) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
                names: { "#approvedSpecVersion": "approvedSpecVersion" },
                values: { ":open": str("open"), ":staleBefore": num(message.nowSeconds - STALE_PENDING_SECONDS) },
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
      if (conversation?.approvedSpecVersion !== undefined) return "approved";
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
    return {
      id: messageId,
      step,
      text,
      status,
      pendingSince,
      ...(approvedTextHash === undefined ? {} : { approvedTextHash }),
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(verdictReason === undefined ? {} : { verdictReason }),
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
    return {
      state: state as ConversationState,
      ...(pendingId === undefined ? {} : { pendingId }),
      ...(latestSpecVersion === undefined ? {} : { latestSpecVersion }),
      ...(approvedSpecVersion === undefined ? {} : { approvedSpecVersion }),
      ...(buildId !== undefined && BUILD_ID_PATTERN.test(buildId) ? { buildId } : {}),
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
        ExpressionAttributeNames: { "#sk": "sk", "#specVersion": "specVersion", "#text": "text", "#createdAt": "createdAt", "#approvedAt": "approvedAt" },
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
      },
      { expression: "attribute_not_exists(#pk)", names: { "#pk": "pk" } },
    );
  }

  async finishReadiness(participantId: string, messageId: string, outcome: ReadinessFinish, nowIso: string): Promise<boolean> {
    const ready = outcome.kind === "ready";
    const answer = outcome.kind === "failed" ? undefined : outcome.answer;
    const items: TransactWriteItem[] = [
      setItem(this.tableName, messageKey(participantId, messageId), { status: str(outcome.kind === "failed" ? "failed" : "done") }, {
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
          kind: str(outcome.kind === "failed" ? "failure" : "answer"),
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
    const spent = outcome.kind === "failed" ? outcome.usage : outcome.answer.usage;
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
        ProjectionExpression: "#type, #buildId, #participantId, #status, #failureReasons, #nickname, #feed",
        ExpressionAttributeNames: {
          "#type": "type",
          "#buildId": "buildId",
          "#participantId": "participantId",
          "#status": "status",
          "#failureReasons": "failureReasons",
          "#nickname": "nickname",
          "#feed": "feed",
        },
      }),
    );
    const item = output.Item;
    const participantId = item?.["participantId"]?.S;
    const status = item?.["status"]?.S;
    if (item?.["type"]?.S !== "build" || item["buildId"]?.S !== buildId || participantId === undefined || !isBuildStatus(status)) return undefined;
    const reasons = item["failureReasons"]?.L?.flatMap((r) => (r.S === undefined ? [] : [r.S]));
    const nickname = item["nickname"]?.S;
    return {
      buildId,
      participantId,
      status,
      ...(nickname === undefined ? {} : { nickname }),
      feed: readFeed(item["feed"]?.L),
      ...(reasons === undefined ? {} : { failureReasons: reasons }),
    };
  }

  async finish(participantId: string, messageId: string, outcome: Finish, from: "pending" | "flagged", nowIso: string): Promise<boolean> {
    const guardrail = outcome.guardrail;
    const spec = outcome.kind === "done" ? outcome.spec : undefined;
    const items: TransactWriteItem[] = [
      setItem(
        this.tableName,
        messageKey(participantId, messageId),
        {
          status: str(outcome.kind),
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
            { type: str("spec"), specVersion: num(spec.version), text: str(spec.text), messageId: str(messageId), createdAt: str(nowIso) },
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
          { state: str("open"), updatedAt: str(nowIso), ...(spec === undefined ? {} : { latestSpecVersion: num(spec.version) }) },
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
