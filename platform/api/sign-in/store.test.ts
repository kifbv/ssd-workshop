import type { GetItemCommand, GetItemCommandOutput, PutItemCommand, PutItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { SIGN_IN_CODE_PUT_ATTRIBUTES } from "../../../infra/lib/config.js";
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
  it("finds an allow-list entry by its key, reading only its email (which this function cannot write)", async () => {
    const { client, sent } = stubClient([
      { ...meta, Item: { email: { S: EMAIL } } },
      meta,
      // An ALLOW item without an email attribute (not written by the import) does not count.
      { ...meta, Item: {} },
    ]);
    const store = new DynamoSignInStore(client, TABLE);
    await expect(store.isAllowListed(EMAIL)).resolves.toBe(true);
    await expect(store.isAllowListed(EMAIL)).resolves.toBe(false);
    await expect(store.isAllowListed(EMAIL)).resolves.toBe(false);
    expect((sent[0] as GetItemCommand).input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "ALLOW" } },
      ProjectionExpression: "#email",
      ExpressionAttributeNames: { "#email": "email" },
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

  it("reads the codes item (consistent read), keeping well-formed entries", async () => {
    const { client, sent } = stubClient([
      {
        ...meta,
        Item: {
          codes: {
            L: [
              { M: { codeHash: { S: "scrypt$aa$bb" }, expiresAt: { N: "1600" } } },
              { M: { codeHash: { S: "x" } } },
            ],
          },
          attempts: { N: "2" },
          version: { N: "4" },
        },
      },
      meta,
    ]);
    const store = new DynamoSignInStore(client, TABLE);
    await expect(store.getCode(EMAIL)).resolves.toEqual({
      codes: [{ codeHash: "scrypt$aa$bb", expiresAt: 1600 }],
      attempts: 2,
      version: 4,
    });
    await expect(store.getCode(EMAIL)).resolves.toBeUndefined();
    expect((sent[0] as GetItemCommand).input).toMatchObject({
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "CODE" } },
      ConsistentRead: true,
    });
  });

  it("writes the codes item (entries, shared attempts, version, TTL) only at the version it read", async () => {
    const conflict = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
    const { client, sent } = stubClient([meta, meta, conflict]);
    const store = new DynamoSignInStore(client, TABLE);
    const codes = {
      codes: [
        { codeHash: "scrypt$aa$bb", expiresAt: 1600 },
        { codeHash: "scrypt$cc$dd", expiresAt: 1700 },
      ],
      attempts: 1,
      version: 3,
    };
    await expect(store.putCode(EMAIL, { ...codes, version: 1 }, 1600, undefined)).resolves.toBe(true);
    await expect(store.putCode(EMAIL, codes, 1700, 2)).resolves.toBe(true);
    await expect(store.putCode(EMAIL, codes, 1700, 2)).resolves.toBe(false);
    expect((sent[0] as PutItemCommand).input).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)" });
    expect((sent[1] as PutItemCommand).input).toEqual({
      TableName: TABLE,
      Item: {
        pk: { S: `EMAIL#${EMAIL}` },
        sk: { S: "CODE" },
        type: { S: "code" },
        codes: {
          L: [
            { M: { codeHash: { S: "scrypt$aa$bb" }, expiresAt: { N: "1600" } } },
            { M: { codeHash: { S: "scrypt$cc$dd" }, expiresAt: { N: "1700" } } },
          ],
        },
        attempts: { N: "1" },
        version: { N: "3" },
        expiresAt: { N: "1700" },
      },
      ConditionExpression: "#version = :expected",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":expected": { N: "2" } },
    });
  });

  it("writes only the attribute names the role's PutItem condition allows", async () => {
    const { client, sent } = stubClient([meta, meta]);
    const store = new DynamoSignInStore(client, TABLE);
    await store.putCodeRequests(EMAIL, [1], 2, undefined);
    await store.putCode(EMAIL, { codes: [{ codeHash: "h", expiresAt: 2 }], attempts: 0, version: 1 }, 2, undefined);
    for (const command of sent as PutItemCommand[]) {
      const names = [...Object.keys(command.input.Item ?? {}), ...Object.values(command.input.ExpressionAttributeNames ?? {})];
      for (const name of names) expect(SIGN_IN_CODE_PUT_ATTRIBUTES).toContain(name);
    }
  });
});
