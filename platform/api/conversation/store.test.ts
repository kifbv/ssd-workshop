import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT as INFRA_ACCOUNT,
  AI_QUEUE_NAME as INFRA_QUEUE_NAME,
  AI_WORKER_UPDATE_ATTRIBUTES,
  CONVERSATION_UPDATE_ATTRIBUTES,
  MODEL_ID as INFRA_MODEL_ID,
} from "../../../infra/lib/config.js";
import { ACCOUNT, AI_QUEUE_NAME, AI_QUEUE_URL, MODEL_ID, PRICE_PER_MILLION_TOKENS } from "../settings.js";
import { DEFAULT_MODEL_ID } from "../../src/smoke/logic.js";
import { BedrockModel, usageOf } from "./model.js";
import { SqsMessageQueue } from "./queue.js";
import { FAILURE_REPLY, STALE_PENDING_SECONDS, type Finish } from "./state.js";
import { DynamoConversationStore, type ConversationSender } from "./store.js";

type Sent = GetItemCommand | QueryCommand | TransactWriteItemsCommand;

function stubClient(answers: (Record<string, unknown> | Error)[]): { client: ConversationSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as ConversationSender;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const ID = "2026-11-23T10:00:00.000Z-0101010101010101";
const NOW_ISO = "2026-11-23T10:00:05.000Z";
const cancelled = (codes: string[]): Error =>
  Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

/** Every attribute name a transaction's updates write or test: pk and sk plus each expression name. */
function namesUsed(command: Sent | undefined): string[] {
  const items = (command?.input as { TransactItems?: TransactWriteItem[] }).TransactItems ?? [];
  // Every #name and :value an expression uses is defined, and every defined one is used (DynamoDB refuses both).
  for (const { Update } of items) {
    const text = `${Update?.UpdateExpression ?? ""} ${Update?.ConditionExpression ?? ""}`;
    const used = new Set(text.match(/[#:][A-Za-z_]+/g) ?? []);
    const defined = new Set([...Object.keys(Update?.ExpressionAttributeNames ?? {}), ...Object.keys(Update?.ExpressionAttributeValues ?? {})]);
    expect([...used].sort(), text).toEqual([...defined].sort());
  }
  return items.flatMap((i) => ["pk", "sk", ...Object.values(i.Update?.ExpressionAttributeNames ?? {})]);
}

const usage = (i: number, o: number) => usageOf({ inputTokens: i, outputTokens: o });
const guardrail = { verdict: "on-path" as const, reason: "fine", suggestion: "", usage: usage(400, 30) };
const DONE: Finish = {
  kind: "done",
  reply: "Who is it for?",
  guardrail,
  answer: { prompt: "a habit tracker", modelId: MODEL_ID, promptVersion: "clarify-v1", historyCount: 2, usage: usage(900, 120) },
};

describe("settings (ticket 1.7)", () => {
  it("uses one model id everywhere, the EU prices, and the infra queue in the workshop account", () => {
    expect(MODEL_ID).toBe("eu.anthropic.claude-sonnet-4-6");
    expect(INFRA_MODEL_ID).toBe(MODEL_ID);
    expect(DEFAULT_MODEL_ID).toBe(MODEL_ID);
    expect(PRICE_PER_MILLION_TOKENS).toEqual({ input: 3.3, output: 16.5 });
    expect(ACCOUNT).toBe(INFRA_ACCOUNT);
    expect(AI_QUEUE_NAME).toBe(INFRA_QUEUE_NAME);
    expect(AI_QUEUE_URL).toBe(`https://sqs.eu-central-1.amazonaws.com/${INFRA_ACCOUNT}/ssd-workshop-ai-messages`);
  });
});

describe("DynamoConversationStore", () => {
  it("creates a message and claims the conversation in one transaction, with updates only", async () => {
    const { client, sent } = stubClient([{}]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(
      store.createMessage("p-1", { id: ID, step: "clarify", text: "a habit tracker", createdAt: "2026-11-23T10:00:00.000Z", nowSeconds: 2000 }),
    ).resolves.toBe("created");
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
    expect(items.every((i) => i.Update !== undefined)).toBe(true);
    expect(items[0]?.Update).toMatchObject({
      TableName: TABLE,
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "CONVERSATION" } },
      ConditionExpression:
        "attribute_not_exists(#approvedSpecVersion) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
      ExpressionAttributeValues: { ":open": { S: "open" }, ":pendingId": { S: ID }, ":staleBefore": { N: "800" } },
    });
    expect(items[1]?.Update).toMatchObject({
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: `MSG#${ID}` } },
      ConditionExpression: "attribute_not_exists(#pk)",
      UpdateExpression: "SET #type = :type, #author = :author, #step = :step, #text = :text, #status = :status, #createdAt = :createdAt, #pendingSince = :pendingSince",
    });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
  });

  it("tells busy from waiting when the conversation has a message in flight", async () => {
    const waiting = stubClient([cancelled(["ConditionalCheckFailed", "None"]), { Item: { state: { S: "waiting" }, pendingId: { S: ID } } }]);
    const msg = { id: ID, step: "clarify" as const, text: "x", createdAt: "x", nowSeconds: 1 };
    await expect(new DynamoConversationStore(waiting.client, TABLE).createMessage("p-1", msg)).resolves.toBe("waiting");
    const busy = stubClient([cancelled(["ConditionalCheckFailed", "None"]), { Item: { state: { S: "open" }, pendingId: { S: ID } } }]);
    await expect(new DynamoConversationStore(busy.client, TABLE).createMessage("p-1", msg)).resolves.toBe("busy");
    const down = stubClient([Object.assign(new Error("x"), { name: "InternalServerError" })]);
    await expect(new DynamoConversationStore(down.client, TABLE).createMessage("p-1", msg)).rejects.toThrow("x");
  });

  it("reads the caller's own message by key with a consistent read, refusing malformed items", async () => {
    const item = { author: { S: "participant" }, step: { S: "clarify" }, text: { S: "hi" }, status: { S: "flagged" }, pendingSince: { N: "5" } };
    const { client, sent } = stubClient([
      { Item: { ...item, approvedTextHash: { S: "ab12" }, suggestion: { S: "a quiz" }, verdictReason: { S: "medical advice" } } },
      { Item: { ...item, author: { S: "assistant" } } },
      { Item: { ...item, status: { S: "odd" } } },
      {},
    ]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.getMessage("p-1", ID)).resolves.toEqual({
      id: ID,
      step: "clarify",
      text: "hi",
      status: "flagged",
      pendingSince: 5,
      approvedTextHash: "ab12",
      suggestion: "a quiz",
      verdictReason: "medical advice",
    });
    for (let i = 0; i < 3; i++) await expect(store.getMessage("p-1", ID)).resolves.toBeUndefined();
    expect(sent[0]?.input).toEqual({ TableName: TABLE, Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: `MSG#${ID}` } }, ConsistentRead: true });
  });

  it("reads a reply's text from the reply item", async () => {
    const { client, sent } = stubClient([{ Item: { author: { S: "assistant" }, text: { S: "Hello" } } }, {}]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.getReplyText("p-1", ID)).resolves.toBe("Hello");
    await expect(store.getReplyText("p-1", ID)).resolves.toBeUndefined();
    expect(sent[0]?.input).toMatchObject({ Key: { sk: { S: `MSG#${ID}-r` } } });
  });

  it("reads the answered exchanges before a message, oldest first", async () => {
    const a = "2026-11-23T09:00:00.000Z-aaaaaaaaaaaaaaaa";
    const b = "2026-11-23T09:01:00.000Z-bbbbbbbbbbbbbbbb";
    const c = "2026-11-23T09:02:00.000Z-cccccccccccccccc";
    const { client, sent } = stubClient([
      {
        Items: [
          { sk: { S: `MSG#${ID}` }, author: { S: "participant" }, text: { S: "now" }, status: { S: "pending" } },
          { sk: { S: `MSG#${c}-r` }, author: { S: "assistant" }, text: { S: "answer c" }, kind: { S: "answer" } },
          { sk: { S: `MSG#${c}` }, author: { S: "participant" }, text: { S: "c" }, status: { S: "done" } },
          { sk: { S: `MSG#${b}-r` }, author: { S: "assistant" }, text: { S: "Sorry" }, kind: { S: "decline" } },
          { sk: { S: `MSG#${b}` }, author: { S: "participant" }, text: { S: "b" }, status: { S: "declined" } },
          { sk: { S: `MSG#${a}-r` }, author: { S: "assistant" }, text: { S: "answer a" }, kind: { S: "answer" } },
          { sk: { S: `MSG#${a}` }, author: { S: "participant" }, text: { S: "a" }, status: { S: "done" } },
        ],
      },
    ]);
    await expect(new DynamoConversationStore(client, TABLE).getHistory("p-1", ID)).resolves.toEqual([
      { question: "a", answer: "answer a" },
      { question: "c", answer: "answer c" },
    ]);
    expect(sent[0]?.input).toMatchObject({
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": { S: "PARTICIPANT#p-1" }, ":from": { S: "MSG#" }, ":to": { S: `MSG#${ID}` } },
      ScanIndexForward: false,
      Limit: 30,
    });
  });

  it("finishes an answered message in one transaction: status, reply with prompt and costs, free conversation, usage ADD", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoConversationStore(client, TABLE).finish("p-1", ID, DONE, "pending", NOW_ISO)).resolves.toBe(true);
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems.map((i) => i.Update);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ ConditionExpression: "#status = :from", ExpressionAttributeValues: { ":from": { S: "pending" }, ":status": { S: "done" } } });
    expect(items[1]).toMatchObject({
      Key: { sk: { S: `MSG#${ID}-r` } },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeValues: {
        ":text": { S: "Who is it for?" },
        ":kind": { S: "answer" },
        ":prompt": { S: "a habit tracker" },
        ":modelId": { S: MODEL_ID },
        ":inputTokens": { N: "900" },
        ":outputTokens": { N: "120" },
        ":costUsd": { N: "0.00495" },
      },
    });
    expect(items[2]).toMatchObject({
      Key: { sk: { S: "CONVERSATION" } },
      ConditionExpression: "#pendingId = :messageId",
      UpdateExpression: "SET #state = :state, #updatedAt = :updatedAt REMOVE #pendingId, #pendingSince",
    });
    expect(items[3]).toMatchObject({
      Key: { sk: { S: "USAGE" } },
      UpdateExpression: "SET #type = :type, #participantId = :participantId, #updatedAt = :updatedAt ADD #inputTokens :add_inputTokens, #outputTokens :add_outputTokens, #costUsd :add_costUsd",
      ExpressionAttributeValues: { ":add_inputTokens": { N: "1300" }, ":add_outputTokens": { N: "150" }, ":add_costUsd": { N: "0.006765" } },
    });
    expect(items[3]?.ConditionExpression).toBeUndefined();
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    // The marker of a facilitator's approval (it skips the guardrail check) is written by neither role.
    for (const marker of ["approved", "approvedTextHash"]) {
      expect(AI_WORKER_UPDATE_ATTRIBUTES).not.toContain(marker);
      expect(CONVERSATION_UPDATE_ATTRIBUTES).not.toContain(marker);
    }
    expect(AI_WORKER_UPDATE_ATTRIBUTES).not.toContain("step");
  });

  it("adds spent tokens to the usage totals on their own, inside the worker's attribute list", async () => {
    const { client, sent } = stubClient([{}]);
    const store = new DynamoConversationStore(client, TABLE);
    await store.addUsage("p-1", usage(400, 30), NOW_ISO);
    await store.addUsage("p-1", usage(0, 0), NOW_ISO);
    expect(sent).toHaveLength(1);
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems.map((i) => i.Update);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "USAGE" } },
      UpdateExpression: "SET #type = :type, #participantId = :participantId, #updatedAt = :updatedAt ADD #inputTokens :add_inputTokens, #outputTokens :add_outputTokens, #costUsd :add_costUsd",
      ExpressionAttributeValues: { ":add_inputTokens": { N: "400" }, ":add_outputTokens": { N: "30" } },
    });
    expect(items[0]?.ConditionExpression).toBeUndefined();
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
  });

  it("pauses a flagged message (no reply) and stays inside the worker's attribute list", async () => {
    const { client, sent } = stubClient([{}]);
    const flagged: Finish = { kind: "flagged", guardrail: { verdict: "flag", reason: "medical", suggestion: "a quiz", usage: usage(400, 30) } };
    await new DynamoConversationStore(client, TABLE).finish("p-1", ID, flagged, "pending", NOW_ISO);
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems.map((i) => i.Update);
    expect(items.map((i) => i?.Key?.["sk"]?.S)).toEqual([`MSG#${ID}`, "CONVERSATION", "USAGE"]);
    expect(items[1]?.ExpressionAttributeValues).toMatchObject({ ":state": { S: "waiting" } });
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
  });

  it("ends a message the queue refused with the conversation function's attributes only (no usage)", async () => {
    const { client, sent } = stubClient([{}]);
    await new DynamoConversationStore(client, TABLE).finish("p-1", ID, { kind: "failed", reply: FAILURE_REPLY }, "pending", NOW_ISO);
    expect((sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems).toHaveLength(3);
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
  });

  it("stores offersSpec on an answer that offered the spec, inside the worker's attribute list (ticket 1.8)", async () => {
    const { client, sent } = stubClient([{}, {}]);
    const store = new DynamoConversationStore(client, TABLE);
    await store.finish("p-1", ID, { ...DONE, offersSpec: true }, "pending", NOW_ISO);
    await store.finish("p-1", ID, DONE, "pending", NOW_ISO);
    const reply = (n: number) => (sent[n]?.input as { TransactItems: TransactWriteItem[] }).TransactItems[1]?.Update;
    expect(reply(0)?.ExpressionAttributeValues?.[":offersSpec"]).toEqual({ BOOL: true });
    expect(reply(1)?.ExpressionAttributeNames).not.toHaveProperty("#offersSpec");
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    expect(CONVERSATION_UPDATE_ATTRIBUTES).not.toContain("offersSpec");
  });

  it("lists the last messages and replies of the caller's partition, oldest first, without prompts or costs (ticket 1.8)", async () => {
    const { client, sent } = stubClient([
      {
        Items: [
          { sk: { S: `MSG#${ID}-r` }, author: { S: "assistant" }, text: { S: "Ready." }, offersSpec: { BOOL: true }, specVersion: { N: "2" } },
          { sk: { S: `MSG#${ID}` }, author: { S: "participant" }, step: { S: "spec" }, text: { S: "weekly" }, status: { S: "done" }, pendingSince: { N: "2000" } },
          { sk: { S: "MSG#z" }, author: { S: "participant" }, text: { S: "no step" }, status: { S: "done" }, pendingSince: { N: "1" } },
          { sk: { S: "MSG#x" }, author: { S: "participant" }, text: { S: "bad" }, status: { S: "odd" }, pendingSince: { N: "1" } },
          { sk: { S: "MSG#y-r" }, author: { S: "assistant" }, text: { S: "Who?" } },
        ],
      },
    ]);
    const items = await new DynamoConversationStore(client, TABLE).listItems("p-1", 50);
    expect(items).toEqual([
      { author: "assistant", replyTo: "y", text: "Who?", offersSpec: false },
      { author: "participant", id: ID, step: "spec", text: "weekly", status: "done", pendingSince: 2000 },
      { author: "assistant", replyTo: ID, text: "Ready.", offersSpec: true, specVersion: 2 },
    ]);
    const input = (sent[0] as QueryCommand).input;
    expect(input).toMatchObject({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      ExpressionAttributeValues: { ":pk": { S: "PARTICIPANT#p-1" }, ":prefix": { S: "MSG#" } },
      ScanIndexForward: false,
      Limit: 50,
    });
    expect(Object.values(input.ExpressionAttributeNames ?? {})).not.toContain("prompt");
    expect(Object.values(input.ExpressionAttributeNames ?? {})).not.toContain("costUsd");
  });

  it("moves the profile from clarify to spec only while nothing is in flight, inside the conversation function's attribute list (ticket 1.8)", async () => {
    const { client, sent } = stubClient([
      {},
      cancelled(["ConditionalCheckFailed", "None"]),
      cancelled(["None", "ConditionalCheckFailed"]),
      { Item: { state: { S: "waiting" }, pendingId: { S: ID } } },
      cancelled(["None", "ConditionalCheckFailed"]),
      { Item: { state: { S: "open" }, pendingId: { S: ID } } },
      new Error("down"),
    ]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.moveToSpec("p-1", 2000, NOW_ISO)).resolves.toBe("moved");
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems.map((i) => i.Update);
    expect(items[0]).toMatchObject({
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "PROFILE" } },
      UpdateExpression: "SET #step = :step",
      ConditionExpression: "#step = :clarify",
      ExpressionAttributeValues: { ":step": { S: "spec" }, ":clarify": { S: "clarify" } },
    });
    expect(items[1]).toMatchObject({
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "CONVERSATION" } },
      ConditionExpression: "attribute_exists(#pk) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
      ExpressionAttributeValues: { ":updatedAt": { S: NOW_ISO }, ":open": { S: "open" }, ":staleBefore": { N: "800" } },
    });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
    await expect(store.moveToSpec("p-1", 2000, NOW_ISO)).resolves.toBe("wrong-step");
    await expect(store.moveToSpec("p-1", 2000, NOW_ISO)).resolves.toBe("waiting");
    await expect(store.moveToSpec("p-1", 2000, NOW_ISO)).resolves.toBe("busy");
    await expect(store.moveToSpec("p-1", 2000, NOW_ISO)).rejects.toThrow("down");
  });

  it("stores a new spec version with its answer, the reply's specVersion and the conversation's latestSpecVersion, inside the worker's list (ticket 1.9)", async () => {
    const { client, sent } = stubClient([{}]);
    const spec: Finish = { ...DONE, spec: { version: 3, text: "# Run log" } } as Finish;
    await new DynamoConversationStore(client, TABLE).finish("p-1", ID, spec, "pending", NOW_ISO);
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
    const specItem = items.find((i) => i.Update?.Key?.["sk"]?.S === "SPEC#0003")?.Update;
    expect(specItem).toMatchObject({
      Key: { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "SPEC#0003" } },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeValues: { ":type": { S: "spec" }, ":specVersion": { N: "3" }, ":text": { S: "# Run log" }, ":messageId": { S: ID }, ":createdAt": { S: NOW_ISO } },
    });
    const reply = items.find((i) => i.Update?.Key?.["sk"]?.S === `MSG#${ID}-r`)?.Update;
    expect(reply?.ExpressionAttributeValues?.[":specVersion"]).toEqual({ N: "3" });
    const conversation = items.find((i) => i.Update?.Key?.["sk"]?.S === "CONVERSATION")?.Update;
    expect(conversation?.ExpressionAttributeValues?.[":latestSpecVersion"]).toEqual({ N: "3" });
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
  });

  it("reads the newest spec version, or one by number, only from items with specVersion (ticket 1.9)", async () => {
    const item = { sk: { S: "SPEC#0002" }, specVersion: { N: "2" }, text: { S: "# Run log" }, createdAt: { S: NOW_ISO } };
    const { client, sent } = stubClient([
      { Items: [item] },
      { Items: [{ ...item, specVersion: undefined }] },
      { Items: [] },
      { Item: { ...item, approvedAt: { S: NOW_ISO } } },
      { Item: item },
      {},
    ]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.getLatestSpec("p-1")).resolves.toEqual({ version: 2, text: "# Run log", createdAt: NOW_ISO, approved: false });
    // A SPEC# item without specVersion (which only the worker's role may write) is not a spec.
    await expect(store.getLatestSpec("p-1")).resolves.toBeUndefined();
    await expect(store.getLatestSpec("p-1")).resolves.toBeUndefined();
    await expect(store.getSpec("p-1", 2)).resolves.toEqual({ version: 2, text: "# Run log", createdAt: NOW_ISO, approved: true });
    await expect(store.getSpec("p-1", 3)).resolves.toBeUndefined();
    await expect(store.getSpec("p-1", 2)).resolves.toBeUndefined();
    expect((sent[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      ExpressionAttributeValues: { ":pk": { S: "PARTICIPANT#p-1" }, ":prefix": { S: "SPEC#" } },
      ScanIndexForward: false,
      Limit: 1,
    });
    expect((sent[3] as GetItemCommand).input.Key).toEqual({ pk: { S: "PARTICIPANT#p-1" }, sk: { S: "SPEC#0002" } });
  });

  it("approves a version in one transaction inside the conversation function's list, and tells why it could not (ticket 1.9)", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoConversationStore(client, TABLE).approveSpec("p-1", 2, 5000, NOW_ISO)).resolves.toBe("approved");
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
    expect(items.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual(["PROFILE", "CONVERSATION", "SPEC#0002"]);
    expect(items[0]?.Update).toMatchObject({ ConditionExpression: "#step = :spec", ExpressionAttributeValues: { ":step": { S: "approved" }, ":spec": { S: "spec" } } });
    expect(items[1]?.Update).toMatchObject({
      UpdateExpression: "SET #approvedSpecVersion = :approvedSpecVersion, #updatedAt = :updatedAt REMOVE #pendingId, #pendingSince",
      ConditionExpression:
        "#latestSpecVersion = :version AND attribute_not_exists(#approvedSpecVersion) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
      ExpressionAttributeValues: { ":version": { N: "2" }, ":staleBefore": { N: String(5000 - STALE_PENDING_SECONDS) } },
    });
    expect(items[2]?.Update).toMatchObject({ UpdateExpression: "SET #approvedAt = :approvedAt", ConditionExpression: "attribute_exists(#pk)" });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);

    const conv = (fields: Record<string, unknown>) => ({ Item: { state: { S: "open" }, ...fields } });
    const cases: [string[], Record<string, unknown> | undefined, string][] = [
      [["ConditionalCheckFailed", "None", "None"], undefined, "wrong-step"],
      [["None", "ConditionalCheckFailed", "None"], conv({}), "no-spec"],
      [["None", "ConditionalCheckFailed", "None"], conv({ latestSpecVersion: { N: "3" } }), "stale"],
      [["None", "ConditionalCheckFailed", "None"], conv({ latestSpecVersion: { N: "2" }, state: { S: "waiting" } }), "waiting"],
      [["None", "ConditionalCheckFailed", "None"], conv({ latestSpecVersion: { N: "2" }, pendingId: { S: ID } }), "busy"],
    ];
    for (const [codes, read, expected] of cases) {
      const stub = stubClient(read === undefined ? [cancelled(codes)] : [cancelled(codes), read]);
      await expect(new DynamoConversationStore(stub.client, TABLE).approveSpec("p-1", 2, 5000, NOW_ISO), expected).resolves.toBe(expected);
    }
    const down = stubClient([Object.assign(new Error("x"), { name: "InternalServerError" })]);
    await expect(new DynamoConversationStore(down.client, TABLE).approveSpec("p-1", 2, 5000, NOW_ISO)).rejects.toThrow("x");
  });

  it("refuses a message once the spec is approved (ticket 1.9)", async () => {
    const { client } = stubClient([cancelled(["ConditionalCheckFailed", "None"]), { Item: { state: { S: "open" }, approvedSpecVersion: { N: "2" } } }]);
    const msg = { id: ID, step: "spec" as const, text: "x", createdAt: "x", nowSeconds: 1 };
    await expect(new DynamoConversationStore(client, TABLE).createMessage("p-1", msg)).resolves.toBe("approved");
  });

  it("answers false on a lost race and throws anything else", async () => {
    const { client } = stubClient([cancelled(["ConditionalCheckFailed", "None", "None", "None"]), new Error("down")]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.finish("p-1", ID, DONE, "pending", NOW_ISO)).resolves.toBe(false);
    await expect(store.finish("p-1", ID, DONE, "pending", NOW_ISO)).rejects.toThrow("down");
  });
});

