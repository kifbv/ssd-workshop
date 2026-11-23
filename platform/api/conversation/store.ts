// The conversation's table access (ticket 1.7). The calls stay thin; the rules live in
// ./conversation.ts, ./worker.ts and ./state.ts.
//
// Every write is an UpdateItem (inside a transaction where several items change together), never a
// PutItem: the functions' roles (infra/lib/api-stack.ts) may update only listed attribute names in
// `PARTICIPANT#*`, so they can never replace or empty another item of the partition. The lists are
// CONVERSATION_UPDATE_ATTRIBUTES and AI_WORKER_UPDATE_ATTRIBUTES in infra/lib/config.ts (tested).
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
import { conversationKey, MESSAGE_PREFIX, messageKey, participantKey, replyId, REPLY_SUFFIX, usageKey, type ItemKey } from "../keys.js";
import { isStep } from "../session/session.js";
import type { ConversationState, MessageStatus, TokenUsage } from "../types.js";
import type { Exchange } from "./answer.js";
import { addUsage } from "./model.js";
import {
  STALE_PENDING_SECONDS,
  type ConversationStore,
  type CreateResult,
  type Finish,
  type ListedItem,
  type MoveResult,
  type NewMessage,
  type StoredConversation,
  type StoredMessage,
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
                // No message in flight, or only a stale pending one (a flagged one never goes stale).
                expression: "attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore)",
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
    return { state: state as ConversationState, ...(pendingId === undefined ? {} : { pendingId }) };
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
        },
        ExpressionAttributeValues: { ":pk": str(pk), ":prefix": str(MESSAGE_PREFIX) },
        ProjectionExpression: "#sk, #author, #text, #status, #pendingSince, #offersSpec",
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
        items.push({ author, replyTo: id.slice(0, -REPLY_SUFFIX.length), text, offersSpec: i["offersSpec"]?.BOOL === true });
      } else if (author === "participant") {
        const status = i["status"]?.S;
        const pendingSince = Number(i["pendingSince"]?.N);
        if (isStatus(status) && Number.isFinite(pendingSince)) items.push({ author, id, text, status, pendingSince });
      }
    }
    return items.reverse();
  }

  async moveToSpec(participantId: string, nowSeconds: number, nowIso: string): Promise<MoveResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(this.tableName, participantKey(participantId), { step: str("spec") }, {
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

  async finish(participantId: string, messageId: string, outcome: Finish, from: "pending" | "flagged", nowIso: string): Promise<boolean> {
    const guardrail = outcome.guardrail;
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
      items.push(
        setItem(
          this.tableName,
          messageKey(participantId, replyId(messageId)),
          {
            type: str("message"),
            author: str("assistant"),
            text: str(outcome.reply),
            ...(outcome.kind === "done" && outcome.offersSpec === true ? { offersSpec: { BOOL: true } } : {}),
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
        setItem(this.tableName, conversationKey(participantId), { state: str("open"), updatedAt: str(nowIso) }, inFlight, {
          remove: ["pendingId", "pendingSince"],
        }),
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
