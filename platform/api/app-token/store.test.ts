// Ticket 3.24: the token store's DynamoDB calls: what they read and write, under which conditions, and that every name
// they use is in the IAM lists of infra/lib/config.ts.
import { DeleteItemCommand, GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
  APP_TOKEN_LIST_READ_ATTRIBUTES,
  APP_TOKEN_LIST_UPDATE_ATTRIBUTES,
  APP_TOKEN_PROFILE_CHECK_ATTRIBUTES,
  APP_TOKEN_PUT_ATTRIBUTES,
  APP_TOKEN_READ_ATTRIBUTES,
  APP_TOKEN_SESSION_CHECK_ATTRIBUTES,
} from "../../../infra/lib/config.js";
import { DynamoAllowListStore, REMOVED_ROLE as ALLOW_LIST_REMOVED_ROLE, type DynamoSender } from "../../src/allowlist/store.js";
import { DynamoAppTokenStore, REMOVED_ROLE, REVOKE_ATTEMPTS, type AppTokenSender } from "./store.js";
import { MAX_APP_TOKENS, signOutWithAppTokens } from "./token.js";

type Sent = GetItemCommand | DeleteItemCommand | TransactWriteItemsCommand | UpdateItemCommand;

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
const SESSION_HASH = "5".repeat(64);
const hash = (n: number): string => n.toString(16).padStart(64, "0");
const conditionFailed = (): Error => Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" });
const cancelled = (): Error => Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] });
/** A transaction cancelled on the condition of its item number `index` only. */
const cancelledAt = (index: number): Error =>
  Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [0, 1, 2, 3].map((i) => ({ Code: i === index ? "ConditionalCheckFailed" : "None" })) });
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
    for (const name of Object.values(input.ExpressionAttributeNames ?? {})) expect(APP_TOKEN_READ_ATTRIBUTES).toContain(name);
    // Try 3: the IAM list names the key too, as every read list does.
    expect(APP_TOKEN_READ_ATTRIBUTES).toEqual(expect.arrayContaining(["pk", "sk"]));
    await expect(store.getAppToken("not-a-hash")).rejects.toThrow();
  });

  it("stores a participant's first token and creates their list with it at version 1, each only if absent, only while the session exists", async () => {
    const { client, sent } = stubClient([{}, {}]);
    await expect(new DynamoAppTokenStore(client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).resolves.toBe("saved");
    const read = (sent[0] as GetItemCommand).input;
    expect(read).toMatchObject({ Key: { pk: { S: "TOKENS#p-1" }, sk: { S: "TOKENS" } }, ConsistentRead: true, ProjectionExpression: "#tokens, #version" });
    for (const name of Object.values(read.ExpressionAttributeNames ?? {})) expect(APP_TOKEN_LIST_READ_ATTRIBUTES).toContain(name);
    expect(APP_TOKEN_LIST_READ_ATTRIBUTES).toEqual(expect.arrayContaining(["pk", "sk"]));
    const items = (sent[1] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(items).toHaveLength(4);
    const [put, update, check, profile] = items;
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
      UpdateExpression: "SET #type = :type, #tokens = :tokens, #expiresAt = :listExpiresAt, #version = :nextVersion",
      ConditionExpression: "attribute_not_exists(#version)",
    });
    expect(update?.Update?.ExpressionAttributeValues?.[":tokens"]).toEqual({ M: { [HASH]: { N: String(NOW_S + 3600) } } });
    expect(update?.Update?.ExpressionAttributeValues?.[":listExpiresAt"]).toEqual({ N: String(NOW_S + 12 * 3600) });
    expect(update?.Update?.ExpressionAttributeValues?.[":nextVersion"]).toEqual({ N: "1" });
    expectPlaceholders(update?.Update as never);
    for (const name of topLevelNames(update?.Update as never)) expect(APP_TOKEN_LIST_UPDATE_ATTRIBUTES).toContain(name);
    expectPlaceholders(put?.Put as never);
    // The session check: that the item exists, nothing else of it (IAM: ConditionCheckItem on SESSION#*, `pk` and `sk`).
    expect(check?.ConditionCheck).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `SESSION#${SESSION_HASH}` }, sk: { S: "SESSION" } },
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    });
    for (const name of topLevelNames(check?.ConditionCheck as never)) expect(APP_TOKEN_SESSION_CHECK_ATTRIBUTES).toContain(name);
    expectPlaceholders(check?.ConditionCheck as never);
    // Try 3 (access review L1): the profile exists and is not marked removed (IAM: ConditionCheckItem on PARTICIPANT#*,
    // `pk`, `sk` and `role`), with the very role `npm run allowlist -- remove` writes.
    expect(profile?.ConditionCheck).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } },
      ConditionExpression: "attribute_exists(#pk) AND #role <> :removed",
      ExpressionAttributeNames: { "#pk": "pk", "#role": "role" },
      ExpressionAttributeValues: { ":removed": { S: "removed" } },
    });
    expect(REMOVED_ROLE).toBe(ALLOW_LIST_REMOVED_ROLE);
    for (const name of topLevelNames(profile?.ConditionCheck as never)) expect(APP_TOKEN_PROFILE_CHECK_ATTRIBUTES).toContain(name);
    expectPlaceholders(profile?.ConditionCheck as never);
    // Every transaction item's IAM list names the key (`pk`, `sk`): .claude/rules/infra.md.
    for (const list of [APP_TOKEN_PUT_ATTRIBUTES, APP_TOKEN_LIST_UPDATE_ATTRIBUTES, APP_TOKEN_SESSION_CHECK_ATTRIBUTES, APP_TOKEN_PROFILE_CHECK_ATTRIBUTES]) {
      expect(list).toEqual(expect.arrayContaining(["pk", "sk"]));
    }
  });

  it("adds a later token to the list, drops expired entries, and holds only while the list's version is the one read (then one more)", async () => {
    const list = { [hash(1)]: { N: String(NOW_S - 1) }, [hash(2)]: { N: String(NOW_S) }, [hash(3)]: { N: String(NOW_S + 10) } };
    const { client, sent } = stubClient([{ Item: { tokens: { M: list }, version: { N: "7" } } }, {}]);
    await expect(new DynamoAppTokenStore(client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).resolves.toBe("saved");
    const update = (sent[1] as TransactWriteItemsCommand).input.TransactItems?.[1]?.Update;
    expect(update?.UpdateExpression).toBe(
      "SET #type = :type, #tokens.#new = :expiresAt, #expiresAt = :listExpiresAt, #version = :nextVersion REMOVE #tokens.#old0, #tokens.#old1",
    );
    expect(update?.ConditionExpression).toBe("#version = :version");
    expect(update?.ExpressionAttributeNames).toMatchObject({ "#new": HASH, "#old0": hash(1), "#old1": hash(2) });
    expect(update?.ExpressionAttributeValues).toMatchObject({ ":version": { N: "7" }, ":nextVersion": { N: "8" } });
    expectPlaceholders(update as never);
    for (const name of topLevelNames(update as never)) expect(APP_TOKEN_LIST_UPDATE_ATTRIBUTES).toContain(name);
    // An emptied list (after a revocation) takes the next token as a map entry, under its version.
    const emptied = stubClient([{ Item: { tokens: { M: {} }, version: { N: "9" } } }, {}]);
    await expect(new DynamoAppTokenStore(emptied.client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).resolves.toBe("saved");
    const next = (emptied.sent[1] as TransactWriteItemsCommand).input.TransactItems?.[1]?.Update;
    expect(next?.UpdateExpression).toBe("SET #type = :type, #tokens.#new = :expiresAt, #expiresAt = :listExpiresAt, #version = :nextVersion");
    expect(next?.ExpressionAttributeValues).toMatchObject({ ":version": { N: "9" }, ":nextVersion": { N: "10" } });
  });

  it(`refuses a new token, writing nothing, while ${MAX_APP_TOKENS} are live; a lost race is a conflict; a missing session or a removed profile is no-session`, async () => {
    const full = Object.fromEntries(Array.from({ length: MAX_APP_TOKENS }, (_, i) => [hash(i + 1), { N: String(NOW_S + 60) }]));
    const { client, sent } = stubClient([{ Item: { tokens: { M: full }, version: { N: "3" } } }]);
    await expect(new DynamoAppTokenStore(client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).resolves.toBe("too-many");
    expect(sent).toHaveLength(1);
    const withExpired = { ...full, [hash(1)]: { N: String(NOW_S) } };
    const race = stubClient([{ Item: { tokens: { M: withExpired }, version: { N: "3" } } }, cancelled()]);
    await expect(new DynamoAppTokenStore(race.client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).resolves.toBe("conflict");
    const signedOut = stubClient([{}, cancelledAt(2)]);
    await expect(new DynamoAppTokenStore(signedOut.client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).resolves.toBe("no-session");
    // Try 3: a profile marked removed (or missing) is refused the same way (the route answers 401).
    const removed = stubClient([{}, cancelledAt(3)]);
    await expect(new DynamoAppTokenStore(removed.client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).resolves.toBe("no-session");
    const failing = stubClient([{}, Object.assign(new Error("x"), { name: "InternalServerError" })]);
    await expect(new DynamoAppTokenStore(failing.client, TABLE).createAppToken("p-1", SESSION_HASH, HASH, TOKEN, NOW_S)).rejects.toThrow("x");
  });

  it("revokes: deletes every listed token, then empties the list (version + 1) while its version is the one read, reading again after a race", async () => {
    const two = { [hash(1)]: { N: "1" }, [hash(2)]: { N: "2" } };
    const three = { ...two, [hash(3)]: { N: "3" } };
    const { client, sent } = stubClient([
      { Item: { tokens: { M: two }, version: { N: "4" } } },
      {},
      {},
      conditionFailed(),
      { Item: { tokens: { M: three }, version: { N: "5" } } },
      {},
      {},
      {},
      {},
    ]);
    await expect(new DynamoAppTokenStore(client, TABLE).revokeAppTokens("p-1")).resolves.toBe(3);
    const deleted = sent.filter((c): c is DeleteItemCommand => c instanceof DeleteItemCommand).map((c) => c.input.Key?.["pk"]?.S);
    expect(deleted).toEqual([`APPTOKEN#${hash(1)}`, `APPTOKEN#${hash(2)}`, `APPTOKEN#${hash(1)}`, `APPTOKEN#${hash(2)}`, `APPTOKEN#${hash(3)}`]);
    const emptied = sent.filter((c): c is UpdateItemCommand => c instanceof UpdateItemCommand).map((c) => c.input);
    expect(emptied).toHaveLength(2);
    const last = emptied[1];
    expect(last).toMatchObject({
      Key: { pk: { S: "TOKENS#p-1" }, sk: { S: "TOKENS" } },
      UpdateExpression: "SET #tokens = :empty, #version = :nextVersion",
      ConditionExpression: "#version = :version",
      ExpressionAttributeValues: { ":empty": { M: {} }, ":version": { N: "5" }, ":nextVersion": { N: "6" } },
    });
    expect(last?.ReturnValues).toBeUndefined();
    expectPlaceholders(last as never);
    for (const name of topLevelNames(last as never)) expect(APP_TOKEN_LIST_UPDATE_ATTRIBUTES).toContain(name);
  });

  it("revokes nothing when there is no list or an empty one, and gives up after repeated races", async () => {
    const none = stubClient([{}, { Item: { tokens: { M: {} }, version: { N: "2" } } }]);
    const store = new DynamoAppTokenStore(none.client, TABLE);
    await expect(store.revokeAppTokens("p-1")).resolves.toBe(0);
    await expect(store.revokeAppTokens("p-1")).resolves.toBe(0);
    expect(none.sent).toHaveLength(2);
    const answers: (Record<string, unknown> | Error)[] = [];
    for (let i = 0; i < REVOKE_ATTEMPTS; i += 1) answers.push({ Item: { tokens: { M: { [hash(1)]: { N: "1" } } }, version: { N: String(i + 1) } } }, {}, conditionFailed());
    const busy = stubClient(answers);
    await expect(new DynamoAppTokenStore(busy.client, TABLE).revokeAppTokens("p-1")).rejects.toThrow();
  });
});

// Ticket 3.24 try 2 (access review M2) and try 3 (L1): a token request that already passed its session check, raced by
// a sign-out or by `npm run allowlist -- remove`, run against a small in-memory DynamoDB that evaluates the stores' real
// conditions and updates, interleaved in EVERY order their calls can take (each `send` is one step; the request retries
// a conflict as the route does). Whatever the order, no token item is left and the list is empty once the other has
// finished.
const SESSION_KEY = { pk: `SESSION#${SESSION_HASH}`, sk: "SESSION" };
const ADDRESS = ["bob", "example.org"].join("@");
/** The racing actor: it gets a client whose every `send` is one step of the schedule. */
type Racer = (client: AppTokenSender & DynamoSender) => Promise<void>;

/** Runs the token request and the racer under one schedule of choices; returns the db afterwards. */
async function runSchedule(choices: number[], racer: Racer, db: MiniDynamo) {
  db.put({ pk: { S: `SESSION#${SESSION_HASH}` }, sk: { S: "SESSION" } });
  db.put({ pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" }, role: { S: "participant" }, nickname: { S: "Bob" } });
  db.put({ pk: { S: `EMAIL#${ADDRESS}` }, sk: { S: "ALLOW" }, email: { S: ADDRESS }, role: { S: "participant" }, participantId: { S: "p-1" } });
  // Bob already holds one token from earlier.
  db.put({ pk: { S: `APPTOKEN#${hash(1)}` }, sk: { S: "TOKEN" }, app: { S: "ada" }, nickname: { S: "Bob" }, expiresAt: { N: String(NOW_S + 60) } });
  db.put({ pk: { S: "TOKENS#p-1" }, sk: { S: "TOKENS" }, tokens: { M: { [hash(1)]: { N: String(NOW_S + 60) } } }, version: { N: "1" } });
  // Each actor's sends waiting for their turn (a revocation's parallel deletes go one by one, in order).
  const waiting = new Map<string, (() => void)[]>([["create", []], ["other", []]]);
  const client = (actor: string): AppTokenSender & DynamoSender =>
    ({
      send: async (command: Sent) => {
        await new Promise<void>((resolve) => waiting.get(actor)?.push(resolve));
        return db.send(command);
      },
    }) as unknown as AppTokenSender & DynamoSender;
  const create = (async () => {
    const store = new DynamoAppTokenStore(client("create"), TABLE);
    const results: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await store.createAppToken("p-1", SESSION_HASH, hash(100 + attempt), TOKEN, NOW_S);
      results.push(result);
      if (result !== "conflict") break;
    }
    return results;
  })();
  const other = racer(client("other"));
  let step = 0;
  for (;;) {
    // Let both actors run until each is waiting on a send or finished.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const ready = ["create", "other"].filter((a) => (waiting.get(a)?.length ?? 0) > 0);
    if (ready.length === 0) break;
    let pick = 0;
    if (ready.length === 2) {
      pick = choices[step] ?? 0;
      step += 1;
    }
    const actor = ready[pick] as string;
    waiting.get(actor)?.shift()?.();
  }
  const results = await create;
  await other;
  return { db, results, choicesUsed: step };
}

/** Every schedule: depth-first over the points where both actors could go next. */
async function everySchedule(racer: Racer, newDb: () => MiniDynamo = () => new MiniDynamo()) {
  const runs: { db: MiniDynamo; results: string[]; choices: number[] }[] = [];
  const stack: number[][] = [[]];
  while (stack.length > 0) {
    const prefix = stack.pop() as number[];
    const run = await runSchedule(prefix, racer, newDb());
    const full = [...prefix];
    while (full.length < run.choicesUsed) full.push(0);
    runs.push({ db: run.db, results: run.results, choices: full });
    for (let i = prefix.length; i < run.choicesUsed; i += 1) stack.push([...full.slice(0, i), 1]);
  }
  return runs;
}

describe("sign-out racing a token request (ticket 3.24 try 2)", () => {
  /** A sign-out over the store and a session delete that is one more step (a DeleteItem through the same client). */
  const signOut =
    (run: (store: DynamoAppTokenStore, deleteSession: () => Promise<void>) => Promise<void>): Racer =>
    async (client) => {
      const deleteSession = async () => {
        await client.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: SESSION_KEY.pk }, sk: { S: SESSION_KEY.sk } } }));
      };
      await run(new DynamoAppTokenStore(client, TABLE), deleteSession);
    };
  const signOutLikeTheRoute = signOut(async (store, deleteSession) => {
    const result = await signOutWithAppTokens({ revokeAppTokens: (id) => store.revokeAppTokens(id), createAppToken: () => Promise.reject(new Error("unused")), deleteSession }, "p-1", SESSION_HASH);
    expect(result).toBe("done");
  });

  it("WHEN a token request and a sign-out interleave in any order (all 36) THEN no token survives the sign-out", async () => {
    const runs = await everySchedule(signOutLikeTheRoute);
    expect(runs).toHaveLength(36);
    for (const run of runs) {
      expect(run.db.tokenItems(), `schedule ${run.choices.join("")} (${run.results.join(", ")})`).toEqual([]);
      expect(run.db.listSize(), `schedule ${run.choices.join("")}`).toBe(0);
      expect(run.db.has(SESSION_KEY)).toBe(false);
    }
    // Some orders made a token before the sign-out ended it, some refused it once the session was gone.
    expect(runs.some((r) => r.results.includes("saved"))).toBe(true);
    expect(runs.some((r) => r.results.at(-1) === "no-session")).toBe(true);
  });

  it("control: WHEN the sign-out revoked only once, before deleting the session (try 1) THEN some order leaves a live token", async () => {
    const runs = await everySchedule(
      signOut(async (store, deleteSession) => {
        await store.revokeAppTokens("p-1");
        await deleteSession();
      }),
    );
    expect(runs.some((r) => r.db.tokenItems().length > 0)).toBe(true);
  });
});

