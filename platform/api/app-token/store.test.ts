// Ticket 3.26: the edit links' DynamoDB calls: what they read and write, under which conditions, and that every name
// they use is in the IAM lists of infra/lib/config.ts.
import { DeleteItemCommand, GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
  APP_EDIT_PROFILE_CHECK_ATTRIBUTES,
  APP_EDIT_PUT_ATTRIBUTES,
  APP_EDIT_READ_ATTRIBUTES,
  APP_EDIT_TOKEN_PUT_ATTRIBUTES,
  APP_EDIT_UPDATE_ATTRIBUTES,
  APP_TOKEN_READ_ATTRIBUTES,
} from "../../../infra/lib/config.js";
import { REMOVED_ROLE as ALLOW_LIST_REMOVED_ROLE, DynamoAllowListStore, type DynamoSender } from "../../src/allowlist/store.js";
import { DELETE_ATTEMPTS, DynamoAppTokenStore, REMOVED_ROLE, type AppTokenSender } from "./store.js";
import { ensureEditLink, hashAppToken, renewEditLink } from "./token.js";

type Sent = GetItemCommand | TransactWriteItemsCommand | DeleteItemCommand;

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

  it("deletes nothing when there is no link; after repeated races deletes the per-app item whatever its hash, then its lookup, twice", async () => {
    const none = stubClient([{}]);
    await expect(new DynamoAppTokenStore(none.client, TABLE).deleteEditLink("ada")).resolves.toBe(false);
    expect(none.sent).toHaveLength(1);
    const NEWER = "c".repeat(64);
    const racing = stubClient([
      ...Array.from({ length: DELETE_ATTEMPTS }, () => [stored(), cancelledAt(1)]).flat(),
      { Attributes: { secretHash: { S: NEWER }, secret: { S: "s" }, nickname: { S: "Ada" } } },
      {},
      {},
    ]);
    await expect(new DynamoAppTokenStore(racing.client, TABLE).deleteEditLink("Ada")).resolves.toBe(true);
    const deletes = racing.sent.slice(DELETE_ATTEMPTS * 2).map((c) => (c as DeleteItemCommand).input);
    expect(deletes).toEqual([
      { TableName: TABLE, Key: { pk: { S: "APPEDIT#ada" }, sk: { S: "EDIT" } }, ReturnValues: "ALL_OLD" },
      { TableName: TABLE, Key: { pk: { S: `APPTOKEN#${NEWER}` }, sk: { S: "TOKEN" } } },
      { TableName: TABLE, Key: { pk: { S: "APPEDIT#ada" }, sk: { S: "EDIT" } }, ReturnValues: "ALL_OLD" },
    ]);
  });
});

// Ticket 3.26 try 2 (access review L1, L2): making and renewing a link raced by reset's delete and by allow-list removal
// (mark the profile removed, then delete the link), against a small in-memory DynamoDB that evaluates the stores' real
// conditions, interleaved in EVERY order their calls can take (each `send` is one step).
const ADDRESS = ["ada", "example.org"].join("@");
const BUILDER = "p-1";
type Client = AppTokenSender & DynamoSender;
type Actor = (client: Client) => Promise<string>;
let counter = 0;
const bytes = (size: number): Buffer => Buffer.alloc(size, ++counter % 256);
const NOW = new Date(NOW_ISO);
const builderStore = (client: Client) => new DynamoAppTokenStore(client, TABLE);
const makeLink: Actor = async (client) => ((await ensureEditLink(builderStore(client), BUILDER, "Ada", bytes, NOW)) === undefined ? "refused" : "made");
const renewLink: Actor = async (client) => {
  const result = await renewEditLink(builderStore(client), BUILDER, "Ada", bytes, NOW);
  return result.ok ? "renewed" : result.reason;
};
const renewTwice: Actor = async (client) => `${await renewLink(client)},${await renewLink(client)}`;
const resetDelete: Actor = async (client) => String(await builderStore(client).deleteEditLink("Ada"));
const removeLikeTheCommand: Actor = async (client) => {
  const result = await new DynamoAllowListStore(client, TABLE, () => NOW).remove(ADDRESS);
  return String(result.removed);
};
/** Control: the removal in the wrong order (link deleted before the profile is marked). */
const removeLinkFirst: Actor = async (client) => {
  await builderStore(client).deleteEditLink("Ada");
  await client.send(
    new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `PARTICIPANT#${BUILDER}` }, sk: { S: "PROFILE" } },
      UpdateExpression: "SET #role = :role",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":role": { S: REMOVED_ROLE } },
    }),
  );
  return "done";
};