describe("SqsMessageQueue", () => {
  it("sends ids only to the queue", async () => {
    const sent: SendMessageCommand[] = [];
    const queue = new SqsMessageQueue({ send: async (c: SendMessageCommand) => (sent.push(c), { $metadata: {} }) }, AI_QUEUE_URL);
    await queue.send({ participantId: "p-1", messageId: ID });
    expect(sent[0]?.input).toEqual({ QueueUrl: AI_QUEUE_URL, MessageBody: JSON.stringify({ participantId: "p-1", messageId: ID }) });
  });
});

describe("BedrockModel", () => {
  it("calls Converse on the EU profile with system prompt, turns and limits, and reads text and tokens", async () => {
    const sent: { command: ConverseCommand; options: unknown }[] = [];
    const client = {
      send: async (command: ConverseCommand, options?: unknown) => {
        sent.push({ command, options });
        return {
          $metadata: {},
          output: { message: { role: "assistant" as const, content: [{ text: " Hello " }, { text: "there" }] } },
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
          stopReason: "end_turn" as const,
          metrics: { latencyMs: 1 },
        };
      },
    };
    const signal = new AbortController().signal;
    const reply = await new BedrockModel(client, MODEL_ID).converse(
      { system: "sys", messages: [{ role: "user", text: "hi" }], maxTokens: 50, temperature: 0 },
      signal,
    );
    expect(reply).toEqual({ text: "Hello there", inputTokens: 12, outputTokens: 3 });
    expect(sent[0]?.command.input).toEqual({
      modelId: MODEL_ID,
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      inferenceConfig: { maxTokens: 50, temperature: 0 },
    });
    expect(sent[0]?.options).toEqual({ abortSignal: signal });
    expect(() => new BedrockModel(client, "anthropic.claude-sonnet-4-6")).toThrow(/eu\.anthropic/);
  });
});
