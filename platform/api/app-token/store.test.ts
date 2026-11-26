// Ticket 3.24: the token store's DynamoDB calls: what they read and write, under which conditions, and that every name
// they use is in the IAM lists of infra/lib/config.ts.
import { DeleteItemCommand, GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { APP_TOKEN_LIST_READ_ATTRIBUTES, APP_TOKEN_LIST_UPDATE_ATTRIBUTES, APP_TOKEN_PUT_ATTRIBUTES, APP_TOKEN_READ_ATTRIBUTES } from "../../../infra/lib/config.js";
import { DynamoAppTokenStore, REVOKE_ATTEMPTS, type AppTokenSender } from "./store.js";
import { MAX_APP_TOKENS } from "./token.js";

type Sent = GetItemCommand | DeleteItemCommand | TransactWriteItemsCommand;

function stubClient(answers: (Record<string, unknown> | Error)[]): { client: AppTokenSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as AppTokenSender;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const NOW_S = 1_800_000_000;
const HASH = "a".repeat(64);
const hash = (n: number): string => n.toString(16).padStart(64, "0");
const conditionFailed = (): Error => Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" });
const cancelled = (): Error => Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] });
const TOKEN = { app: "ada", nickname: "Bob", expiresAt: NOW_S + 3600 };

/** Every `#name` and `:value` an expression uses is defined, and every one defined is used (DynamoDB refuses either). */
function expectPlaceholders(input: { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } & Record<string, unknown>) {
  const text = ["UpdateExpression", "ConditionExpression", "ProjectionExpression"].map((k) => String(input[k] ?? "")).join(" ");
  const used = (prefix: string) => new Set(text.match(new RegExp(`${prefix}[A-Za-z0-9_]+`, "g")) ?? []);
  expect(used("#")).toEqual(new Set(Object.keys(input.ExpressionAttributeNames ?? {})));
  expect(used(":")).toEqual(new Set(Object.keys(input.ExpressionAttributeValues ?? {})));
}

