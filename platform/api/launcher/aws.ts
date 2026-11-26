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
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type DescribeTasksCommandOutput,
  type DesiredStatus,
  type ListTasksCommandOutput,
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
  BUILD_RETRIES_PK,
  BUILD_SLOTS_PK,
  buildKey,
  conversationKey,
  launchKey,
  LAUNCHES_PK,
  messageKey,
  participantKey,
  queueEntryKey,
  retryRequestKey,
  slotCountKey,
  slotHolderKey,
  specKey,
  type ItemKey,
} from "../keys.js";
import type { WorkshopSettings } from "../workshop/settings.js";
import { readSettings } from "../workshop/store.js";
import { BUILDER_CONTAINER_NAME, BUILDS_CLUSTER_NAME, BUILDS_SUBNET_IDS, CLUSTER_LIST_MAX_PAGES } from "../settings.js";
import type { BuildStatus } from "../types.js";
import type { RepositoryRead } from "../conversation/state.js";
import { REBUILD_REQUEST } from "../workshop/texts.js";

/** Ticket 3.9: the Rebuild from my repository route's request (participant's, at step 4, the exact text and the mark). */
function isRebuildRequestItem(item: Record<string, AttributeValue> | undefined): item is Record<string, AttributeValue> {
  return item?.author?.S === "participant" && item.step?.S === "building" && item.request?.S === "rebuild-from-repo" && item.text?.S === REBUILD_REQUEST;
}
import type {
  ApprovedSpec,
  ChangeInput,
  BuildTasks,
  ClusterTask,
  ClusterTaskList,
  ClaimResult,
  DeadLetter,
  DeadLetters,
  LaunchBuild,
  LaunchEntry,
  LaunchRecords,
  RebuildRequestState,
  RetryBuildState,
  RetryRequest,
  SlotCount,
  SlotItem,
  TaskStart,
  TaskState,
} from "./launcher.js";

const str = (value: string): AttributeValue => ({ S: value });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });
const STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];

const conditionFailed = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";

/**
 * Ticket 3.5 (the gap left by 3.4): an UpdateItem of the slot counter that meets a claim or release transaction in flight
 * is refused with TransactionConflictException. For the check's repair that is a lost race like a moved version: the
 * repair counts as refused (and the miss count waits for the next minute), never an error that aborts the check.
 */
