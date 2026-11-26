// The data API's table access (ticket 2.4). The rules live in ./data.ts.
//
// The function's role (infra/lib/api-stack.ts) may read `APP#*` (the live marker, written by the
// deployer) and `APPDATA#*` items, and put, update and delete in `APPDATA#*` only, naming only
// APP_DATA_WRITE_ATTRIBUTES. A transaction is authorized item by item as PutItem, UpdateItem and
// DeleteItem. No call returns attributes beyond what it names (no ALL_NEW / ALL_OLD).
//
// Cost (try 3): DynamoDB bills a read on the whole item's size, whatever the projection, so a write
// never reads the value item (up to 350 KB since ticket 3.17). Everything a write needs is in the small totals item
// (`DATA_USAGE`): the totals, the daily write count (`writeDay`, `writtenBytes`) and each key's size
// (the map `sizes`, keyed by data key), all changed in the same transaction as the value. The
// transaction's only condition is on the totals item; the value item needs none, because every
// change to a value also changes its `sizes` entry in the same transaction (so the entry always
// holds the stored value's size).
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
  type StoredValue,
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

/** A finite number from a DynamoDB number, or undefined. */
function numberOf(value: AttributeValue | undefined): number | undefined {
  if (value?.N === undefined) return undefined;
  const n = Number(value.N);
  return Number.isFinite(n) ? n : undefined;
}

/** The reasons DynamoDB gives, in item order, when it cancels a transaction. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.map((r) => r.Code);
}

/** A cancellation caused by our conditions or by another transaction on the same items. */
const RACE_CODES = ["ConditionalCheckFailed", "TransactionConflict"];
const isRace = (error: unknown): boolean => cancellationCodes(error)?.some((code) => code !== undefined && RACE_CODES.includes(code)) === true;

