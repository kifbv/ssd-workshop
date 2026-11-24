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
import { describe, expect, it } from "vitest";
import {
  BUILDER_CONTAINER_NAME as INFRA_BUILDER_CONTAINER_NAME,
  BUILD_CHECK_QUEUE_NAME as INFRA_BUILD_CHECK_QUEUE_NAME,
  BUILD_DLQ_NAME,
  BUILDS_CLUSTER_NAME as INFRA_BUILDS_CLUSTER_NAME,
  BUILDS_SUBNET_IDS as INFRA_BUILDS_SUBNET_IDS,
  DEPLOY_DLQ_NAME,
  LAUNCHER_BUILD_UPDATE_ATTRIBUTES,
  LAUNCHER_LAUNCH_ATTRIBUTES,
  LAUNCHER_READ_ATTRIBUTES,
  LAUNCHES_PARTITION,
} from "../../../infra/lib/config.js";
import { LAUNCHES_PK } from "../keys.js";
import {
  BUILD_CHECK_QUEUE_NAME,
  BUILD_DLQ_URL,
  BUILDER_CONTAINER_NAME,
  BUILDS_CLUSTER_NAME,
  BUILDS_SUBNET_IDS,
  DEPLOY_DLQ_URL,
} from "../settings.js";
import { DynamoLaunchRecords, EcsBuildTasks, runTaskRequest, type LauncherTableSender, type TaskSender } from "./aws.js";

const TABLE = "ssd-workshop-data";
const NOW = "2026-11-24T10:00:00.000Z";
const ARN = "arn:aws:ecs:eu-central-1:360206963848:task/ssd-workshop-builds/0123";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ATTEMPT = "6f1c2a9e-1111-4222-8333-444455556666";
const START = { buildId: "b-1", token: "ghs_token", baseCommit: COMMIT, attemptId: ATTEMPT };

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

type Expressions = { UpdateExpression?: string; ConditionExpression?: string; ProjectionExpression?: string; KeyConditionExpression?: string };
type Named = Expressions & { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown>; Key?: Record<string, unknown>; Item?: Record<string, unknown> };

