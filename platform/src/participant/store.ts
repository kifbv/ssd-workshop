// The full reset's table access (ticket 2.13): the conversation reset store (../conversation/store.ts) plus the
// build's status, the app's data partition and its live marker. It runs with the owner's own AWS credentials.
import {
  DeleteItemCommand,
  QueryCommand,
  type AttributeValue,
  type BatchWriteItemCommand,
  type BatchWriteItemCommandOutput,
  type DeleteItemCommandOutput,
  type GetItemCommand,
  type GetItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { appDataUsageKey, appLiveKey, buildKey } from "../../api/keys.js";
import { DynamoResetStore, type ResetSender, type ResetStore } from "../conversation/store.js";

export interface ParticipantResetStore extends ResetStore {
  /** The build's status (`queued`, `building`, `deploying`, `live`, `failed`), or undefined when there is no such build. */
  getBuildStatus(buildId: string): Promise<string | undefined>;
  /** Sort keys of every item in the app's data partition `APPDATA#<lower-cased nickname>` (`DATA#*`, `DATA_USAGE`). */
  listAppData(nickname: string): Promise<string[]>;
  /** Deletes the given sort keys of the app's data partition. */
  deleteAppData(nickname: string, sortKeys: readonly string[]): Promise<void>;
  /** Whether the app's live marker `APP#<lower-cased nickname>` / `LIVE` exists. */
  hasLiveMarker(nickname: string): Promise<boolean>;
  /** Deletes the live marker (no error when it is gone). */
  deleteLiveMarker(nickname: string): Promise<void>;
}

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface ParticipantResetSender extends ResetSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  send(command: BatchWriteItemCommand): Promise<BatchWriteItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });

export class DynamoParticipantResetStore extends DynamoResetStore implements ParticipantResetStore {
  constructor(
    private readonly client: ParticipantResetSender,
    table: string,
    sleep?: (ms: number) => Promise<void>,
  ) {
    super(client, table, sleep);
  }

  async getBuildStatus(buildId: string): Promise<string | undefined> {
    return (await this.getAttributes(buildKey(buildId), ["status"]))?.["status"]?.S;
  }

  async listAppData(nickname: string): Promise<string[]> {
    const pk = appDataUsageKey(nickname).pk;
    const keys: string[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const page: QueryCommandOutput = await this.client.send(
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
        const sk = item["sk"]?.S;
        if (sk !== undefined) keys.push(sk);
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
    return keys;
  }

  async deleteAppData(nickname: string, sortKeys: readonly string[]): Promise<void> {
    await this.deleteKeys(appDataUsageKey(nickname).pk, sortKeys);
  }

  async hasLiveMarker(nickname: string): Promise<boolean> {
    return (await this.getAttributes(appLiveKey(nickname), ["pk"]))?.["pk"] !== undefined;
  }

  async deleteLiveMarker(nickname: string): Promise<void> {
    const key = appLiveKey(nickname);
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: { pk: str(key.pk), sk: str(key.sk) } }));
  }
}
