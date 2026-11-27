// Ticket 3.26: the edit links' DynamoDB calls: what they read and write, under which conditions, and that every name
// they use is in the IAM lists of infra/lib/config.ts.
import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
  APP_EDIT_PROFILE_CHECK_ATTRIBUTES,
  APP_EDIT_PUT_ATTRIBUTES,
  APP_EDIT_READ_ATTRIBUTES,
  APP_EDIT_TOKEN_PUT_ATTRIBUTES,
  APP_EDIT_UPDATE_ATTRIBUTES,
  APP_TOKEN_READ_ATTRIBUTES,
} from "../../../infra/lib/config.js";
import { REMOVED_ROLE as ALLOW_LIST_REMOVED_ROLE } from "../../src/allowlist/store.js";
import { DELETE_ATTEMPTS, DynamoAppTokenStore, REMOVED_ROLE, type AppTokenSender } from "./store.js";

type Sent = GetItemCommand | TransactWriteItemsCommand;

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
const NOW_ISO = "2026-11-27T10:00:00.000Z";
const HASH = "a".repeat(64);
const OLD_HASH = "b".repeat(64);
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const LINK = { secret: SECRET, secretHash: HASH, nickname: "Ada" };
/** A transaction cancelled on the condition of its item number `index` only. */
const cancelledAt = (index: number): Error =>
  Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [0, 1, 2, 3].map((i) => ({ Code: i === index ? "ConditionalCheckFailed" : "None" })) });
const stored = (hash = OLD_HASH) => ({ Item: { secret: { S: "old" }, secretHash: { S: hash }, nickname: { S: "Ada" } } });

/** Every `#name` and `:value` an expression uses is defined, and every one defined is used (DynamoDB refuses either). */
function expectPlaceholders(input: { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } & Record<string, unknown>) {
  const text = ["UpdateExpression", "ConditionExpression", "ProjectionExpression"].map((k) => String(input[k] ?? "")).join(" ");
  const used = (prefix: string) => new Set(text.match(new RegExp(`${prefix}[A-Za-z0-9_]+`, "g")) ?? []);
  expect(used("#")).toEqual(new Set(Object.keys(input.ExpressionAttributeNames ?? {})));
  expect(used(":")).toEqual(new Set(Object.keys(input.ExpressionAttributeValues ?? {})));
}

/** Every attribute name an item names (its own attributes and its expressions' names). */
function namesOf(input: { Item?: Record<string, unknown> | undefined; ExpressionAttributeNames?: Record<string, string> | undefined }): string[] {
  return [...new Set([...Object.keys(input.Item ?? {}), ...Object.values(input.ExpressionAttributeNames ?? {})])];
}

