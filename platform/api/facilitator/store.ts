// The facilitator routes' table access (ticket 3.10). The list reads profiles, conversations, usage totals and builds
// through the table's sparse index keyed by `listType` (BY_TYPE_INDEX_NAME): a Query per type, projected, never a Scan, so the
// allow-list's keys (which hold email addresses) are never read. Every request names only what the facilitator role's
// IAM statements allow (infra/lib/config.ts FACILITATOR_INDEX_READ_ATTRIBUTES, FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES,
// RETRY_REQUEST_ATTRIBUTES; checked by ./store.test.ts).
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type PutItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { DynamoFlagDecisions } from "../flags/flags.js";
import { BUILD_ID_PATTERN, BUILD_RETRIES_PK, buildKey, conversationKey, nicknameKey, participantKey, retryRequestKey, type ItemKey } from "../keys.js";
import { BY_TYPE_INDEX_KEY, BY_TYPE_INDEX_NAME } from "../settings.js";
import type { BuildStatus } from "../types.js";
import { limitsFromItem } from "../workshop/settings.js";
import type { FacilitatorStore, RetryBuild, Roster, RosterBuild, RosterProfile } from "./facilitator.js";

/** The DynamoDBClient methods this store uses. */
export interface FacilitatorSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });
const STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];
const PARTICIPANT_PREFIX = "PARTICIPANT#";
/** A single-item write's failed condition (a transaction's is the conversation store's `conditionFailed`). */
const itemConditionFailed = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** What each type's Query projects (all in BY_TYPE_INDEX_ATTRIBUTES, plus the keys). */
export const ROSTER_PROJECTIONS = {
  participant: ["id", "nickname", "role", "group", "step", "stepSince", "createdAt", "paused", "extraBudget", "changeRequestsUsed"],
  conversation: ["pk", "buildId", "state", "pendingId"],
  usage: ["participantId", "costUsd"],
  build: ["buildId", "participantId", "status", "launchedAt", "kind", "changeNumber"],
} as const;

export class DynamoFacilitatorStore extends DynamoFlagDecisions implements FacilitatorStore {
  constructor(
    private readonly sender: FacilitatorSender,
    private readonly table: string,
  ) {
    super(sender, table);
  }

  /** Every item of one type in the index, projected (paged; the index is eventually consistent). */
  private async byType(type: keyof typeof ROSTER_PROJECTIONS): Promise<Record<string, AttributeValue>[]> {
    const names = ROSTER_PROJECTIONS[type];
    const items: Record<string, AttributeValue>[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const answer = await this.sender.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: BY_TYPE_INDEX_NAME,
          KeyConditionExpression: "#listType = :type",
          ProjectionExpression: names.map((name) => `#${name}`).join(", "),
          ExpressionAttributeNames: { "#listType": BY_TYPE_INDEX_KEY, ...Object.fromEntries(names.map((name) => [`#${name}`, name])) },
          ExpressionAttributeValues: { ":type": str(type) },
          Select: "SPECIFIC_ATTRIBUTES",
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      items.push(...(answer.Items ?? []));
      start = answer.LastEvaluatedKey;
    } while (start !== undefined);
    return items;
  }

  private async retryRequests(): Promise<Set<string>> {
    const ids = new Set<string>();
    let start: Record<string, AttributeValue> | undefined;
    do {
      const answer = await this.sender.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "#pk = :pk",
          ProjectionExpression: "#buildId",
          ExpressionAttributeNames: { "#pk": "pk", "#buildId": "buildId" },
          ExpressionAttributeValues: { ":pk": str(BUILD_RETRIES_PK) },
          Select: "SPECIFIC_ATTRIBUTES",
          ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      for (const item of answer.Items ?? []) if (item.buildId?.S !== undefined) ids.add(item.buildId.S);
      start = answer.LastEvaluatedKey;
    } while (start !== undefined);
    return ids;
  }

