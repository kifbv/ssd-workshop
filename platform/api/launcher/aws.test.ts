// Ticket 2.9: the launcher's DynamoDB, ECS and SQS requests, checked against the attribute lists its IAM statements
// allow (infra/lib/config.ts) and against the task's network and override rules.
import {
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type DeleteItemCommandInput,
  type GetItemCommandInput,
  type QueryCommandInput,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { DescribeTasksCommand, RunTaskCommand, type DescribeTasksCommandInput, type RunTaskCommandInput } from "@aws-sdk/client-ecs";
import { ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import {
  BUILDER_CONTAINER_NAME as INFRA_BUILDER_CONTAINER_NAME,
  BUILD_CHECK_QUEUE_NAME as INFRA_BUILD_CHECK_QUEUE_NAME,
  BUILD_DLQ_NAME,
  BUILDS_CLUSTER_NAME as INFRA_BUILDS_CLUSTER_NAME,
  BUILDS_SUBNET_IDS as INFRA_BUILDS_SUBNET_IDS,
  BUILD_QUEUE_PARTITION,
  BUILD_SLOTS_PARTITION,
  DEPLOY_DLQ_NAME,
  LAUNCHER_BUILD_UPDATE_ATTRIBUTES,
  LAUNCHER_LAUNCH_ATTRIBUTES,
  LAUNCHER_QUEUE_ATTRIBUTES,
  LAUNCHER_READ_ATTRIBUTES,
  LAUNCHER_SLOT_ATTRIBUTES,
  LAUNCHES_PARTITION,
  SETTINGS_READ_ATTRIBUTES,
} from "../../../infra/lib/config.js";
import { BUILD_QUEUE_PK, BUILD_SLOTS_PK, LAUNCHES_PK, SETTINGS_PK } from "../keys.js";
import {
  BUILD_CHECK_QUEUE_NAME,
  BUILD_DLQ_URL,
  BUILDER_CONTAINER_NAME,
  BUILDS_CLUSTER_NAME,
  BUILDS_SUBNET_IDS,
  DEPLOY_DLQ_URL,
} from "../settings.js";
import { DynamoLaunchRecords, EcsBuildTasks, runTaskRequest, SqsLaunchVisibility, type LauncherTableSender, type TaskSender, type VisibilitySender } from "./aws.js";

const TABLE = "ssd-workshop-data";
const NOW = "2026-11-24T10:00:00.000Z";
const ARN = "arn:aws:ecs:eu-central-1:360206963848:task/ssd-workshop-builds/0123";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ATTEMPT = "6f1c2a9e-1111-4222-8333-444455556666";
const START = { buildId: "b-1", token: "ghs_token", baseCommit: COMMIT, attemptId: ATTEMPT };
const QUEUE_KEY = `${NOW}#b-1`;
const SLOT = { cap: 15, queueKey: QUEUE_KEY };
const cancelled = (...codes: string[]) => Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

function stub(answers: unknown[] = []) {
  const sent: { input: unknown }[] = [];
  const options: unknown[] = [];
  const client = {
    send: async (command: { input: unknown }, option?: unknown) => {
      sent.push(command);
      options.push(option);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
  } as unknown as LauncherTableSender & TaskSender;
  return { client, sent, options };
}

type Expressions = { UpdateExpression?: string; ConditionExpression?: string; ProjectionExpression?: string; KeyConditionExpression?: string; FilterExpression?: string };
type Named = Expressions & { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown>; Key?: Record<string, unknown>; Item?: Record<string, unknown> };

/** Every attribute name a request uses: placeholders resolved, bare names, the key's and a put item's names. */
function attributeNames(input: Named): string[] {
  const text = [input.UpdateExpression, input.ConditionExpression, input.ProjectionExpression, input.KeyConditionExpression, input.FilterExpression].join(" ");
  const placeholders = (text.match(/#[A-Za-z]+/g) ?? []).map((p) => input.ExpressionAttributeNames?.[p] ?? p);
  const keywords = new Set(["SET", "REMOVE", "ADD", "DELETE", "AND", "OR", "NOT", "IN", "attribute_exists", "attribute_not_exists", "undefined"]);
  const bare = (text.replace(/[#:][A-Za-z]+/g, " ").match(/[A-Za-z_]+/g) ?? []).filter((w) => !keywords.has(w));
  return [...new Set([...placeholders, ...bare, ...Object.keys(input.Key ?? {}), ...Object.keys(input.Item ?? {})])].sort();
}

/** DynamoDB refuses an expression with an undefined or unused placeholder. */
function placeholdersMatch(input: Named): void {
  const text = [input.UpdateExpression, input.ConditionExpression, input.ProjectionExpression, input.KeyConditionExpression, input.FilterExpression].join(" ");
  expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(new Set(text.match(/#[A-Za-z]+/g) ?? []));
  expect(new Set(Object.keys(input.ExpressionAttributeValues ?? {}))).toEqual(new Set(text.match(/:[A-Za-z]+/g) ?? []));
}

const pkOf = (input: Named): string =>
  (((input.Key ?? input.Item)?.pk ?? (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"]) as { S: string }).S;

describe("DynamoLaunchRecords (ticket 2.9)", () => {
  async function everyRequest() {
    const { client, sent } = stub([
      { Item: { nickname: { S: "Ada" }, participantId: { S: "p-1" }, status: { S: "queued" } } },
      { Item: { nickname: { S: "Ada" } } },
      { Item: { buildId: { S: "b-1" }, approvedSpecVersion: { N: "2" } } },
      { Item: { specVersion: { N: "2" }, text: { S: "# Spec" }, approvedAt: { S: NOW } } },
    ]);
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.readBuild("b-1")).toEqual({ nickname: "Ada", participantId: "p-1", status: "queued" });
    expect(await records.readProfileNickname("p-1")).toBe("Ada");
    expect(await records.readConversation("p-1")).toEqual({ buildId: "b-1", approvedSpecVersion: 2 });
    expect(await records.readApprovedSpec("p-1", 2)).toBe("# Spec");
    // Ticket 3.4: the cap, the waiting line and the slots.
    expect((await records.readSettings()).buildsAtOnce).toBe(15);
    expect(await records.enqueue("b-1", QUEUE_KEY)).toBe(true);
    await records.touchQueueEntry(QUEUE_KEY, "b-1", NOW);
    expect(await records.countAhead(QUEUE_KEY, NOW)).toBe(0);
    expect(await records.readSlots()).toEqual({ running: undefined, version: 0, misses: 0 });
    expect(await records.listSlotHolders()).toEqual([]);
    await records.removeSlotItem("BUILD#odd");
    expect(await records.releaseSlot("b-1")).toBe(true);
    expect(await records.repairSlots({ running: 3, version: 4, misses: 0 }, 2, false)).toBe(true);
    expect(await records.repairSlots({ running: -1, version: 4, misses: 0 }, 2, true)).toBe(true);
    await records.noteRepairRefused();
    expect(await records.listQueueEntries()).toEqual([]);
    await records.removeQueueEntry(QUEUE_KEY);
    expect(await records.claim("b-1", "Ada", "p-1", ATTEMPT, NOW, SLOT)).toBe("claimed");
    await records.recordTask("b-1", ARN, NOW);
    expect(await records.failUnstarted("b-1", ["x"], NOW)).toBe(true);
    expect(await records.failUnrecorded("b-1", NOW, ["x"], NOW)).toBe(true);
    expect(await records.failStopped("b-1", ARN, ["x"], NOW)).toBe(true);
    expect(await records.failHandedOver("b-1", ARN, ["x"], NOW)).toBe(true);
    expect(await records.failQueued("b-1", ["x"], NOW)).toBe(true);
    expect(await records.requeueStopped("b-1", ARN, QUEUE_KEY, NOW)).toBe(true);
    expect(await records.failDeploy("b-1", "Ada", COMMIT, ["x"], NOW)).toBe(true);
    expect(await records.listLaunches()).toEqual([]);
    await records.removeLaunch("b-1", ARN);
    return sent;
  }

  it("reads only LAUNCHER_READ_ATTRIBUTES (SETTINGS_READ_ATTRIBUTES, LAUNCHER_SLOT_ATTRIBUTES), consistently, with a projection (so dynamodb:Select is SPECIFIC_ATTRIBUTES)", async () => {
    const sent = await everyRequest();
    const reads = sent.filter((command) => command instanceof GetItemCommand).map((command) => command.input as GetItemCommandInput);
    expect(reads).toHaveLength(6);
    const names = { records: new Set<string>(), settings: new Set<string>(), slots: new Set<string>() };
    for (const input of reads) {
      placeholdersMatch(input as Named);
      expect(input.ConsistentRead).toBe(true);
      expect(input.ProjectionExpression).toBeTruthy();
      const pk = pkOf(input as Named);
      const set = pk === SETTINGS_PK ? names.settings : pk === BUILD_SLOTS_PK ? names.slots : names.records;
      if (set === names.records) expect(pk).toMatch(/^(BUILD|PARTICIPANT)#/);
      for (const name of attributeNames(input as Named)) set.add(name);
    }
    expect([...names.records].sort()).toEqual([...LAUNCHER_READ_ATTRIBUTES].sort());
    for (const name of names.settings) expect(SETTINGS_READ_ATTRIBUTES as readonly string[]).toContain(name);
    for (const name of names.slots) expect(LAUNCHER_SLOT_ATTRIBUTES as readonly string[]).toContain(name);
  });

  it("names exactly LAUNCHER_BUILD_UPDATE_ATTRIBUTES in BUILD# and LAUNCHER_LAUNCH_ATTRIBUTES in LAUNCHES, returning nothing", async () => {
    const sent = await everyRequest();
    const writes: Named[] = [];
    for (const command of sent) {
      if (command instanceof UpdateItemCommand || command instanceof DeleteItemCommand) {
        expect((command.input as UpdateItemCommandInput | DeleteItemCommandInput).ReturnValues).toBe("NONE");
        writes.push(command.input as Named);
      }
      if (command instanceof TransactWriteItemsCommand) {
        for (const item of command.input.TransactItems ?? []) {
          if (item.Update) writes.push(item.Update as Named);
          if (item.Put) writes.push(item.Put as Named);
          if (item.Delete) writes.push(item.Delete as Named);
          if (item.ConditionCheck) writes.push(item.ConditionCheck as Named);
        }
      }
      if (command instanceof QueryCommand) {
        writes.push(command.input as Named);
        // Try 2: IAM requires a projection (or a count, for the line) on every read of the slots and the line.
        const input = command.input as QueryCommandInput;
        const pk = pkOf(input as Named);
        if (pk === BUILD_SLOTS_PK) expect(input.Select).toBe("SPECIFIC_ATTRIBUTES");
        if (pk === BUILD_QUEUE_PK) expect(["SPECIFIC_ATTRIBUTES", "COUNT"]).toContain(input.Select);
        if (input.Select === "SPECIFIC_ATTRIBUTES") expect(input.ProjectionExpression).toBeTruthy();
      }
    }
    const names: Record<string, Set<string>> = { build: new Set(), [LAUNCHES_PK]: new Set(), [BUILD_SLOTS_PK]: new Set(), [BUILD_QUEUE_PK]: new Set() };
    for (const input of writes) {
      placeholdersMatch(input);
      const pk = pkOf(input);
      const set = pk.startsWith("BUILD#") ? names.build : names[pk];
      expect(set, pk).toBeDefined();
      for (const name of attributeNames(input)) set?.add(name);
    }
    expect([...(names.build ?? [])].sort()).toEqual([...LAUNCHER_BUILD_UPDATE_ATTRIBUTES].sort());
    expect([...(names[LAUNCHES_PK] ?? [])].sort()).toEqual([...LAUNCHER_LAUNCH_ATTRIBUTES].sort());
    expect([...(names[BUILD_SLOTS_PK] ?? [])].sort()).toEqual([...LAUNCHER_SLOT_ATTRIBUTES].sort());
    expect([...(names[BUILD_QUEUE_PK] ?? [])].sort()).toEqual([...LAUNCHER_QUEUE_ATTRIBUTES].sort());
    expect(LAUNCHES_PK).toBe(LAUNCHES_PARTITION);
    expect(BUILD_SLOTS_PK).toBe(BUILD_SLOTS_PARTITION);
    expect(BUILD_QUEUE_PK).toBe(BUILD_QUEUE_PARTITION);
    // Partitions no `BUILD#*` or `PARTICIPANT#*` pattern can match.
    for (const pk of [BUILD_SLOTS_PK, BUILD_QUEUE_PK]) expect(pk).not.toMatch(/^(BUILD|PARTICIPANT)#/);
  });

  it("claims only a queued build of the read nickname and participant, with its watch-list entry and a slot, in one transaction", async () => {
    const { client, sent } = stub([cancelled("ConditionalCheckFailed", "None", "None", "None", "None")]);
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.claim("b-1", "Ada", "p-1", ATTEMPT, NOW, SLOT)).toBe("taken");
    const [update, put, count, holder, entry] = (sent[0] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(update?.Update?.ConditionExpression).toBe("#status = :queued AND #nickname = :nickname AND #participantId = :participantId");
    expect(update?.Update?.UpdateExpression).toBe("SET #status = :building, #attemptId = :attemptId, #launchedAt = :now, #updatedAt = :now REMOVE #taskArn, #queueKey");
    expect(update?.Update?.ExpressionAttributeValues?.[":attemptId"]).toEqual({ S: ATTEMPT });
    expect(put?.Put?.Item).toEqual({ pk: { S: "LAUNCHES" }, sk: { S: "BUILD#b-1" }, type: { S: "launch" }, buildId: { S: "b-1" }, claimedAt: { S: NOW } });
    // Ticket 3.4: the slot is taken in the same transaction, the waiting entry removed.
    expect(count?.Update?.Key).toEqual({ pk: { S: "BUILD_SLOTS" }, sk: { S: "COUNT" } });
    expect(holder?.Put?.Item).toEqual({ pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#b-1" }, type: { S: "build-slot" }, buildId: { S: "b-1" }, heldSince: { S: NOW } });
    expect(holder?.Put?.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(entry?.Delete?.Key).toEqual({ pk: { S: "BUILD_QUEUE" }, sk: { S: QUEUE_KEY } });
    // Any other error is thrown.
    const other = stub([Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" })]);
    await expect(new DynamoLaunchRecords(other.client, TABLE).claim("b-1", "Ada", "p-1", ATTEMPT, NOW, SLOT)).rejects.toThrow();
    const odd = stub([cancelled("None", "None", "ValidationError", "None", "None")]);
    await expect(new DynamoLaunchRecords(odd.client, TABLE).claim("b-1", "Ada", "p-1", ATTEMPT, NOW, SLOT)).rejects.toThrow();
  });

  it("criterion 2: WHEN two launchers claim the last slot at the same time THEN the counter's condition lets one through: the other gets no-slot and waits", async () => {
    // The counter moves only while `running` is under the cap; the losing transaction is cancelled on that item (its
    // condition, or a TransactionConflict when both hit DynamoDB at once), never on the build.
    const { client, sent } = stub([{}, cancelled("None", "None", "ConditionalCheckFailed", "None", "None"), cancelled("None", "None", "TransactionConflict", "None", "None")]);
    const records = new DynamoLaunchRecords(client, TABLE);
    const results = await Promise.all([
      records.claim("b-1", "Ada", "p-1", ATTEMPT, NOW, { cap: 15, queueKey: QUEUE_KEY }),
      records.claim("b-2", "Bob", "p-2", ATTEMPT, NOW, { cap: 15, queueKey: `${NOW}#b-2` }),
      records.claim("b-3", "Cy", "p-3", ATTEMPT, NOW, { cap: 15, queueKey: `${NOW}#b-3` }),
    ]);
    expect(results).toEqual(["claimed", "no-slot", "no-slot"]);
    for (const command of sent) {
      const count = (command as TransactWriteItemsCommand).input.TransactItems?.[2]?.Update;
      // Try 2: the counter must exist and be sane: a missing or negative counter is full until the check repairs it.
      expect(count?.ConditionExpression).toBe("attribute_exists(#running) AND #running >= :zero AND #running < :cap");
      expect(count?.UpdateExpression).toBe("ADD #running :delta, #version :one");
      expect(count?.ExpressionAttributeValues).toEqual({ ":delta": { N: "1" }, ":one": { N: "1" }, ":zero": { N: "0" }, ":cap": { N: "15" } });
    }
    // An earlier holder of the same build not freed yet: also no slot (the check frees it within a minute).
    const held = stub([cancelled("None", "None", "None", "ConditionalCheckFailed", "None")]);
    expect(await new DynamoLaunchRecords(held.client, TABLE).claim("b-1", "Ada", "p-1", ATTEMPT, NOW, SLOT)).toBe("no-slot");
  });

  it("frees the slot after each failure it writes (exactly once: the release transaction needs the holder), and repairs the counter only at the version it read", async () => {
    const { client, sent } = stub();
    const records = new DynamoLaunchRecords(client, TABLE);
    await records.failStopped("b-1", ARN, ["x"], NOW);
    expect(sent[1]).toBeInstanceOf(TransactWriteItemsCommand);
    const [check, holder, count] = (sent[1] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(check?.ConditionCheck?.Key).toEqual({ pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } });
    expect(check?.ConditionCheck?.ConditionExpression).toBe("attribute_not_exists(pk) OR NOT (#status IN (:building, :deploying))");
    expect(holder?.Delete).toEqual({ TableName: TABLE, Key: { pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#b-1" } }, ConditionExpression: "attribute_exists(pk)" });
    expect(count?.Update?.ExpressionAttributeValues).toEqual({ ":delta": { N: "-1" }, ":one": { N: "1" } });
    // A failure write refused by its condition frees nothing.
    const refused = stub([Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" })]);
    expect(await new DynamoLaunchRecords(refused.client, TABLE).failQueued("b-1", ["x"], NOW)).toBe(false);
    expect(refused.sent).toHaveLength(1);
    // A release that finds no holder (already freed) is not an error, and a failed release leaves the failure written.
    const freed = stub([{}, cancelled("None", "ConditionalCheckFailed", "None"), {}, Object.assign(new Error("x"), { name: "InternalServerError" })]);
    const twice = new DynamoLaunchRecords(freed.client, TABLE);
    expect(await twice.failQueued("b-1", ["x"], NOW)).toBe(true);
    expect(await twice.failQueued("b-1", ["x"], NOW)).toBe(true);
    // The repair: SET only while the version is the one read (refused repairs back to 0); forced: no condition (it creates
    // a missing counter); a refused repair is counted.
    const repair = stub([{}, Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }), {}, {}]);
    const r = new DynamoLaunchRecords(repair.client, TABLE);
    expect(await r.repairSlots({ running: 9, version: 7, misses: 1 }, 2, false)).toBe(true);
    expect(await r.repairSlots({ running: 0, version: 0, misses: 0 }, 2, false)).toBe(false);
    expect(await r.repairSlots({ running: undefined, version: 0, misses: 0 }, 2, true)).toBe(true);
    await r.noteRepairRefused();
    const [set, first, forced, missed] = repair.sent.map((command) => command.input as UpdateItemCommandInput);
    for (const input of [set, first, forced, missed]) {
      expect(input?.Key).toEqual({ pk: { S: "BUILD_SLOTS" }, sk: { S: "COUNT" } });
      expect(input?.ReturnValues).toBe("NONE");
      placeholdersMatch(input as Named);
    }
    expect(set?.UpdateExpression).toBe("SET #running = :running, #repairMisses = :zero ADD #version :one");
    expect(set?.ConditionExpression).toBe("#version = :seen");
    expect(set?.ExpressionAttributeValues).toEqual({ ":running": { N: "2" }, ":zero": { N: "0" }, ":one": { N: "1" }, ":seen": { N: "7" } });
    expect(first?.ConditionExpression).toBe("attribute_not_exists(#version)");
    expect(forced?.UpdateExpression).toBe(set?.UpdateExpression);
    expect(forced?.ConditionExpression).toBeUndefined();
    expect(missed?.UpdateExpression).toBe("ADD #repairMisses :one");
    expect(missed?.ConditionExpression).toBeUndefined();
  });

  it("ticket 3.5: puts a running build back to queued from the beginning (only while building with that task and no pushed commit), then frees its slot", async () => {
    const { client, sent } = stub();
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.requeueStopped("b-1", ARN, QUEUE_KEY, NOW)).toBe(true);
    const update = sent[0]?.input as UpdateItemCommandInput;
    expect(update).toEqual({
      TableName: TABLE,
      Key: { pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } },
      UpdateExpression: "SET #status = :queued, #queueKey = :queueKey, #updatedAt = :now REMOVE #attemptId, #launchedAt, #taskArn, #feed",
      ConditionExpression: "#status = :building AND #taskArn = :taskArn AND attribute_not_exists(#pushedCommit)",
      ExpressionAttributeNames: {
        "#status": "status",
        "#queueKey": "queueKey",
        "#updatedAt": "updatedAt",
        "#attemptId": "attemptId",
        "#launchedAt": "launchedAt",
        "#taskArn": "taskArn",
        "#feed": "feed",
        "#pushedCommit": "pushedCommit",
      },
      ExpressionAttributeValues: { ":queued": { S: "queued" }, ":queueKey": { S: QUEUE_KEY }, ":now": { S: NOW }, ":building": { S: "building" }, ":taskArn": { S: ARN } },
      ReturnValues: "NONE",
    });
    placeholdersMatch(update as Named);
    // Then the release transaction (the build is no longer running).
    expect(sent[1]).toBeInstanceOf(TransactWriteItemsCommand);
    // Refused (handed over, deploying, another task, gone): nothing more.
    const refused = stub([Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" })]);
    expect(await new DynamoLaunchRecords(refused.client, TABLE).requeueStopped("b-1", ARN, QUEUE_KEY, NOW)).toBe(false);
    expect(refused.sent).toHaveLength(1);
  });

  it("ticket 3.5 (3.4's gap): WHEN a repair or its miss count meets a claim or release in flight (TransactionConflictException) THEN the repair counts as refused, not an error", async () => {
    const conflict = () => Object.assign(new Error("x"), { name: "TransactionConflictException" });
    const { client, sent } = stub([conflict(), conflict(), conflict(), Object.assign(new Error("x"), { name: "InternalServerError" })]);
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.repairSlots({ running: 9, version: 7, misses: 0 }, 2, false)).toBe(false);
    expect(await records.repairSlots({ running: -1, version: 7, misses: 0 }, 2, true)).toBe(false);
    await expect(records.noteRepairRefused()).resolves.toBeUndefined();
    // Any other error still fails the check, as before.
    await expect(records.noteRepairRefused()).rejects.toThrow();
    expect(sent).toHaveLength(4);
  });

  it("try 2: reads the counter as missing (no claim) when it or its running is absent or not a whole number, and lists malformed slot items without a build id", async () => {
    const { client } = stub([
      {},
      { Item: { version: { N: "3" } } },
      { Item: { running: { N: "1.5" }, version: { N: "3" }, repairMisses: { N: "2" } } },
      { Item: { running: { N: "-2" }, version: { N: "4" } } },
      {
        Items: [
          { pk: { S: "BUILD_SLOTS" }, sk: { S: "COUNT" } },
          { pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#b-1" }, type: { S: "build-slot" }, buildId: { S: "b-1" } },
          { pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#b-2" } },
          { pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#b-3" }, type: { S: "other" }, buildId: { S: "b-3" } },
          { pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#b-4" }, type: { S: "build-slot" }, buildId: { S: "b-5" } },
          { pk: { S: "BUILD_SLOTS" }, sk: { S: "BUILD#../x" }, type: { S: "build-slot" }, buildId: { S: "../x" } },
          { pk: { S: "BUILD_SLOTS" }, sk: { S: "ELSE" }, running: { N: "1" } },
        ],
      },
    ]);
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.readSlots()).toEqual({ running: undefined, version: 0, misses: 0 });
    expect(await records.readSlots()).toEqual({ running: undefined, version: 3, misses: 0 });
    expect(await records.readSlots()).toEqual({ running: undefined, version: 3, misses: 2 });
    expect(await records.readSlots()).toEqual({ running: -2, version: 4, misses: 0 });
    expect(await records.listSlotHolders()).toEqual([
      { sk: "BUILD#b-1", buildId: "b-1" },
      { sk: "BUILD#b-2" },
      { sk: "BUILD#b-3" },
      { sk: "BUILD#b-4" },
      { sk: "BUILD#../x" },
      { sk: "ELSE" },
    ]);
    // The counter itself is never removed as a malformed item.
    await expect(records.removeSlotItem("COUNT")).rejects.toThrow();
  });

  it("places a queued build once, counts only entries ahead seen since the cutoff, and makes a waiting message come back after 30 seconds", async () => {
    const { client, sent } = stub([{}, {}, { Count: 2, LastEvaluatedKey: { pk: { S: "BUILD_QUEUE" }, sk: { S: "x" } } }, { Count: 1 }]);
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.enqueue("b-1", QUEUE_KEY)).toBe(true);
    await records.touchQueueEntry(QUEUE_KEY, "b-1", NOW);
    expect(await records.countAhead(QUEUE_KEY, "2026-11-24T09:58:00.000Z")).toBe(3);
    const [enqueue, touch, query] = sent.map((command) => command.input as UpdateItemCommandInput & QueryCommandInput);
    expect(enqueue?.ConditionExpression).toBe("#status = :queued AND attribute_not_exists(#queueKey)");
    expect(touch?.Key).toEqual({ pk: { S: "BUILD_QUEUE" }, sk: { S: QUEUE_KEY } });
    expect(query?.KeyConditionExpression).toBe("pk = :pk AND sk < :place");
    expect(query?.FilterExpression).toBe("#lastSeenAt >= :since");
    expect(query?.Select).toBe("COUNT");
    expect(query?.ExpressionAttributeValues).toEqual({ ":pk": { S: "BUILD_QUEUE" }, ":place": { S: QUEUE_KEY }, ":since": { S: "2026-11-24T09:58:00.000Z" } });
    const visibility: { input: unknown }[] = [];
    const sqs = { send: async (command: { input: unknown }) => visibility.push(command) } as unknown as VisibilitySender;
    await new SqsLaunchVisibility(sqs, "https://sqs/q.fifo").comeBackAfter("handle-1", 30);
    expect(visibility[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect(visibility[0]?.input).toEqual({ QueueUrl: "https://sqs/q.fifo", ReceiptHandle: "handle-1", VisibilityTimeout: 30 });
  });

  it("fails builds only in the state each case expects", async () => {
    const { client, sent } = stub();
    const records = new DynamoLaunchRecords(client, TABLE);
    await records.failStopped("b-1", ARN, ["x"], NOW);
    await records.failQueued("b-1", ["x"], NOW);
    await records.failDeploy("b-1", "Ada", COMMIT, ["x"], NOW);
    await records.failHandedOver("b-1", ARN, ["x"], NOW);
    await records.failUnrecorded("b-1", NOW, ["x"], NOW);
    // Each failure write is followed by its slot release (a transaction).
    const [stopped, queued, deploy, handedOver, unrecorded] = sent.filter((command) => command instanceof UpdateItemCommand).map((command) => command.input as UpdateItemCommandInput);
    expect(unrecorded?.ConditionExpression).toBe("#status = :building AND attribute_not_exists(#taskArn) AND #launchedAt = :claimedAt");
    expect(unrecorded?.ExpressionAttributeValues?.[":claimedAt"]).toEqual({ S: NOW });
    expect(stopped?.ConditionExpression).toBe("#status = :building AND #taskArn = :taskArn AND attribute_not_exists(#pushedCommit)");
    expect(handedOver?.ConditionExpression).toBe("#status = :building AND #taskArn = :taskArn AND attribute_exists(#pushedCommit)");
    expect(queued?.ConditionExpression).toBe("#status = :queued");
    expect(deploy?.ConditionExpression).toBe("#status IN (:building, :deploying) AND #nickname = :nickname AND #pushedCommit = :commit");
    for (const input of [stopped, queued, deploy, handedOver, unrecorded]) {
      expect(input?.UpdateExpression).toBe("SET #status = :failed, #failureReasons = :reasons, #finishedAt = :now, #updatedAt = :now");
      // Compared only, never set.
      expect(input?.UpdateExpression).not.toMatch(/#nickname|#pushedCommit|#participantId|#launchedAt/);
    }
  });

  it("refuses an unapproved or different spec version", async () => {
    const { client } = stub([{ Item: { specVersion: { N: "2" }, text: { S: "x" } } }, { Item: { specVersion: { N: "3" }, text: { S: "x" }, approvedAt: { S: NOW } } }]);
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.readApprovedSpec("p-1", 2)).toBeUndefined();
    expect(await records.readApprovedSpec("p-1", 2)).toBeUndefined();
  });
});

describe("the builder's task (criterion 2)", () => {
  it("criterion 2: WHEN the launcher starts a task THEN it names the ssd-workshop-builds cluster and the two workshop subnets with a public IP", async () => {
    const { client, sent, options } = stub([{ tasks: [{ taskArn: ARN }] }]);
    const tasks = new EcsBuildTasks(client, "arn:aws:ecs:eu-central-1:360206963848:task-definition/ssd-workshop-builder:7", "sg-0123");
    const deadline = new AbortController();
    expect(await tasks.start(START, deadline.signal)).toEqual({ taskArn: ARN });
    // RunTask is cut off with the launch's deadline (ticket 2.9 try 2).
    expect(options[0]).toEqual({ abortSignal: deadline.signal });
    expect(sent[0]).toBeInstanceOf(RunTaskCommand);
    const input = sent[0]?.input as RunTaskCommandInput;
    expect(input).toEqual({
      cluster: "ssd-workshop-builds",
      taskDefinition: "arn:aws:ecs:eu-central-1:360206963848:task-definition/ssd-workshop-builder:7",
      launchType: "FARGATE",
      count: 1,
      startedBy: "b-1",
      networkConfiguration: {
        awsvpcConfiguration: { subnets: ["subnet-05229d71b1e0b41ff", "subnet-0965bcee41d455dba"], securityGroups: ["sg-0123"], assignPublicIp: "ENABLED" },
      },
      overrides: {
        containerOverrides: [
          {
            name: "builder",
            environment: [
              { name: "BUILD_ID", value: "b-1" },
              { name: "BUILDER_GITHUB_TOKEN", value: "ghs_token" },
              { name: "BUILDER_BASE_COMMIT", value: COMMIT },
              { name: "BUILDER_ATTEMPT_ID", value: ATTEMPT },
            ],
          },
        ],
      },
      tags: [{ key: "project", value: "ssd-workshop" }],
    });
    expect(BUILDS_CLUSTER_NAME).toBe(INFRA_BUILDS_CLUSTER_NAME);
    expect(BUILDS_SUBNET_IDS).toEqual(INFRA_BUILDS_SUBNET_IDS);
    expect(BUILDER_CONTAINER_NAME).toBe(INFRA_BUILDER_CONTAINER_NAME);
  });

  it("criterion 1 (overrides): the override carries the build id, the one-repository token, the prepared commit and the attempt id only, nothing else", () => {
    const input = runTaskRequest("td", "sg", START).input;
    const environment = input.overrides?.containerOverrides?.flatMap((override) => override.environment ?? []) ?? [];
    expect(environment.map((variable) => variable.name)).toEqual(["BUILD_ID", "BUILDER_GITHUB_TOKEN", "BUILDER_BASE_COMMIT", "BUILDER_ATTEMPT_ID"]);
    expect(input.overrides?.containerOverrides?.[0]).toEqual({ name: "builder", environment });
    expect(input.overrides).toEqual({ containerOverrides: [{ name: "builder", environment }] });
  });

  it("reports no task when ECS starts none, and a task ECS no longer knows as stopped", async () => {
    const { client, sent } = stub([
      { tasks: [], failures: [{ reason: "RESOURCE:ENI" }] },
      {
        tasks: [
          { taskArn: ARN, lastStatus: "RUNNING", createdAt: new Date(NOW) },
          { taskArn: `${ARN}8`, lastStatus: "STOPPED", createdAt: new Date(NOW), stoppedAt: new Date("2026-11-24T10:05:00.000Z") },
        ],
        failures: [{ arn: `${ARN}9`, reason: "MISSING" }],
      },
    ]);
    const tasks = new EcsBuildTasks(client, "td", "sg");
    expect(await tasks.start(START)).toEqual({ failure: "RESOURCE:ENI" });
    const states = await tasks.describe([ARN, `${ARN}8`, `${ARN}9`]);
    expect(states.get(ARN)).toEqual({ stopped: false, createdAt: new Date(NOW) });
    expect(states.get(`${ARN}8`)).toEqual({ stopped: true, createdAt: new Date(NOW), stoppedAt: new Date("2026-11-24T10:05:00.000Z") });
    expect(states.get(`${ARN}9`)).toEqual({ stopped: true });
    expect((sent[1]?.input as DescribeTasksCommandInput).cluster).toBe("ssd-workshop-builds");
    expect(sent[1]).toBeInstanceOf(DescribeTasksCommand);
  });
});

describe("queue names", () => {
  it("keeps the platform's queue addresses equal to the infrastructure's", () => {
    expect(BUILD_CHECK_QUEUE_NAME).toBe(INFRA_BUILD_CHECK_QUEUE_NAME);
    expect(BUILD_DLQ_URL.endsWith(`/${BUILD_DLQ_NAME}`)).toBe(true);
    expect(DEPLOY_DLQ_URL.endsWith(`/${DEPLOY_DLQ_NAME}`)).toBe(true);
  });
});
