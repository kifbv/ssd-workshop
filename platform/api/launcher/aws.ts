/**
 * The launcher's outside world on AWS (ticket 2.9): the table (DynamoDB), the builder's tasks (ECS), the two
 * dead-letter queues (SQS) and (ticket 3.4) the launch queue's message visibility. Every table request names only the
 * attribute lists its IAM statements allow (infra/lib/config.ts LAUNCHER_READ_ATTRIBUTES, LAUNCHER_BUILD_UPDATE_ATTRIBUTES,
 * LAUNCHER_LAUNCH_ATTRIBUTES, LAUNCHER_SLOT_ATTRIBUTES, LAUNCHER_QUEUE_ATTRIBUTES, SETTINGS_READ_ATTRIBUTES; checked
 * both ways by ./aws.test.ts) and returns no attributes (ReturnValues NONE).
 */
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItemsCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type DescribeTasksCommandOutput,
  type RunTaskCommandOutput,
  type StopTaskCommandOutput,
} from "@aws-sdk/client-ecs";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type ChangeMessageVisibilityCommandOutput,
  type DeleteMessageCommandOutput,
  type ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import { cancellationCodes, countQueuedAhead, releaseSlot, releaseSlotQuietly, slotCountChange } from "../build/slots.js";
import {
  BUILD_ID_PATTERN,
  BUILD_QUEUE_PK,
  BUILD_SLOTS_PK,
  buildKey,
  conversationKey,
  launchKey,
  LAUNCHES_PK,
  participantKey,
  queueEntryKey,
  slotCountKey,
  slotHolderKey,
  specKey,
  type ItemKey,
} from "../keys.js";
import { readSettings } from "../workshop/store.js";
import { BUILDER_CONTAINER_NAME, BUILDS_CLUSTER_NAME, BUILDS_SUBNET_IDS } from "../settings.js";
import type { BuildStatus } from "../types.js";
import type { BuildTasks, ClaimResult, DeadLetter, DeadLetters, LaunchBuild, LaunchEntry, LaunchRecords, SlotCount, SlotItem, TaskStart, TaskState } from "./launcher.js";

const str = (value: string): AttributeValue => ({ S: value });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });
const STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];

const conditionFailed = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";


/** The DynamoDBClient methods the launcher uses. */
export interface LauncherTableSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

/** The fixed failure write of a build: status, reasons and times. */
const FAILED_SET = "SET #status = :failed, #failureReasons = :reasons, #finishedAt = :now, #updatedAt = :now";
const failedNames = { "#status": "status", "#failureReasons": "failureReasons", "#finishedAt": "finishedAt", "#updatedAt": "updatedAt" };
const failedValues = (reasons: readonly string[], nowIso: string): Record<string, AttributeValue> => ({
  ":failed": str("failed"),
  ":reasons": { L: reasons.map(str) },
  ":now": str(nowIso),
});

export class DynamoLaunchRecords implements LaunchRecords {
  constructor(
    private readonly client: LauncherTableSender,
    private readonly table: string,
  ) {}

  private async get(key: ItemKey, names: readonly string[]): Promise<Record<string, AttributeValue> | undefined> {
    const answer = await this.client.send(
      new GetItemCommand({
        TableName: this.table,
        Key: keyOf(key),
        ConsistentRead: true,
        ProjectionExpression: names.map((name) => `#${name}`).join(", "),
        ExpressionAttributeNames: Object.fromEntries(names.map((name) => [`#${name}`, name])),
      }),
    );
    return answer.Item;
  }