  async roster(): Promise<Roster> {
    const [profiles, conversations, usage, builds, retries] = await Promise.all([
      this.byType("participant"),
      this.byType("conversation"),
      this.byType("usage"),
      this.byType("build"),
      this.retryRequests(),
    ]);
    const roster: Roster = { profiles: [], conversations: new Map(), spend: new Map(), builds: new Map(), retries };
    for (const item of profiles) {
      const participantId = item.id?.S;
      if (participantId === undefined) continue;
      const limits = limitsFromItem(item);
      const text = (name: string): Partial<Record<string, string>> => (item[name]?.S === undefined ? {} : { [name]: item[name].S });
      roster.profiles.push({
        participantId,
        ...text("nickname"),
        ...text("role"),
        ...text("group"),
        ...text("step"),
        ...text("stepSince"),
        ...text("createdAt"),
        paused: limits.paused,
        extraBudget: limits.extraBudget,
        changeRequestsUsed: limits.changeRequestsUsed,
      } as RosterProfile);
    }
    for (const item of conversations) {
      const pk = item.pk?.S;
      if (pk === undefined || !pk.startsWith(PARTICIPANT_PREFIX)) continue;
      roster.conversations.set(pk.slice(PARTICIPANT_PREFIX.length), {
        ...(item.buildId?.S === undefined ? {} : { buildId: item.buildId.S }),
        ...(item.state?.S === undefined ? {} : { state: item.state.S }),
        ...(item.pendingId?.S === undefined ? {} : { pendingId: item.pendingId.S }),
      });
    }
    for (const item of usage) {
      const participantId = item.participantId?.S;
      const cost = Number(item.costUsd?.N ?? 0);
      if (participantId !== undefined) roster.spend.set(participantId, Number.isFinite(cost) ? cost : 0);
    }
    for (const item of builds) {
      const buildId = item.buildId?.S;
      const participantId = item.participantId?.S;
      const status = item.status?.S;
      if (buildId === undefined || participantId === undefined || !(STATUSES as readonly string[]).includes(status ?? "")) continue;
      const changeNumber = Number(item.changeNumber?.N);
      const build: RosterBuild = {
        participantId,
        status: status as BuildStatus,
        ...(item.launchedAt?.S === undefined ? {} : { launchedAt: item.launchedAt.S }),
        ...(item.kind?.S === "change" ? { kind: "change" as const } : {}),
        ...(Number.isInteger(changeNumber) && changeNumber >= 1 ? { changeNumber } : {}),
      };
      roster.builds.set(buildId, build);
    }
    return roster;
  }

  async findParticipantId(nickname: string): Promise<string | undefined> {
    const answer = await this.sender.send(
      new GetItemCommand({
        TableName: this.table,
        Key: keyOf(nicknameKey(nickname)),
        ConsistentRead: true,
        ProjectionExpression: "#participantId",
        ExpressionAttributeNames: { "#participantId": "participantId" },
      }),
    );
    return answer.Item?.participantId?.S;
  }

  async getProfileRole(participantId: string): Promise<string | undefined> {
    const answer = await this.sender.send(
      new GetItemCommand({
        TableName: this.table,
        Key: keyOf(participantKey(participantId)),
        ConsistentRead: true,
        ProjectionExpression: "#role",
        ExpressionAttributeNames: { "#role": "role" },
      }),
    );
    return answer.Item?.role?.S;
  }

  async getRetryBuild(buildId: string): Promise<RetryBuild | undefined> {
    if (!BUILD_ID_PATTERN.test(buildId)) return undefined;
    const answer = await this.sender.send(
      new GetItemCommand({
        TableName: this.table,
        Key: keyOf(buildKey(buildId)),
        ConsistentRead: true,
        ProjectionExpression: "#participantId, #status, #launchedAt",
        ExpressionAttributeNames: { "#participantId": "participantId", "#status": "status", "#launchedAt": "launchedAt" },
      }),
    );
    const participantId = answer.Item?.participantId?.S;
    const status = answer.Item?.status?.S;
    if (participantId === undefined || !(STATUSES as readonly string[]).includes(status ?? "")) return undefined;
    const launchedAt = answer.Item?.launchedAt?.S;
    return { participantId, status: status as BuildStatus, ...(launchedAt === undefined ? {} : { launchedAt }) };
  }

  async setPaused(participantId: string, paused: boolean): Promise<boolean> {
    try {
      await this.sender.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: keyOf(participantKey(participantId)),
          UpdateExpression: "SET #paused = :paused",
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#paused": "paused", "#pk": "pk" },
          ExpressionAttributeValues: { ":paused": { BOOL: paused } },
          ReturnValues: "NONE",
        }),
      );
      return true;
    } catch (error) {
      if (itemConditionFailed(error)) return false;
      throw error;
    }
  }

  async addBudget(participantId: string, dollars: number): Promise<number | undefined> {
    try {
      // One atomic ADD per press (two quick presses add twice, as pressed); only the new value of `extraBudget` comes back.
      const answer = await this.sender.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: keyOf(participantKey(participantId)),
          UpdateExpression: "ADD #extraBudget :step",
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#extraBudget": "extraBudget", "#pk": "pk" },
          ExpressionAttributeValues: { ":step": { N: String(dollars) } },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      return limitsFromItem(answer.Attributes).extraBudget;
    } catch (error) {
      if (itemConditionFailed(error)) return undefined;
      throw error;
    }
  }

  async requestRetry(buildId: string, participantId: string, nowIso: string): Promise<void> {
    // The request (a second press replaces it with a new time), then the conversation's note for the page.
    await this.sender.send(
      new PutItemCommand({
        TableName: this.table,
        Item: { ...keyOf(retryRequestKey(buildId)), type: str("build-retry"), buildId: str(buildId), requestedAt: str(nowIso) },
        ReturnValues: "NONE",
      }),
    );
    try {
      await this.sender.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: keyOf(conversationKey(participantId)),
          UpdateExpression: "SET #updatedAt = :now",
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#updatedAt": "updatedAt", "#pk": "pk" },
          ExpressionAttributeValues: { ":now": str(nowIso) },
          ReturnValues: "NONE",
        }),
      );
    } catch (error) {
      if (!itemConditionFailed(error)) throw error;
    }
  }
}
