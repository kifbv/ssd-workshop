// The media API's table and bucket access (ticket 3.18). The rules live in ./media.ts.
//
// The function's role (infra/lib/api-stack.ts) may read the live marker's `liveAt` (`APP#*`, GetItem and the finish
// transaction's ConditionCheck), app write tokens (3.24's projected read) and `APPMEDIA#*` items, and put and update
// only in `APPMEDIA#*` (no record is deleted since try 3: every end is a tombstone), naming only APP_MEDIA_WRITE_ATTRIBUTES; in the bucket it may only put and delete under
// `app-media/`. Every transaction is authorized item by item; no call returns an item's attributes.
//
// Items: `APPMEDIA#<nickname>` / `MEDIA_USAGE` (bytes, files, the day's uploads: `uploadDay`, `uploadedBytes`) and
// `APPMEDIA#<nickname>` / `MEDIA#<id>` (bytes, contentType, status `uploading`/`stored`/`deleted`, uploadedBy, createdAt;
// a `deleted` record is a tombstone that keeps its id from being used again).
// Reads are of these small items only (a file's bytes are in S3, never in the table).
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, PutObjectCommand, type DeleteObjectCommandOutput, type PutObjectCommandOutput } from "@aws-sdk/client-s3";
import { appLiveKey, appMediaKey, appMediaUsageKey, type ItemKey } from "../keys.js";
import {
  DAILY_UPLOAD_BUDGET_BYTES,
  MAX_APP_MEDIA_BYTES,
  MAX_APP_MEDIA_FILES,
  MEDIA_CACHE_CONTROL,
  type AppMediaStore,
  type MediaBucket,
  type MediaRecord,
  type MediaUsage,
  type NewMedia,
  type ReserveResult,
  type UploadCharge,
} from "./media.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface AppMediaSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

/** The methods of S3Client the bucket uses. */
export interface MediaBucketSender {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

function numberOf(value: AttributeValue | undefined): number | undefined {
  if (value?.N === undefined) return undefined;
  const n = Number(value.N);
  return Number.isFinite(n) ? n : undefined;
}

/** The reasons DynamoDB gives, in item order, when it cancels a transaction. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}
const RACE_CODES = ["ConditionalCheckFailed", "TransactionConflict"];
const isRace = (error: unknown): boolean => cancellationCodes(error)?.some((code) => code !== undefined && RACE_CODES.includes(code)) === true;

/** How often `finish` tries again when another write on the same items made DynamoDB cancel it (TransactionConflict). */
export const FINISH_ATTEMPTS = 3;

const USAGE_NAMES = { "#bytes": "bytes", "#files": "files", "#updatedAt": "updatedAt", "#uploadDay": "uploadDay", "#uploadedBytes": "uploadedBytes" } as const;

/** The day's upload count, as the data API's daily budget (only forward: a later day never resets to an earlier one). */
function budgetParts(charge: UploadCharge): { set: string; condition: string; values: Record<string, AttributeValue> } {
  return charge.sameDay
    ? {
        set: "#uploadedBytes = #uploadedBytes + :cost",
        condition: "#uploadDay = :today AND #uploadedBytes <= :budgetLimit",
        values: { ":today": str(charge.today), ":cost": num(charge.cost), ":budgetLimit": num(DAILY_UPLOAD_BUDGET_BYTES - charge.cost) },
      }
    : {
        set: "#uploadDay = :today, #uploadedBytes = :cost",
        condition: "(attribute_not_exists(#uploadDay) OR #uploadDay < :today)",
        values: { ":today": str(charge.today), ":cost": num(charge.cost) },
      };
}

export class DynamoAppMediaStore implements AppMediaStore {
  constructor(
    private readonly client: AppMediaSender,
    private readonly tableName: string,
    private readonly pause: () => Promise<void> = async () => {},
  ) {}

