import { GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { APP_DATA_WRITE_ATTRIBUTES } from "../../../infra/lib/config.js";
import { MAX_APP_DATA_BYTES, MAX_KEYS } from "./data.js";
import { DynamoAppDataStore, type AppDataSender } from "./store.js";

type Sent = GetItemCommand | TransactWriteItemsCommand;

function stubClient(answers: (Record<string, unknown> | Error)[]): { client: AppDataSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as AppDataSender;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const NOW_ISO = "2026-11-24T10:00:00.000Z";
const cancelled = (codes: string[]): Error =>
  Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

/** Every attribute name a transaction writes or tests; also checks every placeholder is defined and used. */
function namesUsed(command: Sent | undefined): string[] {
  const items = (command?.input as { TransactItems?: TransactWriteItem[] }).TransactItems ?? [];
  const names: string[] = [];
  for (const item of items) {
    const part = item.Put ?? item.Update ?? item.Delete;
    const update = item.Update?.UpdateExpression ?? "";
    const text = `${update} ${part?.ConditionExpression ?? ""}`;
    const used = new Set(text.match(/[#:][A-Za-z_]+/g) ?? []);
    const defined = new Set([...Object.keys(part?.ExpressionAttributeNames ?? {}), ...Object.keys(part?.ExpressionAttributeValues ?? {})]);
    expect([...used].sort(), text).toEqual([...defined].sort());
    names.push(...Object.keys(item.Put?.Item ?? {}), ...Object.keys(item.Update?.Key ?? item.Delete?.Key ?? {}), ...Object.values(part?.ExpressionAttributeNames ?? {}));
  }
  return names;
}

const items = (command: Sent | undefined): TransactWriteItem[] => (command as TransactWriteItemsCommand).input.TransactItems ?? [];

describe("DynamoAppDataStore", () => {
  it("reads the live marker of the lower-cased nickname, requiring liveAt", async () => {
    const { client, sent } = stubClient([{ Item: { liveAt: { S: NOW_ISO } } }, { Item: {} }, {}]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.isLive("Ada-42")).resolves.toBe(true);
    await expect(store.isLive("Ada-42")).resolves.toBe(false);
    await expect(store.isLive("Ada-42")).resolves.toBe(false);
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "APP#ada-42" }, sk: { S: "LIVE" } },
      ConsistentRead: true,
      ProjectionExpression: "#a",
      ExpressionAttributeNames: { "#a": "liveAt" },
    });
  });

  it("reads a value's text, its size and the app's totals with consistent reads", async () => {
    const { client, sent } = stubClient([
      { Item: { value: { S: '{"a":1}' } } },
      {},
      { Item: { bytes: { N: "7" } } },
      {},
      { Item: { bytes: { N: "120" }, keys: { N: "3" } } },
      {},
    ]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.getValue("Ada-42", "score")).resolves.toBe('{"a":1}');
    await expect(store.getValue("Ada-42", "score")).resolves.toBeUndefined();
    await expect(store.getValueBytes("Ada-42", "score")).resolves.toBe(7);
    await expect(store.getValueBytes("Ada-42", "score")).resolves.toBeUndefined();
    await expect(store.getUsage("Ada-42")).resolves.toEqual({ bytes: 120, keys: 3 });
    await expect(store.getUsage("Ada-42")).resolves.toEqual({ bytes: 0, keys: 0 });
    expect(sent[0]?.input).toMatchObject({ Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA#score" } }, ConsistentRead: true, ExpressionAttributeNames: { "#a": "value" } });
    expect(sent[2]?.input).toMatchObject({ ExpressionAttributeNames: { "#a": "bytes" }, ConsistentRead: true });
    expect(sent[4]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA_USAGE" } },
      ConsistentRead: true,
      ProjectionExpression: "#bytes, #keys",
      ExpressionAttributeNames: { "#bytes": "bytes", "#keys": "keys" },
    });
  });

  it("stores a new value and adds it to the totals in one transaction, conditional on the limits", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoAppDataStore(client, TABLE).putValue("Ada-42", "score", "42", 2, undefined, NOW_ISO)).resolves.toBe("saved");
    expect(sent[0]).toBeInstanceOf(TransactWriteItemsCommand);
    expect(sent[0]?.input).toEqual({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: {
              pk: { S: "APPDATA#ada-42" },
              sk: { S: "DATA#score" },
              type: { S: "app-data" },
              value: { S: "42" },
              bytes: { N: "2" },
              updatedAt: { S: NOW_ISO },
            },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA_USAGE" } },
            UpdateExpression:
              "SET #type = :type, #bytes = if_not_exists(#bytes, :zero) + :bytesDelta, #keys = if_not_exists(#keys, :zero) + :keysDelta, #updatedAt = :now",
            ConditionExpression: "attribute_not_exists(#pk) OR (#bytes <= :bytesLimit AND #keys <= :keysLimit)",
            ExpressionAttributeNames: { "#pk": "pk", "#type": "type", "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt" },
            ExpressionAttributeValues: {
              ":type": { S: "app-data-usage" },
              ":zero": { N: "0" },
              ":bytesDelta": { N: "2" },
              ":keysDelta": { N: "1" },
              ":now": { S: NOW_ISO },
              ":bytesLimit": { N: String(MAX_APP_DATA_BYTES - 2) },
              ":keysLimit": { N: String(MAX_KEYS - 1) },
            },
          },
        },
      ],
    });
    namesUsed(sent[0]);
  });

  it("replaces a value only over the size it read, moving the totals by the difference (no new key)", async () => {
    const { client, sent } = stubClient([{}, {}]);
    const store = new DynamoAppDataStore(client, TABLE);
    await store.putValue("Ada-42", "score", '"abcdefgh"', 10, 300, NOW_ISO);
    const [put, usage] = items(sent[0]);
    expect(put?.Put).toMatchObject({ ConditionExpression: "#bytes = :previous", ExpressionAttributeNames: { "#bytes": "bytes" }, ExpressionAttributeValues: { ":previous": { N: "300" } } });
    expect(usage?.Update?.ExpressionAttributeValues).toMatchObject({
      ":bytesDelta": { N: "-290" },
      ":keysDelta": { N: "0" },
      ":bytesLimit": { N: String(MAX_APP_DATA_BYTES + 290) },
      ":keysLimit": { N: String(MAX_KEYS) },
    });
    namesUsed(sent[0]);
    await store.putValue("Ada-42", "score", "1", 1, 0, NOW_ISO);
    expect(items(sent[1])[0]?.Put?.ExpressionAttributeValues).toEqual({ ":previous": { N: "0" } });
  });

  it("tells a limit (the totals' condition) from a race, and passes other errors on", async () => {
    const { client } = stubClient([
      cancelled(["None", "ConditionalCheckFailed"]),
      cancelled(["ConditionalCheckFailed", "ConditionalCheckFailed"]),
      cancelled(["ConditionalCheckFailed", "None"]),
      cancelled(["TransactionConflict", "None"]),
      cancelled(["ValidationError", "None"]),
      Object.assign(new Error("x"), { name: "InternalServerError" }),
    ]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.putValue("ada", "k", "1", 1, undefined, NOW_ISO)).resolves.toBe("limit");
    await expect(store.putValue("ada", "k", "1", 1, undefined, NOW_ISO)).resolves.toBe("limit");
    await expect(store.putValue("ada", "k", "1", 1, undefined, NOW_ISO)).resolves.toBe("conflict");
    await expect(store.putValue("ada", "k", "1", 1, undefined, NOW_ISO)).resolves.toBe("conflict");
    await expect(store.putValue("ada", "k", "1", 1, undefined, NOW_ISO)).rejects.toThrow("cancelled");
    await expect(store.putValue("ada", "k", "1", 1, undefined, NOW_ISO)).rejects.toThrow("x");
  });

  it("deletes a value only over the size it read and takes it off the totals in one transaction", async () => {
    const { client, sent } = stubClient([{}, cancelled(["ConditionalCheckFailed", "None"]), cancelled(["None", "TransactionConflict"]), new Error("boom")]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO)).resolves.toBe("deleted");
    expect(sent[0]?.input).toEqual({
      TransactItems: [
        {
          Delete: {
            TableName: TABLE,
            Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA#score" } },
            ConditionExpression: "#bytes = :previous",
            ExpressionAttributeNames: { "#bytes": "bytes" },
            ExpressionAttributeValues: { ":previous": { N: "12" } },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA_USAGE" } },
            UpdateExpression: "SET #bytes = #bytes - :bytes, #keys = #keys - :one, #updatedAt = :now",
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk", "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt" },
            ExpressionAttributeValues: { ":bytes": { N: "12" }, ":one": { N: "1" }, ":now": { S: NOW_ISO } },
          },
        },
      ],
    });
    namesUsed(sent[0]);
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO)).resolves.toBe("conflict");
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO)).resolves.toBe("conflict");
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO)).rejects.toThrow("boom");
  });

  it("writes only in APPDATA# partitions and names only the attributes the role allows (never liveAt)", async () => {
    const { client, sent } = stubClient([{}, {}, {}]);
    const store = new DynamoAppDataStore(client, TABLE);
    await store.putValue("Ada-42", "k", "1", 1, undefined, NOW_ISO);
    await store.putValue("Ada-42", "k", "1", 1, 5, NOW_ISO);
    await store.deleteValue("Ada-42", "k", 1, NOW_ISO);
    for (const command of sent) {
      const names = namesUsed(command);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(APP_DATA_WRITE_ATTRIBUTES).toContain(name);
      for (const item of items(command)) {
        const key = item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key;
        expect(key?.["pk"]?.S).toMatch(/^APPDATA#/);
        expect(item.Put?.ReturnValuesOnConditionCheckFailure ?? item.Update?.ReturnValuesOnConditionCheckFailure).toBeUndefined();
      }
    }
    expect(APP_DATA_WRITE_ATTRIBUTES).not.toContain("liveAt");
  });
});
