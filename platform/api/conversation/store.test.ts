import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT as INFRA_ACCOUNT,
  AI_QUEUE_NAME as INFRA_QUEUE_NAME,
  AI_WORKER_BUILD_CHECK_ATTRIBUTES,
  AI_WORKER_BUILD_UPDATE_ATTRIBUTES,
  AI_WORKER_UPDATE_ATTRIBUTES,
  BUILD_QUEUE_NAME as INFRA_BUILD_QUEUE_NAME,
  BUILD_QUEUE_PARTITION,
  CONVERSATION_UPDATE_ATTRIBUTES,
  QUEUE_COUNT_ATTRIBUTES,
  MODEL_ID as INFRA_MODEL_ID,
  SETTINGS_READ_ATTRIBUTES,
} from "../../../infra/lib/config.js";
import { BUDGET_REPLY, budgetOf } from "../workshop/budget.js";
import { DEFAULT_SETTINGS } from "../workshop/settings.js";
import { ACCOUNT, AI_QUEUE_NAME, AI_QUEUE_URL, BUILD_QUEUE_NAME, BUILD_QUEUE_URL, MODEL_ID, PRICE_PER_MILLION_TOKENS } from "../settings.js";
import { DEFAULT_MODEL_ID } from "../../src/smoke/logic.js";
import { BedrockModel, usageOf } from "./model.js";
import { SqsBuildQueue, SqsMessageQueue } from "./queue.js";
import { READINESS_REQUEST } from "./readiness.js";
import { CHANGE_BUILD_REQUEST } from "./change.js";
import { buildIdFor, FAILURE_REPLY, STALE_PENDING_SECONDS, type ChangeBuildFinish, type Finish, type ReadinessFinish } from "./state.js";
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
    // An answer never moves the step (only the readiness check's outcome does, ticket 2.7).
    expect(namesUsed(sent[0])).not.toContain("step");
    expect(AI_WORKER_UPDATE_ATTRIBUTES).not.toContain("approvedAt");
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

  it("ends a message over budget (ticket 3.3) as failed with the budget text as a reply of kind budget, counting a guardrail call's tokens, inside the worker's list", async () => {
    const { client, sent } = stubClient([{}, {}]);
    const store = new DynamoConversationStore(client, TABLE);
    await store.finish("p-1", ID, { kind: "over-budget", reply: BUDGET_REPLY }, "pending", NOW_ISO);
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems.map((i) => i.Update);
    expect(items.map((i) => i?.Key?.["sk"]?.S)).toEqual([`MSG#${ID}`, `MSG#${ID}-r`, "CONVERSATION"]);
    expect(items[0]?.ExpressionAttributeValues).toMatchObject({ ":status": { S: "failed" }, ":from": { S: "pending" } });
    expect(items[1]?.ExpressionAttributeValues).toMatchObject({ ":text": { S: BUDGET_REPLY }, ":kind": { S: "budget" } });
    expect(items[1]?.ExpressionAttributeValues?.[":costUsd"]).toBeUndefined();
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    await store.finish("p-1", ID, { kind: "over-budget", reply: BUDGET_REPLY, guardrail }, "pending", NOW_ISO);
    const withGuardrail = (sent[1]?.input as { TransactItems: TransactWriteItem[] }).TransactItems.map((i) => i.Update);
    expect(withGuardrail.map((i) => i?.Key?.["sk"]?.S)).toEqual([`MSG#${ID}`, `MSG#${ID}-r`, "CONVERSATION", "USAGE"]);
    expect(withGuardrail[3]?.ExpressionAttributeValues).toMatchObject({ ":add_costUsd": { N: String(guardrail.usage.costUsd) } });
    for (const name of namesUsed(sent[1])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
  });

  it("reads the budget facts (ticket 3.3): the settings, the profile's extraBudget and the usage's costUsd, each projected and consistent", async () => {
    const { client, sent } = stubClient([
      { Item: { aiBudgetUsd: { N: "8" }, stopped: { BOOL: false } } },
      { Item: { extraBudget: { N: "2" } } },
      { Item: { costUsd: { N: "3.25" } } },
    ]);
    const facts = await new DynamoConversationStore(client, TABLE).getBudgetFacts("p-1");
    expect(facts).toEqual({
      settings: { ...DEFAULT_SETTINGS, aiBudgetUsd: 8 },
      limits: { extraBudget: 2, paused: false, changeRequestsUsed: 0 },
      spentUsd: 3.25,
    });
    const inputs = sent.map((c) => c.input as GetItemCommand["input"]);
    expect(inputs.map((i) => [i.Key?.["pk"]?.S, i.Key?.["sk"]?.S])).toEqual([
      ["SETTINGS", "SETTINGS"],
      ["PARTICIPANT#p-1", "PROFILE"],
      ["PARTICIPANT#p-1", "USAGE"],
    ]);
    expect(inputs.every((i) => i.ConsistentRead === true && i.TableName === TABLE)).toBe(true);
    expect(inputs.map((i) => Object.values(i.ExpressionAttributeNames ?? {}))).toEqual([
      ["aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce", "stopped", "resumedAt"],
      // Ticket 3.6: also the change requests used (compared with the cap before a change is taken or built).
      ["extraBudget", "changeRequestsUsed"],
      ["costUsd"],
    ]);
    for (const name of Object.values(inputs[0]?.ExpressionAttributeNames ?? {})) expect(SETTINGS_READ_ATTRIBUTES, name).toContain(name);
    // No items yet: the defaults, no extra budget, nothing spent.
    const empty = stubClient([{}, {}, {}]);
    await expect(new DynamoConversationStore(empty.client, TABLE).getBudgetFacts("p-1")).resolves.toEqual({
      settings: DEFAULT_SETTINGS,
      limits: { extraBudget: 0, paused: false, changeRequestsUsed: 0 },
      spentUsd: 0,
    });
    // A USAGE item without costUsd is nothing spent; a broken (negative) costUsd is passed on, and budgetOf fails closed.
    const noCost = stubClient([{}, {}, { Item: {} }]);
    expect((await new DynamoConversationStore(noCost.client, TABLE).getBudgetFacts("p-1")).spentUsd).toBe(0);
    const negative = stubClient([{}, {}, { Item: { costUsd: { N: "-1" } } }]);
    expect(budgetOf(await new DynamoConversationStore(negative.client, TABLE).getBudgetFacts("p-1")).reached).toBe(true);
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

  it("moves the profile from clarify to spec (stepSince the time of the move, ticket 3.2) only while nothing is in flight, inside the conversation function's attribute list (ticket 1.8)", async () => {
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
      UpdateExpression: "SET #step = :step, #stepSince = :stepSince",
      ConditionExpression: "#step = :clarify",
      ExpressionAttributeValues: { ":step": { S: "spec" }, ":stepSince": { S: NOW_ISO }, ":clarify": { S: "clarify" } },
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

  it("approves a version and stores the readiness request in one transaction inside the conversation function's list, and tells why it could not (tickets 1.9, 2.7)", async () => {
    const readiness = { id: ID, step: "approved" as const, text: READINESS_REQUEST, createdAt: NOW_ISO, nowSeconds: 5000 };
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoConversationStore(client, TABLE).approveSpec("p-1", 2, 5000, NOW_ISO, readiness)).resolves.toBe("approved");
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
    expect(items.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual(["PROFILE", "CONVERSATION", "SPEC#0002", `MSG#${ID}`]);
    expect(items[0]?.Update).toMatchObject({
      UpdateExpression: "SET #step = :step, #stepSince = :stepSince",
      ConditionExpression: "#step = :spec",
      ExpressionAttributeValues: { ":step": { S: "approved" }, ":stepSince": { S: NOW_ISO }, ":spec": { S: "spec" } },
    });
    expect(items[1]?.Update).toMatchObject({
      UpdateExpression:
        "SET #approvedSpecVersion = :approvedSpecVersion, #state = :state, #pendingId = :pendingId, #pendingSince = :pendingSince, #updatedAt = :updatedAt",
      ConditionExpression:
        "#latestSpecVersion = :version AND attribute_not_exists(#approvedSpecVersion) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
      ExpressionAttributeValues: { ":version": { N: "2" }, ":pendingId": { S: ID }, ":staleBefore": { N: String(5000 - STALE_PENDING_SECONDS) } },
    });
    expect(items[2]?.Update).toMatchObject({ UpdateExpression: "SET #approvedAt = :approvedAt", ConditionExpression: "attribute_exists(#pk)" });
    expect(items[3]?.Update).toMatchObject({
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeValues: { ":step": { S: "approved" }, ":text": { S: READINESS_REQUEST }, ":status": { S: "pending" }, ":author": { S: "participant" } },
    });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);

    const conv = (fields: Record<string, unknown>) => ({ Item: { state: { S: "open" }, ...fields } });
    const cases: [string[], Record<string, unknown> | undefined, string][] = [
      [["ConditionalCheckFailed", "None", "None", "None"], undefined, "wrong-step"],
      [["None", "ConditionalCheckFailed", "None", "None"], conv({}), "no-spec"],
      [["None", "ConditionalCheckFailed", "None", "None"], conv({ latestSpecVersion: { N: "3" } }), "stale"],
      [["None", "ConditionalCheckFailed", "None", "None"], conv({ latestSpecVersion: { N: "2" }, state: { S: "waiting" } }), "waiting"],
      [["None", "ConditionalCheckFailed", "None", "None"], conv({ latestSpecVersion: { N: "2" }, pendingId: { S: ID } }), "busy"],
    ];
    for (const [codes, read, expected] of cases) {
      const stub = stubClient(read === undefined ? [cancelled(codes)] : [cancelled(codes), read]);
      await expect(new DynamoConversationStore(stub.client, TABLE).approveSpec("p-1", 2, 5000, NOW_ISO, readiness), expected).resolves.toBe(expected);
    }
    const down = stubClient([Object.assign(new Error("x"), { name: "InternalServerError" })]);
    await expect(new DynamoConversationStore(down.client, TABLE).approveSpec("p-1", 2, 5000, NOW_ISO, readiness)).rejects.toThrow("x");
  });

  it("asks for the readiness check again only for the same approval with no build and nothing in flight (ticket 2.7)", async () => {
    const message = { id: ID, step: "approved" as const, text: READINESS_REQUEST, createdAt: NOW_ISO, nowSeconds: 5000 };
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoConversationStore(client, TABLE).requestReadiness("p-1", 2, message)).resolves.toBe("created");
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
    expect(items.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual(["CONVERSATION", `MSG#${ID}`]);
    expect(items[0]?.Update).toMatchObject({
      ConditionExpression:
        "#approvedSpecVersion = :version AND attribute_not_exists(#buildId) AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
      ExpressionAttributeValues: { ":version": { N: "2" }, ":pendingId": { S: ID } },
    });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
    const conv = (fields: Record<string, unknown>) => ({ Item: { state: { S: "open" }, ...fields } });
    for (const [read, expected] of [
      [conv({ approvedSpecVersion: { N: "2" }, pendingId: { S: ID } }), "busy"],
      [conv({ approvedSpecVersion: { N: "2" }, buildId: { S: "b-1" } }), "wrong-step"],
      [conv({}), "wrong-step"],
    ] as const) {
      const stub = stubClient([cancelled(["ConditionalCheckFailed", "None"]), read]);
      await expect(new DynamoConversationStore(stub.client, TABLE).requestReadiness("p-1", 2, message), expected).resolves.toBe(expected);
    }
  });

  describe("finishReadiness (ticket 2.7)", () => {
    const answer = { prompt: READINESS_REQUEST, modelId: MODEL_ID, promptVersion: "readiness-v1", historyCount: 0, usage: usage(900, 60) };
    const BUILD_ID = buildIdFor(ID);
    const READY: ReadinessFinish = { kind: "ready", reply: "Ready.", version: 2, answer, build: { buildId: BUILD_ID, nickname: "Ada-Lovelace" } };
    const NOT_READY: ReadinessFinish = { kind: "not-ready", reply: "Not ready:\n- login", version: 2, answer };
    const run = async (outcome: ReadinessFinish) => {
      const { client, sent } = stubClient([{}]);
      await expect(new DynamoConversationStore(client, TABLE).finishReadiness("p-1", ID, outcome, NOW_ISO)).resolves.toBe(true);
      return { sent, items: (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems };
    };

    it("a pass: message done, reply, conversation with the build id, step building, the new build (only if absent) and the tokens, in one transaction", async () => {
      const { sent, items } = await run(READY);
      expect(items.map((i) => `${i.Update?.Key?.["pk"]?.S}/${i.Update?.Key?.["sk"]?.S}`)).toEqual([
        `PARTICIPANT#p-1/MSG#${ID}`,
        `PARTICIPANT#p-1/MSG#${ID}-r`,
        "PARTICIPANT#p-1/CONVERSATION",
        "PARTICIPANT#p-1/PROFILE",
        `BUILD#${BUILD_ID}/BUILD`,
        "PARTICIPANT#p-1/USAGE",
      ]);
      expect(items[0]?.Update).toMatchObject({ ConditionExpression: "#status = :pending", ExpressionAttributeValues: { ":status": { S: "done" } } });
      expect(items[1]?.Update).toMatchObject({ ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeValues: { ":kind": { S: "answer" }, ":promptVersion": { S: "readiness-v1" } } });
      expect(items[2]?.Update).toMatchObject({
        UpdateExpression: "SET #state = :state, #updatedAt = :updatedAt, #buildId = :buildId REMOVE #pendingId, #pendingSince",
        ConditionExpression: "#pendingId = :messageId AND #approvedSpecVersion = :version",
        ExpressionAttributeValues: { ":messageId": { S: ID }, ":version": { N: "2" }, ":buildId": { S: BUILD_ID } },
      });
      expect(items[3]?.Update).toMatchObject({
        UpdateExpression: "SET #step = :step, #stepSince = :stepSince",
        ConditionExpression: "#step = :approved",
        ExpressionAttributeValues: { ":step": { S: "building" }, ":stepSince": { S: NOW_ISO } },
      });
      expect(items[4]?.Update).toMatchObject({
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeValues: {
          ":type": { S: "build" },
          ":buildId": { S: BUILD_ID },
          ":nickname": { S: "Ada-Lovelace" },
          ":participantId": { S: "p-1" },
          ":status": { S: "queued" },
          ":createdAt": { S: NOW_ISO },
          ":updatedAt": { S: NOW_ISO },
        },
      });
      expect(items[5]?.Update?.ExpressionAttributeValues).toMatchObject({ ":add_inputTokens": { N: "900" }, ":add_outputTokens": { N: "60" } });
      // Every name is in the AI worker's lists (participant partition, build partition); the placeholders all match.
      const used = namesUsed(sent[0]);
      expect(used.length).toBeGreaterThan(10);
      for (const item of items) {
        const names = ["pk", "sk", ...Object.values(item.Update?.ExpressionAttributeNames ?? {})];
        const list: readonly string[] = item.Update?.Key?.["pk"]?.S?.startsWith("BUILD#") ? AI_WORKER_BUILD_UPDATE_ATTRIBUTES : AI_WORKER_UPDATE_ATTRIBUTES;
        for (const name of names) expect(list, name).toContain(name);
      }
      expect(BUILD_ID).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    });

    it("no pass: back to step spec with the approval removed, the reasons as the reply, the tokens counted, no build", async () => {
      const { sent, items } = await run(NOT_READY);
      expect(items.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual([`MSG#${ID}`, `MSG#${ID}-r`, "CONVERSATION", "PROFILE", "USAGE"]);
      expect(items[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":text": { S: "Not ready:\n- login" }, ":kind": { S: "answer" } });
      expect(items[2]?.Update).toMatchObject({
        UpdateExpression: "SET #state = :state, #updatedAt = :updatedAt REMOVE #pendingId, #pendingSince, #approvedSpecVersion",
        ConditionExpression: "#pendingId = :messageId AND #approvedSpecVersion = :version",
      });
      expect(items[3]?.Update).toMatchObject({
        UpdateExpression: "SET #step = :step, #stepSince = :stepSince",
        ConditionExpression: "#step = :approved",
        ExpressionAttributeValues: { ":step": { S: "spec" }, ":stepSince": { S: NOW_ISO } },
      });
      for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    });

    it("no verdict: the message failed with the neutral reply; without tokens no usage item; inside both roles' lists (the conversation function uses it on a queue failure)", async () => {
      const { sent, items } = await run({ kind: "failed", reply: "Sorry.", version: 2 });
      expect(items.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual([`MSG#${ID}`, `MSG#${ID}-r`, "CONVERSATION", "PROFILE"]);
      expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":status": { S: "failed" } });
      expect(items[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":kind": { S: "failure" } });
      for (const name of namesUsed(sent[0])) {
        expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
        expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
      }
      const withTokens = await run({ kind: "failed", reply: "Sorry.", version: 2, usage: usage(10, 1) });
      expect(withTokens.items.at(-1)?.Update?.Key?.["sk"]?.S).toBe("USAGE");
    });

    it("over budget (ticket 3.3): like no verdict, back to step spec, with the budget text as a reply of kind budget and the tokens counted", async () => {
      const { sent, items } = await run({ kind: "over-budget", reply: BUDGET_REPLY, version: 2, usage: usage(900, 60) });
      expect(items.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual([`MSG#${ID}`, `MSG#${ID}-r`, "CONVERSATION", "PROFILE", "USAGE"]);
      expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":status": { S: "failed" } });
      expect(items[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":text": { S: BUDGET_REPLY }, ":kind": { S: "budget" } });
      expect(items[2]?.Update?.UpdateExpression).toContain("REMOVE #pendingId, #pendingSince, #approvedSpecVersion");
      for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
      expect((await run({ kind: "over-budget", reply: BUDGET_REPLY, version: 2 })).items).toHaveLength(4);
    });

    it("answers false on a lost race (a duplicate delivery, a second build) and throws anything else", async () => {
      const { client } = stubClient([cancelled(["None", "None", "None", "None", "ConditionalCheckFailed", "None"]), new Error("down")]);
      const store = new DynamoConversationStore(client, TABLE);
      await expect(store.finishReadiness("p-1", ID, READY, NOW_ISO)).resolves.toBe(false);
      await expect(store.finishReadiness("p-1", ID, READY, NOW_ISO)).rejects.toThrow("down");
    });
  });

  it("reads a profile's step and nickname, and a build only when it is one (ticket 2.7)", async () => {
    const { client, sent } = stubClient([
      { Item: { step: { S: "approved" }, nickname: { S: "Ada" } } },
      { Item: { type: { S: "build" }, buildId: { S: "b-1" }, participantId: { S: "p-1" }, status: { S: "failed" }, failureReasons: { L: [{ S: "a" }, { S: "b" }] } } },
      { Item: { type: { S: "app-live" }, buildId: { S: "b-1" }, participantId: { S: "p-1" }, status: { S: "queued" } } },
      {},
    ]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.getParticipantInfo("p-1")).resolves.toEqual({ step: "approved", nickname: "Ada" });
    // Ticket 3.6: a build without a kind (every build from before 3.6) reads as a first build.
    await expect(store.getBuild("b-1")).resolves.toEqual({ buildId: "b-1", participantId: "p-1", status: "failed", kind: "first", feed: [], failureReasons: ["a", "b"] });
    await expect(store.getBuild("b-1")).resolves.toBeUndefined();
    await expect(store.getBuild("b-1")).resolves.toBeUndefined();
    // A malformed id is not even read.
    await expect(store.getBuild("../x")).resolves.toBeUndefined();
    expect(sent).toHaveLength(4);
    expect((sent[1] as GetItemCommand).input).toMatchObject({ Key: { pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } }, ConsistentRead: true });
  });

  it("reads a build's nickname and feed, keeping only well-formed events, oldest first (ticket 2.10)", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const at = { S: "2026-11-24T10:00:00.000Z" };
    const ev = (fields: Record<string, string>) => ({ M: { ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { S: v }])), at } });
    const { client, sent } = stubClient([
      {
        Item: {
          type: { S: "build" },
          buildId: { S: "b-1" },
          participantId: { S: "p-1" },
          status: { S: "building" },
          nickname: { S: "Ada-Runner" },
          feed: {
            L: [
              ev({ kind: "step", step: "preparing" }),
              ev({ kind: "step", step: "hacking" }),
              ev({ kind: "file", path: "<b>index.html</b>" }),
              ev({ kind: "fetch", host: "en.wikipedia.org" }),
              ev({ kind: "commit", sha, message: "Add the home screen" }),
              ev({ kind: "commit", sha: "../../evil", message: "x" }),
              ev({ kind: "other" }),
              { M: { kind: { S: "file" }, path: { S: "no-time.js" } } },
              { S: "not a map" },
            ],
          },
        },
      },
    ]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.getBuild("b-1")).resolves.toEqual({
      buildId: "b-1",
      participantId: "p-1",
      status: "building",
      kind: "first",
      nickname: "Ada-Runner",
      feed: [
        { kind: "step", step: "preparing", at: at.S },
        { kind: "file", path: "<b>index.html</b>", at: at.S },
        { kind: "fetch", host: "en.wikipedia.org", at: at.S },
        { kind: "commit", sha, message: "Add the home screen", at: at.S },
      ],
    });
    const input = (sent[0] as GetItemCommand).input;
    expect(input.ProjectionExpression).toBe("#type, #buildId, #participantId, #status, #failureReasons, #nickname, #feed, #queueKey, #kind, #changeNumber");
    expect(Object.keys(input.ExpressionAttributeNames ?? {}).sort()).toEqual([
      "#buildId",
      "#changeNumber",
      "#failureReasons",
      "#feed",
      "#kind",
      "#nickname",
      "#participantId",
      "#queueKey",
      "#status",
      "#type",
    ]);
  });

  it("ticket 3.4: reads a queued build's place and counts the entries ahead of it with a COUNT-only Query of BUILD_QUEUE (QUEUE_COUNT_ATTRIBUTES)", async () => {
    const place = "2026-11-25T10:00:00.000Z#b-1";
    const { client, sent } = stubClient([
      { Item: { type: { S: "build" }, buildId: { S: "b-1" }, participantId: { S: "p-1" }, status: { S: "queued" }, queueKey: { S: place } } },
      { Count: 2, LastEvaluatedKey: { pk: { S: "BUILD_QUEUE" }, sk: { S: "x" } } },
      { Count: 1 },
    ]);
    const store = new DynamoConversationStore(client, TABLE);
    expect((await store.getBuild("b-1"))?.queueKey).toBe(place);
    expect(await store.countQueuedAhead(place, "2026-11-25T09:58:00.000Z")).toBe(3);
    const queries = sent.slice(1).map((command) => (command as QueryCommand).input);
    for (const input of queries) {
      expect(input.Select).toBe("COUNT");
      expect(input.ProjectionExpression).toBeUndefined();
      expect(input.ExpressionAttributeValues?.[":pk"]).toEqual({ S: BUILD_QUEUE_PARTITION });
      const names = [...Object.values(input.ExpressionAttributeNames ?? {}), "pk", "sk"];
      for (const name of names) expect(QUEUE_COUNT_ATTRIBUTES as readonly string[], name).toContain(name);
    }
    expect(queries[1]?.ExclusiveStartKey).toEqual({ pk: { S: "BUILD_QUEUE" }, sk: { S: "x" } });
  });

  it("sends a build id alone to the FIFO launch queue, deduplicated by the build id, grouped by participant (ticket 2.7)", async () => {
    const sent: SendMessageCommand[] = [];
    const queue = new SqsBuildQueue({ send: async (c: SendMessageCommand) => (sent.push(c), { $metadata: {} }) }, BUILD_QUEUE_URL);
    await queue.send({ buildId: "b-1", participantId: "p-1" });
    expect(sent[0]?.input).toEqual({ QueueUrl: BUILD_QUEUE_URL, MessageBody: '{"buildId":"b-1"}', MessageDeduplicationId: "b-1", MessageGroupId: "p-1" });
    expect(BUILD_QUEUE_NAME).toBe(INFRA_BUILD_QUEUE_NAME);
    expect(BUILD_QUEUE_URL).toBe(`https://sqs.eu-central-1.amazonaws.com/${INFRA_ACCOUNT}/ssd-workshop-builds.fifo`);
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

  it("puts a held job back on the queue with a delay (ticket 3.5)", async () => {
    const sent: SendMessageCommand[] = [];
    const queue = new SqsMessageQueue({ send: async (c: SendMessageCommand) => (sent.push(c), { $metadata: {} }) }, AI_QUEUE_URL);
    await queue.sendLater({ participantId: "p-1", messageId: ID }, 30);
    expect(sent[0]?.input).toEqual({ QueueUrl: AI_QUEUE_URL, MessageBody: JSON.stringify({ participantId: "p-1", messageId: ID }), DelaySeconds: 30 });
  });
});

