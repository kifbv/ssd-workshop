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
// The edit link store's calls (ticket 3.26) go through the same client.
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
    const { client, sent } = stubClient([meta, meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data", fixedNow);
    await expect(store.upsert({ email: "jane@example.com", group: "g", role: "participant" })).resolves.toBe("added");
    expect(sent).toHaveLength(2);

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
    const { client } = stubClient([{ ...meta, Attributes: { group: { S: "old" } } }, meta]);
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
    const { client, sent } = stubClient([meta, meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).resolves.toEqual({ removed: true, editLinkDeleted: false });
    expect(sent).toHaveLength(2);
    expect((sent[1] as DeleteItemCommand).input).toEqual({
      TableName: "ssd-workshop-data",
      Key: KEY,
      ConditionExpression: "attribute_exists(pk)",
    });
  });

  it("says false when there was no entry, and passes other errors on", async () => {
    const missing = new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    const { client } = stubClient([meta, missing, meta, Object.assign(new Error("denied"), { name: "AccessDeniedException" })]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).resolves.toEqual({ removed: false, editLinkDeleted: false });
    await expect(store.remove("jane@example.com")).rejects.toThrow("denied");
  });
});

describe("the linked profile follows the allow-list (ticket 3.10)", () => {
  const KEY = { pk: { S: "EMAIL#jane@example.com" }, sk: { S: "ALLOW" } };
  const PROFILE = { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } };
  const linked = { ...meta, Item: { participantId: { S: "p-1" } } };

  it("WHEN a linked entry is imported THEN the profile's group and role are updated too, reading only the link", async () => {
    const { client, sent } = stubClient([{ ...meta, Attributes: { group: { S: "blue" } } }, linked, meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data", fixedNow);
    await expect(store.upsert({ email: "jane@example.com", group: "green", role: "facilitator" })).resolves.toBe("updated");
    expect((sent[1] as GetItemCommand).input).toEqual({
      TableName: "ssd-workshop-data",
      Key: KEY,
      ProjectionExpression: "#participantId",
      ExpressionAttributeNames: { "#participantId": "participantId" },
      ConsistentRead: true,
    });
    expect((sent[2] as UpdateItemCommand).input).toEqual({
      TableName: "ssd-workshop-data",
      Key: PROFILE,
      UpdateExpression: "SET #group = :group, #role = :role",
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk", "#group": "group", "#role": "role" },
      ExpressionAttributeValues: { ":group": { S: "green" }, ":role": { S: "facilitator" } },
      ReturnValues: "NONE",
    });
  });

  it("WHEN the linked profile does not exist yet THEN the import still succeeds (the sign-in creates it)", async () => {
    const missing = new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    const { client, sent } = stubClient([meta, linked, missing]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data", fixedNow);
    await expect(store.upsert({ email: "jane@example.com", group: "green", role: "participant" })).resolves.toBe("added");
    expect(sent).toHaveLength(3);
  });

  it("WHEN the profile update fails otherwise THEN the error is passed on", async () => {
    const { client } = stubClient([meta, linked, Object.assign(new Error("denied"), { name: "AccessDeniedException" })]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data", fixedNow);
    await expect(store.upsert({ email: "jane@example.com", group: "green", role: "participant" })).rejects.toThrow("denied");
  });

  it("WHEN a linked entry is removed THEN the profile's role becomes `removed` (off the dashboard); its group is kept", async () => {
    // The profile has no nickname yet: no app, no edit link.
    const { client, sent } = stubClient([linked, meta, meta, meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).resolves.toEqual({ removed: true, editLinkDeleted: false });
    expect((sent[1] as UpdateItemCommand).input).toMatchObject({
      Key: PROFILE,
      UpdateExpression: "SET #role = :role",
      ExpressionAttributeValues: { ":role": { S: "removed" } },
    });
    expect((sent[2] as GetItemCommand).input).toEqual({
      TableName: "ssd-workshop-data",
      Key: PROFILE,
      ProjectionExpression: "#nickname",
      ExpressionAttributeNames: { "#nickname": "nickname" },
      ConsistentRead: true,
    });
    expect((sent[3] as DeleteItemCommand).input.Key).toEqual(KEY);
  });

  it("ticket 3.26: WHEN a linked entry is removed THEN the person's app's edit link and its lookup item are deleted, after the profile is marked and before the entry goes", async () => {
    const hash = "a".repeat(64);
    const named = { ...meta, Item: { nickname: { S: "Jane-1" } } };
    const link = { ...meta, Item: { secret: { S: "s" }, secretHash: { S: hash }, nickname: { S: "Jane-1" } } };
    const { client, sent } = stubClient([linked, meta, named, link, meta as never, meta]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).resolves.toEqual({ removed: true, editLinkDeleted: true });
    const keys = sent.map((c) => `${c.constructor.name} ${(c.input as { Key?: { pk?: { S?: string } } }).Key?.pk?.S ?? ""}`);
    expect(keys).toEqual([
      "GetItemCommand EMAIL#jane@example.com",
      "UpdateItemCommand PARTICIPANT#p-1",
      "GetItemCommand PARTICIPANT#p-1",
      "GetItemCommand APPEDIT#jane-1",
      "TransactWriteItemsCommand ",
      "DeleteItemCommand EMAIL#jane@example.com",
    ]);
    const items = (sent[4] as unknown as { input: { TransactItems: { Delete?: { Key: { pk: { S: string } } } }[] } }).input.TransactItems;
    expect(items.map((i) => i.Delete?.Key.pk.S)).toEqual([`APPTOKEN#${hash}`, "APPEDIT#jane-1"]);
  });

  it("ticket 3.26: WHEN deleting the edit link fails THEN the entry stays, so running remove again finishes the job", async () => {
    const named = { ...meta, Item: { nickname: { S: "Jane-1" } } };
    const { client, sent } = stubClient([linked, meta, named, Object.assign(new Error("throttled"), { name: "ThrottlingException" })]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).rejects.toThrow("throttled");
    expect(sent.map((command) => command.constructor.name)).not.toContain("DeleteItemCommand");
  });

  it("WHEN the profile update fails THEN the entry stays, so running remove again finishes the job", async () => {
    const { client, sent } = stubClient([linked, Object.assign(new Error("throttled"), { name: "ThrottlingException" })]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).rejects.toThrow("throttled");
    expect(sent).toHaveLength(2);
    expect(sent.map((command) => command.constructor.name)).not.toContain("DeleteItemCommand");
  });

  it("WHEN there was no entry THEN no profile is touched", async () => {
    const missing = new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    const { client, sent } = stubClient([meta, missing]);
    const store = new DynamoAllowListStore(client, "ssd-workshop-data");
    await expect(store.remove("jane@example.com")).resolves.toEqual({ removed: false, editLinkDeleted: false });
    expect(sent).toHaveLength(2);
  });
});
