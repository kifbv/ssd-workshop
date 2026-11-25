/**
 * Build slots (ticket 3.4): at most `buildsAtOnce` builds hold a slot at once. The launcher's claim takes one (adds a
 * holder item and counts `running` up, in the claim's transaction, only while `running` is under the cap); this module
 * frees one. The deployer (live and failed) and the launcher (its failures and its check's) call `releaseSlotQuietly`
 * after their own terminal write; the builder task does not (it runs next to the AI agent and has no right on the slots:
 * its failed builds are freed by the launcher's check within a minute). One transaction that
 *
 * - checks the build is no longer `building` or `deploying` (or gone): a late release never frees a running build's slot,
 * - deletes the build's holder item, only while it exists (so a slot is freed exactly once, whoever comes first),
 * - counts `running` down (and `version` up, so the check's repair can tell the counter moved).
 *
 * A release that finds no holder (already freed, or a build launched before ticket 3.4) changes nothing. A failed
 * release is left to the launcher's check, which every minute frees the holders of builds no longer running and sets the
 * counter to the number of holders left.
 *
 * Its names are SLOT_RELEASE_ATTRIBUTES and SLOT_RELEASE_CHECK_ATTRIBUTES in infra/lib/config.ts (the deployer has
 * exactly these rights, checked on the synth output; the launcher has more).
 */
import {
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type QueryCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { BUILD_QUEUE_PK, buildKey, slotCountKey, slotHolderKey, type ItemKey } from "../keys.js";

export interface SlotReleaseSender {
  send(command: TransactWriteItemsCommand, options?: { abortSignal?: AbortSignal }): Promise<TransactWriteItemsCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

/** The counter's update when a slot is taken (+1) or freed (-1): `version` always goes up. */
export function slotCountChange(delta: 1 | -1): { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, AttributeValue> } {
  return {
    UpdateExpression: "ADD #running :delta, #version :one",
    ExpressionAttributeNames: { "#running": "running", "#version": "version" },
    ExpressionAttributeValues: { ":delta": { N: String(delta) }, ":one": { N: "1" } },
  };
}

/** The release transaction's three items (exported for the stores' tests). */
export function releaseSlotItems(table: string, buildId: string): TransactWriteItem[] {
  return [
    {
      ConditionCheck: {
        TableName: table,
        Key: keyOf(buildKey(buildId)),
        ConditionExpression: "attribute_not_exists(pk) OR NOT (#status IN (:building, :deploying))",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":building": str("building"), ":deploying": str("deploying") },
      },
    },
    { Delete: { TableName: table, Key: keyOf(slotHolderKey(buildId)), ConditionExpression: "attribute_exists(pk)" } },
    { Update: { TableName: table, Key: keyOf(slotCountKey()), ...slotCountChange(-1) } },
  ];
}

/** The cancellation reasons of a cancelled transaction, or undefined for any other error. */
export function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: unknown } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((reason) => reason.Code);
}

/** Writes to one item cancel each other on DynamoDB (TransactionConflict): pause 20 to 80 ms before another try. */
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 60)));

/**
 * Frees the build's slot: true when it held one (now freed), false when there was nothing to free or the build still
 * runs. Throws on any other error (after three tries on a TransactionConflict).
 */
export async function releaseSlot(
  client: SlotReleaseSender,
  table: string,
  buildId: string,
  options: { signal?: AbortSignal; sleep?: () => Promise<void> } = {},
): Promise<boolean> {
  const command = (): TransactWriteItemsCommand => new TransactWriteItemsCommand({ TransactItems: releaseSlotItems(table, buildId) });
  for (let attempt = 1; ; attempt += 1) {
    try {
      // A writer cut off by its deadline (the deployer) stops this request too.
      await (options.signal === undefined ? client.send(command()) : client.send(command(), { abortSignal: options.signal }));
      return true;
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes === undefined) throw error;
      if (codes.includes("ConditionalCheckFailed")) return false;
      if (!codes.includes("TransactionConflict") || attempt >= 3) throw error;
      await (options.sleep ?? pause)();
    }
  }
}

/** releaseSlot for a writer that has already ended the build: an error is left to the launcher's check (every minute). */
export async function releaseSlotQuietly(client: SlotReleaseSender, table: string, buildId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return await releaseSlot(client, table, buildId, signal === undefined ? {} : { signal });
  } catch {
    return false;
  }
}

export interface QueueCountSender {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

/**
 * The builds ahead of `queueKey` in the waiting line: entries with an earlier place whose message was seen at or after
 * `sinceIso` (QUEUE_SEEN_MS ago). A Query with `Select` `COUNT` only (QUEUE_COUNT_ATTRIBUTES in infra/lib/config.ts),
 * page by page. Used by the launcher (start order) and by `GET /api/build` (the page's "builds ahead").
 */
export async function countQueuedAhead(client: QueueCountSender, table: string, queueKey: string, sinceIso: string): Promise<number> {
  let count = 0;
  let start: Record<string, AttributeValue> | undefined;
  do {
    const answer = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND sk < :place",
        FilterExpression: "#lastSeenAt >= :since",
        ExpressionAttributeNames: { "#lastSeenAt": "lastSeenAt" },
        ExpressionAttributeValues: { ":pk": str(BUILD_QUEUE_PK), ":place": str(queueKey), ":since": str(sinceIso) },
        Select: "COUNT",
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }),
    );
    count += answer.Count ?? 0;
    start = answer.LastEvaluatedKey;
  } while (start !== undefined);
  return count;
}