  private async get(key: ItemKey, names: Record<string, string>): Promise<Record<string, AttributeValue> | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(key), ConsistentRead: true, ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names }),
    );
    return output.Item;
  }

  private async transact(items: TransactWriteItem[]): Promise<void> {
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
  }

  /** Live only with the marker's `liveAt`, which only the deployer writes. */
  async isLive(nickname: string): Promise<boolean> {
    return (await this.get(appLiveKey(nickname), { "#liveAt": "liveAt" }))?.["liveAt"]?.S !== undefined;
  }

  async getUsage(nickname: string): Promise<MediaUsage> {
    const item = await this.get(appMediaUsageKey(nickname), { "#bytes": "bytes", "#files": "files", "#uploadDay": "uploadDay", "#uploadedBytes": "uploadedBytes" });
    return {
      bytes: numberOf(item?.["bytes"]) ?? 0,
      files: numberOf(item?.["files"]) ?? 0,
      uploadDay: item?.["uploadDay"]?.S,
      uploadedBytes: numberOf(item?.["uploadedBytes"]) ?? 0,
      // The first upload creates the item with `files`, and nothing removes it but a reset.
      created: item?.["files"] !== undefined,
    };
  }

  async getRecord(nickname: string, id: string): Promise<MediaRecord | undefined> {
    const item = await this.get(appMediaKey(nickname, id), { "#bytes": "bytes", "#status": "status", "#createdAt": "createdAt" });
    const bytes = numberOf(item?.["bytes"]);
    const status = item?.["status"]?.S;
    const createdAt = item?.["createdAt"]?.S;
    if (bytes === undefined || (status !== "uploading" && status !== "stored" && status !== "deleted") || createdAt === undefined) return undefined;
    return { bytes, status, createdAt };
  }

  async reserve(nickname: string, id: string, file: NewMedia, nowIso: string, created: boolean, charge: UploadCharge): Promise<ReserveResult> {
    const record: TransactWriteItem = {
      Put: {
        TableName: this.tableName,
        Item: {
          ...keyOf(appMediaKey(nickname, id)),
          type: str("app-media"),
          bytes: num(file.bytes),
          contentType: str(file.contentType),
          status: str("uploading"),
          uploadedBy: str(file.uploadedBy),
          createdAt: str(nowIso),
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    };
    const budget = budgetParts(charge);
    const usage: TransactWriteItem = {
      Update: created
        ? {
            TableName: this.tableName,
            Key: keyOf(appMediaUsageKey(nickname)),
            UpdateExpression: `SET #type = :type, #bytes = #bytes + :size, #files = #files + :one, #updatedAt = :now, ${budget.set}`,
            // Old + this file <= limit, written as old <= limit - this file: parallel uploads can never pass it.
            ConditionExpression: `attribute_exists(#files) AND #bytes <= :bytesLimit AND #files <= :filesLimit AND ${budget.condition}`,
            ExpressionAttributeNames: { "#type": "type", ...USAGE_NAMES },
            ExpressionAttributeValues: {
              ":type": str("app-media-usage"),
              ":size": num(file.bytes),
              ":one": num(1),
              ":now": str(nowIso),
              ":bytesLimit": num(MAX_APP_MEDIA_BYTES - file.bytes),
              ":filesLimit": num(MAX_APP_MEDIA_FILES - 1),
              ...budget.values,
            },
          }
        : {
            TableName: this.tableName,
            Key: keyOf(appMediaUsageKey(nickname)),
            UpdateExpression: "SET #type = :type, #bytes = :size, #files = :one, #updatedAt = :now, #uploadDay = :today, #uploadedBytes = :cost",
            ConditionExpression: "attribute_not_exists(#files)",
            ExpressionAttributeNames: { "#type": "type", ...USAGE_NAMES },
            ExpressionAttributeValues: { ":type": str("app-media-usage"), ":size": num(file.bytes), ":one": num(1), ":now": str(nowIso), ":today": str(charge.today), ":cost": num(charge.cost) },
          },
    };
    try {
      await this.transact([record, usage]);
      return "reserved";
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes?.[0] === "ConditionalCheckFailed") return "taken";
      if (isRace(error)) return "conflict";
      throw error;
    }
  }

  async finish(nickname: string, id: string): Promise<boolean> {
    const items: TransactWriteItem[] = [
      {
        Update: {
          TableName: this.tableName,
          Key: keyOf(appMediaKey(nickname, id)),
          UpdateExpression: "SET #status = :stored",
          ConditionExpression: "#status = :uploading",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":stored": str("stored"), ":uploading": str("uploading") },
        },
      },
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: keyOf(appLiveKey(nickname)),
          ConditionExpression: "attribute_exists(#liveAt)",
          ExpressionAttributeNames: { "#liveAt": "liveAt" },
        },
      },
    ];
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.transact(items);
        return true;
      } catch (error) {
        const codes = cancellationCodes(error);
        // A failed condition: the record is gone or no longer uploading, or the app is no longer live.
        if (codes?.includes("ConditionalCheckFailed") === true) return false;
        // Another write on one of the items at the same moment (the deployer touching the live marker): try again.
        if (codes?.includes("TransactionConflict") !== true || attempt >= FINISH_ATTEMPTS) throw error;
        await this.pause();
      }
    }
  }

  /** The totals' part of giving a file's room back (not the day's uploads, which stay counted). */
  private giveBack(nickname: string, bytes: number, nowIso: string): TransactWriteItem {
    return {
      Update: {
        TableName: this.tableName,
        Key: keyOf(appMediaUsageKey(nickname)),
        UpdateExpression: "SET #bytes = #bytes - :size, #files = #files - :one, #updatedAt = :now",
        ConditionExpression: "attribute_exists(#files)",
        ExpressionAttributeNames: { "#bytes": "bytes", "#files": "files", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":size": num(bytes), ":one": num(1), ":now": str(nowIso) },
      },
    };
  }

  async release(nickname: string, id: string, bytes: number, nowIso: string): Promise<void> {
    try {
      await this.transact([
        {
          // A tombstone (try 3), never a delete: the failed put may have reached S3 (and a cache) before its key was
          // deleted again, so the id must never serve other bytes later.
          Update: {
            TableName: this.tableName,
            Key: keyOf(appMediaKey(nickname, id)),
            UpdateExpression: "SET #status = :deleted",
            ConditionExpression: "#status = :uploading AND #bytes = :size",
            ExpressionAttributeNames: { "#status": "status", "#bytes": "bytes" },
            ExpressionAttributeValues: { ":deleted": str("deleted"), ":uploading": str("uploading"), ":size": num(bytes) },
          },
        },
        this.giveBack(nickname, bytes, nowIso),
      ]);
    } catch (error) {
      // Already gone (a reset, a DELETE of a dead upload): nothing to give back.
      if (!isRace(error)) throw error;
    }
  }

  /**
   * The record stays as a tombstone (`deleted`), so a later PUT of the same id finds it and answers 409: an address
   * never serves other bytes than it first did. Only a reset deletes tombstones.
   */
  async remove(nickname: string, id: string, record: MediaRecord, nowIso: string): Promise<"deleted" | "conflict"> {
    try {
      await this.transact([
        {
          Update: {
            TableName: this.tableName,
            Key: keyOf(appMediaKey(nickname, id)),
            UpdateExpression: "SET #status = :deleted",
            ConditionExpression: "#status = :status AND #bytes = :size",
            ExpressionAttributeNames: { "#status": "status", "#bytes": "bytes" },
            ExpressionAttributeValues: { ":deleted": str("deleted"), ":status": str(record.status), ":size": num(record.bytes) },
          },
        },
        this.giveBack(nickname, record.bytes, nowIso),
      ]);
      return "deleted";
    } catch (error) {
      if (isRace(error)) return "conflict";
      throw error;
    }
  }
}

/** The media bucket: one object per file, with its fixed type and long cache header (MEDIA_CACHE_CONTROL). */
export class S3MediaBucket implements MediaBucket {
  constructor(
    private readonly client: MediaBucketSender,
    private readonly bucketName: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: body, ContentType: contentType, CacheControl: MEDIA_CACHE_CONTROL, ContentLength: body.length }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }
}
