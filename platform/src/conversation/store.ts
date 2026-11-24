// The reset command's table access: it runs with the owner's own AWS credentials, not a Lambda role.
import {
  BatchWriteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type BatchWriteItemCommandOutput,
  type GetItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { conversationKey, MESSAGE_PREFIX, nicknameKey, participantKey, SPEC_PREFIX } from "../../api/keys.js";
import { conditionFailed } from "../../api/conversation/store.js";

/** What the command needs to know before it resets anything. */
export interface ResetState {
  /** The message the AI is answering (or the facilitator is deciding on), if any. */
  pendingId?: string;
  /** Epoch seconds: when `pendingId` became pending. */
  pendingSince?: number;
  /** "waiting" while a flagged message waits for a facilitator. */
  state?: string;
  /** ISO 8601: the conversation item's last change; every message sent or answered changes it. */
  updatedAt?: string;
  /** Whether the conversation item exists (a participant who never wrote has none). */
  exists: boolean;
}

/** The items a reset deletes: sort keys of the participant's messages, replies and spec versions. */
export interface ResetItems {
  messages: string[];
  specs: string[];
}

export interface ResetStore {
  /** The participant id that claimed the nickname (any letter case), if any. */
  findParticipantId(nickname: string): Promise<string | undefined>;
  /** The participant's step, or undefined when there is no profile. */
  getStep(participantId: string): Promise<string | undefined>;
  getResetState(participantId: string): Promise<ResetState>;
  listResetItems(participantId: string): Promise<ResetItems>;
  /**
   * Deletes the conversation item and puts the step back to clarify, in one transaction, on condition
   * that the conversation item is unchanged since it was read (same message in flight, same `updatedAt`;
   * none read: still none). False when it changed.
   */
  restart(participantId: string, seen: ResetState): Promise<boolean>;
  /** Deletes the given sort keys of the participant's partition. */
  deleteItems(participantId: string, sortKeys: readonly string[]): Promise<void>;
}

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface ResetSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  send(command: BatchWriteItemCommand): Promise<BatchWriteItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });

/** BatchWriteItem takes at most 25 requests. */
export const BATCH_SIZE = 25;
/** Tries for the items DynamoDB leaves unprocessed (throttling) before giving up. */
export const BATCH_ATTEMPTS = 5;

/** The condition that the conversation item is as it was read: same message in flight, same last change. */
export function unchangedSince(seen: ResetState): {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
} {
  if (!seen.exists) return { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } };
  const parts: string[] = [];
  const names: Record<string, string> = { "#pendingId": "pendingId" };
  const values: Record<string, AttributeValue> = {};
  if (seen.pendingId === undefined) parts.push("attribute_not_exists(#pendingId)");
  else {
    parts.push("#pendingId = :seen");
    values[":seen"] = str(seen.pendingId);
  }
  names["#updatedAt"] = "updatedAt";
  if (seen.updatedAt === undefined) parts.push("attribute_not_exists(#updatedAt)");
  else {
    parts.push("#updatedAt = :updatedAt");
    values[":updatedAt"] = str(seen.updatedAt);
  }
  return {
    ConditionExpression: parts.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
  };
}

export class DynamoResetStore implements ResetStore {
  constructor(
    private readonly sender: ResetSender,
    private readonly table: string,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async getAttributes(key: { pk: string; sk: string }, names: string[]): Promise<Record<string, AttributeValue> | undefined> {
    const output = await this.sender.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { pk: str(key.pk), sk: str(key.sk) },
        ProjectionExpression: names.map((n) => `#${n}`).join(", "),
        ExpressionAttributeNames: Object.fromEntries(names.map((n) => [`#${n}`, n])),
        ConsistentRead: true,
      }),
    );
    return output.Item;
  }

  async findParticipantId(nickname: string): Promise<string | undefined> {
    return (await this.getAttributes(nicknameKey(nickname), ["participantId"]))?.["participantId"]?.S;
  }

  async getStep(participantId: string): Promise<string | undefined> {
    return (await this.getAttributes(participantKey(participantId), ["step"]))?.["step"]?.S;
  }

  async getResetState(participantId: string): Promise<ResetState> {
    const item = await this.getAttributes(conversationKey(participantId), ["pk", "pendingId", "pendingSince", "state", "updatedAt"]);
    const pendingId = item?.["pendingId"]?.S;
    const pendingSince = item?.["pendingSince"]?.N;
    const state = item?.["state"]?.S;
    const updatedAt = item?.["updatedAt"]?.S;
    return {
      exists: item?.["pk"] !== undefined,
      ...(pendingId === undefined ? {} : { pendingId }),
      ...(pendingSince === undefined ? {} : { pendingSince: Number(pendingSince) }),
      ...(state === undefined ? {} : { state }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    };
  }

  async listResetItems(participantId: string): Promise<ResetItems> {
    const pk = conversationKey(participantId).pk;
    const items: ResetItems = { messages: [], specs: [] };
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const page = await this.sender.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "#pk = :pk",
          ProjectionExpression: "#sk",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: { ":pk": str(pk) },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        const sk = item["sk"]?.S ?? "";
        if (sk.startsWith(MESSAGE_PREFIX)) items.messages.push(sk);
        else if (sk.startsWith(SPEC_PREFIX)) items.specs.push(sk);
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
    return items;
  }

  async restart(participantId: string, seen: ResetState): Promise<boolean> {
    const conversation = conversationKey(participantId);
    const profile = participantKey(participantId);
    try {
      await this.sender.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Delete: { TableName: this.table, Key: { pk: str(conversation.pk), sk: str(conversation.sk) }, ...unchangedSince(seen) } },
            {
              Update: {
                TableName: this.table,
                Key: { pk: str(profile.pk), sk: str(profile.sk) },
                UpdateExpression: "SET #step = :clarify",
                ConditionExpression: "attribute_exists(#pk) AND #step IN (:clarify, :spec, :approved, :building)",
                ExpressionAttributeNames: { "#pk": "pk", "#step": "step" },
                ExpressionAttributeValues: { ":clarify": str("clarify"), ":spec": str("spec"), ":approved": str("approved"), ":building": str("building") },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async deleteItems(participantId: string, sortKeys: readonly string[]): Promise<void> {
    const pk = conversationKey(participantId).pk;
    for (let i = 0; i < sortKeys.length; i += BATCH_SIZE) {
      let requests: { DeleteRequest: { Key: Record<string, AttributeValue> } }[] = sortKeys.slice(i, i + BATCH_SIZE).map((sk) => ({ DeleteRequest: { Key: { pk: str(pk), sk: str(sk) } } }));
      for (let attempt = 1; requests.length > 0; attempt++) {
        if (attempt > BATCH_ATTEMPTS) throw Object.assign(new Error("some items were left after retries"), { name: "UnprocessedItems" });
        if (attempt > 1) await this.sleep(100 * 2 ** (attempt - 1));
        const output = await this.sender.send(new BatchWriteItemCommand({ RequestItems: { [this.table]: requests } }));
        requests = (output.UnprocessedItems?.[this.table] ?? []).flatMap((r) =>
          r.DeleteRequest?.Key === undefined ? [] : [{ DeleteRequest: { Key: r.DeleteRequest.Key } }],
        );
      }
    }
  }
}