/** Every attribute name a request uses: placeholders resolved, bare names, the key's and a put item's names. */
function attributeNames(input: Named): string[] {
  const text = [input.UpdateExpression, input.ConditionExpression, input.ProjectionExpression, input.KeyConditionExpression].join(" ");
  const placeholders = (text.match(/#[A-Za-z]+/g) ?? []).map((p) => input.ExpressionAttributeNames?.[p] ?? p);
  const keywords = new Set(["SET", "REMOVE", "ADD", "DELETE", "AND", "OR", "NOT", "IN", "attribute_exists", "attribute_not_exists", "undefined"]);
  const bare = (text.replace(/[#:][A-Za-z]+/g, " ").match(/[A-Za-z_]+/g) ?? []).filter((w) => !keywords.has(w));
  return [...new Set([...placeholders, ...bare, ...Object.keys(input.Key ?? {}), ...Object.keys(input.Item ?? {})])].sort();
}

/** DynamoDB refuses an expression with an undefined or unused placeholder. */
function placeholdersMatch(input: Named): void {
  const text = [input.UpdateExpression, input.ConditionExpression, input.ProjectionExpression, input.KeyConditionExpression].join(" ");
  expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(new Set(text.match(/#[A-Za-z]+/g) ?? []));
  expect(new Set(Object.keys(input.ExpressionAttributeValues ?? {}))).toEqual(new Set(text.match(/:[A-Za-z]+/g) ?? []));
}

const pkOf = (input: Named): string => ((input.Key ?? input.Item)?.pk as { S: string }).S;

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
    expect(await records.claim("b-1", "Ada", "p-1", ATTEMPT, NOW)).toBe(true);
    await records.recordTask("b-1", ARN, NOW);
    expect(await records.failUnstarted("b-1", ["x"], NOW)).toBe(true);
    expect(await records.failStopped("b-1", ARN, ["x"], NOW)).toBe(true);
    expect(await records.failHandedOver("b-1", ARN, ["x"], NOW)).toBe(true);
    expect(await records.failQueued("b-1", ["x"], NOW)).toBe(true);
    expect(await records.failDeploy("b-1", "Ada", COMMIT, ["x"], NOW)).toBe(true);
    expect(await records.listLaunches()).toEqual([]);
    await records.removeLaunch("b-1", ARN);
    return sent;
  }

  it("reads only LAUNCHER_READ_ATTRIBUTES, consistently, with a projection (so dynamodb:Select is SPECIFIC_ATTRIBUTES)", async () => {
    const sent = await everyRequest();
    const reads = sent.filter((command) => command instanceof GetItemCommand).map((command) => command.input as GetItemCommandInput);
    expect(reads).toHaveLength(4);
    const names = new Set<string>();
    for (const input of reads) {
      placeholdersMatch(input as Named);
      expect(input.ConsistentRead).toBe(true);
      expect(input.ProjectionExpression).toBeTruthy();
      expect(pkOf(input as Named)).toMatch(/^(BUILD|PARTICIPANT)#/);
      for (const name of attributeNames(input as Named)) names.add(name);
    }
    expect([...names].sort()).toEqual([...LAUNCHER_READ_ATTRIBUTES].sort());
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
        }
      }
      if (command instanceof QueryCommand) writes.push(command.input as Named);
    }
    const build = new Set<string>();
    const launch = new Set<string>();
    for (const input of writes) {
      placeholdersMatch(input);
      const pk = (input as QueryCommandInput).KeyConditionExpression ? LAUNCHES_PK : pkOf(input);
      if (pk.startsWith("BUILD#")) for (const name of attributeNames(input)) build.add(name);
      else {
        expect(pk).toBe(LAUNCHES_PK);
        for (const name of attributeNames(input)) launch.add(name);
      }
    }
    expect([...build].sort()).toEqual([...LAUNCHER_BUILD_UPDATE_ATTRIBUTES].sort());
    expect([...launch].sort()).toEqual([...LAUNCHER_LAUNCH_ATTRIBUTES].sort());
    expect(LAUNCHES_PK).toBe(LAUNCHES_PARTITION);
  });

  it("claims only a queued build of the read nickname and participant, with its watch-list entry, in one transaction", async () => {
    const { client, sent } = stub([Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] })]);
    const records = new DynamoLaunchRecords(client, TABLE);
    expect(await records.claim("b-1", "Ada", "p-1", ATTEMPT, NOW)).toBe(false);
    const [update, put] = (sent[0] as TransactWriteItemsCommand).input.TransactItems ?? [];
    expect(update?.Update?.ConditionExpression).toBe("#status = :queued AND #nickname = :nickname AND #participantId = :participantId");
    expect(update?.Update?.UpdateExpression).toBe("SET #status = :building, #attemptId = :attemptId, #launchedAt = :now, #updatedAt = :now REMOVE #taskArn");
    expect(update?.Update?.ExpressionAttributeValues?.[":attemptId"]).toEqual({ S: ATTEMPT });
    expect(put?.Put?.Item).toEqual({ pk: { S: "LAUNCHES" }, sk: { S: "BUILD#b-1" }, type: { S: "launch" }, buildId: { S: "b-1" }, claimedAt: { S: NOW } });
    // A conflict that is not a condition is an error.
    const other = stub([Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] })]);
    await expect(new DynamoLaunchRecords(other.client, TABLE).claim("b-1", "Ada", "p-1", ATTEMPT, NOW)).rejects.toThrow();
  });

  it("fails builds only in the state each case expects", async () => {
    const { client, sent } = stub();
    const records = new DynamoLaunchRecords(client, TABLE);
    await records.failStopped("b-1", ARN, ["x"], NOW);
    await records.failQueued("b-1", ["x"], NOW);
    await records.failDeploy("b-1", "Ada", COMMIT, ["x"], NOW);
    await records.failHandedOver("b-1", ARN, ["x"], NOW);
    const [stopped, queued, deploy, handedOver] = sent.map((command) => command.input as UpdateItemCommandInput);
    expect(stopped?.ConditionExpression).toBe("#status = :building AND #taskArn = :taskArn AND attribute_not_exists(#pushedCommit)");
    expect(handedOver?.ConditionExpression).toBe("#status = :building AND #taskArn = :taskArn AND attribute_exists(#pushedCommit)");
    expect(queued?.ConditionExpression).toBe("#status = :queued");
    expect(deploy?.ConditionExpression).toBe("#status IN (:building, :deploying) AND #nickname = :nickname AND #pushedCommit = :commit");
    for (const input of [stopped, queued, deploy, handedOver]) {
      expect(input?.UpdateExpression).toBe("SET #status = :failed, #failureReasons = :reasons, #finishedAt = :now, #updatedAt = :now");
      // Compared only, never set.
      expect(input?.UpdateExpression).not.toMatch(/#nickname|#pushedCommit|#participantId/);
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