const transactionConflict = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === "TransactionConflictException";

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
    const item = await this.get(buildKey(buildId), ["nickname", "participantId", "status", "queueKey", "kind", "changeNumber", "specVersion"]);
    const nickname = item?.nickname?.S;
    const participantId = item?.participantId?.S;
    const status = item?.status?.S;
    const queueKey = item?.queueKey?.S;
    if (nickname === undefined || participantId === undefined || !(STATUSES as readonly string[]).includes(status ?? "")) return undefined;
    const changeNumber = Number(item?.changeNumber?.N);
    const specVersion = Number(item?.specVersion?.N);
    return {
      nickname,
      participantId,
      status: status as BuildStatus,
      ...(queueKey === undefined ? {} : { queueKey }),
      // Ticket 3.7: a change build, and its number and version only when they are whole numbers of 1 or more.
      ...(item?.kind?.S === "change" ? { kind: "change" as const } : {}),
      ...(Number.isInteger(changeNumber) && changeNumber >= 1 ? { changeNumber } : {}),
      ...(Number.isInteger(specVersion) && specVersion >= 1 ? { specVersion } : {}),
    };
  }

  readSettings(): Promise<WorkshopSettings> {
    return readSettings(this.client, this.table);
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
    try {
      if (force) {
        await this.client.send(
          new UpdateItemCommand({ TableName: this.table, Key: keyOf(slotCountKey()), UpdateExpression: expression, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: "NONE" }),
        );
        return true;
      }
      return await this.update(
        slotCountKey(),
        expression,
        seen.version === 0 ? "attribute_not_exists(#version)" : "#version = :seen",
        names,
        { ...values, ...(seen.version === 0 ? {} : { ":seen": { N: String(seen.version) } }) },
      );
    } catch (error) {
      if (transactionConflict(error)) return false;
      throw error;
    }
  }

  async noteRepairRefused(): Promise<void> {
    try {
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
    } catch (error) {
      // A claim or release in flight: this miss is not counted (the next refused repair counts).
      if (!transactionConflict(error)) throw error;
    }
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

  async readApprovedSpec(participantId: string, version: number): Promise<ApprovedSpec | undefined> {
    const item = await this.get(specKey(participantId, version), ["specVersion", "text", "approvedAt", "rebuildApprovedAt", "messageId", "whatChanges"]);
    if (item?.specVersion?.N !== String(version)) return undefined;
    const text = item.text?.S;
    if (text === undefined) return undefined;
    const whatChanges = (item.whatChanges?.L ?? []).flatMap((line) => (line.S === undefined ? [] : [line.S]));
    const listed = whatChanges.length > 0 ? { whatChanges } : {};
    // Approved by the participant through the conversation function (Approve spec, Build this change).
    if (item.approvedAt?.S !== undefined) return { text, ...listed };
    // Ticket 3.9 try 2: approved by Rebuild from my repository (the AI worker): built only with its request's read.
    const requestId = item.messageId?.S;
    if (item.rebuildApprovedAt?.S !== undefined && requestId !== undefined) return { text, ...listed, rebuildRequestId: requestId };
    return undefined;
  }

  /** Ticket 3.9: only the route's marked request (author, step, text and mark), with whether it is the one in flight. */
  async readRebuildRequest(participantId: string, messageId: string): Promise<RebuildRequestState | undefined> {
    const item = await this.get(messageKey(participantId, messageId), ["author", "step", "text", "status", "request", "repositoryRead", "pendingSince"]);
    if (!isRebuildRequestItem(item)) return undefined;
    const conversation = await this.get(conversationKey(participantId), ["pendingId"]);
    const since = Number(item.pendingSince?.N);
    return {
      pending: item.status?.S === "pending",
      read: item.repositoryRead?.S !== undefined,
      inFlight: conversation?.pendingId?.S === messageId,
      ...(Number.isInteger(since) ? { pendingSince: since } : {}),
    };
  }

  async readRebuildSpec(participantId: string, messageId: string): Promise<{ text: string; repository: string } | undefined> {
    const item = await this.get(messageKey(participantId, messageId), ["author", "step", "text", "request", "repositoryRead", "repositorySpec", "repositoryName"]);
    if (!isRebuildRequestItem(item) || item.repositoryRead?.S !== "found") return undefined;
    const text = item.repositorySpec?.S;
    const repository = item.repositoryName?.S;
    return text === undefined || repository === undefined ? undefined : { text, repository };
  }

  storeRepositoryRead(participantId: string, messageId: string, read: RepositoryRead): Promise<boolean> {
    const found = read.kind === "found";
    return this.update(
      messageKey(participantId, messageId),
      found ? "SET #repositoryRead = :read, #repositorySpec = :spec, #repositoryName = :repository" : "SET #repositoryRead = :read",
      "attribute_exists(#pk) AND attribute_not_exists(#repositoryRead)",
      { "#pk": "pk", "#repositoryRead": "repositoryRead", ...(found ? { "#repositorySpec": "repositorySpec", "#repositoryName": "repositoryName" } : {}) },
      { ":read": str(read.kind), ...(found ? { ":spec": str(read.text), ":repository": str(read.repository) } : {}) },
    );
  }

  setChangeInput(buildId: string, attemptId: string, input: ChangeInput, nowIso: string): Promise<boolean> {
    return this.update(
      buildKey(buildId),
      "SET #changeSpec = :spec, #changeList = :list, #updatedAt = :now",
      "#status = :building AND #attemptId = :attemptId AND attribute_not_exists(#taskArn)",
      { "#changeSpec": "changeSpec", "#changeList": "changeList", "#updatedAt": "updatedAt", "#status": "status", "#attemptId": "attemptId", "#taskArn": "taskArn" },
      {
        ":spec": str(input.spec),
        ":list": { L: input.whatChanges.map(str) },
        ":now": str(nowIso),
        ":building": str("building"),
        ":attemptId": str(attemptId),
      },
    );
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

  requeueStopped(buildId: string, taskArn: string, queueKey: string, nowIso: string): Promise<boolean> {
    // Like a failure write, it ends the build's run: its slot is freed after it.
    return this.failAndRelease(buildId, this.update(
      buildKey(buildId),
      "SET #status = :queued, #queueKey = :queueKey, #updatedAt = :now REMOVE #attemptId, #launchedAt, #taskArn, #feed",
      "#status = :building AND #taskArn = :taskArn AND attribute_not_exists(#pushedCommit)",
      {
        "#status": "status",
        "#queueKey": "queueKey",
        "#updatedAt": "updatedAt",
        "#attemptId": "attemptId",
        "#launchedAt": "launchedAt",
        "#taskArn": "taskArn",
        "#feed": "feed",
        "#pushedCommit": "pushedCommit",
      },
      { ":queued": str("queued"), ":queueKey": str(queueKey), ":now": str(nowIso), ":building": str("building"), ":taskArn": str(taskArn) },
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

  async readPaused(participantId: string): Promise<boolean> {
    return (await this.get(participantKey(participantId), ["paused"]))?.paused?.BOOL === true;
  }

  async listRetryRequests(): Promise<RetryRequest[]> {
    return (await this.queryAll(BUILD_RETRIES_PK, ["buildId", "requestedAt"])).flatMap((item): RetryRequest[] => {
      const buildId = item.buildId?.S;
      const requestedAt = item.requestedAt?.S;
      // Only a well-formed request at its own key (`BUILD#<buildId>`); anything else is left alone (and never acted on).
      if (buildId === undefined || requestedAt === undefined || !BUILD_ID_PATTERN.test(buildId) || item.sk?.S !== `BUILD#${buildId}`) return [];
      return [{ buildId, requestedAt }];
    });
  }

  async removeRetryRequest(buildId: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: keyOf(retryRequestKey(buildId)), ReturnValues: "NONE" }));
  }

  async readRetryBuild(buildId: string): Promise<RetryBuildState | undefined> {
    const item = await this.get(buildKey(buildId), ["status", "taskArn", "launchedAt", "pushedCommit"]);
    const status = item?.status?.S;
    if (!(STATUSES as readonly string[]).includes(status ?? "")) return undefined;
    const taskArn = item?.taskArn?.S;
    const launchedAt = item?.launchedAt?.S;
    return {
      status: status as BuildStatus,
      ...(taskArn === undefined ? {} : { taskArn }),
      ...(launchedAt === undefined ? {} : { launchedAt }),
      handedOver: item?.pushedCommit !== undefined,
    };
  }

  requeueFailed(buildId: string, queueKey: string, nowIso: string): Promise<boolean> {
    const removed = ["failureReasons", "finishedAt", "pushedCommit", "taskArn", "launchedAt", "attemptId", "feed"] as const;
    return this.update(
      buildKey(buildId),
      `SET #status = :queued, #queueKey = :queueKey, #updatedAt = :now REMOVE ${removed.map((name) => `#${name}`).join(", ")}`,
      "#status = :failed",
      { "#status": "status", "#queueKey": "queueKey", "#updatedAt": "updatedAt", ...Object.fromEntries(removed.map((name) => [`#${name}`, name])) },
      { ":queued": str("queued"), ":queueKey": str(queueKey), ":now": str(nowIso), ":failed": str("failed") },
    );
  }
}

/** The ECSClient methods the launcher uses. */
export interface TaskSender {
  send(command: RunTaskCommand, options?: { abortSignal?: AbortSignal }): Promise<RunTaskCommandOutput>;
  send(command: DescribeTasksCommand): Promise<DescribeTasksCommandOutput>;
  send(command: StopTaskCommand): Promise<StopTaskCommandOutput>;
  send(command: ListTasksCommand): Promise<ListTasksCommandOutput>;
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

  async stop(taskArn: string, reason = "Stopped by the build launcher"): Promise<void> {
    await this.client.send(new StopTaskCommand({ cluster: BUILDS_CLUSTER_NAME, task: taskArn, reason }));
  }

  /**
   * Ticket 3.14: the builds cluster's tasks (ListTasks of desired status RUNNING, then PENDING; each task once), described
   * 100 at a time, with the `subnetId` of each network interface attachment and when ECS created the task. A task already
   * STOPPED, or one ECS no longer knows, is left out. At most CLUSTER_LIST_MAX_PAGES pages per status (try 2, checker B:
   * the check never runs unbounded); `truncated` says the bound was hit. ListTasks needs `ecs:ListTasks` (Resource `*`,
   * condition `ecs:cluster`).
   */
  async listClusterTasks(): Promise<ClusterTaskList> {
    const seen = new Set<string>();
    let truncated = false;
    for (const desiredStatus of ["RUNNING", "PENDING"] satisfies DesiredStatus[]) {
      let nextToken: string | undefined;
      let pages = 0;
      do {
        const answer = await this.client.send(
          new ListTasksCommand({ cluster: BUILDS_CLUSTER_NAME, desiredStatus, maxResults: 100, ...(nextToken === undefined ? {} : { nextToken }) }),
        );
        pages += 1;
        for (const arn of answer.taskArns ?? []) seen.add(arn);
        nextToken = answer.nextToken;
      } while (nextToken !== undefined && pages < CLUSTER_LIST_MAX_PAGES);
      if (nextToken !== undefined) truncated = true;
    }
    const arns = [...seen];
    const tasks: ClusterTask[] = [];
    for (let i = 0; i < arns.length; i += 100) {
      const answer = await this.client.send(new DescribeTasksCommand({ cluster: BUILDS_CLUSTER_NAME, tasks: arns.slice(i, i + 100) }));
      for (const task of answer.tasks ?? []) {
        if (task.taskArn === undefined || task.lastStatus === "STOPPED") continue;
        const subnetIds = (task.attachments ?? []).flatMap((attachment) =>
          (attachment.details ?? []).flatMap((detail) => (detail.name === "subnetId" && detail.value !== undefined ? [detail.value] : [])),
        );
        tasks.push({ taskArn: task.taskArn, subnetIds, ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }) });
      }
    }
    return { tasks, truncated };
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