describe("DynamoAppTokenStore (ticket 3.26)", () => {
  it("the write check reads a lookup item by hash with a consistent read of app, nickname and kind only", async () => {
    const { client, sent } = stubClient([
      { Item: { app: { S: "ada" }, nickname: { S: "Ada" }, kind: { S: "edit" } } },
      { Item: { app: { S: "ada" }, nickname: { S: "Bob" } } },
      {},
    ]);
    const store = new DynamoAppTokenStore(client, TABLE);
    await expect(store.getAppToken(HASH)).resolves.toEqual({ app: "ada", nickname: "Ada", kind: "edit" });
    // A 3.24 token: no kind (the check refuses it).
    await expect(store.getAppToken(HASH)).resolves.toEqual({ app: "ada", nickname: "Bob" });
    await expect(store.getAppToken(HASH)).resolves.toBeUndefined();
    const input = (sent[0] as GetItemCommand).input;
    expect(input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `APPTOKEN#${HASH}` }, sk: { S: "TOKEN" } },
      ConsistentRead: true,
      ProjectionExpression: "#app, #nickname, #kind",
      ExpressionAttributeNames: { "#app": "app", "#nickname": "nickname", "#kind": "kind" },
    });
    for (const name of namesOf(input)) expect(APP_TOKEN_READ_ATTRIBUTES).toContain(name);
    expect(APP_TOKEN_READ_ATTRIBUTES).toEqual(expect.arrayContaining(["pk", "sk"]));
    // The secret is never in what the write routes may read.
    for (const name of ["secret", "secretHash"]) expect(APP_TOKEN_READ_ATTRIBUTES).not.toContain(name);
    await expect(store.getAppToken("not-a-hash")).rejects.toThrow();
  });

  it("reads an app's edit link (secret, hash, builder) with a consistent projected read; a broken item is none", async () => {
    const { client, sent } = stubClient([stored(), {}, { Item: { secret: { S: "x" }, secretHash: { S: "nothex" }, nickname: { S: "Ada" } } }]);
    const store = new DynamoAppTokenStore(client, TABLE);
    await expect(store.getEditLink("Ada")).resolves.toEqual({ secret: "old", secretHash: OLD_HASH, nickname: "Ada" });
    await expect(store.getEditLink("Ada")).resolves.toBeUndefined();
    await expect(store.getEditLink("Ada")).resolves.toBeUndefined();
    const input = (sent[0] as GetItemCommand).input;
    expect(input).toMatchObject({ Key: { pk: { S: "APPEDIT#ada" }, sk: { S: "EDIT" } }, ConsistentRead: true, ProjectionExpression: "#secret, #secretHash, #nickname" });
    expectPlaceholders(input as never);
    for (const name of namesOf(input)) expect(APP_EDIT_READ_ATTRIBUTES).toContain(name);
  });

  it("makes a link only if the app has none, with its lookup item (kind edit) and a check of the builder's profile", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoAppTokenStore(client, TABLE).createEditLink("Ada", "p-1", LINK, NOW_ISO)).resolves.toBe("saved");
    const items = (sent[0] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    const [edit, lookup, profile] = items;
    expect(edit?.Put?.Item).toEqual({
      pk: { S: "APPEDIT#ada" },
      sk: { S: "EDIT" },
      type: { S: "app-edit" },
      app: { S: "ada" },
      nickname: { S: "Ada" },
      secret: { S: SECRET },
      secretHash: { S: HASH },
      createdAt: { S: NOW_ISO },
    });
    expect(edit?.Put?.ConditionExpression).toBe("attribute_not_exists(#pk)");
    for (const name of namesOf(edit?.Put as never)) expect(APP_EDIT_PUT_ATTRIBUTES).toContain(name);
    expect(lookup?.Put?.Item).toEqual({
      pk: { S: `APPTOKEN#${HASH}` },
      sk: { S: "TOKEN" },
      type: { S: "app-edit-token" },
      app: { S: "ada" },
      nickname: { S: "Ada" },
      kind: { S: "edit" },
      createdAt: { S: NOW_ISO },
    });
    // The lookup item never holds the secret, and has no expiry.
    expect(JSON.stringify(lookup)).not.toContain(SECRET);
    expect(lookup?.Put?.ConditionExpression).toBe("attribute_not_exists(#pk)");
    for (const name of namesOf(lookup?.Put as never)) expect(APP_EDIT_TOKEN_PUT_ATTRIBUTES).toContain(name);
    expect(profile?.ConditionCheck).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } },
      ConditionExpression: "attribute_exists(#pk) AND #role <> :removed",
      ExpressionAttributeNames: { "#pk": "pk", "#role": "role" },
      ExpressionAttributeValues: { ":removed": { S: REMOVED_ROLE } },
    });
    expect(REMOVED_ROLE).toBe(ALLOW_LIST_REMOVED_ROLE);
    for (const name of namesOf(profile?.ConditionCheck as never)) expect(APP_EDIT_PROFILE_CHECK_ATTRIBUTES).toContain(name);
    for (const item of items) expectPlaceholders((item.Put ?? item.ConditionCheck) as never);
  });

  it("a make that finds a link already there is `exists`; a removed profile is `removed`; other errors are thrown", async () => {
    const { client } = stubClient([cancelledAt(0), cancelledAt(2), Object.assign(new Error("down"), { name: "InternalServerError" })]);
    const store = new DynamoAppTokenStore(client, TABLE);
    await expect(store.createEditLink("ada", "p-1", LINK, NOW_ISO)).resolves.toBe("exists");
    await expect(store.createEditLink("ada", "p-1", LINK, NOW_ISO)).resolves.toBe("removed");
    await expect(store.createEditLink("ada", "p-1", LINK, NOW_ISO)).rejects.toThrow("down");
  });

  it("renews in one transaction: the per-app item only while its hash is the old one, the new lookup, the old lookup's delete, the profile check", async () => {
    const { client, sent } = stubClient([{}, cancelledAt(0), cancelledAt(3)]);
    const store = new DynamoAppTokenStore(client, TABLE);
    await expect(store.renewEditLink("Ada", "p-1", OLD_HASH, LINK, NOW_ISO)).resolves.toBe("saved");
    const items = (sent[0] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(items).toHaveLength(4);
    const [update, lookup, removal, profile] = items;
    expect(update?.Update).toMatchObject({
      Key: { pk: { S: "APPEDIT#ada" }, sk: { S: "EDIT" } },
      UpdateExpression: "SET #secret = :secret, #secretHash = :secretHash, #updatedAt = :now",
      ConditionExpression: "#secretHash = :oldHash",
    });
    expect(update?.Update?.ExpressionAttributeValues?.[":oldHash"]).toEqual({ S: OLD_HASH });
    expectPlaceholders(update?.Update as never);
    for (const name of namesOf(update?.Update as never)) expect(APP_EDIT_UPDATE_ATTRIBUTES).toContain(name);
    expect(lookup?.Put?.Item?.["pk"]).toEqual({ S: `APPTOKEN#${HASH}` });
    expect(lookup?.Put?.Item?.["kind"]).toEqual({ S: "edit" });
    expect(removal?.Delete).toEqual({ TableName: TABLE, Key: { pk: { S: `APPTOKEN#${OLD_HASH}` }, sk: { S: "TOKEN" } } });
    expect(profile?.ConditionCheck?.Key).toEqual({ pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } });
    await expect(store.renewEditLink("Ada", "p-1", OLD_HASH, LINK, NOW_ISO)).resolves.toBe("changed");
    await expect(store.renewEditLink("Ada", "p-1", OLD_HASH, LINK, NOW_ISO)).resolves.toBe("removed");
  });

  it("deletes the link and its lookup item together, only while the hash is the one read; reads again after a renewal", async () => {
    const { client, sent } = stubClient([stored(), cancelledAt(1), stored(HASH), {}]);
    await expect(new DynamoAppTokenStore(client, TABLE).deleteEditLink("Ada")).resolves.toBe(true);
    const last = (sent[3] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(last[0]?.Delete).toEqual({ TableName: TABLE, Key: { pk: { S: `APPTOKEN#${HASH}` }, sk: { S: "TOKEN" } } });
    expect(last[1]?.Delete).toMatchObject({ Key: { pk: { S: "APPEDIT#ada" }, sk: { S: "EDIT" } }, ConditionExpression: "#secretHash = :hash" });
    expect(last[1]?.Delete?.ExpressionAttributeValues?.[":hash"]).toEqual({ S: HASH });
    expectPlaceholders(last[1]?.Delete as never);
  });

  it("deletes nothing when there is no link, and gives up after repeated races", async () => {
    const none = stubClient([{}]);
    await expect(new DynamoAppTokenStore(none.client, TABLE).deleteEditLink("ada")).resolves.toBe(false);
    expect(none.sent).toHaveLength(1);
    const racing = stubClient(Array.from({ length: DELETE_ATTEMPTS }, () => [stored(), cancelledAt(1)]).flat());
    await expect(new DynamoAppTokenStore(racing.client, TABLE).deleteEditLink("ada")).rejects.toThrow("kept changing");
  });
});
