/**
 * The builder's view of the table (ticket 2.8): its build record (with the live feed the step 3 page shows, ticket
 * 2.10) and the participant's usage totals. Its read is a GetItem naming only BUILDER_BUILD_READ_ATTRIBUTES; every write is an UpdateItem naming only
 * BUILDER_BUILD_UPDATE_ATTRIBUTES (in `BUILD#*`) or BUILDER_USAGE_UPDATE_ATTRIBUTES (the `USAGE` item), both in infra/lib/config.ts, for ticket 2.9's
 * `dynamodb:Attributes` condition; no call returns attributes (ReturnValues NONE). Ticket 3.4: it never touches the build
 * slots (it runs next to the AI agent): a build it marks failed is freed by the launcher's minute check.
 *
 * The feed is one list attribute `feed` on the build item: steps, written files, web fetches (the host only, ticket
 * 2.15) and commits, oldest first, each with its time. It stays small (at most MAX_FEED_FILES file events and
 * MAX_FEED_FETCHES fetch events; paths and commit lines are capped), far under DynamoDB's 400 KB item limit.
 */
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { buildKey, usageKey, type ItemKey } from "../api/keys.js";
import type { BuildStatus, TokenUsage } from "../api/types.js";

/** The steps of a build, in order; the deployer then sets the build `live` or `failed`. */
export const BUILD_STEPS = ["preparing", "writing", "checking", "committing", "deploying"] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

/** One line of the feed. `at` is ISO 8601. */
export type FeedEvent =
  | { kind: "step"; step: BuildStep; at: string }
  | { kind: "file"; path: string; at: string }
  | { kind: "fetch"; host: string; at: string }
  | { kind: "commit"; sha: string; message: string; at: string };

/** At most this many file events are kept (the first write of each path); a bigger app is still built. */
export const MAX_FEED_FILES = 200;

/** At most this many web fetch events are kept (ticket 2.15); later fetches still happen but are not shown. */
export const MAX_FEED_FETCHES = 50;

/** What the builder reads of its build. */
export interface BuildToRun {
  nickname: string;
  participantId: string;
  status: BuildStatus;
}

export interface BuildRecords {
  /** The build's nickname, participant and status, or undefined when there is no such build. */
  read(buildId: string): Promise<BuildToRun | undefined>;
  /**
   * Takes the build: only one that exists, is `building` under this launch (`attemptId`, set by the launcher's claim,
   * ticket 2.9 try 2), belongs to `nickname` and has no pushed commit yet. Sets a new feed holding `first` and removes
   * earlier failure reasons. False when refused.
   */
  claim(buildId: string, attemptId: string, nickname: string, first: FeedEvent, nowIso: string): Promise<boolean>;
  /** Appends to the feed while the build is `building` under this launch; false otherwise (it was marked failed or relaunched meanwhile). */
  addFeed(buildId: string, attemptId: string, events: readonly FeedEvent[], nowIso: string): Promise<boolean>;
  /**
   * Stores the commit the builder pushed (`pushedCommit`, the deployer's commit binding) and appends `events`, only
   * while the build is `building` under this launch and has no pushed commit. False when refused.
   */
  handOver(buildId: string, attemptId: string, commit: string, events: readonly FeedEvent[], nowIso: string): Promise<boolean>;
  /** Marks the build `failed` with `reasons`, only while it is `building` under this launch. False when refused. */
  markFailed(buildId: string, attemptId: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /** Adds tokens and cost to the participant's `USAGE` totals (atomic ADD). */
  addUsage(participantId: string, usage: TokenUsage, nowIso: string): Promise<void>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

/** A feed event as DynamoDB stores it (a map). */
export function feedValue(event: FeedEvent): AttributeValue {
  const fields: Record<string, AttributeValue> = { kind: str(event.kind), at: str(event.at) };
  if (event.kind === "step") fields.step = str(event.step);
  if (event.kind === "file") fields.path = str(event.path);
  if (event.kind === "fetch") fields.host = str(event.host);
  if (event.kind === "commit") {
    fields.sha = str(event.sha);
    fields.message = str(event.message);
  }
  return { M: fields };
}

const feedList = (events: readonly FeedEvent[]): AttributeValue => ({ L: events.map(feedValue) });

/** The methods of DynamoDBClient the builder uses. */
export interface BuilderTableSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
}

const STATUSES: readonly BuildStatus[] = ["queued", "building", "deploying", "live", "failed"];

/**
 * Every write of the runner holds only while the build is `building` under the launch that started this task (ticket
 * 2.9 try 2): a second runner for the same build (an earlier launch's task, or one started by someone else) can never
 * claim, feed, hand over or fail it.
 */
const THIS_ATTEMPT = "#status = :building AND #attemptId = :attemptId";
const attemptNames = { "#status": "status", "#attemptId": "attemptId" };
const attemptValues = (attemptId: string): Record<string, AttributeValue> => ({ ":building": str("building"), ":attemptId": str(attemptId) });

const conditionFailed = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";

export class DynamoBuildRecords implements BuildRecords {
  constructor(
    private readonly client: BuilderTableSender,
    private readonly table: string,
  ) {}

