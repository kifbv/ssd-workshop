// The data API's table access (ticket 2.4). The rules live in ./data.ts.
//
// The function's role (infra/lib/api-stack.ts) may read `APP#*` (the live marker, written by the
// deployer) and `APPDATA#*` items, and put, update and delete in `APPDATA#*` only, naming only
// APP_DATA_WRITE_ATTRIBUTES. A transaction is authorized item by item as PutItem, UpdateItem and
// DeleteItem. No call returns attributes beyond what it names (no ALL_NEW / ALL_OLD).
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { appDataKey, appDataUsageKey, appLiveKey, type ItemKey } from "../keys.js";
import { MAX_APP_DATA_BYTES, MAX_KEYS, type AppDataStore, type AppUsage, type DeleteResult, type PutResult } from "./data.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface AppDataSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

/** The reasons DynamoDB gives, in item order, when it cancels a transaction. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.map((r) => r.Code);
}

/** A cancellation caused by our conditions or by another transaction on the same items. */
const RACE_CODES = ["ConditionalCheckFailed", "TransactionConflict"];

export class DynamoAppDataStore implements AppDataStore {
  constructor(
    private readonly client: AppDataSender,
    private readonly tableName: string,
  ) {}

  private async get(key: ItemKey, attribute: string): Promise<AttributeValue | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(key),
        ConsistentRead: true,
        ProjectionExpression: "#a",
        ExpressionAttributeNames: { "#a": attribute },
      }),
    );
    return output.Item?.[attribute];
  }

  /** Live only with the marker's `liveAt`, an attribute the data API's role cannot write. */
  async isLive(nickname: string): Promise<boolean> {
    return (await this.get(appLiveKey(nickname), "liveAt"))?.S !== undefined;
  }

  async getValue(nickname: string, key: string): Promise<string | undefined> {
    return (await this.get(appDataKey(nickname, key), "value"))?.S;
  }

  async getValueBytes(nickname: string, key: string): Promise<number | undefined> {
    const bytes = Number((await this.get(appDataKey(nickname, key), "bytes"))?.N);
    return Number.isInteger(bytes) && bytes >= 0 ? bytes : undefined;
  }

  async getUsage(nickname: string): Promise<AppUsage> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appDataUsageKey(nickname)),
        ConsistentRead: true,
        ProjectionExpression: "#bytes, #keys",
        ExpressionAttributeNames: { "#bytes": "bytes", "#keys": "keys" },
      }),
    );
    const bytes = Number(output.Item?.["bytes"]?.N ?? 0);
    const keys = Number(output.Item?.["keys"]?.N ?? 0);
    return { bytes: Number.isFinite(bytes) ? bytes : 0, keys: Number.isFinite(keys) ? keys : 0 };
  }

  async putValue(nickname: string, key: string, json: string, bytes: number, previousBytes: number | undefined, nowIso: string): Promise<PutResult> {
    const bytesDelta = bytes - (previousBytes ?? 0);
    const keysDelta = previousBytes === undefined ? 1 : 0;
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...keyOf(appDataKey(nickname, key)),
                  type: str("app-data"),
                  value: str(json),
                  bytes: num(bytes),
                  updatedAt: str(nowIso),
                },
                // Only over the value that was read (by its size, which the totals depend on).
                ...(previousBytes === undefined
                  ? { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } }
                  : {
                      ConditionExpression: "#bytes = :previous",
                      ExpressionAttributeNames: { "#bytes": "bytes" },
                      ExpressionAttributeValues: { ":previous": num(previousBytes) },
                    }),
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keyOf(appDataUsageKey(nickname)),
                UpdateExpression:
                  "SET #type = :type, #bytes = if_not_exists(#bytes, :zero) + :bytesDelta, #keys = if_not_exists(#keys, :zero) + :keysDelta, #updatedAt = :now",
                // The new totals stay within the limits: old + delta <= limit, written as old <= limit - delta.
                ConditionExpression: "attribute_not_exists(#pk) OR (#bytes <= :bytesLimit AND #keys <= :keysLimit)",
                ExpressionAttributeNames: { "#pk": "pk", "#type": "type", "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt" },
                ExpressionAttributeValues: {
                  ":type": str("app-data-usage"),
                  ":zero": num(0),
                  ":bytesDelta": num(bytesDelta),
                  ":keysDelta": num(keysDelta),
                  ":now": str(nowIso),
                  ":bytesLimit": num(MAX_APP_DATA_BYTES - bytesDelta),
                  ":keysLimit": num(MAX_KEYS - keysDelta),
                },
              },
            },
          ],
        }),
      );
      return "saved";
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes?.[1] === "ConditionalCheckFailed") return "limit";
      if (codes?.some((code) => code !== undefined && RACE_CODES.includes(code)) === true) return "conflict";
      throw error;
    }
  }

  async deleteValue(nickname: string, key: string, previousBytes: number, nowIso: string): Promise<DeleteResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.tableName,
                Key: keyOf(appDataKey(nickname, key)),
                ConditionExpression: "#bytes = :previous",
                ExpressionAttributeNames: { "#bytes": "bytes" },
                ExpressionAttributeValues: { ":previous": num(previousBytes) },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keyOf(appDataUsageKey(nickname)),
                UpdateExpression: "SET #bytes = #bytes - :bytes, #keys = #keys - :one, #updatedAt = :now",
                ConditionExpression: "attribute_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk", "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt" },
                ExpressionAttributeValues: { ":bytes": num(previousBytes), ":one": num(1), ":now": str(nowIso) },
              },
            },
          ],
        }),
      );
      return "deleted";
    } catch (error) {
      if (cancellationCodes(error)?.some((code) => code !== undefined && RACE_CODES.includes(code)) === true) return "conflict";
      throw error;
    }
  }
}