  /** An UpdateItem with a condition; false when the condition failed. */
  private async update(
    key: ItemKey,
    expression: string,
    condition: string,
    names: Record<string, string>,
    values: Record<string, AttributeValue> | undefined,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: keyOf(key),
          UpdateExpression: expression,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ...(values === undefined ? {} : { ExpressionAttributeValues: values }),
          ReturnValues: "NONE",
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async readBuild(buildId: string): Promise<LaunchBuild | undefined> {
    const item = await this.get(buildKey(buildId), ["nickname", "participantId", "status", "queueKey"]);
    const nickname = item?.nickname?.S;
    const participantId = item?.participantId?.S;
    const status = item?.status?.S;
    const queueKey = item?.queueKey?.S;
    if (nickname === undefined || participantId === undefined || !(STATUSES as readonly string[]).includes(status ?? "")) return undefined;
    return { nickname, participantId, status: status as BuildStatus, ...(queueKey === undefined ? {} : { queueKey }) };
  }

  async readBuildsAtOnce(): Promise<number> {
    return (await readSettings(this.client, this.table)).buildsAtOnce;
  }

  enqueue(buildId: string, queueKey: string): Promise<boolean> {
    return this.update(
      buildKey(buildId),
      "SET #queueKey = :queueKey",
      "#status = :queued AND attribute_not_exists(#queueKey)",
      { "#queueKey": "queueKey", "#status": "status" },
      { ":queueKey": str(queueKey), ":queued": str("queued") },
    );
  }

  async touchQueueEntry(queueKey: string, buildId: string, nowIso: string): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: keyOf(queueEntryKey(queueKey)),
        UpdateExpression: "SET #type = :type, #buildId = :buildId, #lastSeenAt = :now",
        ExpressionAttributeNames: { "#type": "type", "#buildId": "buildId", "#lastSeenAt": "lastSeenAt" },
        ExpressionAttributeValues: { ":type": str("queued-build"), ":buildId": str(buildId), ":now": str(nowIso) },
        ReturnValues: "NONE",
      }),
    );
  }

  countAhead(queueKey: string, sinceIso: string): Promise<number> {
    return countQueuedAhead(this.client, this.table, queueKey, sinceIso);
  }

  async readSlots(): Promise<SlotCount> {
    const item = await this.get(slotCountKey(), ["running", "version", "repairMisses"]);
    const whole = (value: AttributeValue | undefined): number | undefined => {
      const n = value?.N === undefined ? Number.NaN : Number(value.N);
      return Number.isSafeInteger(n) ? n : undefined;
    };
    return { running: whole(item?.running), version: whole(item?.version) ?? 0, misses: Math.max(0, whole(item?.repairMisses) ?? 0) };
  }

  async listSlotHolders(): Promise<SlotItem[]> {
    return (await this.queryAll(BUILD_SLOTS_PK, ["type", "buildId"])).flatMap((item): SlotItem[] => {
      const sk = item.sk?.S;
      if (sk === undefined || sk === slotCountKey().sk) return [];
      const buildId = item.buildId?.S;
      const wellFormed = item.type?.S === "build-slot" && buildId !== undefined && BUILD_ID_PATTERN.test(buildId) && slotHolderKey(buildId).sk === sk;
      return [wellFormed ? { sk, buildId } : { sk }];
    });
  }

  async removeSlotItem(sk: string): Promise<void> {
    if (sk === slotCountKey().sk) throw Object.assign(new Error("not a slot item"), { name: "NotASlotItem" });
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: keyOf({ pk: BUILD_SLOTS_PK, sk }), ReturnValues: "NONE" }));
  }

  releaseSlot(buildId: string): Promise<boolean> {
    return releaseSlot(this.client, this.table, buildId);
  }

  async repairSlots(seen: SlotCount, running: number, force: boolean): Promise<boolean> {
    const expression = "SET #running = :running, #repairMisses = :zero ADD #version :one";
    const names = { "#running": "running", "#repairMisses": "repairMisses", "#version": "version" };
    const values = { ":running": { N: String(running) }, ":zero": { N: "0" }, ":one": { N: "1" } };
    if (force) {
      await this.client.send(
        new UpdateItemCommand({ TableName: this.table, Key: keyOf(slotCountKey()), UpdateExpression: expression, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: "NONE" }),
      );
      return true;
    }
    return this.update(
      slotCountKey(),
      expression,
      seen.version === 0 ? "attribute_not_exists(#version)" : "#version = :seen",
      names,
      { ...values, ...(seen.version === 0 ? {} : { ":seen": { N: String(seen.version) } }) },
    );
  }

  async noteRepairRefused(): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: keyOf(slotCountKey()),
        UpdateExpression: "ADD #repairMisses :one",
        ExpressionAttributeNames: { "#repairMisses": "repairMisses" },
        ExpressionAttributeValues: { ":one": { N: "1" } },
        ReturnValues: "NONE",
      }),
    );
  }

  async listQueueEntries(): Promise<{ queueKey: string; buildId: string }[]> {
    return (await this.queryAll(BUILD_QUEUE_PK, ["buildId"])).flatMap((item) =>
      item.sk?.S !== undefined && item.buildId?.S !== undefined ? [{ queueKey: item.sk.S, buildId: item.buildId.S }] : [],
    );
  }

  async removeQueueEntry(queueKey: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: keyOf(queueEntryKey(queueKey)), ReturnValues: "NONE" }));
  }

  /** Every item of a partition (consistent), with the key and `names` (a projection: `Select` SPECIFIC_ATTRIBUTES, which IAM requires). */
  private async queryAll(pk: string, names: readonly string[]): Promise<Record<string, AttributeValue>[]> {
    const items: Record<string, AttributeValue>[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const answer = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ProjectionExpression: ["pk", "sk", ...names].map((name) => `#${name}`).join(", "),
          ExpressionAttributeNames: Object.fromEntries(["pk", "sk", ...names].map((name) => [`#${name}`, name])),
          ExpressionAttributeValues: { ":pk": str(pk) },
          Select: "SPECIFIC_ATTRIBUTES",
          ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      items.push(...(answer.Items ?? []));
      start = answer.LastEvaluatedKey;
    } while (start !== undefined);
    return items;
  }

  /** A failure write, then (ticket 3.4) the build's slot freed: a failed release is left to the check. */
  private async failAndRelease(buildId: string, failed: Promise<boolean>): Promise<boolean> {
    if (!(await failed)) return false;
    await releaseSlotQuietly(this.client, this.table, buildId);
    return true;
  }

  async readProfileNickname(participantId: string): Promise<string | undefined> {
    return (await this.get(participantKey(participantId), ["nickname"]))?.nickname?.S;
  }

  async readConversation(participantId: string): Promise<{ buildId?: string; approvedSpecVersion?: number }> {
    const item = await this.get(conversationKey(participantId), ["buildId", "approvedSpecVersion"]);
    const buildId = item?.buildId?.S;
    const version = Number(item?.approvedSpecVersion?.N);
    return {
      ...(buildId === undefined ? {} : { buildId }),
      ...(Number.isInteger(version) && version > 0 ? { approvedSpecVersion: version } : {}),
    };
  }

  async readApprovedSpec(participantId: string, version: number): Promise<string | undefined> {
    const item = await this.get(specKey(participantId, version), ["specVersion", "text", "approvedAt"]);
    if (item?.specVersion?.N !== String(version) || item.approvedAt?.S === undefined) return undefined;
    return item.text?.S;
  }

  async claim(buildId: string, nickname: string, participantId: string, attemptId: string, nowIso: string, slot: { cap: number; queueKey: string }): Promise<ClaimResult> {
    const launch = launchKey(buildId);
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: keyOf(buildKey(buildId)),
                UpdateExpression: "SET #status = :building, #attemptId = :attemptId, #launchedAt = :now, #updatedAt = :now REMOVE #taskArn, #queueKey",
                ConditionExpression: "#status = :queued AND #nickname = :nickname AND #participantId = :participantId",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#attemptId": "attemptId",
                  "#launchedAt": "launchedAt",
                  "#updatedAt": "updatedAt",
                  "#taskArn": "taskArn",
                  "#queueKey": "queueKey",
                  "#nickname": "nickname",
                  "#participantId": "participantId",
                },
                ExpressionAttributeValues: {
                  ":building": str("building"),
                  ":queued": str("queued"),
                  ":attemptId": str(attemptId),
                  ":now": str(nowIso),
                  ":nickname": str(nickname),
                  ":participantId": str(participantId),
                },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...keyOf(launch), type: str("launch"), buildId: str(buildId), claimedAt: str(nowIso) },
              },
            },
            // Ticket 3.4: the slot. The counter goes up only while it exists and is between 0 and the cap: a missing or
            // negative counter is full until the minute check repairs it (try 2).
            {
              Update: {
                TableName: this.table,
                Key: keyOf(slotCountKey()),
                ...slotCountChange(1),
                ConditionExpression: "attribute_exists(#running) AND #running >= :zero AND #running < :cap",
                ExpressionAttributeValues: { ...slotCountChange(1).ExpressionAttributeValues, ":zero": { N: "0" }, ":cap": { N: String(slot.cap) } },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...keyOf(slotHolderKey(buildId)), type: str("build-slot"), buildId: str(buildId), heldSince: str(nowIso) },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            { Delete: { TableName: this.table, Key: keyOf(queueEntryKey(slot.queueKey)) } },
          ],
        }),
      );
      return "claimed";
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes === undefined) throw error;
      // The build is no longer queued (or changed): a duplicate. Otherwise the counter was at the cap (or missing or
      // negative), another write to it won the race (TransactionConflict), or an item at this build's holder key (an
      // earlier holder not freed yet, or a malformed item) is still there: wait for a slot; the check clears the last two.
      if (codes[0] === "ConditionalCheckFailed") return "taken";
      if (codes.every((code) => code === undefined || code === "None" || code === "ConditionalCheckFailed" || code === "TransactionConflict")) return "no-slot";
      throw error;
    }
  }

  async recordTask(buildId: string, taskArn: string, nowIso: string): Promise<void> {
    // The watch list first: it is what the check uses.
    const watched = await this.update(
      launchKey(buildId),
      "SET #taskArn = :taskArn",
      "attribute_exists(pk) AND attribute_not_exists(#taskArn)",
      { "#taskArn": "taskArn" },
      { ":taskArn": str(taskArn) },
    );
    if (!watched) throw Object.assign(new Error("launch entry gone"), { name: "LaunchEntryGone" });
    await this.update(buildKey(buildId), "SET #taskArn = :taskArn, #updatedAt = :now", "attribute_exists(pk)", { "#taskArn": "taskArn", "#updatedAt": "updatedAt" }, {
      ":taskArn": str(taskArn),
      ":now": str(nowIso),
    });
  }

  async failUnstarted(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const failed = await this.failAndRelease(buildId, this.update(
      buildKey(buildId),
      FAILED_SET,
      "#status = :building AND attribute_not_exists(#taskArn)",
      { ...failedNames, "#taskArn": "taskArn" },
      { ...failedValues(reasons, nowIso), ":building": str("building") },
    ));
    await this.removeLaunch(buildId, undefined);
    return failed;
  }

  failUnrecorded(buildId: string, claimedAt: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    return this.failAndRelease(buildId, this.update(
      buildKey(buildId),
      FAILED_SET,
      "#status = :building AND attribute_not_exists(#taskArn) AND #launchedAt = :claimedAt",
      { ...failedNames, "#taskArn": "taskArn", "#launchedAt": "launchedAt" },
      { ...failedValues(reasons, nowIso), ":building": str("building"), ":claimedAt": str(claimedAt) },
    ));
  }

  failStopped(buildId: string, taskArn: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    return this.failAndRelease(buildId, this.update(
      buildKey(buildId),
      FAILED_SET,
      "#status = :building AND #taskArn = :taskArn AND attribute_not_exists(#pushedCommit)",
      { ...failedNames, "#taskArn": "taskArn", "#pushedCommit": "pushedCommit" },
      { ...failedValues(reasons, nowIso), ":building": str("building"), ":taskArn": str(taskArn) },
    ));
  }

  failHandedOver(buildId: string, taskArn: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    return this.failAndRelease(buildId, this.update(
      buildKey(buildId),
      FAILED_SET,
      "#status = :building AND #taskArn = :taskArn AND attribute_exists(#pushedCommit)",
      { ...failedNames, "#taskArn": "taskArn", "#pushedCommit": "pushedCommit" },
      { ...failedValues(reasons, nowIso), ":building": str("building"), ":taskArn": str(taskArn) },
    ));
  }

  failQueued(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    return this.failAndRelease(buildId, this.update(buildKey(buildId), FAILED_SET, "#status = :queued", failedNames, { ...failedValues(reasons, nowIso), ":queued": str("queued") }));
  }

  failDeploy(buildId: string, nickname: string, commit: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    return this.failAndRelease(buildId, this.update(
      buildKey(buildId),
      FAILED_SET,
      "#status IN (:building, :deploying) AND #nickname = :nickname AND #pushedCommit = :commit",
      { ...failedNames, "#nickname": "nickname", "#pushedCommit": "pushedCommit" },
      { ...failedValues(reasons, nowIso), ":building": str("building"), ":deploying": str("deploying"), ":nickname": str(nickname), ":commit": str(commit) },
    ));
  }

  async listLaunches(): Promise<LaunchEntry[]> {
    const entries: LaunchEntry[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const answer = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ProjectionExpression: "#buildId, #taskArn, #claimedAt",
          ExpressionAttributeNames: { "#buildId": "buildId", "#taskArn": "taskArn", "#claimedAt": "claimedAt" },
          ExpressionAttributeValues: { ":pk": str(LAUNCHES_PK) },
          ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      for (const item of answer.Items ?? []) {
        const buildId = item.buildId?.S;
        const claimedAt = item.claimedAt?.S;
        if (buildId === undefined || claimedAt === undefined) continue;
        const taskArn = item.taskArn?.S;
        entries.push({ buildId, claimedAt, ...(taskArn === undefined ? {} : { taskArn }) });
      }
      start = answer.LastEvaluatedKey;
    } while (start !== undefined);
    return entries;
  }

  async removeLaunch(buildId: string, taskArn: string | undefined): Promise<void> {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.table,
          Key: keyOf(launchKey(buildId)),
          ConditionExpression: taskArn === undefined ? "attribute_not_exists(#taskArn)" : "#taskArn = :taskArn",
          ExpressionAttributeNames: { "#taskArn": "taskArn" },
          ...(taskArn === undefined ? {} : { ExpressionAttributeValues: { ":taskArn": str(taskArn) } }),
          ReturnValues: "NONE",
        }),
      );
    } catch (error) {
      if (!conditionFailed(error)) throw error;
    }
  }
}

