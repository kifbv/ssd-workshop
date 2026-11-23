import type { GetItemCommand, GetItemCommandOutput, PutItemCommand, PutItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoSignInStore, type DynamoSender } from "./store.js";

type Sent = GetItemCommand | PutItemCommand;
type Answer = GetItemCommandOutput | PutItemCommandOutput | Error;

/** A stand-in for DynamoDBClient: records each command and answers (or throws) from a list. */
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
const TABLE = "ssd-workshop-data";
const EMAIL = "jane@example.com";

describe("DynamoSignInStore", () => {
  it("finds an allow-list entry by its key, reading only the key", async () => {
    const { client, sent } = stubClient([{ ...meta, Item: { pk: { S: `EMAIL#${EMAIL}` } } }, meta]);
    const store = new DynamoSignInStore(client, TABLE);
    await expect(store.isAllowListed(EMAIL)).resolves.toBe(true);
    await expect(store.isAllowListed(EMAIL)).resolves.toBe(false);
    expect((sent[0] as GetItemCommand).input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "ALLOW" } },
      ProjectionExpression: "pk",
    });
  });

  it("reads the code requests record (consistent read) and its version", async () => {
    const { client, sent } = stubClient([
      { ...meta, Item: { sentAt: { L: [{ N: "100" }, { N: "200" }] }, version: { N: "3" } } },
      meta,
    ]);
    const store = new DynamoSignInStore(client, TABLE);
    await expect(store.getCodeRequests(EMAIL)).resolves.toEqual({ sentAt: [100, 200], version: 3 });
    await expect(store.getCodeRequests(EMAIL)).resolves.toBeUndefined();
    expect((sent[0] as GetItemCommand).input).toMatchObject({
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "CODE_REQUESTS" } },
      ConsistentRead: true,
    });
  });

  it("creates the code requests record only if it does not exist yet", async () => {
    const { client, sent } = stubClient([meta]);
    await expect(new DynamoSignInStore(client, TABLE).putCodeRequests(EMAIL, [100], 3700, undefined)).resolves.toBe(true);
    expect((sent[0] as PutItemCommand).input).toEqual({
      TableName: TABLE,
      Item: {
        pk: { S: `EMAIL#${EMAIL}` },
        sk: { S: "CODE_REQUESTS" },
        type: { S: "code-requests" },
        sentAt: { L: [{ N: "100" }] },
        version: { N: "1" },
        expiresAt: { N: "3700" },
      },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });

  it("updates the record only at the version it read, and answers false when another request wrote first", async () => {
    const conflict = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
    const { client, sent } = stubClient([meta, conflict]);
    const store = new DynamoSignInStore(client, TABLE);
    await expect(store.putCodeRequests(EMAIL, [100, 200], 3800, 1)).resolves.toBe(true);
    await expect(store.putCodeRequests(EMAIL, [100, 200], 3800, 1)).resolves.toBe(false);
    expect((sent[0] as PutItemCommand).input).toMatchObject({
      Item: { version: { N: "2" } },
      ConditionExpression: "#version = :expected",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":expected": { N: "1" } },
    });
  });

  it("passes any other error on", async () => {
    const { client } = stubClient([Object.assign(new Error("x"), { name: "InternalServerError" })]);
    await expect(new DynamoSignInStore(client, TABLE).putCodeRequests(EMAIL, [1], 2, undefined)).rejects.toThrow("x");
  });

  it("writes the code item (hash, expiry, attempts 0), replacing any previous code", async () => {
    const { client, sent } = stubClient([meta]);
    await new DynamoSignInStore(client, TABLE).putCode(EMAIL, {
      codeHash: "scrypt$aa$bb",
      expiresAt: 1600,
      attempts: 0,
      createdAt: "2026-11-23T10:00:00.000Z",
    });
    const input = (sent[0] as PutItemCommand).input;
    expect(input).toEqual({
      TableName: TABLE,
      Item: {
        pk: { S: `EMAIL#${EMAIL}` },
        sk: { S: "CODE" },
        type: { S: "code" },
        codeHash: { S: "scrypt$aa$bb" },
        expiresAt: { N: "1600" },
        attempts: { N: "0" },
        createdAt: { S: "2026-11-23T10:00:00.000Z" },
      },
    });
    expect(input.ConditionExpression).toBeUndefined();
  });
});
