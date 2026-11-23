import {
  BatchWriteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { handleConversationRequest, HISTORY_ROUTE, SEND_ROUTE, type ConversationDeps as ApiDeps } from "../../api/conversation/conversation.js";
import { FakeConversationTable, FakeQueue } from "../../api/conversation/fakes.js";
import { STALE_PENDING_SECONDS } from "../../api/conversation/state.js";
import { hashToken, SESSION_COOKIE } from "../../api/session/session.js";
import { parseConversationArgs, runConversation, type ConversationDeps } from "./command.js";
import { DynamoResetStore, type ResetItems, type ResetSender, type ResetState, type ResetStore } from "./store.js";

const NOW = new Date("2026-11-23T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const ADA = Buffer.alloc(32, 1).toString("base64url");
const BOB = Buffer.alloc(32, 2).toString("base64url");
const SECRET = "my secret app idea about the quarterly numbers";

/** The reset store over the in-memory table the API's own tests use, so a reset is checked through the real routes. */
class FakeResetStore implements ResetStore {
  restarts = 0;
  constructor(private readonly t: FakeConversationTable) {}
  async findParticipantId(nickname: string) {
    return this.t.findParticipantId(nickname);
  }
  async getStep(id: string) {
    return this.t.profiles.get(id)?.step;
  }
  async getResetState(id: string): Promise<ResetState> {
    const c = this.t.conversations.get(id);
    return {
      ...(c?.pendingId === undefined ? {} : { pendingId: c.pendingId }),
      ...(c?.pendingSince === undefined ? {} : { pendingSince: c.pendingSince }),
      ...(c === undefined ? {} : { state: c.state }),
    };
  }
  async listResetItems(id: string): Promise<ResetItems> {
    const ids = [...(this.t.messages.get(id)?.keys() ?? [])];
    const replies = [...(this.t.replies.get(id)?.keys() ?? [])].map((m) => `MSG#${m}-r`);
    return {
      messages: [...ids.map((m) => `MSG#${m}`), ...replies],
      specs: (this.t.specs.get(id) ?? []).map((s) => `SPEC#${String(s.version).padStart(4, "0")}`),
    };
  }
  async restart(id: string, seen: string | undefined) {
    this.restarts++;
    if (this.t.conversations.get(id)?.pendingId !== seen) return false;
    const profile = this.t.profiles.get(id);
    if (profile === undefined || profile.step === "nickname") return false;
    this.t.conversations.delete(id);
    profile.step = "clarify";
    return true;
  }
  async deleteItems(id: string, sortKeys: readonly string[]) {
    for (const sk of sortKeys) {
      if (sk.startsWith("SPEC#")) this.t.specs.set(id, (this.t.specs.get(id) ?? []).filter((s) => s.version !== Number(sk.slice(5))));
      else if (sk.endsWith("-r")) this.t.replies.get(id)?.delete(sk.slice(4, -2));
      else this.t.messages.get(id)?.delete(sk.slice(4));
    }
  }
}

/** Ada and Bob, each with an answered message, a reply and a spec, Ada at the given step. */
function setup(step: "clarify" | "spec" | "approved" = "spec") {
  const table = new FakeConversationTable();
  table.addParticipant("p-ada", "Ada", hashToken(ADA), NOW_S + 3600, step);
  table.addParticipant("p-bob", "Bob", hashToken(BOB), NOW_S + 3600, "spec");
  for (const id of ["p-ada", "p-bob"]) {
    const messageId = "2026-11-23T09:00:00.000Z-0101010101010101";
    table.messages.set(id, new Map([[messageId, { id: messageId, step: "clarify", text: SECRET, status: "done", pendingSince: NOW_S - 3600, createdAt: "x" }]]));
    table.replies.set(id, new Map([[messageId, { text: "Who is it for?", kind: "answer", createdAt: "x" }]]));
    table.specs.set(id, [
      { version: 1, text: "# Spec", messageId, createdAt: "x" },
      { version: 2, text: "# Spec v2", messageId, createdAt: "x" },
    ]);
    table.conversations.set(id, { state: "open", latestSpecVersion: 2, ...(step === "approved" && id === "p-ada" ? { approvedSpecVersion: 2 } : {}) });
    table.usage.set(id, { inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
  }
  const store = new FakeResetStore(table);
  const out: string[] = [];
  const err: string[] = [];
  const deps: ConversationDeps = { createStore: () => store, now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l) };
  const api: ApiDeps = { sessions: table, store: table, queue: new FakeQueue(), now: () => NOW, randomBytes: (n) => Buffer.alloc(n, 7), log: () => undefined };
  const history = async (token = ADA) =>
    JSON.parse((await handleConversationRequest({ routeKey: HISTORY_ROUTE, cookies: [`${SESSION_COOKIE}=${token}`] }, api)).body ?? "{}") as {
      step: string;
      messages: unknown[];
    };
  const send = (text: string) =>
    handleConversationRequest(
      { routeKey: SEND_ROUTE, cookies: [`${SESSION_COOKIE}=${ADA}`], headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) },
      api,
    );
  return { table, store, deps, out, err, history, send };
}

describe("parseConversationArgs", () => {
  it("takes reset with one nickname and an optional --yes in any place", () => {
    expect(parseConversationArgs(["reset", "Ada"])).toEqual({ command: "reset", nickname: "Ada", confirmed: false });
    expect(parseConversationArgs(["reset", "Ada", "--yes"])).toEqual({ command: "reset", nickname: "Ada", confirmed: true });
    expect(parseConversationArgs(["reset", "--yes", "Ada"])).toEqual({ command: "reset", nickname: "Ada", confirmed: true });
  });

  it("refuses anything else", () => {
    expect(parseConversationArgs([])).toEqual({ error: "no command given" });
    expect(parseConversationArgs(["delete", "Ada"])).toEqual({ error: "unknown command" });
    expect(parseConversationArgs(["reset"])).toEqual({ error: "reset needs a nickname" });
    expect(parseConversationArgs(["reset", "Ada", "Bob"])).toHaveProperty("error");
    expect(parseConversationArgs(["reset", "Ada", "--yes", "--yes"])).toHaveProperty("error");
    expect(parseConversationArgs(["reset", "a@b.c"])).toHaveProperty("error");
  });

  it("makes no AWS call on a usage error", async () => {
    let created = false;
    const err: string[] = [];
    const code = await runConversation(["reset"], {
      createStore: () => {
        created = true;
        throw new Error("no");
      },
      now: () => NOW,
      out: () => undefined,
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(created).toBe(false);
    expect(err.join("\n")).toContain("Usage: npm run conversation -- reset <nickname> [--yes]");
  });
});

describe("npm run conversation -- reset <nickname>", () => {
  it("WHEN run without --yes THEN it says what it would delete and changes nothing", async () => {
    const { deps, out, table, store } = setup();
    expect(await runConversation(["reset", "Ada"], deps)).toBe(0);
    expect(out).toEqual([
      "Ada is at step 2 (Spec), with 2 messages and replies and 2 spec versions.",
      "Nothing changed. Run again with --yes to delete them and send Ada back to step 1 (Clarify); their AI usage totals are kept.",
    ]);
    expect(store.restarts).toBe(0);
    expect(table.messages.get("p-ada")?.size).toBe(1);
    expect(table.profiles.get("p-ada")?.step).toBe("spec");
  });

  it("WHEN run with --yes THEN the messages, replies and specs are gone, the step is clarify, and the page shows an empty step 1", async () => {
    const { deps, out, err, table, history, send } = setup();
    expect((await history()).messages).toHaveLength(2);
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe("Reset Ada: deleted 2 messages and replies and 2 spec versions; back at step 1 (Clarify). AI usage totals kept.");
    expect(table.messages.get("p-ada")?.size).toBe(0);
    expect(table.replies.get("p-ada")?.size).toBe(0);
    expect(table.specs.get("p-ada")).toEqual([]);
    expect(table.conversations.has("p-ada")).toBe(false);
    expect(table.usage.get("p-ada")).toEqual({ inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
    const after = await history();
    expect(after.step).toBe("clarify");
    expect(after.messages).toEqual([]);
    expect((await send("A plant watering reminder")).statusCode).toBe(202);
  });

  it("WHEN Ada is reset THEN Bob's conversation, specs and step are untouched", async () => {
    const { deps, table, history } = setup();
    await runConversation(["reset", "Ada", "--yes"], deps);
    expect(table.messages.get("p-bob")?.size).toBe(1);
    expect(table.specs.get("p-bob")).toHaveLength(2);
    expect(table.profiles.get("p-bob")?.step).toBe("spec");
    expect((await history(BOB)).messages).toHaveLength(2);
  });

  it("WHEN the spec was approved THEN a reset lets the participant write again", async () => {
    const { deps, send } = setup("approved");
    expect((await send("hello")).statusCode).toBe(409);
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(0);
    expect((await send("hello")).statusCode).toBe(202);
  });

  it("WHEN a message waits for a facilitator THEN the reset clears it too", async () => {
    const { deps, table } = setup("clarify");
    table.conversations.set("p-ada", { state: "waiting", pendingId: "m-flagged", pendingSince: NOW_S - 30 });
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(0);
    expect(table.conversations.has("p-ada")).toBe(false);
  });

  it("WHEN the AI is still answering THEN it refuses and changes nothing, but a stale pending message does not block", async () => {
    const { deps, err, table, store } = setup("clarify");
    table.conversations.set("p-ada", { state: "open", pendingId: "m-live", pendingSince: NOW_S - 30 });
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(1);
    expect(err).toEqual(["The AI is still answering Ada's last message; try again in a minute. Nothing changed."]);
    expect(store.restarts).toBe(0);
    table.conversations.set("p-ada", { state: "open", pendingId: "m-stale", pendingSince: NOW_S - STALE_PENDING_SECONDS - 1 });
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(0);
  });

  it("WHEN a message arrives between the read and the reset THEN nothing is deleted", async () => {
    const { deps, err, table, store } = setup("clarify");
    const original = store.listResetItems.bind(store);
    store.listResetItems = async (id) => {
      const items = await original(id);
      table.conversations.set(id, { state: "open", pendingId: "m-new", pendingSince: NOW_S });
      return items;
    };
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(1);
    expect(err).toEqual(["Ada sent a message meanwhile; nothing changed. Try again in a minute."]);
    expect(table.messages.get("p-ada")?.size).toBe(1);
  });

  it("WHEN the nickname is unknown or has no step yet THEN it says so and exits 1", async () => {
    const { deps, err, table } = setup();
    expect(await runConversation(["reset", "Zed", "--yes"], deps)).toBe(1);
    expect(err).toEqual(["No participant has the nickname Zed."]);
    const profile = table.profiles.get("p-ada");
    if (profile !== undefined) profile.step = "nickname";
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(1);
    expect(err[1]).toBe("Ada has not reached step 1 yet; there is nothing to reset.");
  });

  it("WHEN the table fails THEN it prints the redacted error and how to finish, and never a message text", async () => {
    const { deps, out, err, store } = setup();
    store.deleteItems = async () => {
      throw Object.assign(new Error(`throttled near ${SECRET}`), { name: "ProvisionedThroughputExceededException" });
    };
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(1);
    expect(err[1]).toBe("Run the same command again: a reset that stopped part way finishes on the next run.");
    // The output never shows a message text or an id.
    for (const line of [...out]) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("p-ada");
    }
    // A second run finishes the job: the step is already clarify and the conversation item gone.
    store.deleteItems = FakeResetStore.prototype.deleteItems.bind(store);
    expect(await runConversation(["reset", "Ada", "--yes"], deps)).toBe(0);
  });
});

describe("DynamoResetStore", () => {
  function stub(answers: (Record<string, unknown> | Error)[]) {
    const sent: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        sent.push(command);
        const answer = answers.shift();
        if (answer === undefined) throw new Error("unexpected call");
        if (answer instanceof Error) throw answer;
        return { $metadata: {}, ...answer };
      },
    } as unknown as ResetSender;
    const waits: number[] = [];
    return { store: new DynamoResetStore(client, "ssd-workshop-data", async (ms) => void waits.push(ms)), sent, waits };
  }

  /** Every #name and :value an expression uses is defined, and every defined one is used (DynamoDB refuses both). */
  function checkPlaceholders(input: { ConditionExpression?: string; UpdateExpression?: string; ExpressionAttributeNames?: object; ExpressionAttributeValues?: object }) {
    const text = `${input.UpdateExpression ?? ""} ${input.ConditionExpression ?? ""}`;
    const used = new Set(text.match(/[#:][A-Za-z_]+/g) ?? []);
    const defined = new Set([...Object.keys(input.ExpressionAttributeNames ?? {}), ...Object.keys(input.ExpressionAttributeValues ?? {})]);
    expect([...used].sort(), text).toEqual([...defined].sort());
  }

  it("resolves the nickname through its lower-cased claim and reads state with consistent reads", async () => {
    const { store, sent } = stub([
      { Item: { participantId: { S: "p-1" } } },
      { Item: { step: { S: "spec" } } },
      { Item: { pendingId: { S: "m-1" }, pendingSince: { N: "1000" }, state: { S: "waiting" } } },
    ]);
    await expect(store.findParticipantId("Ada")).resolves.toBe("p-1");
    await expect(store.getStep("p-1")).resolves.toBe("spec");
    await expect(store.getResetState("p-1")).resolves.toEqual({ pendingId: "m-1", pendingSince: 1000, state: "waiting" });
    expect((sent[0] as GetItemCommand).input).toMatchObject({ Key: { pk: { S: "NICK#ada" }, sk: { S: "NICK" } }, ConsistentRead: true });
    expect((sent[1] as GetItemCommand).input).toMatchObject({ Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } }, ProjectionExpression: "#step" });
    expect((sent[2] as GetItemCommand).input).toMatchObject({ Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "CONVERSATION" } } });
  });

  it("lists only message, reply and spec keys of the participant's own partition, page by page, reading only sk", async () => {
    const { store, sent } = stub([
      { Items: [{ sk: { S: "CONVERSATION" } }, { sk: { S: "MSG#a" } }, { sk: { S: "MSG#a-r" } }], LastEvaluatedKey: { pk: { S: "x" } } },
      { Items: [{ sk: { S: "PROFILE" } }, { sk: { S: "SPEC#0001" } }, { sk: { S: "USAGE" } }] },
    ]);
    await expect(store.listResetItems("p-1")).resolves.toEqual({ messages: ["MSG#a", "MSG#a-r"], specs: ["SPEC#0001"] });
    expect(sent).toHaveLength(2);
    expect((sent[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "PARTICIPANT#p-1" } },
      ProjectionExpression: "#sk",
    });
    expect((sent[1] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: { S: "x" } });
  });

  it("restarts in one transaction: deletes the conversation if the message in flight is unchanged, and sets the step to clarify", async () => {
    const { store, sent } = stub([{}, {}]);
    await expect(store.restart("p-1", undefined)).resolves.toBe(true);
    await expect(store.restart("p-1", "m-1")).resolves.toBe(true);
    for (const command of sent as TransactWriteItemsCommand[]) {
      const items = (command.input.TransactItems ?? []) as TransactWriteItem[];
      expect(items).toHaveLength(2);
      expect(items[0]?.Delete?.Key).toEqual({ pk: { S: "PARTICIPANT#p-1" }, sk: { S: "CONVERSATION" } });
      expect(items[1]?.Update).toMatchObject({ Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } }, UpdateExpression: "SET #step = :clarify" });
      for (const item of items) checkPlaceholders((item.Delete ?? item.Update) as object);
    }
    const first = ((sent[0] as TransactWriteItemsCommand).input.TransactItems ?? [])[0];
    const second = ((sent[1] as TransactWriteItemsCommand).input.TransactItems ?? [])[0];
    expect(first?.Delete?.ConditionExpression).toBe("attribute_not_exists(#pendingId)");
    expect(second?.Delete).toMatchObject({ ConditionExpression: "#pendingId = :seen", ExpressionAttributeValues: { ":seen": { S: "m-1" } } });
  });

  it("answers false when a condition failed, and throws any other error", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    const { store } = stub([cancelled, Object.assign(new Error("down"), { name: "InternalServerError" })]);
    await expect(store.restart("p-1", undefined)).resolves.toBe(false);
    await expect(store.restart("p-1", undefined)).rejects.toThrow("down");
  });

  it("deletes in batches of 25 and retries unprocessed items with a growing wait, then gives up", async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `MSG#${String(i).padStart(2, "0")}`);
    const left = { UnprocessedItems: { "ssd-workshop-data": [{ DeleteRequest: { Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "MSG#00" } } } }] } };
    const { store, sent, waits } = stub([left, {}, {}]);
    await store.deleteItems("p-1", keys);
    const batches = sent as BatchWriteItemCommand[];
    expect(batches.map((b) => b.input.RequestItems?.["ssd-workshop-data"]?.length)).toEqual([25, 1, 5]);
    expect(batches[0]?.input.RequestItems?.["ssd-workshop-data"]?.[0]).toEqual({ DeleteRequest: { Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "MSG#00" } } } });
    expect(waits).toEqual([200]);

    const stuck = stub([left, left, left, left, left]);
    await expect(stuck.store.deleteItems("p-1", ["MSG#00"])).rejects.toThrow("some items were left after retries");
    expect(stuck.sent).toHaveLength(5);
  });

  it("deletes nothing for an empty list", async () => {
    const { store, sent } = stub([]);
    await store.deleteItems("p-1", []);
    expect(sent).toHaveLength(0);
  });
});