/** The ECSClient methods the launcher uses. */
export interface TaskSender {
  send(command: RunTaskCommand, options?: { abortSignal?: AbortSignal }): Promise<RunTaskCommandOutput>;
  send(command: DescribeTasksCommand): Promise<DescribeTasksCommandOutput>;
  send(command: StopTaskCommand): Promise<StopTaskCommandOutput>;
}

/**
 * The RunTask request (exported for its test): the builds cluster, the deployed task definition, Fargate, the two
 * workshop subnets with the builds security group and a public IP (the subnets have no NAT gateway), the build id, its
 * one-repository token, the commit the launcher prepared and the launch's attempt id as the container's only overrides,
 * `startedBy` the build id (so `npm run builds -- retry` finds every task of the build with ListTasks, ticket 2.9 try 2),
 * and the project tag.
 */
export function runTaskRequest(taskDefinitionArn: string, securityGroupId: string, start: TaskStart): RunTaskCommand {
  return new RunTaskCommand({
    cluster: BUILDS_CLUSTER_NAME,
    taskDefinition: taskDefinitionArn,
    launchType: "FARGATE",
    count: 1,
    startedBy: start.buildId,
    networkConfiguration: {
      awsvpcConfiguration: { subnets: [...BUILDS_SUBNET_IDS], securityGroups: [securityGroupId], assignPublicIp: "ENABLED" },
    },
    overrides: {
      containerOverrides: [
        {
          name: BUILDER_CONTAINER_NAME,
          environment: [
            { name: "BUILD_ID", value: start.buildId },
            { name: "BUILDER_GITHUB_TOKEN", value: start.token },
            { name: "BUILDER_BASE_COMMIT", value: start.baseCommit },
            { name: "BUILDER_ATTEMPT_ID", value: start.attemptId },
          ],
        },
      ],
    },
    tags: [{ key: "project", value: "ssd-workshop" }],
  });
}

