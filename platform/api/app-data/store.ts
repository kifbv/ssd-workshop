// The data API's table access (ticket 2.4). The rules live in ./data.ts.
//
// The function's role (infra/lib/api-stack.ts) may read `APP#*` (the live marker, written by the
// deployer) and `APPDATA#*` items, and put, update and delete in `APPDATA#*` only, naming only
// APP_DATA_WRITE_ATTRIBUTES. A transaction is authorized item by item as PutItem, UpdateItem and
// DeleteItem. No call returns attributes beyond what it names (no ALL_NEW / ALL_OLD). The totals item
// (`DATA_USAGE`) also holds the daily write count (`writeDay`, `writtenBytes`), changed in the same
// transaction as every value.
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { appDataKey, appDataUsageKey, appLiveKey, type ItemKey } from "../keys.js";
import {
  DAILY_WRITE_BUDGET_BYTES,
  MAX_APP_DATA_BYTES,
  MAX_KEYS,
  type AppDataStore,
  type AppUsage,
  type DeleteResult,
  type PutResult,
  type WriteCharge,
} from "./data.js";

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

/**
 * The daily write budget's part of the totals item's update (UpdateExpression cannot branch, so the
 * branch is chosen from what was read, and the condition fails, for another try, if that changed):
 * - a later write of the day adds its cost, only while the count is still today's and stays within
 *   the budget (count + cost <= budget, written as count <= budget - cost): parallel writes can never
 *   pass the budget;
 * - the first write of a day starts the count at its cost, only while no write of today got in first.
 */
function budgetParts(charge: WriteCharge): { set: string; condition: string; values: Record<string, AttributeValue> } {
  return charge.sameDay
    ? {
        set: "#writtenBytes = #writtenBytes + :cost",
        condition: "#writeDay = :today AND #writtenBytes <= :budgetLimit",
        values: { ":today": str(charge.today), ":cost": num(charge.cost), ":budgetLimit": num(DAILY_WRITE_BUDGET_BYTES - charge.cost) },
      }
    : {
        set: "#writeDay = :today, #writtenBytes = :cost",
        condition: "(attribute_not_exists(#writeDay) OR #writeDay <> :today)",
        values: { ":today": str(charge.today), ":cost": num(charge.cost) },
      };
}

const BUDGET_NAMES = { "#writeDay": "writeDay", "#writtenBytes": "writtenBytes" } as const;

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
        ProjectionExpression: "#bytes, #keys, #writeDay, #writtenBytes",
        ExpressionAttributeNames: { "#bytes": "bytes", "#keys": "keys", ...BUDGET_NAMES },
      }),
    );
    const finite = (value: string | undefined): number => {
      const n = Number(value ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      bytes: finite(output.Item?.["bytes"]?.N),
      keys: finite(output.Item?.["keys"]?.N),
      writeDay: output.Item?.["writeDay"]?.S,
      writtenBytes: finite(output.Item?.["writtenBytes"]?.N),
    };
  }

  async putValue(nickname: string, key: string, json: string, bytes: number, previousBytes: number | undefined, nowIso: string, charge: WriteCharge): Promise<PutResult> {
    const bytesDelta = bytes - (previousBytes ?? 0);
    const keysDelta = previousBytes === undefined ? 1 : 0;
    const budget = budgetParts(charge);
    // The new totals stay within the limits: old + delta <= limit, written as old <= limit - delta. On
    // a later write of the day the item exists (it holds today's count), so no attribute_not_exists.
    const limits = charge.sameDay
      ? `${budget.condition} AND #bytes <= :bytesLimit AND #keys <= :keysLimit`
      : `(attribute_not_exists(#pk) OR (#bytes <= :bytesLimit AND #keys <= :keysLimit)) AND ${budget.condition}`;
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
                UpdateExpression: `SET #type = :type, #bytes = if_not_exists(#bytes, :zero) + :bytesDelta, #keys = if_not_exists(#keys, :zero) + :keysDelta, #updatedAt = :now, ${budget.set}`,
                ConditionExpression: limits,
                ExpressionAttributeNames: {
                  ...(charge.sameDay ? {} : { "#pk": "pk" }),
                  "#type": "type",
                  "#bytes": "bytes",
                  "#keys": "keys",
                  "#updatedAt": "updatedAt",
                  ...BUDGET_NAMES,
                },
                ExpressionAttributeValues: {
                  ":type": str("app-data-usage"),
                  ":zero": num(0),
                  ":bytesDelta": num(bytesDelta),
                  ":keysDelta": num(keysDelta),
                  ":now": str(nowIso),
                  ":bytesLimit": num(MAX_APP_DATA_BYTES - bytesDelta),
                  ":keysLimit": num(MAX_KEYS - keysDelta),
                  ...budget.values,
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

  async deleteValue(nickname: string, key: string, previousBytes: number, nowIso: string, charge: WriteCharge): Promise<DeleteResult> {
    const budget = budgetParts(charge);
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
                UpdateExpression: `SET #bytes = #bytes - :bytes, #keys = #keys - :one, #updatedAt = :now, ${budget.set}`,
                ConditionExpression: `attribute_exists(#pk) AND ${budget.condition}`,
                ExpressionAttributeNames: { "#pk": "pk", "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt", ...BUDGET_NAMES },
                ExpressionAttributeValues: { ":bytes": num(previousBytes), ":one": num(1), ":now": str(nowIso), ...budget.values },
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