describe("allow-list removal racing a token request (ticket 3.24 try 3, access review L1)", () => {
  /** The real `npm run allowlist -- remove` store call: mark the profile removed, revoke the tokens, delete the entry. */
  const removeLikeTheCommand: Racer = async (client) => {
    const result = await new DynamoAllowListStore(client, TABLE).remove(ADDRESS);
    expect(result.removed).toBe(true);
  };

  it("WHEN a token request and a removal interleave in any order THEN no token survives the removal (the session is left)", async () => {
    const runs = await everySchedule(removeLikeTheCommand);
    expect(runs.length).toBeGreaterThan(20);
    for (const run of runs) {
      expect(run.db.tokenItems(), `schedule ${run.choices.join("")} (${run.results.join(", ")})`).toEqual([]);
      expect(run.db.listSize(), `schedule ${run.choices.join("")}`).toBe(0);
      // The removed person's session is still there until their next call: only the profile check stops the create.
      expect(run.db.has(SESSION_KEY)).toBe(true);
      expect(run.db.has({ pk: `EMAIL#${ADDRESS}`, sk: "ALLOW" })).toBe(false);
    }
    expect(runs.some((r) => r.results.includes("saved"))).toBe(true);
    expect(runs.some((r) => r.results.at(-1) === "no-session")).toBe(true);
  });

  it("control: WHEN the create transaction did not check the profile (try 2) THEN some order leaves a live token", async () => {
    const runs = await everySchedule(removeLikeTheCommand, () => new MiniDynamo({ ignoreChecksIn: "PARTICIPANT#" }));
    expect(runs.some((r) => r.db.tokenItems().length > 0)).toBe(true);
  });
});