export class EcsBuildTasks implements BuildTasks {
  constructor(
    private readonly client: TaskSender,
    private readonly taskDefinitionArn: string,
    private readonly securityGroupId: string,
  ) {}

  async start(start: TaskStart, signal?: AbortSignal): Promise<{ taskArn: string } | { failure: string }> {
    const request = runTaskRequest(this.taskDefinitionArn, this.securityGroupId, start);
    const answer = await (signal === undefined ? this.client.send(request) : this.client.send(request, { abortSignal: signal }));
    const taskArn = answer.tasks?.[0]?.taskArn;
    if (taskArn === undefined) return { failure: answer.failures?.[0]?.reason ?? "no task" };
    return { taskArn };
  }

  async describe(taskArns: readonly string[]): Promise<Map<string, TaskState>> {
    const states = new Map<string, TaskState>();
    for (let i = 0; i < taskArns.length; i += 100) {
      const answer = await this.client.send(new DescribeTasksCommand({ cluster: BUILDS_CLUSTER_NAME, tasks: taskArns.slice(i, i + 100) }));
      for (const task of answer.tasks ?? []) {
        if (task.taskArn === undefined) continue;
        states.set(task.taskArn, {
          stopped: task.lastStatus === "STOPPED",
          ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
          ...(task.stoppedAt === undefined ? {} : { stoppedAt: task.stoppedAt }),
        });
      }
      // ECS forgets stopped tasks after about an hour: a task it reports MISSING has stopped.
      for (const failure of answer.failures ?? []) {
        if (failure.arn !== undefined && failure.reason === "MISSING") states.set(failure.arn, { stopped: true });
      }
    }
    return states;
  }