describe("global Stop in the conversation store (ticket 3.5)", () => {
  it("holds a message: its pendingSince and the conversation's to now, only while it is pending and in flight, naming only the AI worker's attributes", async () => {
    const { client, sent } = stubClient([{}, cancelled(["ConditionalCheckFailed", "None"]), new Error("down")]);
    const store = new DynamoConversationStore(client, TABLE);
    expect(await store.holdMessage("p-1", ID, 1_800_000_000)).toBe(true);
    const items = (sent[0]?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
    expect(items.map((i) => i.Update?.Key)).toEqual([
      { pk: { S: "PARTICIPANT#p-1" }, sk: { S: "CONVERSATION" } },
      { pk: { S: "PARTICIPANT#p-1" }, sk: { S: `MSG#${ID}` } },
    ]);
    expect(items[0]?.Update).toMatchObject({
      UpdateExpression: "SET #pendingSince = :pendingSince",
      ConditionExpression: "#pendingId = :messageId AND #state = :open",
      ExpressionAttributeValues: { ":pendingSince": { N: "1800000000" }, ":messageId": { S: ID }, ":open": { S: "open" } },
    });
    expect(items[1]?.Update).toMatchObject({
      UpdateExpression: "SET #pendingSince = :pendingSince",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeValues: { ":pendingSince": { N: "1800000000" }, ":pending": { S: "pending" } },
    });
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    // No longer pending or in flight: nothing written, false; a table error is thrown.
    expect(await store.holdMessage("p-1", ID, 1)).toBe(false);
    await expect(store.holdMessage("p-1", ID, 1)).rejects.toThrow("down");
  });

  it("reads the settings projected to SETTINGS_READ_ATTRIBUTES", async () => {
    const { client, sent } = stubClient([{ Item: { stopped: { BOOL: true } } }]);
    expect(await new DynamoConversationStore(client, TABLE).getSettings()).toEqual({ ...DEFAULT_SETTINGS, stopped: true });
    for (const name of Object.values((sent[0] as GetItemCommand).input.ExpressionAttributeNames ?? {})) expect(SETTINGS_READ_ATTRIBUTES, name).toContain(name);
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

describe("change requests in the conversation store (ticket 3.6)", () => {
  const items = (command: Sent | undefined): TransactWriteItem[] => (command?.input as { TransactItems: TransactWriteItem[] }).TransactItems;
  /** The names a transaction's ConditionCheck items name (each defined and used, both ways). */
  function checkNames(command: Sent | undefined): string[] {
    return items(command).flatMap((i) => {
      if (i.ConditionCheck === undefined) return [];
      const text = i.ConditionCheck.ConditionExpression ?? "";
      const used = new Set(text.match(/[#:][A-Za-z_]+/g) ?? []);
      const defined = new Set([...Object.keys(i.ConditionCheck.ExpressionAttributeNames ?? {}), ...Object.keys(i.ConditionCheck.ExpressionAttributeValues ?? {})]);
      expect([...used].sort(), text).toEqual([...defined].sort());
      return ["pk", "sk", ...Object.values(i.ConditionCheck.ExpressionAttributeNames ?? {})];
    });
  }
  const answer = { prompt: CHANGE_BUILD_REQUEST, modelId: MODEL_ID, promptVersion: "readiness-v2", historyCount: 0, usage: usage(900, 60) };
  const ready = (used: number): ChangeBuildFinish => ({
    kind: "ready",
    reply: "ok",
    version: 2,
    previousBuildId: "b-0",
    answer,
    build: { buildId: "b-1", nickname: "Ada", changeNumber: used + 1 },
    used,
    cap: 5,
  });

  it("takes a change request only while the conversation's build is the one it follows (no approval condition), inside the conversation function's list", async () => {
    const message = { id: ID, step: "building" as const, text: "Add a chart", createdAt: NOW_ISO, nowSeconds: 5000 };
    const { client, sent } = stubClient([{}, cancelled(["ConditionalCheckFailed", "None"]), { Item: { state: { S: "open" }, approvedSpecVersion: { N: "1" }, buildId: { S: "b-1" } } }]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.createMessage("p-1", message, "b-0")).resolves.toBe("created");
    expect(items(sent[0])[0]?.Update).toMatchObject({
      ConditionExpression: "#buildId = :afterBuild AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
      ExpressionAttributeValues: { ":afterBuild": { S: "b-0" } },
    });
    expect(items(sent[0])[1]?.Update?.ExpressionAttributeValues?.[":request"]).toBeUndefined();
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
    // The build moved on meanwhile: busy (never "approved", which means steps 1 and 2 are closed).
    await expect(store.createMessage("p-1", message, "b-0")).resolves.toBe("busy");
  });

  it("stores a change answer's version with its list and makes it the proposal, inside the worker's list", async () => {
    const { client, sent } = stubClient([{}]);
    const finish: Finish = { ...DONE, spec: { version: 2, text: "# A", whatChanges: ["Adds a chart"] } };
    await new DynamoConversationStore(client, TABLE).finish("p-1", ID, finish, "pending", NOW_ISO);
    const spec = items(sent[0]).find((i) => i.Update?.Key?.["sk"]?.S === "SPEC#0002")?.Update;
    expect(spec?.ExpressionAttributeValues?.[":whatChanges"]).toEqual({ L: [{ S: "Adds a chart" }] });
    const conversation = items(sent[0]).find((i) => i.Update?.Key?.["sk"]?.S === "CONVERSATION")?.Update;
    expect(conversation?.ExpressionAttributeValues).toMatchObject({ ":latestSpecVersion": { N: "2" }, ":proposedSpecVersion": { N: "2" } });
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    // A step 2 version (no list) is not a proposal.
    const plain = stubClient([{}]);
    await new DynamoConversationStore(plain.client, TABLE).finish("p-1", ID, { ...DONE, spec: { version: 2, text: "# A" } }, "pending", NOW_ISO);
    expect(JSON.stringify(items(plain.sent[0]))).not.toContain("proposedSpecVersion");
    expect(JSON.stringify(items(plain.sent[0]))).not.toContain("whatChanges");
    // The limit reply (no AI call).
    const limit = stubClient([{}]);
    await new DynamoConversationStore(limit.client, TABLE).finish("p-1", ID, { kind: "over-limit", reply: "You've used your 5 changes." }, "pending", NOW_ISO);
    expect(items(limit.sent[0])[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":kind": { S: "limit" } });
    expect(items(limit.sent[0])[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":status": { S: "failed" } });
  });

  it("Build this change: the request (marked change-build) in flight and the version approved, only for this proposal after this build, inside the conversation function's list", async () => {
    const message = { id: ID, step: "building" as const, text: CHANGE_BUILD_REQUEST, createdAt: NOW_ISO, nowSeconds: 5000, request: "change-build" as const };
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoConversationStore(client, TABLE).requestChangeBuild("p-1", 2, "b-0", message)).resolves.toBe("created");
    const list = items(sent[0]);
    expect(list.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual(["CONVERSATION", "SPEC#0002", `MSG#${ID}`]);
    expect(list[0]?.Update).toMatchObject({
      ConditionExpression:
        "#proposedSpecVersion = :version AND #buildId = :buildId AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
      ExpressionAttributeValues: { ":version": { N: "2" }, ":buildId": { S: "b-0" }, ":pendingId": { S: ID } },
    });
    expect(list[1]?.Update).toMatchObject({ UpdateExpression: "SET #approvedAt = :approvedAt", ConditionExpression: "attribute_exists(#pk)" });
    expect(list[2]?.Update?.ExpressionAttributeValues).toMatchObject({ ":request": { S: "change-build" }, ":text": { S: CHANGE_BUILD_REQUEST }, ":step": { S: "building" } });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
    const conv = (fields: Record<string, unknown>) => ({ Item: { state: { S: "open" }, buildId: { S: "b-0" }, ...fields } });
    for (const [read, expected] of [
      [conv({}), "stale"],
      [conv({ proposedSpecVersion: { N: "3" } }), "stale"],
      [conv({ proposedSpecVersion: { N: "2" }, buildId: { S: "b-9" } }), "stale"],
      [conv({ proposedSpecVersion: { N: "2" }, pendingId: { S: "x" } }), "busy"],
      [conv({ proposedSpecVersion: { N: "2" }, state: { S: "waiting" } }), "waiting"],
    ] as const) {
      const stub = stubClient([cancelled(["ConditionalCheckFailed", "None", "None"]), read]);
      await expect(new DynamoConversationStore(stub.client, TABLE).requestChangeBuild("p-1", 2, "b-0", message), expected).resolves.toBe(expected);
    }
  });

  it("Not this one removes the proposal only, while nothing is in flight, inside the conversation function's list", async () => {
    const { client, sent } = stubClient([{}, cancelled(["ConditionalCheckFailed"]), { Item: { state: { S: "open" }, proposedSpecVersion: { N: "2" }, pendingId: { S: ID } } }]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.discardChange("p-1", 2, 5000, NOW_ISO)).resolves.toBe("discarded");
    expect(items(sent[0])).toHaveLength(1);
    expect(items(sent[0])[0]?.Update).toMatchObject({
      Key: { sk: { S: "CONVERSATION" } },
      UpdateExpression: "SET #updatedAt = :updatedAt REMOVE #proposedSpecVersion",
      ConditionExpression: "#proposedSpecVersion = :version AND (attribute_not_exists(#pendingId) OR (#state = :open AND #pendingSince < :staleBefore))",
    });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
    await expect(store.discardChange("p-1", 2, 5000, NOW_ISO)).resolves.toBe("busy");
  });

  it("queues a change build in one transaction: the count from exactly the value read and below the cap, the previous build live or failed, the build of kind change, inside the worker's lists", async () => {
    const { client, sent } = stubClient([{}, {}]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.finishChangeBuild("p-1", ID, ready(2), NOW_ISO)).resolves.toBe(true);
    const list = items(sent[0]);
    expect(list.map((i) => (i.ConditionCheck === undefined ? i.Update?.Key?.["sk"]?.S : `check ${i.ConditionCheck.Key?.["pk"]?.S}`))).toEqual([
      `MSG#${ID}`,
      `MSG#${ID}-r`,
      "CONVERSATION",
      "PROFILE",
      "check BUILD#b-0",
      "BUILD",
      "USAGE",
    ]);
    expect(list[2]?.Update).toMatchObject({
      UpdateExpression: "SET #state = :state, #updatedAt = :updatedAt, #buildId = :buildId, #approvedSpecVersion = :approvedSpecVersion REMOVE #pendingId, #pendingSince, #proposedSpecVersion",
      ConditionExpression: "#pendingId = :messageId AND #proposedSpecVersion = :version AND #buildId = :previousBuildId",
      ExpressionAttributeValues: { ":buildId": { S: "b-1" }, ":previousBuildId": { S: "b-0" }, ":approvedSpecVersion": { N: "2" } },
    });
    expect(list[3]?.Update).toMatchObject({
      UpdateExpression: "SET #changeRequestsUsed = :changeRequestsUsed",
      ConditionExpression: "#step = :building AND #changeRequestsUsed = :used AND #changeRequestsUsed < :cap",
      ExpressionAttributeValues: { ":changeRequestsUsed": { N: "3" }, ":used": { N: "2" }, ":cap": { N: "5" }, ":building": { S: "building" } },
    });
    expect(list[4]?.ConditionCheck).toMatchObject({ ConditionExpression: "#status IN (:live, :failed)", Key: { pk: { S: "BUILD#b-0" }, sk: { S: "BUILD" } } });
    expect(list[5]?.Update).toMatchObject({
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeValues: { ":kind": { S: "change" }, ":changeNumber": { N: "3" }, ":specVersion": { N: "2" }, ":status": { S: "queued" } },
    });
    // Each item inside the role's lists: participant items in the worker's, the build in its build list, the check in its check list.
    for (const item of list) {
      if (item.Update === undefined) continue;
      const names = ["pk", "sk", ...Object.values(item.Update.ExpressionAttributeNames ?? {})];
      const allowed: readonly string[] = (item.Update.Key?.["pk"]?.S ?? "").startsWith("BUILD#") ? AI_WORKER_BUILD_UPDATE_ATTRIBUTES : AI_WORKER_UPDATE_ATTRIBUTES;
      for (const name of names) expect(allowed, name).toContain(name);
    }
    namesUsed(sent[0]);
    for (const name of checkNames(sent[0])) expect(AI_WORKER_BUILD_CHECK_ATTRIBUTES, name).toContain(name);
    // The first change: the count may be absent.
    await store.finishChangeBuild("p-1", ID, ready(0), NOW_ISO);
    expect(items(sent[1])[3]?.Update?.ConditionExpression).toBe(
      "#step = :building AND (attribute_not_exists(#changeRequestsUsed) OR (#changeRequestsUsed = :used AND #changeRequestsUsed < :cap))",
    );
    namesUsed(sent[1]);
  });

  it("ends a change build request that is not built without the count, the build or the check, keeping the proposal", async () => {
    const { client, sent } = stubClient([{}, {}, cancelled(["None", "None", "None", "ConditionalCheckFailed"])]);
    const store = new DynamoConversationStore(client, TABLE);
    await store.finishChangeBuild("p-1", ID, { kind: "not-ready", reply: "no", version: 2, previousBuildId: "b-0", answer }, NOW_ISO);
    const list = items(sent[0]);
    expect(list.map((i) => i.Update?.Key?.["sk"]?.S)).toEqual([`MSG#${ID}`, `MSG#${ID}-r`, "CONVERSATION", "USAGE"]);
    expect(list[2]?.Update).toMatchObject({
      UpdateExpression: "SET #state = :state, #updatedAt = :updatedAt REMOVE #pendingId, #pendingSince",
      ConditionExpression: "#pendingId = :messageId AND #proposedSpecVersion = :version AND #buildId = :previousBuildId",
    });
    for (const name of namesUsed(sent[0])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    await store.finishChangeBuild("p-1", ID, { kind: "over-limit", reply: "You've used your 5 changes.", version: 2, previousBuildId: "b-0" }, NOW_ISO);
    expect(items(sent[1])[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":kind": { S: "limit" } });
    expect(items(sent[1])).toHaveLength(3);
    namesUsed(sent[1]);
    // A lost race (the count moved, the previous build runs again) writes nothing.
    await expect(store.finishChangeBuild("p-1", ID, ready(1), NOW_ISO)).resolves.toBe(false);
  });

  it("notes the suggestions ask and stores the suggestions once, inside each role's list; reads them back with the proposal", async () => {
    const { client, sent } = stubClient([{}, cancelled(["ConditionalCheckFailed"]), {}, {}]);
    const store = new DynamoConversationStore(client, TABLE);
    await expect(store.markSuggestionsRequested("p-1", NOW_ISO, "2026-11-23T09:50:05.000Z")).resolves.toBe(true);
    expect(items(sent[0])[0]?.Update).toMatchObject({
      UpdateExpression: "SET #suggestionsRequestedAt = :suggestionsRequestedAt",
      ConditionExpression:
        "attribute_exists(#pk) AND attribute_not_exists(#suggestions) AND (attribute_not_exists(#suggestionsRequestedAt) OR #suggestionsRequestedAt < :askedBefore)",
    });
    for (const name of namesUsed(sent[0])) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).toContain(name);
    await expect(store.markSuggestionsRequested("p-1", NOW_ISO, "x")).resolves.toBe(false);
    await expect(store.storeSuggestions("p-1", ["a b c", "d e f", "g h i"], usage(900, 60), NOW_ISO)).resolves.toBe(true);
    expect(items(sent[2])[0]?.Update).toMatchObject({
      UpdateExpression: "SET #suggestions = :suggestions",
      ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#suggestions)",
      ExpressionAttributeValues: { ":suggestions": { L: [{ S: "a b c" }, { S: "d e f" }, { S: "g h i" }] } },
    });
    expect(items(sent[2])[1]?.Update?.Key?.["sk"]?.S).toBe("USAGE");
    for (const name of namesUsed(sent[2])) expect(AI_WORKER_UPDATE_ATTRIBUTES, name).toContain(name);
    // Only the worker counts changes; the conversation function never writes the count, a list or a version.
    for (const name of ["changeRequestsUsed", "whatChanges", "specVersion"]) expect(CONVERSATION_UPDATE_ATTRIBUTES, name).not.toContain(name);
    const read = stubClient([
      {
        Item: {
          state: { S: "open" },
          proposedSpecVersion: { N: "2" },
          suggestions: { L: [{ S: "a" }, { N: "1" }, { S: "b" }] },
          suggestionsRequestedAt: { S: NOW_ISO },
        },
      },
      { Item: { sk: { S: "SPEC#0002" }, specVersion: { N: "2" }, text: { S: "# A" }, createdAt: { S: NOW_ISO }, whatChanges: { L: [{ S: "Adds a chart" }] } } },
    ]);
    const reader = new DynamoConversationStore(read.client, TABLE);
    await expect(reader.getConversation("p-1")).resolves.toEqual({ state: "open", proposedSpecVersion: 2, suggestions: ["a", "b"], suggestionsRequestedAt: NOW_ISO });
    await expect(reader.getSpec("p-1", 2)).resolves.toEqual({ version: 2, text: "# A", createdAt: NOW_ISO, approved: false, whatChanges: ["Adds a chart"] });
    expect((read.sent[1]?.input as GetItemCommand["input"]).ProjectionExpression).toContain("#whatChanges");
  });

  it("asks the worker for suggestions with the participant id only", async () => {
    const sent: SendMessageCommand[] = [];
    const queue = new SqsMessageQueue({ send: async (command: SendMessageCommand) => (sent.push(command), { $metadata: {} }) }, AI_QUEUE_URL);
    await queue.sendSuggestions("p-1");
    await queue.sendSuggestions("p-1", 30);
    expect(sent.map((c) => c.input)).toEqual([
      { QueueUrl: AI_QUEUE_URL, MessageBody: '{"participantId":"p-1","suggestions":true}' },
      { QueueUrl: AI_QUEUE_URL, MessageBody: '{"participantId":"p-1","suggestions":true}', DelaySeconds: 30 },
    ]);
  });
});
