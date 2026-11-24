import { createHash } from "node:crypto";
import { GetItemCommand, ScanCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { handleConversationRequest, POLL_ROUTE, SEND_ROUTE, type ConversationDeps } from "../../api/conversation/conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, verdictReply } from "../../api/conversation/fakes.js";
import { CLARIFY_SYSTEM_PROMPT } from "../../api/conversation/answer.js";
import { DEFAULT_SUGGESTION } from "../../api/conversation/guardrail.js";
import { processJob } from "../../api/conversation/worker.js";
import type { HttpRequest } from "../../api/http.js";
import { hashToken, SESSION_COOKIE } from "../../api/session/session.js";
import { MODEL_ID } from "../../api/settings.js";
import { parseFlagsArgs, runFlags, terminalSafe, type FlagsDeps } from "./command.js";
import { DynamoFlagsStore, type FlagsSender } from "./store.js";

const NOW = new Date("2026-11-23T10:00:00.000Z");
const TOKEN = Buffer.alloc(32, 1).toString("base64url");
const OTHER = Buffer.alloc(32, 2).toString("base64url");
const TEXT = "An app that tells my colleagues which pills to take";

async function setupFlagged() {
  const table = new FakeConversationTable();
  table.addParticipant("p-ada", "Ada", hashToken(TOKEN), NOW.getTime() / 1000 + 3600);
  table.addParticipant("p-bob", "Bob", hashToken(OTHER), NOW.getTime() / 1000 + 3600);
  const queue = new FakeQueue();
  const model = new FakeModel();
  let clock = NOW;
  const api: ConversationDeps = { sessions: table, store: table, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, 5), log: () => undefined };
  const workerDeps = { store: table, model, modelId: MODEL_ID, builds: new FakeBuildQueue(), now: () => clock, log: () => undefined };
  const send = (text: string, t = TOKEN): HttpRequest => ({
    routeKey: SEND_ROUTE,
    cookies: [`${SESSION_COOKIE}=${t}`],
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const res = await handleConversationRequest(send(TEXT), api);
  const id = (JSON.parse(res.body ?? "{}") as { id: string }).id;
  model.push(verdictReply("flag", "A medication reminder checklist", "medical advice"));
  await processJob(queue.sent.shift(), workerDeps);
  expect(table.conversations.get("p-ada")?.state).toBe("waiting");
  const out: string[] = [];
  const err: string[] = [];
  const deps: FlagsDeps = {
    createStore: () => table,
    createQueue: () => queue,
    now: () => {
      clock = new Date(clock.getTime() + 60_000);
      return clock;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  const poll = async () =>
    JSON.parse((await handleConversationRequest({ routeKey: POLL_ROUTE, cookies: [`${SESSION_COOKIE}=${TOKEN}`], pathParameters: { id } }, api)).body ?? "{}") as Record<string, unknown>;
  const drain = async () => {
    while (queue.sent.length > 0) await processJob(queue.sent.shift(), workerDeps);
  };
  return { table, queue, model, deps, out, err, id, poll, drain, sendAgain: () => handleConversationRequest(send("a new idea"), api) };
}

describe("criterion 4: npm run flags -- approve|reject <nickname>", () => {
  it("WHEN approve <nickname> runs THEN the waiting message continues: the AI answers it without a new check", async () => {
    const s = await setupFlagged();
    expect(await runFlags(["approve", "ada"], s.deps)).toBe(0);
    expect(s.out).toEqual(["Approved: ada's message goes to the AI now; the answer appears on their page."]);
    expect(s.queue.sent).toEqual([{ participantId: "p-ada", messageId: s.id }]);
    expect(await s.poll()).toEqual({ id: s.id, status: "pending" });
    s.model.push({ text: "Let's keep it to reminders you set yourself.", inputTokens: 10, outputTokens: 10 });
    await s.drain();
    expect(s.model.requests.at(-1)?.system).toBe(CLARIFY_SYSTEM_PROMPT);
    expect(s.model.requests).toHaveLength(2);
    expect(await s.poll()).toEqual({ id: s.id, status: "done", reply: "Let's keep it to reminders you set yourself." });
    expect(s.table.conversations.get("p-ada")).toEqual({ state: "open" });
    expect((await s.sendAgain()).statusCode).toBe(202);
  });

  it("WHEN reject <nickname> runs THEN the waiting message is declined with one polite sentence and the participant can write again", async () => {
    const s = await setupFlagged();
    expect(await runFlags(["reject", "Ada"], s.deps)).toBe(0);
    expect(s.out).toEqual(["Rejected: Ada's message got a polite decline, and Ada can write again."]);
    expect(await s.poll()).toEqual({
      id: s.id,
      status: "declined",
      reply: "Sorry, that's outside what we can build in this workshop, but how about a medication reminder checklist instead?",
    });
    expect(s.queue.sent).toHaveLength(0);
    expect(s.model.requests).toHaveLength(1);
    expect((await s.sendAgain()).statusCode).toBe(202);
  });

  it("decides only once, and refuses unknown nicknames and participants with nothing waiting", async () => {
    const s = await setupFlagged();
    expect(await runFlags(["reject", "Ada"], s.deps)).toBe(0);
    expect(await runFlags(["approve", "Ada"], s.deps)).toBe(1);
    expect(await runFlags(["approve", "Bob"], s.deps)).toBe(1);
    expect(await runFlags(["reject", "Nobody"], s.deps)).toBe(1);
    expect(s.err).toEqual([
      "Ada has no message waiting for a decision.",
      "Bob has no message waiting for a decision.",
      "No participant has the nickname Nobody.",
    ]);
    expect(s.queue.sent).toHaveLength(0);
  });

  it("lists each waiting nickname with the flagged message and the guardrail's reason, never an id or an email", async () => {
    const s = await setupFlagged();
    expect(await runFlags(["list"], s.deps)).toBe(0);
    expect(s.out).toEqual(["Waiting for a decision: 1", "", "Ada", `  Message: ${TEXT}`, "  Flagged because: medical advice"]);
    const printed = [...s.out, ...s.err].join("\n");
    for (const secret of ["p-ada", s.id, "@"]) expect(printed).not.toContain(secret);
  });

  it("prints a participant's text without terminal control characters", async () => {
    const s = await setupFlagged();
    const message = s.table.messages.get("p-ada")?.get(s.id);
    if (message) message.text = "pills\u001b[2J\nfor all\u202e";
    expect(await runFlags(["list"], s.deps)).toBe(0);
    expect(s.out[3]).toBe("  Message: pills [2J for all ");
    expect(terminalSafe("a\tb\rc\u0007d")).toBe("a b c d");
  });

  it("lists nothing when no one is waiting", async () => {
    const s = await setupFlagged();
    await runFlags(["reject", "Ada"], s.deps);
    s.out.length = 0;
    expect(await runFlags(["list"], s.deps)).toBe(0);
    expect(s.out).toEqual(["Waiting for a decision: 0"]);
  });

  it("refuses usage errors before creating a store", async () => {
    let created = 0;
    const err: string[] = [];
    const deps: FlagsDeps = {
      createStore: () => {
        created++;
        return new FakeConversationTable();
      },
      createQueue: () => new FakeQueue(),
      now: () => NOW,
      out: () => undefined,
      err: (l) => err.push(l),
    };
    for (const args of [[], ["approve"], ["approve", "a b"], ["approve", "x"], ["reject", "Ada", "Bob"], ["list", "x"], ["delete", "Ada"], ["approve", "ad#a"]]) {
      expect(await runFlags(args, deps), args.join(" ")).toBe(1);
    }
    expect(created).toBe(0);
    expect(err[0]).toContain("Usage: npm run flags");
    expect(parseFlagsArgs(["approve", " Ada "])).toEqual({ command: "approve", nickname: "Ada" });
  });

  it("reports a refused queue after an approval, and AWS errors without addresses", async () => {
    const s = await setupFlagged();
    s.queue.failure = Object.assign(new Error("queue down"), { name: "QueueDoesNotExist" });
    expect(await runFlags(["approve", "Ada"], s.deps)).toBe(1);
    expect(s.err[0]).toBe("Approved, but the queue refused the message (QueueDoesNotExist: queue down).");
    const failing = { ...s.deps, createStore: () => ({ listWaiting: async () => Promise.reject(new Error("denied for jane@example.com")) }) as never };
    expect(await runFlags(["list"], failing)).toBe(1);
    expect(s.err.at(-1)).not.toContain("jane@example.com");
  });

  it("uses the default suggestion when the guardrail gave none", async () => {
    const s = await setupFlagged();
    const message = s.table.messages.get("p-ada")?.get(s.id);
    if (message) delete message.suggestion;
    await runFlags(["reject", "Ada"], s.deps);
    expect((await s.poll())["reply"]).toContain(DEFAULT_SUGGESTION);
  });
});

describe("DynamoFlagsStore", () => {
  function stub(answers: Record<string, unknown>[]) {
    const sent: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        sent.push(command);
        return { $metadata: {}, ...answers.shift() };
      },
    } as unknown as FlagsSender;
    return { store: new DynamoFlagsStore(client, "ssd-workshop-data"), sent };
  }

  it("resolves a nickname through its lower-cased claim and reads only the participant id", async () => {
    const { store, sent } = stub([{ Item: { participantId: { S: "p-1" } } }, {}]);
    await expect(store.findParticipantId("Ada")).resolves.toBe("p-1");
    await expect(store.findParticipantId("Bob")).resolves.toBeUndefined();
    expect((sent[0] as GetItemCommand).input).toMatchObject({ Key: { pk: { S: "NICK#ada" }, sk: { S: "NICK" } }, ProjectionExpression: "#participantId" });
  });

  it("lists waiting conversations with a paginated scan projecting only the key", async () => {
    const { store, sent } = stub([
      { Items: [{ pk: { S: "PARTICIPANT#p-1" } }], LastEvaluatedKey: { pk: { S: "x" } } },
      { Items: [{ pk: { S: "PARTICIPANT#p-2" } }] },
    ]);
    await expect(store.listWaiting()).resolves.toEqual(["p-1", "p-2"]);
    expect(sent).toHaveLength(2);
    expect((sent[0] as ScanCommand).input).toMatchObject({ ProjectionExpression: "#pk", FilterExpression: "#type = :conversation AND #state = :waiting" });
  });

  it("approves in one transaction: the message back to pending, approved for its text's SHA-256, the conversation open", async () => {
    const { store, sent } = stub([{}]);
    await expect(store.approve("p-1", "m-1", "a weather app", 1000, "2026-11-23T10:00:00.000Z")).resolves.toBe(true);
    const items = ((sent[0] as TransactWriteItemsCommand).input.TransactItems ?? []) as TransactWriteItem[];
    const hash = createHash("sha256").update("a weather app").digest("hex");
    expect(items[0]?.Update).toMatchObject({
      Key: { sk: { S: "MSG#m-1" } },
      ConditionExpression: "#status = :flagged",
      ExpressionAttributeValues: { ":status": { S: "pending" }, ":approvedTextHash": { S: hash }, ":pendingSince": { N: "1000" } },
    });
    expect(JSON.stringify(items)).not.toContain("a weather app");
    expect(JSON.stringify(items)).not.toContain(":approved\"");
    expect(items[1]?.Update).toMatchObject({
      Key: { sk: { S: "CONVERSATION" } },
      ConditionExpression: "#state = :waiting AND #pendingId = :messageId",
    });
  });
});
