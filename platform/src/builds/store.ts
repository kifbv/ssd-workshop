// `npm run builds` on AWS (ticket 2.9), with the caller's own credentials: the table, the launch queue and the build
// tasks. Run by Franck only (the access stack denies Claude sessions every send to `ssd-workshop-builds*`).
import {
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
  type AttributeValue,
  type GetItemCommandOutput,
  type ScanCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { DescribeTasksCommand, ListTasksCommand, type DescribeTasksCommandOutput, type ListTasksCommandOutput } from "@aws-sdk/client-ecs";
import { SendMessageCommand, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import { buildKey, conversationKey, nicknameKey, type ItemKey } from "../../api/keys.js";
import { BUILDS_CLUSTER_NAME } from "../../api/settings.js";
import type { BuildStatus } from "../../api/types.js";
import type { BuildSummary, BuildsStore, LaunchQueue, RetryBuild, TaskWatch } from "./command.js";

const str = (value: string): AttributeValue => ({ S: value });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });
const STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];
const statusOf = (value: string | undefined): BuildStatus | undefined => (STATUSES as readonly string[]).includes(value ?? "") ? (value as BuildStatus) : undefined;

export interface BuildsTableSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: ScanCommand): Promise<ScanCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
}

/** What a retry removes from the build, so the launcher and the builder take it as new. */
export const REQUEUE_REMOVED = ["failureReasons", "finishedAt", "pushedCommit", "deployedCommit", "taskArn", "launchedAt", "attemptId", "feed"] as const;

export class DynamoBuildsStore implements BuildsStore {
  constructor(
    private readonly client: BuildsTableSender,
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

  async listBuilds(): Promise<BuildSummary[]> {
    const builds: BuildSummary[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const answer = await this.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "#type = :build AND begins_with(pk, :prefix)",
          ProjectionExpression: "#buildId, #nickname, #status, #createdAt",
          ExpressionAttributeNames: { "#type": "type", "#buildId": "buildId", "#nickname": "nickname", "#status": "status", "#createdAt": "createdAt" },
          ExpressionAttributeValues: { ":build": str("build"), ":prefix": str("BUILD#") },
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      for (const item of answer.Items ?? []) {
        const buildId = item.buildId?.S;
        const nickname = item.nickname?.S;
        const status = statusOf(item.status?.S);
        if (buildId === undefined || nickname === undefined || status === undefined) continue;
        const createdAt = item.createdAt?.S;
        builds.push({ buildId, nickname, status, ...(createdAt === undefined ? {} : { createdAt }) });
      }
      start = answer.LastEvaluatedKey;
    } while (start !== undefined);
    return builds;
  }

  async findParticipantId(nickname: string): Promise<string | undefined> {
    return (await this.get(nicknameKey(nickname), ["participantId"]))?.participantId?.S;
  }

  async readConversationBuildId(participantId: string): Promise<string | undefined> {
    return (await this.get(conversationKey(participantId), ["buildId"]))?.buildId?.S;
  }

  async readBuild(buildId: string): Promise<RetryBuild | undefined> {
    const item = await this.get(buildKey(buildId), ["nickname", "participantId", "status", "taskArn"]);
    const nickname = item?.nickname?.S;
    const participantId = item?.participantId?.S;
    const status = statusOf(item?.status?.S);
    if (nickname === undefined || participantId === undefined || status === undefined) return undefined;
    const taskArn = item?.taskArn?.S;
    return { nickname, participantId, status, ...(taskArn === undefined ? {} : { taskArn }) };
  }

  async requeue(buildId: string, from: BuildStatus, nowIso: string): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: keyOf(buildKey(buildId)),
          UpdateExpression: `SET #status = :queued, #updatedAt = :now REMOVE ${REQUEUE_REMOVED.map((name) => `#${name}`).join(", ")}`,
          ConditionExpression: "#status = :from",
          ExpressionAttributeNames: {
            "#status": "status",
            "#updatedAt": "updatedAt",
            ...Object.fromEntries(REQUEUE_REMOVED.map((name) => [`#${name}`, name])),
          },
          ExpressionAttributeValues: { ":queued": str("queued"), ":now": str(nowIso), ":from": str(from) },
          ReturnValues: "NONE",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}

export interface LaunchSender {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
}

export class SqsLaunchQueue implements LaunchQueue {
  constructor(
    private readonly client: LaunchSender,
    private readonly queueUrl: string,
  ) {}

  async send(buildId: string, participantId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify({ buildId }), MessageGroupId: participantId, MessageDeduplicationId: deduplicationId }),
    );
  }
}

export interface TaskReader {
  send(command: DescribeTasksCommand): Promise<DescribeTasksCommandOutput>;
  send(command: ListTasksCommand): Promise<ListTasksCommandOutput>;
}

export class EcsTaskWatch implements TaskWatch {
  constructor(private readonly client: TaskReader) {}

  async isStopped(taskArn: string): Promise<boolean> {
    const answer = await this.client.send(new DescribeTasksCommand({ cluster: BUILDS_CLUSTER_NAME, tasks: [taskArn] }));
    const task = answer.tasks?.find((t) => t.taskArn === taskArn);
    return task === undefined || task.lastStatus === "STOPPED";
  }

  async runningTasks(buildId: string): Promise<number> {
    // startedBy must be the only filter (ECS); the desired status defaults to RUNNING. One page holds up to 100 tasks:
    // any at all is enough to refuse.
    const answer = await this.client.send(new ListTasksCommand({ cluster: BUILDS_CLUSTER_NAME, startedBy: buildId }));
    return answer.taskArns?.length ?? 0;
  }
}