  async read(buildId: string): Promise<BuildToRun | undefined> {
    const answer = await this.client.send(
      new GetItemCommand({
        TableName: this.table,
        Key: keyOf(buildKey(buildId)),
        ConsistentRead: true,
        ProjectionExpression: "#nickname, #participantId, #status",
        ExpressionAttributeNames: { "#nickname": "nickname", "#participantId": "participantId", "#status": "status" },
      }),
    );
    const item = answer.Item;
    const nickname = item?.nickname?.S;
    const participantId = item?.participantId?.S;
    const status = item?.status?.S;
    if (nickname === undefined || participantId === undefined || !(STATUSES as readonly string[]).includes(status ?? "")) return undefined;
    return { nickname, participantId, status: status as BuildStatus };
  }

  private async update(
    key: ItemKey,
    expression: string,
    condition: string | undefined,
    names: Record<string, string>,
    values: Record<string, AttributeValue>,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: keyOf(key),
          UpdateExpression: expression,
          ...(condition === undefined ? {} : { ConditionExpression: condition }),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "NONE",
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  claim(buildId: string, attemptId: string, nickname: string, first: FeedEvent, nowIso: string): Promise<boolean> {
    return this.update(
      buildKey(buildId),
      "SET #feed = :feed, #updatedAt = :now REMOVE #failureReasons, #finishedAt",
      `attribute_exists(pk) AND #nickname = :nickname AND ${THIS_ATTEMPT} AND attribute_not_exists(#pushedCommit)`,
      {
        "#feed": "feed",
        "#updatedAt": "updatedAt",
        "#failureReasons": "failureReasons",
        "#finishedAt": "finishedAt",
        "#nickname": "nickname",
        "#pushedCommit": "pushedCommit",
        ...attemptNames,
      },
      { ":feed": feedList([first]), ":now": str(nowIso), ":nickname": str(nickname), ...attemptValues(attemptId) },
    );
  }

  addFeed(buildId: string, attemptId: string, events: readonly FeedEvent[], nowIso: string): Promise<boolean> {
    return this.update(
      buildKey(buildId),
      "SET #feed = list_append(if_not_exists(#feed, :empty), :events), #updatedAt = :now",
      `attribute_exists(pk) AND ${THIS_ATTEMPT}`,
      { "#feed": "feed", "#updatedAt": "updatedAt", ...attemptNames },
      { ":empty": { L: [] }, ":events": feedList(events), ":now": str(nowIso), ...attemptValues(attemptId) },
    );
  }

  handOver(buildId: string, attemptId: string, commit: string, events: readonly FeedEvent[], nowIso: string): Promise<boolean> {
    return this.update(
      buildKey(buildId),
      "SET #pushedCommit = :commit, #feed = list_append(if_not_exists(#feed, :empty), :events), #updatedAt = :now",
      `attribute_exists(pk) AND ${THIS_ATTEMPT} AND attribute_not_exists(#pushedCommit)`,
      { "#pushedCommit": "pushedCommit", "#feed": "feed", "#updatedAt": "updatedAt", ...attemptNames },
      { ":commit": str(commit), ":empty": { L: [] }, ":events": feedList(events), ":now": str(nowIso), ...attemptValues(attemptId) },
    );
  }

  markFailed(buildId: string, attemptId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    return this.update(
      buildKey(buildId),
      "SET #status = :failed, #failureReasons = :reasons, #finishedAt = :now, #updatedAt = :now",
      `attribute_exists(pk) AND ${THIS_ATTEMPT}`,
      { "#failureReasons": "failureReasons", "#finishedAt": "finishedAt", "#updatedAt": "updatedAt", ...attemptNames },
      { ":failed": str("failed"), ":reasons": { L: reasons.map(str) }, ":now": str(nowIso), ...attemptValues(attemptId) },
    );
  }

  async addUsage(participantId: string, usage: TokenUsage, nowIso: string): Promise<void> {
    if (usage.inputTokens + usage.outputTokens === 0) return;
    await this.update(
      usageKey(participantId),
      "SET #type = :type, #participantId = :participantId, #updatedAt = :now ADD #inputTokens :inputTokens, #outputTokens :outputTokens, #costUsd :costUsd",
      undefined,
      {
        "#type": "type",
        "#participantId": "participantId",
        "#updatedAt": "updatedAt",
        "#inputTokens": "inputTokens",
        "#outputTokens": "outputTokens",
        "#costUsd": "costUsd",
      },
      {
        ":type": str("usage"),
        ":participantId": str(participantId),
        ":now": str(nowIso),
        ":inputTokens": num(usage.inputTokens),
        ":outputTokens": num(usage.outputTokens),
        ":costUsd": num(usage.costUsd),
      },
    );
  }
}
