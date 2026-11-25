import { DeleteItemCommand, GetItemCommand, TransactWriteItemsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { PARTICIPANT_NICK_PUT_ATTRIBUTES, PARTICIPANT_PROFILE_UPDATE_ATTRIBUTES, SESSION_ALLOW_READ_ATTRIBUTES } from "../../../infra/lib/config.js";
import { DynamoParticipantStore, type ParticipantSender } from "./store.js";

type Sent = GetItemCommand | DeleteItemCommand | TransactWriteItemsCommand;

function stubClient(answers: (Record<string, unknown> | Error)[]): { client: ParticipantSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as ParticipantSender;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const cancelled = (codes: string[]): Error =>
  Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe("DynamoParticipantStore", () => {
  it("reads a session by its hash with a consistent read (participant, expiry and the sealed allow-list link only)", async () => {
    const { client, sent } = stubClient([
      { Item: { participantId: { S: "p-1" }, expiresAt: { N: "1800" }, allowRef: { S: "sealed" } } },
      { Item: { participantId: { S: "p-1" }, expiresAt: { N: "1800" } } },
      { Item: { participantId: { S: "p-1" } } },
      {},
    ]);
    const store = new DynamoParticipantStore(client, TABLE);
    await expect(store.getSession("ab12")).resolves.toEqual({ participantId: "p-1", expiresAt: 1800, allowRef: "sealed" });
    await expect(store.getSession("ab12")).resolves.toEqual({ participantId: "p-1", expiresAt: 1800 });
    await expect(store.getSession("ab12")).resolves.toBeUndefined();
    await expect(store.getSession("ab12")).resolves.toBeUndefined();
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "SESSION#ab12" }, sk: { S: "SESSION" } },
      ConsistentRead: true,
      ProjectionExpression: "#participantId, #expiresAt, #allowRef",
      ExpressionAttributeNames: { "#participantId": "participantId", "#expiresAt": "expiresAt", "#allowRef": "allowRef" },
    });
  });

  it("re-reads an allow-list entry with a consistent read of role, group and participant only, never the address (ticket 3.1)", async () => {
    const entry = { role: { S: "facilitator" }, group: { S: "red" }, participantId: { S: "p-1" } };
    const { client, sent } = stubClient([
      { Item: entry },
      { Item: { role: { S: "admin" }, group: { S: "green" } } },
      { Item: { ...entry, role: { S: "boss" } } },
      { Item: { role: { S: "participant" }, participantId: { S: "p-1" } } },
      {},
    ]);
    const store = new DynamoParticipantStore(client, TABLE);
    await expect(store.getAllowEntry("ada@example.test")).resolves.toEqual({ role: "facilitator", group: "red", participantId: "p-1" });
    await expect(store.getAllowEntry("ada@example.test")).resolves.toEqual({ role: "admin", group: "green" });
    await expect(store.getAllowEntry("ada@example.test")).resolves.toBeUndefined();
    await expect(store.getAllowEntry("ada@example.test")).resolves.toBeUndefined();
    await expect(store.getAllowEntry("ada@example.test")).resolves.toBeUndefined();
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "EMAIL#ada@example.test" }, sk: { S: "ALLOW" } },
      ConsistentRead: true,
      ProjectionExpression: "#role, #group, #participantId",
      ExpressionAttributeNames: { "#role": "role", "#group": "group", "#participantId": "participantId" },
    });
    // Within the role's GetItem condition on `EMAIL#*` (attribute names, with a projection).
    const input = (sent[0] as GetItemCommand).input;
    for (const name of [...Object.keys(input.Key ?? {}), ...Object.values(input.ExpressionAttributeNames ?? {})]) {
      expect(SESSION_ALLOW_READ_ATTRIBUTES).toContain(name);
    }
    expect(SESSION_ALLOW_READ_ATTRIBUTES).not.toContain("email");
  });

  it("deletes a session by its hash (ticket 3.1)", async () => {
    const { client, sent } = stubClient([{}]);
    await new DynamoParticipantStore(client, TABLE).deleteSession("ab12");
    expect(sent[0]).toBeInstanceOf(DeleteItemCommand);
    expect(sent[0]?.input).toEqual({ TableName: TABLE, Key: { pk: { S: "SESSION#ab12" }, sk: { S: "SESSION" } } });
  });

  it("reads a profile with a consistent read, refusing a malformed one", async () => {
    const profile = { id: { S: "p-1" }, role: { S: "participant" }, group: { S: "blue" }, step: { S: "clarify" } };
    const { client, sent } = stubClient([
      { Item: { ...profile, nickname: { S: "Ada" } } },
      { Item: profile },
      { Item: { ...profile, role: { S: "boss" } } },
      { Item: { ...profile, id: { S: "p-2" } } },
      {},
    ]);
    const store = new DynamoParticipantStore(client, TABLE);
    await expect(store.getParticipant("p-1")).resolves.toEqual({ id: "p-1", nickname: "Ada", role: "participant", group: "blue", step: "clarify" });
    await expect(store.getParticipant("p-1")).resolves.toEqual({ id: "p-1", role: "participant", group: "blue", step: "clarify" });
    await expect(store.getParticipant("p-1")).resolves.toBeUndefined();
    await expect(store.getParticipant("p-1")).resolves.toBeUndefined();
    await expect(store.getParticipant("p-1")).resolves.toBeUndefined();
    expect(sent[0]?.input).toMatchObject({ Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } }, ConsistentRead: true });
  });

  it("claims the lower-cased nickname and sets it on the profile in one transaction", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoParticipantStore(client, TABLE).claimNickname("p-1", "Ada-42", "2026-11-23T10:00:00.000Z")).resolves.toBe("saved");
    expect(sent[0]).toBeInstanceOf(TransactWriteItemsCommand);
    expect(sent[0]?.input).toEqual({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: {
              pk: { S: "NICK#ada-42" },
              sk: { S: "NICK" },
              type: { S: "nick" },
              nickname: { S: "Ada-42" },
              participantId: { S: "p-1" },
              createdAt: { S: "2026-11-23T10:00:00.000Z" },
            },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } },
            UpdateExpression: "SET #nickname = :nickname, #step = :next",
            ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#nickname) AND #step = :current",
            ExpressionAttributeNames: { "#pk": "pk", "#nickname": "nickname", "#step": "step" },
            ExpressionAttributeValues: { ":nickname": { S: "Ada-42" }, ":next": { S: "clarify" }, ":current": { S: "nickname" } },
          },
        },
      ],
    });
  });

  it("tells a taken nickname from a profile that already has one, and passes other errors on", async () => {
    const { client } = stubClient([
      cancelled(["ConditionalCheckFailed", "None"]),
      cancelled(["None", "ConditionalCheckFailed"]),
      cancelled(["ConditionalCheckFailed", "ConditionalCheckFailed"]),
      cancelled(["TransactionConflict", "None"]),
      Object.assign(new Error("x"), { name: "InternalServerError" }),
    ]);
    const store = new DynamoParticipantStore(client, TABLE);
    await expect(store.claimNickname("p-1", "Ada", "x")).resolves.toBe("taken");
    await expect(store.claimNickname("p-1", "Ada", "x")).resolves.toBe("already-set");
    await expect(store.claimNickname("p-1", "Ada", "x")).resolves.toBe("already-set");
    await expect(store.claimNickname("p-1", "Ada", "x")).rejects.toThrow("cancelled");
    await expect(store.claimNickname("p-1", "Ada", "x")).rejects.toThrow("x");
  });

  it("names only the attributes the role's conditions allow (claim put, profile update)", async () => {
    const { client, sent } = stubClient([{}]);
    await new DynamoParticipantStore(client, TABLE).claimNickname("p-1", "Ada", "x");
    const [put, update] = (sent[0] as TransactWriteItemsCommand).input.TransactItems ?? [];
    const names = (part?: {
      Item?: Record<string, AttributeValue> | undefined;
      Key?: Record<string, AttributeValue> | undefined;
      ExpressionAttributeNames?: Record<string, string> | undefined;
    }) => [
      ...Object.keys(part?.Item ?? {}),
      ...Object.keys(part?.Key ?? {}),
      ...Object.values(part?.ExpressionAttributeNames ?? {}),
    ];
    expect(names(put?.Put).length).toBeGreaterThan(0);
    for (const name of names(put?.Put)) expect(PARTICIPANT_NICK_PUT_ATTRIBUTES).toContain(name);
    for (const name of names(update?.Update)) expect(PARTICIPANT_PROFILE_UPDATE_ATTRIBUTES).toContain(name);
  });
});
