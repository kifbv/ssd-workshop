import type { ScanCommand, ScanCommandOutput, UpdateItemCommand, UpdateItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoAllowListStore, type DynamoSender } from "./store.js";

type Sent = UpdateItemCommand | ScanCommand;

/** A stand-in for DynamoDBClient: records each command and answers from a list. */
function stubClient(answers: (UpdateItemCommandOutput | ScanCommandOutput)[]): { client: DynamoSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
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