function seed(db: MiniDynamo, withLink: boolean): void {
  db.put({ pk: { S: `PARTICIPANT#${BUILDER}` }, sk: { S: "PROFILE" }, role: { S: "participant" }, nickname: { S: "Ada" } });
  db.put({ pk: { S: `EMAIL#${ADDRESS}` }, sk: { S: "ALLOW" }, role: { S: "participant" }, participantId: { S: BUILDER } });
  if (!withLink) return;
  const secret = Buffer.alloc(32, 200).toString("base64url");
  const secretHash = hashAppToken(secret);
  db.put({ pk: { S: "APPEDIT#ada" }, sk: { S: "EDIT" }, app: { S: "ada" }, nickname: { S: "Ada" }, secret: { S: secret }, secretHash: { S: secretHash } });
  db.put({ pk: { S: `APPTOKEN#${secretHash}` }, sk: { S: "TOKEN" }, app: { S: "ada" }, nickname: { S: "Ada" }, kind: { S: "edit" } });
}

/**
 * Runs the builder's actor and the deleting one under one schedule of choices. `atDelete` is the table's lookup items
 * right after the deleter's last step (nothing else can have run in between).
 */
async function runSchedule(choices: number[], builder: Actor, deleter: Actor, db: MiniDynamo) {
  const waiting = new Map<string, (() => void)[]>([["builder", []], ["deleter", []]]);
  const client = (actor: string): Client =>
    ({
      send: async (command: Sent | UpdateItemCommand) => {
        await new Promise<void>((resolve) => waiting.get(actor)?.push(resolve));
        return db.send(command);
      },
    }) as unknown as Client;
  let deleterDone = false;
  const built = builder(client("builder"));
  const deleted = deleter(client("deleter")).finally(() => {
    deleterDone = true;
  });
  let atDelete: string[] | undefined;
  let step = 0;
  for (;;) {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    if (deleterDone && atDelete === undefined) atDelete = db.tokenItems();
    const ready = ["builder", "deleter"].filter((a) => (waiting.get(a)?.length ?? 0) > 0);
    if (ready.length === 0) break;
    let pick = 0;
    if (ready.length === 2) {
      pick = choices[step] ?? 0;
      step += 1;
    }
    waiting.get(ready[pick] as string)?.shift()?.();
  }
  return { results: [await built, await deleted], atDelete: atDelete ?? [], choicesUsed: step };
}

/** Every schedule: depth-first over the points where both actors could go next. */
async function everySchedule(builder: Actor, deleter: Actor, withLink: boolean) {
  const runs: { db: MiniDynamo; results: string[]; atDelete: string[]; label: string }[] = [];
  const stack: number[][] = [[]];
  while (stack.length > 0) {
    const prefix = stack.pop() as number[];
    const db = new MiniDynamo();
    seed(db, withLink);
    const run = await runSchedule(prefix, builder, deleter, db);
    const full = [...prefix];
    while (full.length < run.choicesUsed) full.push(0);
    runs.push({ db, results: run.results, atDelete: run.atDelete, label: `schedule ${full.join("")} (${run.results.join("; ")})` });
    for (let i = prefix.length; i < run.choicesUsed; i += 1) stack.push([...full.slice(0, i), 1]);
  }
  return runs;
}

/** Every lookup item left belongs to the app's current link (no orphan a later delete could not find). */
function expectConsistent(db: MiniDynamo, label: string): void {
  const hash = db.get({ pk: "APPEDIT#ada", sk: "EDIT" })?.["secretHash"]?.S;
  expect(db.tokenItems(), label).toEqual(hash === undefined ? [] : [`APPTOKEN#${hash}|TOKEN`]);
}

