// Ticket 3.4: freeing a build slot (one transaction keyed by the holder item) and counting the builds ahead.
import { QueryCommand, TransactWriteItemsCommand, type QueryCommandOutput, type TransactWriteItemsCommandOutput } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { cancellationCodes, countQueuedAhead, releaseSlot, releaseSlotItems, releaseSlotQuietly, slotCountChange } from "./slots.js";

const TABLE = "ssd-workshop-data";

const cancelled = (...codes: string[]): Error =>
  Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

/** Answers each send with the next entry: an Error is thrown, anything else resolves. */
function sender(answers: (Error | "ok")[]) {
  const sent: { command: TransactWriteItemsCommand; signal: AbortSignal | undefined }[] = [];
  return {
    sent,
    send: async (command: TransactWriteItemsCommand, options?: { abortSignal?: AbortSignal }): Promise<TransactWriteItemsCommandOutput> => {
      sent.push({ command, signal: options?.abortSignal });
      const answer = answers.shift() ?? "ok";
      if (answer instanceof Error) throw answer;
      return { $metadata: {} };
    },
  };
}

const noPause = async (): Promise<void> => {};

describe("releaseSlot", () => {
  it("is one transaction: the build has ended (or is gone), its holder exists and is deleted, the counter goes down", () => {
    const [check, holder, count] = releaseSlotItems(TABLE, "b-1");
    expect(check?.ConditionCheck).toMatchObject({
      Key: { pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } },
      ConditionExpression: "attribute_not_exists(pk) OR NOT (#status IN (:building, :deploying))",
    });
    expect(holder?.Delete).toMatchObject({ Key: { pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#b-1" } }, ConditionExpression: "attribute_exists(pk)" });
    expect(count?.Update).toMatchObject({ Key: { pk: { S: "BUILD_SLOTS" }, sk: { S: "COUNT" } }, ...slotCountChange(-1) });
    expect(slotCountChange(-1).ExpressionAttributeValues).toEqual({ ":delta": { N: "-1" }, ":one": { N: "1" } });
  });

  it("answers true when it freed the slot, and passes the writer's deadline on", async () => {
    const client = sender(["ok"]);
    const signal = new AbortController().signal;
    expect(await releaseSlot(client, TABLE, "b-1", { signal })).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.signal).toBe(signal);
    expect(client.sent[0]?.command.input.TransactItems).toEqual(releaseSlotItems(TABLE, "b-1"));
  });

  it("answers false when a condition fails (slot already freed, or the build still runs): nothing to free", async () => {
    expect(await releaseSlot(sender([cancelled("None", "ConditionalCheckFailed", "None")]), TABLE, "b-1")).toBe(false);
    expect(await releaseSlot(sender([cancelled("ConditionalCheckFailed", "None", "None")]), TABLE, "b-1")).toBe(false);
  });

  it("tries again after a TransactionConflict, at most 3 tries, then throws", async () => {
    const twice = sender([cancelled("None", "None", "TransactionConflict"), cancelled("None", "None", "TransactionConflict"), "ok"]);
    expect(await releaseSlot(twice, TABLE, "b-1", { sleep: noPause })).toBe(true);
    expect(twice.sent).toHaveLength(3);
    const always = sender([1, 2, 3, 4].map(() => cancelled("None", "None", "TransactionConflict")));
    await expect(releaseSlot(always, TABLE, "b-1", { sleep: noPause })).rejects.toThrow("Transaction cancelled");
    expect(always.sent).toHaveLength(3);
  });

  it("throws any other error; releaseSlotQuietly answers false instead (the minute check repairs)", async () => {
    const throttled = Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" });
    await expect(releaseSlot(sender([throttled]), TABLE, "b-1")).rejects.toThrow("slow down");
    expect(await releaseSlotQuietly(sender([throttled]), TABLE, "b-1")).toBe(false);
    expect(await releaseSlotQuietly(sender(["ok"]), TABLE, "b-1")).toBe(true);
  });

  it("reads cancellation codes only from a cancelled transaction", () => {
    expect(cancellationCodes(cancelled("None", "ConditionalCheckFailed"))).toEqual(["None", "ConditionalCheckFailed"]);
    expect(cancellationCodes(new Error("x"))).toBeUndefined();
    expect(cancellationCodes(null)).toBeUndefined();
  });
});

describe("countQueuedAhead", () => {
  it("counts the entries placed earlier and seen recently, page by page, with a strongly consistent COUNT query", async () => {
    const sent: QueryCommand[] = [];
    const pages: QueryCommandOutput[] = [
      { $metadata: {}, Count: 2, LastEvaluatedKey: { pk: { S: "BUILD_QUEUE" }, sk: { S: "a" } } },
      { $metadata: {}, Count: 1 },
    ];
    const client = { send: async (command: QueryCommand): Promise<QueryCommandOutput> => (sent.push(command), pages.shift() ?? { $metadata: {} }) };
    expect(await countQueuedAhead(client, TABLE, "2026-11-25T10:00:00.000Z#b-9", "2026-11-25T09:58:00.000Z")).toBe(3);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.input).toMatchObject({
      KeyConditionExpression: "pk = :pk AND sk < :place",
      FilterExpression: "#lastSeenAt >= :since",
      ExpressionAttributeValues: { ":pk": { S: "BUILD_QUEUE" }, ":place": { S: "2026-11-25T10:00:00.000Z#b-9" }, ":since": { S: "2026-11-25T09:58:00.000Z" } },
      Select: "COUNT",
      ConsistentRead: true,
    });
    expect(sent[0]?.input.ExclusiveStartKey).toBeUndefined();
    expect(sent[1]?.input.ExclusiveStartKey).toEqual({ pk: { S: "BUILD_QUEUE" }, sk: { S: "a" } });
  });
});