/**
 * Just enough of DynamoDB for the token store: GetItem, DeleteItem, UpdateItem and TransactWriteItems (Put, Update,
 * ConditionCheck; all conditions checked before anything is written) with the condition and update forms the stores
 * use (`attribute_exists`, `attribute_not_exists`, `#a = :v`, `#a <> :v`, `AND` within `OR`; `SET` of top-level or map-entry paths, `REMOVE`).
 */
class MiniDynamo {
  /** `ignoreChecksIn`: a transaction's ConditionCheck on a key with this prefix always holds (a control: try 2's create). */
  constructor(private readonly options: { ignoreChecksIn?: string } = {}) {}
  private readonly items = new Map<string, Record<string, AttributeValue>>();
  private static id(key: Record<string, AttributeValue> | { pk: string; sk: string }): string {
    const value = (v: unknown) => (typeof v === "string" ? v : (v as { S: string }).S);
    return `${value((key as Record<string, unknown>)["pk"])}|${value((key as Record<string, unknown>)["sk"])}`;
  }
  put(item: Record<string, AttributeValue>): void {
    this.items.set(MiniDynamo.id(item), structuredClone(item));
  }
  delete(key: { pk: string; sk: string }): void {
    this.items.delete(MiniDynamo.id(key));
  }
  has(key: { pk: string; sk: string }): boolean {
    return this.items.has(MiniDynamo.id(key));
  }
  tokenItems(): string[] {
    return [...this.items.keys()].filter((k) => k.startsWith("APPTOKEN#"));
  }
  listSize(): number {
    return Object.keys(this.items.get("TOKENS#p-1|TOKENS")?.["tokens"]?.M ?? {}).length;
  }