describe("reset's delete racing a make or a renewal (ticket 3.26 try 2)", () => {
  for (const [name, builder, withLink] of [
    ["a make (GET /api/build)", makeLink, false],
    ["a renewal", renewLink, true],
    ["two renewals", renewTwice, true],
  ] as const) {
    it(`WHEN ${name} and the delete interleave in any order THEN no lookup item survives the delete and none is orphaned`, async () => {
      const runs = await everySchedule(builder, resetDelete, withLink);
      expect(runs.length).toBeGreaterThanOrEqual(3);
      for (const run of runs) {
        expect(run.atDelete, run.label).toEqual([]);
        expectConsistent(run.db, run.label);
      }
      // Some orders deleted a link (the builder's, when it came first).
      expect(runs.some((r) => r.results[1] === "true")).toBe(true);
    });
  }

  it("WHEN the builder renews before every one of the delete's tries (hostile) THEN the delete still ends with no link, and renewing after it finds none", async () => {
    const db = new MiniDynamo();
    seed(db, true);
    let renewals = 0;
    const hostile = {
      send: async (command: Sent) => {
        if (command instanceof TransactWriteItemsCommand) {
          expect((await renewEditLink(builderStore(db as unknown as Client), BUILDER, "Ada", bytes, NOW)).ok).toBe(true);
          renewals += 1;
        }
        return db.send(command);
      },
    } as unknown as Client;
    await expect(builderStore(hostile).deleteEditLink("Ada")).resolves.toBe(true);
    expect(renewals).toBe(DELETE_ATTEMPTS);
    expect(db.tokenItems()).toEqual([]);
    expect(db.get({ pk: "APPEDIT#ada", sk: "EDIT" })).toBeUndefined();
    expect(await renewLink(db as unknown as Client)).toBe("none");
  });

  it("WHEN a make lands between the forced delete of the per-app item and its lookup's delete THEN the second pass deletes it too", async () => {
    const db = new MiniDynamo();
    seed(db, true);
    let made = false;
    const hostile = {
      send: async (command: Sent) => {
        if (command instanceof TransactWriteItemsCommand) await renewEditLink(builderStore(db as unknown as Client), BUILDER, "Ada", bytes, NOW);
        const answer = await db.send(command);
        if (command instanceof DeleteItemCommand && command.input.ReturnValues === "ALL_OLD" && !made) {
          made = (await makeLink(db as unknown as Client)) === "made";
        }
        return answer;
      },
    } as unknown as Client;
    await expect(builderStore(hostile).deleteEditLink("Ada")).resolves.toBe(true);
    expect(made).toBe(true);
    expect(db.tokenItems()).toEqual([]);
    expect(db.get({ pk: "APPEDIT#ada", sk: "EDIT" })).toBeUndefined();
  });
});

describe("allow-list removal racing a make or a renewal (ticket 3.26 try 2)", () => {
  for (const [name, builder, withLink] of [
    ["a make", makeLink, false],
    ["a renewal", renewLink, true],
  ] as const) {
    it(`WHEN ${name} and the removal interleave in any order THEN no link is left and none is made for the removed profile`, async () => {
      const runs = await everySchedule(builder, removeLikeTheCommand, withLink);
      expect(runs.length).toBeGreaterThan(5);
      for (const run of runs) {
        expect(run.atDelete, run.label).toEqual([]);
        expect(run.db.tokenItems(), run.label).toEqual([]);
        expect(run.db.get({ pk: "APPEDIT#ada", sk: "EDIT" }), run.label).toBeUndefined();
        expect(run.db.get({ pk: `PARTICIPANT#${BUILDER}`, sk: "PROFILE" })?.["role"]?.S).toBe(REMOVED_ROLE);
      }
      // Some orders made or renewed before the removal deleted it, some were refused once the profile was marked.
      expect(runs.some((r) => r.results[0] === (withLink ? "renewed" : "made"))).toBe(true);
      expect(runs.some((r) => r.results[0] !== (withLink ? "renewed" : "made"))).toBe(true);
    });
  }

  it("control: WHEN the removal deleted the link before marking the profile THEN some order leaves a live link", async () => {
    const runs = await everySchedule(makeLink, removeLinkFirst, false);
    expect(runs.some((r) => r.db.tokenItems().length > 0)).toBe(true);
  });
});

/**
 * Just enough of DynamoDB for the edit links: GetItem (projection ignored), DeleteItem (ReturnValues ALL_OLD),
 * UpdateItem (`SET` of top-level names) and TransactWriteItems (Put, Update, Delete, ConditionCheck; every condition
 * checked before anything is written) with the condition forms the stores use (`attribute_exists`,
 * `attribute_not_exists`, `#a = :v`, `#a <> :v`, joined by `AND`).
 */
class MiniDynamo {
  private readonly items = new Map<string, Record<string, AttributeValue>>();
  private static id(key: Record<string, unknown>): string {
    const value = (v: unknown) => (typeof v === "string" ? v : (v as { S: string }).S);
    return `${value(key["pk"])}|${value(key["sk"])}`;
  }
  put(item: Record<string, AttributeValue>): void {
    this.items.set(MiniDynamo.id(item), structuredClone(item));
  }
  get(key: { pk: string; sk: string }): Record<string, AttributeValue> | undefined {
    return this.items.get(MiniDynamo.id(key));
  }
  tokenItems(): string[] {
    return [...this.items.keys()].filter((k) => k.startsWith("APPTOKEN#")).sort();
  }

