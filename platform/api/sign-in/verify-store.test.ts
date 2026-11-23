import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
  SIGN_IN_VERIFY_EMAIL_UPDATE_ATTRIBUTES,
  SIGN_IN_VERIFY_PROFILE_UPDATE_ATTRIBUTES,
  SIGN_IN_VERIFY_SESSION_PUT_ATTRIBUTES,
} from "../../../infra/lib/config.js";
import { DynamoVerifyStore, type VerifySender } from "./verify-store.js";

type Sent = GetItemCommand | UpdateItemCommand | DeleteItemCommand | PutItemCommand;
type Answer = Record<string, unknown> | Error;

function stubClient(answers: Answer[]): { client: VerifySender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as VerifySender;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const EMAIL = "jane@example.com";
const conflict = (): Error => Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });

/** Every attribute name a write names: key, item and expression names. */
function namesOf(command: Sent): string[] {
  const input = command.input as {
    Key?: Record<string, AttributeValue>;
    Item?: Record<string, AttributeValue>;
    ExpressionAttributeNames?: Record<string, string>;
  };
  return [
    ...Object.keys(input.Key ?? {}),
    ...Object.keys(input.Item ?? {}),
    ...Object.values(input.ExpressionAttributeNames ?? {}),
  ];
}

describe("DynamoVerifyStore", () => {
  it("reads an allow-list entry (consistent read) and counts it only with an email and a known role", async () => {
    const { client, sent } = stubClient([
      { Item: { email: { S: EMAIL }, group: { S: "blue" }, role: { S: "facilitator" }, participantId: { S: "p-1" } } },
      { Item: { email: { S: EMAIL }, group: { S: "blue" }, role: { S: "participant" } } },
      { Item: { group: { S: "blue" }, role: { S: "participant" } } },
      { Item: { email: { S: EMAIL }, group: { S: "blue" }, role: { S: "boss" } } },
      {},
    ]);
    const store = new DynamoVerifyStore(client, TABLE);
    await expect(store.getAllowEntry(EMAIL)).resolves.toEqual({ group: "blue", role: "facilitator", participantId: "p-1" });
    await expect(store.getAllowEntry(EMAIL)).resolves.toEqual({ group: "blue", role: "participant" });
    await expect(store.getAllowEntry(EMAIL)).resolves.toBeUndefined();
    await expect(store.getAllowEntry(EMAIL)).resolves.toBeUndefined();
    await expect(store.getAllowEntry(EMAIL)).resolves.toBeUndefined();
    expect(sent[0]?.input).toMatchObject({
      TableName: TABLE,
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "ALLOW" } },
      ConsistentRead: true,
    });
  });

  it("reads the codes item with a consistent read", async () => {
    const { client, sent } = stubClient([
      { Item: { codes: { L: [{ M: { codeHash: { S: "h" }, expiresAt: { N: "9" } } }] }, attempts: { N: "2" }, version: { N: "4" } } },
    ]);
    await expect(new DynamoVerifyStore(client, TABLE).getCode(EMAIL)).resolves.toEqual({
      codes: [{ codeHash: "h", expiresAt: 9 }],
      attempts: 2,
      version: 4,
    });
    expect(sent[0]?.input).toMatchObject({ Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "CODE" } }, ConsistentRead: true });
  });

  it("counts a wrong try with one atomic add (attempts and version), only on an existing item, and returns both", async () => {
    const { client, sent } = stubClient([{ Attributes: { attempts: { N: "3" }, version: { N: "8" } } }, conflict(), { Attributes: {} }]);
    const store = new DynamoVerifyStore(client, TABLE);
    await expect(store.addWrongTry(EMAIL)).resolves.toEqual({ attempts: 3, version: 8 });
    await expect(store.addWrongTry(EMAIL)).resolves.toBeUndefined();
    await expect(store.addWrongTry(EMAIL)).rejects.toThrow();
    expect(sent[0]).toBeInstanceOf(UpdateItemCommand);
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "CODE" } },
      UpdateExpression: "ADD #attempts :one, #version :one",
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#attempts": "attempts", "#version": "version", "#pk": "pk" },
      ExpressionAttributeValues: { ":one": { N: "1" } },
      ReturnValues: "UPDATED_NEW",
    });
  });

  it("deletes (uses up or burns) the codes item only at the version it read", async () => {
    const { client, sent } = stubClient([{}, conflict()]);
    const store = new DynamoVerifyStore(client, TABLE);
    await expect(store.deleteCode(EMAIL, 2)).resolves.toBe(true);
    await expect(store.deleteCode(EMAIL, 2)).resolves.toBe(false);
    expect(sent[0]).toBeInstanceOf(DeleteItemCommand);
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "CODE" } },
      ConditionExpression: "#version = :expected",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":expected": { N: "2" } },
    });
  });

  it("links the allow-list entry by updating only participantId, if the entry exists and has none", async () => {
    const { client, sent } = stubClient([{}, conflict()]);
    const store = new DynamoVerifyStore(client, TABLE);
    await expect(store.linkParticipant(EMAIL, "p-1")).resolves.toBe(true);
    await expect(store.linkParticipant(EMAIL, "p-1")).resolves.toBe(false);
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `EMAIL#${EMAIL}` }, sk: { S: "ALLOW" } },
      UpdateExpression: "SET #participantId = :id",
      ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#participantId)",
      ExpressionAttributeNames: { "#pk": "pk", "#participantId": "participantId" },
      ExpressionAttributeValues: { ":id": { S: "p-1" } },
    });
  });

  it("creates or refreshes the profile (role and group; step and createdAt only if new) and returns the step", async () => {
    const { client, sent } = stubClient([
      { Attributes: { step: { S: "nickname" } } },
      { Attributes: { step: { S: "clarify" }, role: { S: "admin" } } },
    ]);
    const store = new DynamoVerifyStore(client, TABLE);
    await expect(store.upsertProfile("p-1", "admin", "blue", "2026-11-23T10:00:00.000Z")).resolves.toBe("nickname");
    await expect(store.upsertProfile("p-1", "admin", "blue", "x")).resolves.toBe("clarify");
    expect(sent[0]?.input).toMatchObject({
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } },
      UpdateExpression:
        "SET #type = :type, #id = :id, #role = :role, #group = :group, #createdAt = if_not_exists(#createdAt, :now), #step = if_not_exists(#step, :first)",
      ExpressionAttributeValues: {
        ":type": { S: "participant" },
        ":id": { S: "p-1" },
        ":role": { S: "admin" },
        ":group": { S: "blue" },
        ":now": { S: "2026-11-23T10:00:00.000Z" },
        ":first": { S: "nickname" },
      },
      ReturnValues: "UPDATED_NEW",
    });
  });

  it("does not fail a sign-in when the update returns no valid step: it answers the first step", async () => {
    const { client } = stubClient([{ Attributes: {} }, {}, { Attributes: { step: { S: "bogus" } } }]);
    const store = new DynamoVerifyStore(client, TABLE);
    await expect(store.upsertProfile("p-1", "participant", "g", "x")).resolves.toBe("nickname");
    await expect(store.upsertProfile("p-1", "participant", "g", "x")).resolves.toBe("nickname");
    await expect(store.upsertProfile("p-1", "participant", "g", "x")).resolves.toBe("nickname");
  });

  it("puts a new session (hash, participant, times; never the token) only if absent", async () => {
    const { client, sent } = stubClient([{}]);
    await new DynamoVerifyStore(client, TABLE).putSession("ab12", "p-1", "2026-11-23T10:00:00.000Z", 1800);
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Item: {
        pk: { S: "SESSION#ab12" },
        sk: { S: "SESSION" },
        type: { S: "session" },
        tokenHash: { S: "ab12" },
        participantId: { S: "p-1" },
        createdAt: { S: "2026-11-23T10:00:00.000Z" },
        expiresAt: { N: "1800" },
      },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    });
  });

  it("passes any other error on", async () => {
    const { client } = stubClient([Object.assign(new Error("x"), { name: "InternalServerError" })]);
    await expect(new DynamoVerifyStore(client, TABLE).deleteCode(EMAIL, 1)).rejects.toThrow("x");
  });

  it("names only the attributes the role's conditions allow, per partition and action", async () => {
    const { client, sent } = stubClient([
      { Attributes: { attempts: { N: "1" }, version: { N: "2" } } },
      {},
      {},
      { Attributes: { step: { S: "clarify" } } },
      {},
    ]);
    const store = new DynamoVerifyStore(client, TABLE);
    await store.addWrongTry(EMAIL);
    await store.deleteCode(EMAIL, 1);
    await store.linkParticipant(EMAIL, "p-1");
    await store.upsertProfile("p-1", "participant", "g", "x");
    await store.putSession("ab", "p-1", "x", 1);
    const allowed = (command: Sent): readonly string[] => {
      const pk = (command.input as { Key?: { pk?: { S?: string } }; Item?: { pk?: { S?: string } } }).Key?.pk?.S ??
        (command.input as { Item?: { pk?: { S?: string } } }).Item?.pk?.S ?? "";
      if (command instanceof DeleteItemCommand) return ["pk", "sk", "version"]; // no attribute condition; still minimal
      if (command instanceof PutItemCommand && pk.startsWith("SESSION#")) return SIGN_IN_VERIFY_SESSION_PUT_ATTRIBUTES;
      if (command instanceof UpdateItemCommand && pk.startsWith("EMAIL#")) return SIGN_IN_VERIFY_EMAIL_UPDATE_ATTRIBUTES;
      if (command instanceof UpdateItemCommand && pk.startsWith("PARTICIPANT#")) return SIGN_IN_VERIFY_PROFILE_UPDATE_ATTRIBUTES;
      return [];
    };
    expect(sent).toHaveLength(5);
    for (const command of sent) {
      for (const name of namesOf(command)) expect(allowed(command), `${command.constructor.name} ${name}`).toContain(name);
    }
    expect(SIGN_IN_VERIFY_EMAIL_UPDATE_ATTRIBUTES).not.toContain("email");
    expect(SIGN_IN_VERIFY_PROFILE_UPDATE_ATTRIBUTES).not.toContain("nickname");
  });
});
