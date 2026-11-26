// The full reset's table access (ticket 2.13): the conversation reset store (../conversation/store.ts, which also
// reads the build's status) plus the app's data partition and its live marker. It runs with the owner's own AWS credentials.
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
import { DynamoAppTokenStore } from "../../api/app-token/store.js";
import { appDataUsageKey, appLiveKey } from "../../api/keys.js";
import { DynamoResetStore, type ResetSender, type ResetStore } from "../conversation/store.js";

export interface ParticipantResetStore extends ResetStore {
  /** Sort keys of every item in the app's data partition `APPDATA#<lower-cased nickname>` (`DATA#*`, `DATA_USAGE`). */
  listAppData(nickname: string): Promise<string[]>;
  /** Deletes the given sort keys of the app's data partition. */
  deleteAppData(nickname: string, sortKeys: readonly string[]): Promise<void>;
  /** Whether the app's live marker `APP#<lower-cased nickname>` / `LIVE` exists. */
  hasLiveMarker(nickname: string): Promise<boolean>;
  /** Deletes the live marker; true when this call deleted it, false when it was already gone. */
  deleteLiveMarker(nickname: string): Promise<boolean>;
  /** Ticket 3.24: deletes every app write token of the participant and their list; returns how many were listed. */
  revokeAppTokens(participantId: string): Promise<number>;
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

  revokeAppTokens(participantId: string): Promise<number> {
    return new DynamoAppTokenStore(this.client, this.table).revokeAppTokens(participantId);
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

  async deleteLiveMarker(nickname: string): Promise<boolean> {
    const key = appLiveKey(nickname);
    const output = await this.client.send(
      new DeleteItemCommand({ TableName: this.table, Key: { pk: str(key.pk), sk: str(key.sk) }, ReturnValues: "ALL_OLD" }),
    );
    return output.Attributes !== undefined;
  }
}