  private holds(item: Record<string, AttributeValue> | undefined, expression: string | undefined, names: Record<string, string>, values: Record<string, AttributeValue>): boolean {
    if (expression === undefined) return true;
    return expression.split(" AND ").every((part) => {
      let m = /^attribute_exists\((#?\w+)\)$/.exec(part);
      const name = (n: string) => (n.startsWith("#") ? (names[n] as string) : n);
      if (m) return item?.[name(m[1] as string)] !== undefined;
      m = /^attribute_not_exists\((#\w+)\)$/.exec(part);
      if (m) return item?.[name(m[1] as string)] === undefined;
      m = /^(#\w+) = (:\w+)$/.exec(part);
      if (m) return item?.[name(m[1] as string)] !== undefined && JSON.stringify(item?.[name(m[1] as string)]) === JSON.stringify(values[m[2] as string]);
      // DynamoDB: a comparison with a missing attribute is false, `<>` included (the store pairs it with attribute_exists).
      m = /^(#\w+) <> (:\w+)$/.exec(part);
      if (m) {
        const value = item?.[name(m[1] as string)];
        return value !== undefined && JSON.stringify(value) !== JSON.stringify(values[m[2] as string]);
      }
      throw new Error(`MiniDynamo cannot read the condition ${part}`);
    });
  }

  private applyUpdate(key: Record<string, AttributeValue>, expression: string, names: Record<string, string>, values: Record<string, AttributeValue>): void {
    const item = structuredClone(this.items.get(MiniDynamo.id(key)) ?? { ...key });
    for (const assignment of expression.replace(/^SET /, "").split(", ")) {
      const [path, value] = assignment.split(" = ") as [string, string];
      item[names[path] as string] = structuredClone(values[value] as AttributeValue);
    }
    this.items.set(MiniDynamo.id(key), item);
  }

  async send(command: Sent | UpdateItemCommand): Promise<Record<string, unknown>> {
    if (command instanceof GetItemCommand) {
      const item = this.items.get(MiniDynamo.id(command.input.Key ?? {}));
      return item === undefined ? {} : { Item: structuredClone(item) };
    }
    if (command instanceof DeleteItemCommand) {
      const id = MiniDynamo.id(command.input.Key ?? {});
      const old = this.items.get(id);
      if (!this.holds(old, command.input.ConditionExpression, command.input.ExpressionAttributeNames ?? {}, command.input.ExpressionAttributeValues ?? {})) {
        throw Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
      }
      this.items.delete(id);
      return command.input.ReturnValues === "ALL_OLD" && old !== undefined ? { Attributes: old } : {};
    }
    if (command instanceof UpdateItemCommand) {
      const { Key = {}, ConditionExpression, ExpressionAttributeNames = {}, ExpressionAttributeValues = {}, UpdateExpression = "" } = command.input;
      if (!this.holds(this.items.get(MiniDynamo.id(Key)), ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues)) {
        throw Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
      }
      this.applyUpdate(Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues);
      return {};
    }
    const items = command.input.TransactItems ?? [];
    const codes = items.map((t) => {
      const part = t.Put ?? t.Update ?? t.Delete ?? t.ConditionCheck;
      const key = t.Put ? t.Put.Item : (part as { Key: Record<string, AttributeValue> }).Key;
      return this.holds(this.items.get(MiniDynamo.id(key ?? {})), part?.ConditionExpression, part?.ExpressionAttributeNames ?? {}, (part as { ExpressionAttributeValues?: Record<string, AttributeValue> })?.ExpressionAttributeValues ?? {})
        ? "None"
        : "ConditionalCheckFailed";
    });
    if (codes.some((c) => c !== "None")) throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });
    for (const t of items) {
      if (t.Put?.Item) this.put(t.Put.Item);
      if (t.Update) this.applyUpdate(t.Update.Key ?? {}, t.Update.UpdateExpression ?? "", t.Update.ExpressionAttributeNames ?? {}, t.Update.ExpressionAttributeValues ?? {});
      if (t.Delete) this.items.delete(MiniDynamo.id(t.Delete.Key ?? {}));
    }
    return {};
  }
}