  async stop(taskArn: string): Promise<void> {
    await this.client.send(new StopTaskCommand({ cluster: BUILDS_CLUSTER_NAME, task: taskArn, reason: "Stopped by the build launcher" }));
  }
}

/** The SQSClient method the launch uses to make a waiting build's message come back (ticket 3.4). */
export interface VisibilitySender {
  send(command: ChangeMessageVisibilityCommand): Promise<ChangeMessageVisibilityCommandOutput>;
}

/** The launch queue: a waiting build's message becomes visible again after `seconds` (instead of the queue's 150). */
export class SqsLaunchVisibility {
  constructor(
    private readonly client: VisibilitySender,
    private readonly queueUrl: string,
  ) {}

  async comeBackAfter(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  }
}

/** The SQSClient methods the check uses. */
export interface DeadLetterSender {
  send(command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput>;
  send(command: DeleteMessageCommand): Promise<DeleteMessageCommandOutput>;
}

export class SqsDeadLetters implements DeadLetters {
  constructor(
    private readonly client: DeadLetterSender,
    private readonly queueUrl: string,
  ) {}

  async receive(): Promise<DeadLetter[]> {
    const answer = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 60 }));
    return (answer.Messages ?? []).flatMap((message) => (message.ReceiptHandle === undefined ? [] : [{ body: message.Body, receiptHandle: message.ReceiptHandle }]));
  }

  async remove(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }
}