/**
 * The daily write budget's part of the totals item's update (UpdateExpression cannot branch, so the
 * branch is chosen from what was read, and the condition fails, for another try, if that changed):
 * - a later write of the day adds its cost, only while the count is still today's and stays within
 *   the budget (count + cost <= budget, written as count <= budget - cost): parallel writes can never
 *   pass the budget;
 * - the first write of a day starts the count at its cost, only while the stored day is older than
 *   today (ISO dates compare as text). A stored day later than today (another instance's clock ahead)
 *   fails the condition like a lost race: the count only ever moves forward, never back to 0.
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
        condition: "(attribute_not_exists(#writeDay) OR #writeDay < :today)",
        values: { ":today": str(charge.today), ":cost": num(charge.cost) },
      };
}

const BUDGET_NAMES = { "#writeDay": "writeDay", "#writtenBytes": "writtenBytes" } as const;

export class DynamoAppDataStore implements AppDataStore {
  constructor(
    private readonly client: AppDataSender,
    private readonly tableName: string,
  ) {}

  private async get(key: ItemKey, attribute: string, consistent: boolean): Promise<AttributeValue | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(key),
        ConsistentRead: consistent,
        ProjectionExpression: "#a",
        ExpressionAttributeNames: { "#a": attribute },
      }),
    );
    return output.Item?.[attribute];
  }

  /** Live only with the marker's `liveAt`, an attribute the data API's role cannot write. */
  async isLive(nickname: string): Promise<boolean> {
    return (await this.get(appLiveKey(nickname), "liveAt", true))?.S !== undefined;
  }

  /**
   * Eventually consistent: half the cost; right after a write it may, rarely, still give the previous value. The writer
   * and time come with it (ticket 3.24): a read bills the whole item whatever the projection, so they cost nothing more.
   */
  async getValue(nickname: string, key: string): Promise<StoredValue | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appDataKey(nickname, key)),
        ConsistentRead: false,
        ProjectionExpression: "#value, #updatedBy, #updatedAt",
        ExpressionAttributeNames: { "#value": "value", "#updatedBy": "updatedBy", "#updatedAt": "updatedAt" },
      }),
    );
    const json = output.Item?.["value"]?.S;
    if (json === undefined) return undefined;
    const updatedBy = output.Item?.["updatedBy"]?.S;
    const updatedAt = output.Item?.["updatedAt"]?.S;
    return { json, ...(updatedBy === undefined ? {} : { updatedBy }), ...(updatedAt === undefined ? {} : { updatedAt }) };
  }

  async getUsage(nickname: string): Promise<AppUsage> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appDataUsageKey(nickname)),
        ConsistentRead: true,
        ProjectionExpression: "#bytes, #keys, #writeDay, #writtenBytes, #sizes",
        ExpressionAttributeNames: { "#bytes": "bytes", "#keys": "keys", ...BUDGET_NAMES, "#sizes": "sizes" },
      }),
    );
    const item = output.Item;
    const sizes = new Map<string, number>();
    for (const [key, value] of Object.entries(item?.["sizes"]?.M ?? {})) {
      const bytes = numberOf(value);
      if (bytes !== undefined && bytes >= 0) sizes.set(key, bytes);
    }
    return {
      bytes: numberOf(item?.["bytes"]) ?? 0,
      keys: numberOf(item?.["keys"]) ?? 0,
      writeDay: item?.["writeDay"]?.S,
      writtenBytes: numberOf(item?.["writtenBytes"]) ?? 0,
      sizes,
      // The first write creates the item with `keys` and `sizes` together, and nothing removes them.
      created: item?.["keys"] !== undefined,
    };
  }

  async putValue(nickname: string, key: string, json: string, bytes: number, previousBytes: number | undefined, created: boolean, nowIso: string, charge: WriteCharge, updatedBy: string): Promise<PutResult> {
    const value = {
      Put: {
        TableName: this.tableName,
        Item: { ...keyOf(appDataKey(nickname, key)), type: str("app-data"), value: str(json), bytes: num(bytes), updatedAt: str(nowIso), updatedBy: str(updatedBy) },
      },
    };
    const budget = budgetParts(charge);
    const usage = created ? this.nextUsage(nickname, key, bytes, previousBytes, nowIso, budget) : this.firstUsage(nickname, key, bytes, nowIso, charge);
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [value, { Update: usage }] }));
      return "saved";
    } catch (error) {
      // A failed condition is a lost race or a limit reached since the read: data.ts reads again.
      if (isRace(error)) return "conflict";
      throw error;
    }
  }

  /** The app's first value: creates the totals item, with the `sizes` map, only while it does not exist. */
  private firstUsage(nickname: string, key: string, bytes: number, nowIso: string, charge: WriteCharge) {
    return {
      TableName: this.tableName,
      Key: keyOf(appDataUsageKey(nickname)),
      UpdateExpression: "SET #type = :type, #bytes = :size, #keys = :one, #updatedAt = :now, #sizes = :sizes, #writeDay = :today, #writtenBytes = :cost",
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk", "#type": "type", "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt", "#sizes": "sizes", ...BUDGET_NAMES },
      ExpressionAttributeValues: {
        ":type": str("app-data-usage"),
        ":size": num(bytes),
        ":one": num(1),
        ":now": str(nowIso),
        ":sizes": { M: { [key]: num(bytes) } },
        ":today": str(charge.today),
        ":cost": num(charge.cost),
      },
    };
  }

  /**
   * A later value: only while the key's size is still the one read (absent for a new key), the new
   * totals stay within the limits (old + delta <= limit, written as old <= limit - delta) and the day's
   * writes within the budget.
   */
  private nextUsage(nickname: string, key: string, bytes: number, previousBytes: number | undefined, nowIso: string, budget: ReturnType<typeof budgetParts>) {
    const bytesDelta = bytes - (previousBytes ?? 0);
    const keysDelta = previousBytes === undefined ? 1 : 0;
    const sizeCondition = previousBytes === undefined ? "attribute_exists(#sizes) AND attribute_not_exists(#sizes.#k)" : "#sizes.#k = :previous";
    return {
      TableName: this.tableName,
      Key: keyOf(appDataUsageKey(nickname)),
      UpdateExpression: `SET #type = :type, #bytes = #bytes + :bytesDelta, #keys = #keys + :keysDelta, #updatedAt = :now, #sizes.#k = :size, ${budget.set}`,
      ConditionExpression: `${sizeCondition} AND #bytes <= :bytesLimit AND #keys <= :keysLimit AND ${budget.condition}`,
      ExpressionAttributeNames: { "#type": "type", "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt", "#sizes": "sizes", "#k": key, ...BUDGET_NAMES },
      ExpressionAttributeValues: {
        ":type": str("app-data-usage"),
        ":bytesDelta": num(bytesDelta),
        ":keysDelta": num(keysDelta),
        ":now": str(nowIso),
        ":size": num(bytes),
        ...(previousBytes === undefined ? {} : { ":previous": num(previousBytes) }),
        ":bytesLimit": num(MAX_APP_DATA_BYTES - bytesDelta),
        ":keysLimit": num(MAX_KEYS - keysDelta),
        ...budget.values,
      },
    };
  }

  async deleteValue(nickname: string, key: string, previousBytes: number, nowIso: string, charge: WriteCharge): Promise<DeleteResult> {
    const budget = budgetParts(charge);
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Delete: { TableName: this.tableName, Key: keyOf(appDataKey(nickname, key)) } },
            {
              Update: {
                TableName: this.tableName,
                Key: keyOf(appDataUsageKey(nickname)),
                UpdateExpression: `SET #bytes = #bytes - :previous, #keys = #keys - :one, #updatedAt = :now, ${budget.set} REMOVE #sizes.#k`,
                ConditionExpression: `#sizes.#k = :previous AND ${budget.condition}`,
                ExpressionAttributeNames: { "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt", "#sizes": "sizes", "#k": key, ...BUDGET_NAMES },
                ExpressionAttributeValues: { ":previous": num(previousBytes), ":one": num(1), ":now": str(nowIso), ...budget.values },
              },
            },
          ],
        }),
      );
      return "deleted";
    } catch (error) {
      if (isRace(error)) return "conflict";
      throw error;
    }
  }
}