  private holds(item: Record<string, AttributeValue> | undefined, expression: string | undefined, names: Record<string, string>, values: Record<string, AttributeValue>): boolean {
    if (expression === undefined) return true;
    return expression.split(" OR ").some((alternative) => alternative.split(" AND ").every((part) => {
      let m = /^attribute_exists\((#\w+)\)$/.exec(part);
      if (m) return item?.[names[m[1] as string] as string] !== undefined;
      m = /^attribute_not_exists\((#\w+)\)$/.exec(part);
      if (m) return item?.[names[m[1] as string] as string] === undefined;
      m = /^(#\w+) = (:\w+)$/.exec(part);
      if (m) return JSON.stringify(item?.[names[m[1] as string] as string]) === JSON.stringify(values[m[2] as string]);
      // DynamoDB: a comparison with a missing attribute is false, `<>` included (the store pairs it with attribute_exists).
      m = /^(#\w+) <> (:\w+)$/.exec(part);
      if (m) {
        const value = item?.[names[m[1] as string] as string];
        return value !== undefined && JSON.stringify(value) !== JSON.stringify(values[m[2] as string]);
      }
      throw new Error(`MiniDynamo cannot read the condition ${part}`);
    }));
  }

  private applyUpdate(key: Record<string, AttributeValue>, expression: string, names: Record<string, string>, values: Record<string, AttributeValue>): void {
    const item = structuredClone(this.items.get(MiniDynamo.id(key)) ?? { ...key });
    const [setPart, removePart] = expression.replace(/^SET /, "").split(" REMOVE ");
    for (const assignment of (setPart ?? "").split(", ")) {
      const [path, value] = assignment.split(" = ") as [string, string];
      const [top, entry] = path.split(".").map((n) => names[n] as string) as [string, string | undefined];
      const v = structuredClone(values[value] as AttributeValue);
      if (entry === undefined) item[top] = v;
      else {
        const map = item[top]?.M;
        if (map === undefined) throw new Error("ValidationException: the document path does not exist");
        map[entry] = v;
      }
    }
    for (const path of removePart?.split(", ") ?? []) {
      const [top, entry] = path.split(".").map((n) => names[n] as string) as [string, string];
      delete item[top]?.M?.[entry];
    }
    this.items.set(MiniDynamo.id(key), item);
  }

  async send(command: Sent | UpdateItemCommand): Promise<Record<string, unknown>> {
    if (command instanceof GetItemCommand) {
      const item = this.items.get(MiniDynamo.id(command.input.Key ?? {}));
      return item === undefined ? {} : { Item: structuredClone(item) };
    }
    if (command instanceof DeleteItemCommand) {
      this.items.delete(MiniDynamo.id(command.input.Key ?? {}));
      return {};
    }
    if (command instanceof UpdateItemCommand) {
      const { Key = {}, ConditionExpression, ExpressionAttributeNames = {}, ExpressionAttributeValues = {}, UpdateExpression = "" } = command.input;
      if (!this.holds(this.items.get(MiniDynamo.id(Key)), ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues)) throw conditionFailed();
      this.applyUpdate(Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues);
      return {};
    }
    const items = command.input.TransactItems ?? [];
    const codes = items.map((t) => {
      const part = t.Put ?? t.Update ?? t.ConditionCheck;
      const key = t.Put ? t.Put.Item : (part as { Key: Record<string, AttributeValue> }).Key;
      const ignored = this.options.ignoreChecksIn;
      if (t.ConditionCheck && ignored !== undefined && (key?.["pk"]?.S ?? "").startsWith(ignored)) return "None";
      return this.holds(this.items.get(MiniDynamo.id(key ?? {})), part?.ConditionExpression, part?.ExpressionAttributeNames ?? {}, (part as { ExpressionAttributeValues?: Record<string, AttributeValue> })?.ExpressionAttributeValues ?? {})
        ? "None"
        : "ConditionalCheckFailed";
    });
    if (codes.some((c) => c !== "None")) throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });
    for (const t of items) {
      if (t.Put?.Item) this.put(t.Put.Item);
      if (t.Update) this.applyUpdate(t.Update.Key ?? {}, t.Update.UpdateExpression ?? "", t.Update.ExpressionAttributeNames ?? {}, t.Update.ExpressionAttributeValues ?? {});
    }
    return {};
  }
}
