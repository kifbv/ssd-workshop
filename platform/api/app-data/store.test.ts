import { GetItemCommand, TransactWriteItemsCommand, type AttributeValue, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { APP_DATA_WRITE_ATTRIBUTES } from "../../../infra/lib/config.js";
import {
  DAILY_WRITE_BUDGET_BYTES,
  MAX_APP_DATA_BYTES,
  MAX_KEYS,
  MAX_VALUE_BYTES,
  USAGE_ENTRY_BYTES,
  USAGE_ITEM_BASE_BYTES,
  usageItemBytes,
  VALUE_ITEM_OVERHEAD_BYTES,
  type WriteCharge,
} from "./data.js";
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
const TODAY = "2026-11-24";
/** A write on a day that already has writes (adds to the count) and the first write of a day (starts it). */
const SAME_DAY: WriteCharge = { today: TODAY, cost: 2048, sameDay: true };
const NEW_DAY: WriteCharge = { today: TODAY, cost: 2048, sameDay: false };
const cancelled = (codes: string[]): Error =>
  Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

/**
 * The top-level attribute names a transaction writes or tests (what IAM's `dynamodb:Attributes` sees:
 * for `sizes.<key>` only `sizes`). Also checks that every placeholder is defined and used, and that
 * the data key's placeholder `#k` is only ever a map key inside `sizes`, never an attribute of its own.
 */
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
    const attributeNames = part?.ExpressionAttributeNames ?? {};
    for (const path of text.match(/#[A-Za-z_]+(?:\.#[A-Za-z_]+)*/g) ?? []) {
      const [top = "", ...nested] = path.split(".");
      expect(top, text).not.toBe("#k");
      names.push(attributeNames[top] ?? `undefined ${top}`);
      for (const inner of nested) {
        expect(top, text).toBe("#sizes");
        expect(inner, text).toBe("#k");
      }
    }
    names.push(...Object.keys(item.Put?.Item ?? {}), ...Object.keys(item.Update?.Key ?? item.Delete?.Key ?? {}));
  }
  return names;
}

/** DynamoDB's item size limit: 400 KB, attribute names and values together. */
const DYNAMODB_ITEM_LIMIT_BYTES = 400 * 1024;

/**
 * An attribute value's size as DynamoDB counts it: a string's UTF-8 bytes; a number about one byte per
 * two significant digits plus one; a map 3 bytes plus each entry's name, value and 1 byte.
 */
function attributeBytes(value: AttributeValue): number {
  if (value.S !== undefined) return Buffer.byteLength(value.S, "utf8");
  if (value.N !== undefined) return Math.ceil(value.N.replace(/[-.]/g, "").replace(/^0+/, "").length / 2) + 1;
  if (value.M !== undefined) return 3 + Object.entries(value.M).reduce((sum, [name, inner]) => sum + Buffer.byteLength(name, "utf8") + attributeBytes(inner) + 1, 0);
  throw new Error("unexpected attribute type");
}