/** The top-level attribute names an expression names (a map entry's key under `tokens` is not one). */
function topLevelNames(input: { ExpressionAttributeNames?: Record<string, string> } & Record<string, unknown>): string[] {
  const text = ["UpdateExpression", "ConditionExpression", "ProjectionExpression"].map((k) => String(input[k] ?? "")).join(" ");
  const names = text.match(/(?<![.#A-Za-z0-9_])#[A-Za-z0-9_]+/g) ?? [];
  return [...new Set(names.map((n) => input.ExpressionAttributeNames?.[n] ?? n))];
}

describe("DynamoAppTokenStore (ticket 3.24)", () => {
  it("reads a token by its hash with a consistent read of app, nickname and expiry only", async () => {
    const { client, sent } = stubClient([{ Item: { app: { S: "ada" }, nickname: { S: "Bob" }, expiresAt: { N: "1800" } } }, {}, { Item: { app: { S: "ada" } } }]);
    const store = new DynamoAppTokenStore(client, TABLE);
    await expect(store.getAppToken(HASH)).resolves.toEqual({ app: "ada", nickname: "Bob", expiresAt: 1800 });
    await expect(store.getAppToken(HASH)).resolves.toBeUndefined();
    await expect(store.getAppToken(HASH)).resolves.toBeUndefined();
    const input = (sent[0] as GetItemCommand).input;
    expect(input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `APPTOKEN#${HASH}` }, sk: { S: "TOKEN" } },
      ConsistentRead: true,
      ProjectionExpression: "#app, #nickname, #expiresAt",
      ExpressionAttributeNames: { "#app": "app", "#nickname": "nickname", "#expiresAt": "expiresAt" },
    });
    expect(Object.values(input.ExpressionAttributeNames ?? {}).sort()).toEqual([...APP_TOKEN_READ_ATTRIBUTES].sort());
    await expect(store.getAppToken("not-a-hash")).rejects.toThrow();
  });

  it("stores a participant's first token and creates their list with it, each only if absent", async () => {
    const { client, sent } = stubClient([{}, {}]);
    await expect(new DynamoAppTokenStore(client, TABLE).createAppToken("p-1", HASH, TOKEN, NOW_S)).resolves.toBe("saved");
    const read = (sent[0] as GetItemCommand).input;
    expect(read).toMatchObject({ Key: { pk: { S: "TOKENS#p-1" }, sk: { S: "TOKENS" } }, ConsistentRead: true, ProjectionExpression: "#tokens" });
    expect(Object.values(read.ExpressionAttributeNames ?? {})).toEqual([...APP_TOKEN_LIST_READ_ATTRIBUTES]);
    const [put, update] = (sent[1] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(put?.Put?.Item).toEqual({
      pk: { S: `APPTOKEN#${HASH}` },
      sk: { S: "TOKEN" },
      type: { S: "app-token" },
      app: { S: "ada" },
      nickname: { S: "Bob" },
      createdAt: { S: new Date(NOW_S * 1000).toISOString() },
      expiresAt: { N: String(NOW_S + 3600) },
    });
    expect(put?.Put?.ConditionExpression).toBe("attribute_not_exists(#pk)");
    for (const name of [...Object.keys(put?.Put?.Item ?? {}), "pk"]) expect(APP_TOKEN_PUT_ATTRIBUTES).toContain(name);
    expect(update?.Update).toMatchObject({
      Key: { pk: { S: "TOKENS#p-1" }, sk: { S: "TOKENS" } },
      UpdateExpression: "SET #type = :type, #tokens = :tokens, #expiresAt = :listExpiresAt",
      ConditionExpression: "attribute_not_exists(#tokens)",
    });
    expect(update?.Update?.ExpressionAttributeValues?.[":tokens"]).toEqual({ M: { [HASH]: { N: String(NOW_S + 3600) } } });
    expect(update?.Update?.ExpressionAttributeValues?.[":listExpiresAt"]).toEqual({ N: String(NOW_S + 12 * 3600) });
    expectPlaceholders(update?.Update as never);
    for (const name of topLevelNames(update?.Update as never)) expect(APP_TOKEN_LIST_UPDATE_ATTRIBUTES).toContain(name);
    expectPlaceholders(put?.Put as never);
  });

  it("adds a later token to the list, drops expired entries, and holds only while the list's size is the one read", async () => {
    const list = { [hash(1)]: { N: String(NOW_S - 1) }, [hash(2)]: { N: String(NOW_S) }, [hash(3)]: { N: String(NOW_S + 10) } };
    const { client, sent } = stubClient([{ Item: { tokens: { M: list } } }, {}]);
    await expect(new DynamoAppTokenStore(client, TABLE).createAppToken("p-1", HASH, TOKEN, NOW_S)).resolves.toBe("saved");
    const update = (sent[1] as TransactWriteItemsCommand).input.TransactItems?.[1]?.Update;
    expect(update?.UpdateExpression).toBe("SET #type = :type, #tokens.#new = :expiresAt, #expiresAt = :listExpiresAt REMOVE #tokens.#old0, #tokens.#old1");
    expect(update?.ConditionExpression).toBe("size(#tokens) = :size");
    expect(update?.ExpressionAttributeNames).toMatchObject({ "#new": HASH, "#old0": hash(1), "#old1": hash(2) });
    expect(update?.ExpressionAttributeValues?.[":size"]).toEqual({ N: "3" });
    expectPlaceholders(update as never);
    for (const name of topLevelNames(update as never)) expect(APP_TOKEN_LIST_UPDATE_ATTRIBUTES).toContain(name);
  });

  it(`refuses a new token, writing nothing, while ${MAX_APP_TOKENS} are live; a lost race is a conflict`, async () => {
    const full = Object.fromEntries(Array.from({ length: MAX_APP_TOKENS }, (_, i) => [hash(i + 1), { N: String(NOW_S + 60) }]));
    const { client, sent } = stubClient([{ Item: { tokens: { M: full } } }]);
    await expect(new DynamoAppTokenStore(client, TABLE).createAppToken("p-1", HASH, TOKEN, NOW_S)).resolves.toBe("too-many");
    expect(sent).toHaveLength(1);
    const withExpired = { ...full, [hash(1)]: { N: String(NOW_S) } };
    const race = stubClient([{ Item: { tokens: { M: withExpired } } }, cancelled()]);
    await expect(new DynamoAppTokenStore(race.client, TABLE).createAppToken("p-1", HASH, TOKEN, NOW_S)).resolves.toBe("conflict");
    const failing = stubClient([{}, Object.assign(new Error("x"), { name: "InternalServerError" })]);
    await expect(new DynamoAppTokenStore(failing.client, TABLE).createAppToken("p-1", HASH, TOKEN, NOW_S)).rejects.toThrow("x");
  });

  it("revokes: deletes every listed token, then the list while it still has as many entries, reading again after a race", async () => {
    const two = { [hash(1)]: { N: "1" }, [hash(2)]: { N: "2" } };
    const three = { ...two, [hash(3)]: { N: "3" } };
    const { client, sent } = stubClient([{ Item: { tokens: { M: two } } }, {}, {}, conditionFailed(), { Item: { tokens: { M: three } } }, {}, {}, {}, {}]);
    await expect(new DynamoAppTokenStore(client, TABLE).revokeAppTokens("p-1")).resolves.toBe(3);
    const deleted = sent.filter((c): c is DeleteItemCommand => c instanceof DeleteItemCommand).map((c) => c.input.Key?.["pk"]?.S);
    expect(deleted).toEqual([`APPTOKEN#${hash(1)}`, `APPTOKEN#${hash(2)}`, "TOKENS#p-1", `APPTOKEN#${hash(1)}`, `APPTOKEN#${hash(2)}`, `APPTOKEN#${hash(3)}`, "TOKENS#p-1"]);
    const last = (sent[sent.length - 1] as DeleteItemCommand).input;
    expect(last).toMatchObject({ ConditionExpression: "attribute_not_exists(#pk) OR size(#tokens) = :size", ExpressionAttributeValues: { ":size": { N: "3" } } });
    expect(last.ReturnValues).toBeUndefined();
    expectPlaceholders(last as never);
  });

  it("revokes nothing when there is no list, and gives up after repeated races", async () => {
    const none = stubClient([{}]);
    await expect(new DynamoAppTokenStore(none.client, TABLE).revokeAppTokens("p-1")).resolves.toBe(0);
    const answers: (Record<string, unknown> | Error)[] = [];
    for (let i = 0; i < REVOKE_ATTEMPTS; i += 1) answers.push({ Item: { tokens: { M: { [hash(1)]: { N: "1" } } } } }, {}, conditionFailed());
    const busy = stubClient(answers);
    await expect(new DynamoAppTokenStore(busy.client, TABLE).revokeAppTokens("p-1")).rejects.toThrow();
  });
});
