import {
  ConditionalCheckFailedException,
  type DeleteItemCommand,
  type DeleteItemCommandOutput,
  type GetItemCommand,
  type GetItemCommandOutput,
  type ScanCommand,
  type ScanCommandOutput,
  type UpdateItemCommand,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoAllowListStore, type DynamoSender } from "./store.js";

type Sent = UpdateItemCommand | ScanCommand | GetItemCommand | DeleteItemCommand;
type Answer = UpdateItemCommandOutput | ScanCommandOutput | GetItemCommandOutput | DeleteItemCommandOutput | Error;

/** A stand-in for DynamoDBClient: records each command and answers from a list (an Error is thrown). */
function stubClient(answers: Answer[]): { client: DynamoSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as DynamoSender;
  return { client, sent };
}

const meta = { $metadata: {} };
const fixedNow = () => new Date("2026-11-23T10:00:00.000Z");

describe("DynamoAllowListStore.upsert", () => {
  it("criterion 1: writes the allow-list item by its key and keeps createdAt of an existing entry", async () => {
    const { client, sent } = stubClient([meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data", fixedNow);
    await expect(store.upsert({ email: "jane@example.com", group: "g", role: "participant" })).resolves.toBe("added");

    const input = (sent[0] as UpdateItemCommand).input;
    expect(input.TableName).toBe("ssd-workshop-data");
    expect(input.Key).toEqual({ pk: { S: "EMAIL#jane@example.com" }, sk: { S: "ALLOW" } });
    expect(input.UpdateExpression).toContain("#createdAt = if_not_exists(#createdAt, :now)");
    expect(input.UpdateExpression).not.toContain("participantId");
    expect(input.ExpressionAttributeValues).toEqual({
      ":type": { S: "allow" },
      ":email": { S: "jane@example.com" },
      ":group": { S: "g" },
      ":role": { S: "participant" },
      ":now": { S: "2026-11-23T10:00:00.000Z" },
    });
    expect(input.ReturnValues).toBe("UPDATED_OLD");
  });

  it("reports an existing entry as updated", async () => {
    const { client } = stubClient([{ ...meta, Attributes: { group: { S: "old" } } }]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data", fixedNow);
    await expect(store.upsert({ email: "jane@example.com", group: "g", role: "admin" })).resolves.toBe("updated");
  });
});

describe("DynamoAllowListStore.listAll", () => {
  it("criterion 3: scans allow items page by page and reads only group and role", async () => {
    const { client, sent } = stubClient([
      { ...meta, Items: [{ group: { S: "a" }, role: { S: "admin" } }], LastEvaluatedKey: { pk: { S: "k" } } },
      { ...meta, Items: [{ group: { S: "b" }, role: { S: "participant" } }] },
    ]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.listAll()).resolves.toEqual([
      { group: "a", role: "admin" },
      { group: "b", role: "participant" },
    ]);
    const [first, second] = sent.map((c) => (c as ScanCommand).input);
    expect(first?.FilterExpression).toBe("#type = :allow");
    expect(first?.ExpressionAttributeValues).toEqual({ ":allow": { S: "allow" } });
    expect(first?.ProjectionExpression).toBe("#group, #role");
    expect(first?.ExclusiveStartKey).toBeUndefined();
    expect(second?.ExclusiveStartKey).toEqual({ pk: { S: "k" } });
  });
});

describe("DynamoAllowListStore.exists and remove (ticket 3.1)", () => {
  const KEY = { pk: { S: "EMAIL#jane@example.com" }, sk: { S: "ALLOW" } };

  it("looks the entry up by its key with a consistent read of the key only", async () => {
    const { client, sent } = stubClient([{ ...meta, Item: { pk: KEY.pk } }, meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.exists("jane@example.com")).resolves.toBe(true);
    await expect(store.exists("jane@example.com")).resolves.toBe(false);
    expect((sent[0] as GetItemCommand).input).toEqual({
      TableName: "ssd-workshop-data",
      Key: KEY,
      ProjectionExpression: "pk",
      ConsistentRead: true,
    });
  });

  it("criterion 1: deletes only the EMAIL#/ALLOW item, conditional on it existing, and returns no old values", async () => {
    const { client, sent } = stubClient([meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).resolves.toBe(true);
    expect((sent[0] as DeleteItemCommand).input).toEqual({
      TableName: "ssd-workshop-data",
      Key: KEY,
      ConditionExpression: "attribute_exists(pk)",
    });
  });

  it("says false when there was no entry, and passes other errors on", async () => {
    const missing = new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    const { client } = stubClient([missing, Object.assign(new Error("denied"), { name: "AccessDeniedException" })]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).resolves.toBe(false);
    await expect(store.remove("jane@example.com")).rejects.toThrow("denied");
  });
});