const itemBytes = (item: Record<string, AttributeValue>): number =>
  Object.entries(item).reduce((sum, [name, value]) => sum + Buffer.byteLength(name, "utf8") + attributeBytes(value), 0);

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

  it("reads a value's text, writer and time with an eventually consistent read (half the cost of a consistent one)", async () => {
    const { client, sent } = stubClient([
      { Item: { value: { S: '{"a":1}' }, updatedBy: { S: "Bob" }, updatedAt: { S: NOW_ISO } } },
      { Item: { value: { S: "2" } } },
      {},
    ]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.getValue("Ada-42", "score")).resolves.toStrictEqual({ json: '{"a":1}', updatedBy: "Bob", updatedAt: NOW_ISO });
    // A value from before ticket 3.24 has no writer.
    await expect(store.getValue("Ada-42", "score")).resolves.toStrictEqual({ json: "2" });
    await expect(store.getValue("Ada-42", "score")).resolves.toBeUndefined();
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA#score" } },
      ConsistentRead: false,
      ProjectionExpression: "#value, #updatedBy, #updatedAt",
      ExpressionAttributeNames: { "#value": "value", "#updatedBy": "updatedBy", "#updatedAt": "updatedAt" },
    });
  });

  it("reads the app's totals, daily count and every key's size from the totals item alone, consistently", async () => {
    const { client, sent } = stubClient([
      { Item: { bytes: { N: "120" }, keys: { N: "2" }, writeDay: { S: TODAY }, writtenBytes: { N: "4096" }, sizes: { M: { score: { N: "100" }, ["__proto__"]: { N: "20" } } } } },
      {},
      { Item: { bytes: { N: "0" }, keys: { N: "0" }, sizes: { M: {} } } },
    ]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.getUsage("Ada-42")).resolves.toStrictEqual({
      bytes: 120,
      keys: 2,
      writeDay: TODAY,
      writtenBytes: 4096,
      sizes: new Map([
        ["score", 100],
        ["__proto__", 20],
      ]),
      created: true,
    });
    await expect(store.getUsage("Ada-42")).resolves.toStrictEqual({ bytes: 0, keys: 0, writeDay: undefined, writtenBytes: 0, sizes: new Map(), created: false });
    await expect(store.getUsage("Ada-42")).resolves.toMatchObject({ created: true, sizes: new Map() });
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA_USAGE" } },
      ConsistentRead: true,
      ProjectionExpression: "#bytes, #keys, #writeDay, #writtenBytes, #sizes",
      ExpressionAttributeNames: { "#bytes": "bytes", "#keys": "keys", "#writeDay": "writeDay", "#writtenBytes": "writtenBytes", "#sizes": "sizes" },
    });
    expect(sent.every((command) => command instanceof GetItemCommand)).toBe(true);
  });

  it("creates the totals item with the first value of an app, only while it does not exist yet", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoAppDataStore(client, TABLE).putValue("Ada-42", "score", "42", 2, undefined, false, NOW_ISO, NEW_DAY, "Bob")).resolves.toBe("saved");
    expect(sent[0]).toBeInstanceOf(TransactWriteItemsCommand);
    expect(sent[0]?.input).toEqual({
      TransactItems: [
        {
          // No condition: the totals item's condition covers it (see "never reads or tests the value item").
          Put: {
            TableName: TABLE,
            Item: {
              pk: { S: "APPDATA#ada-42" },
              sk: { S: "DATA#score" },
              type: { S: "app-data" },
              value: { S: "42" },
              bytes: { N: "2" },
              updatedAt: { S: NOW_ISO },
              updatedBy: { S: "Bob" },
            },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA_USAGE" } },
            UpdateExpression: "SET #type = :type, #bytes = :size, #keys = :one, #updatedAt = :now, #sizes = :sizes, #writeDay = :today, #writtenBytes = :cost",
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: {
              "#pk": "pk",
              "#type": "type",
              "#bytes": "bytes",
              "#keys": "keys",
              "#updatedAt": "updatedAt",
              "#sizes": "sizes",
              "#writeDay": "writeDay",
              "#writtenBytes": "writtenBytes",
            },
            ExpressionAttributeValues: {
              ":type": { S: "app-data-usage" },
              ":size": { N: "2" },
              ":one": { N: "1" },
              ":now": { S: NOW_ISO },
              ":sizes": { M: { score: { N: "2" } } },
              ":today": { S: TODAY },
              ":cost": { N: "2048" },
            },
          },
        },
      ],
    });
    namesUsed(sent[0]);
  });

  it("adds a new key only while the totals item has no size for it, and within the limits and today's budget", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoAppDataStore(client, TABLE).putValue("Ada-42", "high-score", "42", 2, undefined, true, NOW_ISO, SAME_DAY, "Bob")).resolves.toBe("saved");
    const [put, usage] = items(sent[0]);
    expect(put?.Put?.ConditionExpression).toBeUndefined();
    expect(usage?.Update).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA_USAGE" } },
      UpdateExpression:
        "SET #type = :type, #bytes = #bytes + :bytesDelta, #keys = #keys + :keysDelta, #updatedAt = :now, #sizes.#k = :size, #writtenBytes = #writtenBytes + :cost",
      ConditionExpression:
        "attribute_exists(#sizes) AND attribute_not_exists(#sizes.#k) AND #bytes <= :bytesLimit AND #keys <= :keysLimit AND #writeDay = :today AND #writtenBytes <= :budgetLimit",
      ExpressionAttributeNames: {
        "#type": "type",
        "#bytes": "bytes",
        "#keys": "keys",
        "#updatedAt": "updatedAt",
        "#sizes": "sizes",
        // The data key goes through a placeholder (it may hold dashes); IAM sees only `sizes`.
        "#k": "high-score",
        "#writeDay": "writeDay",
        "#writtenBytes": "writtenBytes",
      },
      ExpressionAttributeValues: {
        ":type": { S: "app-data-usage" },
        ":bytesDelta": { N: "2" },
        ":keysDelta": { N: "1" },
        ":now": { S: NOW_ISO },
        ":size": { N: "2" },
        ":bytesLimit": { N: String(MAX_APP_DATA_BYTES - 2) },
        ":keysLimit": { N: String(MAX_KEYS - 1) },
        ":today": { S: TODAY },
        ":cost": { N: "2048" },
        ":budgetLimit": { N: String(DAILY_WRITE_BUDGET_BYTES - 2048) },
      },
    });
    namesUsed(sent[0]);
  });

  it("replaces a value only while the totals item still holds the size it read, moving the totals by the difference (no new key)", async () => {
    const { client, sent } = stubClient([{}, {}]);
    const store = new DynamoAppDataStore(client, TABLE);
    await store.putValue("Ada-42", "score", '"abcdefgh"', 10, 300, true, NOW_ISO, SAME_DAY, "Bob");
    const [put, usage] = items(sent[0]);
    expect(put?.Put?.ConditionExpression).toBeUndefined();
    expect(usage?.Update?.ConditionExpression).toBe(
      "#sizes.#k = :previous AND #bytes <= :bytesLimit AND #keys <= :keysLimit AND #writeDay = :today AND #writtenBytes <= :budgetLimit",
    );
    expect(usage?.Update?.ExpressionAttributeValues).toMatchObject({
      ":previous": { N: "300" },
      ":size": { N: "10" },
      ":bytesDelta": { N: "-290" },
      ":keysDelta": { N: "0" },
      ":bytesLimit": { N: String(MAX_APP_DATA_BYTES + 290) },
      ":keysLimit": { N: String(MAX_KEYS) },
    });
    namesUsed(sent[0]);
    await store.putValue("Ada-42", "score", "1", 1, 0, true, NOW_ISO, SAME_DAY, "Bob");
    expect(items(sent[1])[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":previous": { N: "0" } });
  });

  it("on the first write of a day, starts the count only while the stored day is older (ISO dates compare as text): never resets a later day", async () => {
    const { client, sent } = stubClient([{}]);
    await new DynamoAppDataStore(client, TABLE).putValue("Ada-42", "score", "42", 2, 7, true, NOW_ISO, NEW_DAY, "Bob");
    const usage = items(sent[0])[1]?.Update;
    expect(usage?.UpdateExpression).toBe(
      "SET #type = :type, #bytes = #bytes + :bytesDelta, #keys = #keys + :keysDelta, #updatedAt = :now, #sizes.#k = :size, #writeDay = :today, #writtenBytes = :cost",
    );
    expect(usage?.ConditionExpression).toBe(
      "#sizes.#k = :previous AND #bytes <= :bytesLimit AND #keys <= :keysLimit AND (attribute_not_exists(#writeDay) OR #writeDay < :today)",
    );
    expect(usage?.ExpressionAttributeValues).toMatchObject({ ":today": { S: TODAY }, ":cost": { N: "2048" } });
    expect(usage?.ExpressionAttributeValues?.[":budgetLimit"]).toBeUndefined();
    namesUsed(sent[0]);
    // The comparison the condition relies on.
    expect("2026-11-23" < TODAY && "2025-12-31" < TODAY && !("2026-11-25" < TODAY) && !(TODAY < TODAY)).toBe(true);
  });

  it("treats any cancellation by a condition or another transaction as a race (read again), and passes other errors on", async () => {
    const { client } = stubClient([
      cancelled(["None", "ConditionalCheckFailed"]),
      cancelled(["None", "TransactionConflict"]),
      cancelled(["TransactionConflict", "None"]),
      cancelled(["ValidationError", "None"]),
      Object.assign(new Error("x"), { name: "InternalServerError" }),
    ]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.putValue("ada", "k", "1", 1, undefined, true, NOW_ISO, SAME_DAY, "Bob")).resolves.toBe("conflict");
    await expect(store.putValue("ada", "k", "1", 1, undefined, true, NOW_ISO, SAME_DAY, "Bob")).resolves.toBe("conflict");
    await expect(store.putValue("ada", "k", "1", 1, undefined, true, NOW_ISO, SAME_DAY, "Bob")).resolves.toBe("conflict");
    await expect(store.putValue("ada", "k", "1", 1, undefined, true, NOW_ISO, SAME_DAY, "Bob")).rejects.toThrow("cancelled");
    await expect(store.putValue("ada", "k", "1", 1, undefined, true, NOW_ISO, SAME_DAY, "Bob")).rejects.toThrow("x");
  });

  it("deletes a value only while the totals item still holds the size it read, taking it off the totals in one transaction", async () => {
    const { client, sent } = stubClient([{}, cancelled(["None", "ConditionalCheckFailed"]), cancelled(["None", "TransactionConflict"]), new Error("boom")]);
    const store = new DynamoAppDataStore(client, TABLE);
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO, SAME_DAY)).resolves.toBe("deleted");
    expect(sent[0]?.input).toEqual({
      TransactItems: [
        { Delete: { TableName: TABLE, Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA#score" } } } },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: { S: "APPDATA#ada-42" }, sk: { S: "DATA_USAGE" } },
            UpdateExpression: "SET #bytes = #bytes - :previous, #keys = #keys - :one, #updatedAt = :now, #writtenBytes = #writtenBytes + :cost REMOVE #sizes.#k",
            ConditionExpression: "#sizes.#k = :previous AND #writeDay = :today AND #writtenBytes <= :budgetLimit",
            ExpressionAttributeNames: { "#bytes": "bytes", "#keys": "keys", "#updatedAt": "updatedAt", "#sizes": "sizes", "#k": "score", "#writeDay": "writeDay", "#writtenBytes": "writtenBytes" },
            ExpressionAttributeValues: {
              ":previous": { N: "12" },
              ":one": { N: "1" },
              ":now": { S: NOW_ISO },
              ":today": { S: TODAY },
              ":cost": { N: "2048" },
              ":budgetLimit": { N: String(DAILY_WRITE_BUDGET_BYTES - 2048) },
            },
          },
        },
      ],
    });
    namesUsed(sent[0]);
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO, SAME_DAY)).resolves.toBe("conflict");
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO, SAME_DAY)).resolves.toBe("conflict");
    await expect(store.deleteValue("Ada-42", "score", 12, NOW_ISO, SAME_DAY)).rejects.toThrow("boom");
  });

  it("starts the day's count on the first delete of a day, only while the stored day is older", async () => {
    const { client, sent } = stubClient([{}]);
    await new DynamoAppDataStore(client, TABLE).deleteValue("Ada-42", "score", 12, NOW_ISO, NEW_DAY);
    const usage = items(sent[0])[1]?.Update;
    expect(usage?.UpdateExpression).toBe("SET #bytes = #bytes - :previous, #keys = #keys - :one, #updatedAt = :now, #writeDay = :today, #writtenBytes = :cost REMOVE #sizes.#k");
    expect(usage?.ConditionExpression).toBe("#sizes.#k = :previous AND (attribute_not_exists(#writeDay) OR #writeDay < :today)");
    namesUsed(sent[0]);
  });

  it("never reads or tests the value item on a write: a write reads only the totals item (a value of 350 KB costs nothing to refuse)", async () => {
    const { client, sent } = stubClient([{}, {}, {}, {}]);
    const store = new DynamoAppDataStore(client, TABLE);
    await store.putValue("Ada-42", "k", "1", 1, undefined, false, NOW_ISO, NEW_DAY, "Bob");
    await store.putValue("Ada-42", "k", "1", 1, 5, true, NOW_ISO, SAME_DAY, "Bob");
    await store.deleteValue("Ada-42", "k", 1, NOW_ISO, SAME_DAY);
    await store.deleteValue("Ada-42", "k", 1, NOW_ISO, NEW_DAY);
    for (const command of sent) {
      expect(command).toBeInstanceOf(TransactWriteItemsCommand);
      const [value, usage] = items(command);
      const valuePart = value?.Put ?? value?.Delete;
      expect(valuePart?.ConditionExpression).toBeUndefined();
      expect(valuePart?.ExpressionAttributeNames).toBeUndefined();
      expect(usage?.Update?.Key?.["sk"]?.S).toBe("DATA_USAGE");
      expect(usage?.Update?.ConditionExpression).toBeDefined();
    }
  });

  it("keeps the largest value item and the totals item of 500 keys of 64 characters under DynamoDB's 400 KB item limit (ticket 3.17)", async () => {
    const { client, sent } = stubClient([{}]);
    const nickname = "N".repeat(20); // the longest nickname (1.5 rules)
    const key = "k".repeat(64); // the longest key
    const json = JSON.stringify("x".repeat(MAX_VALUE_BYTES - 2));
    await new DynamoAppDataStore(client, TABLE).putValue(nickname, key, json, MAX_VALUE_BYTES, undefined, false, NOW_ISO, NEW_DAY, "W".repeat(20));
    const [value, usage] = items(sent[0]);
    // The value item: 350 KB of value plus its overhead, which VALUE_ITEM_OVERHEAD_BYTES bounds.
    const valueItem = value?.Put?.Item ?? {};
    expect(itemBytes(valueItem) - MAX_VALUE_BYTES).toBeLessThanOrEqual(VALUE_ITEM_OVERHEAD_BYTES);
    expect(MAX_VALUE_BYTES + VALUE_ITEM_OVERHEAD_BYTES).toBeLessThanOrEqual(DYNAMODB_ITEM_LIMIT_BYTES);
    // The totals item at its largest: 500 keys of 64 characters, each holding 350 KB in `sizes`, full totals and budget.
    const update = usage?.Update;
    const names = update?.ExpressionAttributeNames ?? {};
    const values = update?.ExpressionAttributeValues ?? {};
    const sizes = Object.fromEntries(Array.from({ length: MAX_KEYS }, (_, i) => [String(i).padStart(64, "k"), { N: String(MAX_VALUE_BYTES) }]));
    const totalsItem: Record<string, AttributeValue> = {
      ...(update?.Key ?? {}),
      [names["#type"] ?? ""]: values[":type"] ?? { S: "" },
      [names["#bytes"] ?? ""]: { N: String(MAX_APP_DATA_BYTES) },
      [names["#keys"] ?? ""]: { N: String(MAX_KEYS) },
      [names["#updatedAt"] ?? ""]: values[":now"] ?? { S: "" },
      [names["#sizes"] ?? ""]: { M: sizes },
      [names["#writeDay"] ?? ""]: values[":today"] ?? { S: "" },
      [names["#writtenBytes"] ?? ""]: { N: String(DAILY_WRITE_BUDGET_BYTES) },
    };
    expect(Object.keys(totalsItem).sort()).toEqual(["bytes", "keys", "pk", "sizes", "sk", "type", "updatedAt", "writeDay", "writtenBytes"]);
    const bound = usageItemBytes(new Map(Object.keys(sizes).map((k) => [k, MAX_VALUE_BYTES])), Object.keys(sizes)[0] ?? "");
    expect(bound).toBe(USAGE_ITEM_BASE_BYTES + MAX_KEYS * (64 + USAGE_ENTRY_BYTES));
    expect(itemBytes(totalsItem)).toBeLessThanOrEqual(bound);
    expect(bound).toBeLessThanOrEqual(DYNAMODB_ITEM_LIMIT_BYTES);
  });

  it("writes only in APPDATA# partitions and names only the attributes the role allows (never liveAt; the data key only inside sizes)", async () => {
    const { client, sent } = stubClient([{}, {}, {}, {}, {}, {}, {}, {}]);
    const store = new DynamoAppDataStore(client, TABLE);
    for (const charge of [SAME_DAY, NEW_DAY]) {
      await store.putValue("Ada-42", "my-key_1", "1", 1, undefined, false, NOW_ISO, charge, "Bob");
      await store.putValue("Ada-42", "my-key_1", "1", 1, undefined, true, NOW_ISO, charge, "Bob");
      await store.putValue("Ada-42", "my-key_1", "1", 1, 5, true, NOW_ISO, charge, "Bob");
      await store.deleteValue("Ada-42", "my-key_1", 1, NOW_ISO, charge);
    }
    for (const name of ["writeDay", "writtenBytes", "sizes"]) expect(APP_DATA_WRITE_ATTRIBUTES).toContain(name);
    for (const command of sent) {
      const names = namesUsed(command);
      expect(names.length).toBeGreaterThan(0);
      expect(names).not.toContain("my-key_1");
      for (const name of names) expect(APP_DATA_WRITE_ATTRIBUTES).toContain(name);
      for (const item of items(command)) {
        const key = item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key;
        expect(key?.["pk"]?.S).toMatch(/^APPDATA#/);
        expect(item.Put?.ReturnValuesOnConditionCheckFailure ?? item.Update?.ReturnValuesOnConditionCheckFailure).toBeUndefined();
        expect(item.Update?.ReturnValuesOnConditionCheckFailure).toBeUndefined();
      }
    }
    expect(APP_DATA_WRITE_ATTRIBUTES).not.toContain("liveAt");
  });
});
