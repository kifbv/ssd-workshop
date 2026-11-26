// Ticket 2.8: the builder's DynamoDB and SQS requests, checked against the attribute lists ticket 2.9's task role will
// be limited to (infra/lib/config.ts) and against the deployer's message format.
import { GetItemCommand, UpdateItemCommand, type GetItemCommandInput, type UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { BUILDER_BUILD_READ_ATTRIBUTES, BUILDER_BUILD_UPDATE_ATTRIBUTES, BUILDER_USAGE_UPDATE_ATTRIBUTES, DEPLOY_QUEUE_NAME } from "../../infra/lib/config.js";
import { parseDeployJob } from "../api/deploy/deploy.js";
import { DEPLOY_QUEUE_URL } from "../api/settings.js";
import { deployRequest, SqsDeployQueue, type DeploySender } from "./queue.js";
import { DynamoBuildRecords, type BuilderTableSender, type FeedEvent } from "./records.js";
import { jobFromEnvironment } from "./runner.js";

const TABLE = "ssd-workshop-data";
const NOW = "2026-11-24T10:00:00.000Z";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ATTEMPT = "6f1c2a9e-1111-4222-8333-444455556666";

function stub(answers: unknown[]) {
  const sent: (GetItemCommand | UpdateItemCommand)[] = [];
  const client = {
    send: async (command: GetItemCommand | UpdateItemCommand) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
  } as unknown as BuilderTableSender;
  return { client, sent };
}

/** Every attribute name an expression names (`#x` placeholders' values). */
const namesOf = (input: { ExpressionAttributeNames?: Record<string, string> | undefined }): string[] => [...Object.values(input.ExpressionAttributeNames ?? {}), "pk", "sk"];

/**
 * Every attribute name the request's expressions actually use, parsed from their text: each `#x` placeholder resolved
 * through ExpressionAttributeNames, each bare name (`pk` in `attribute_exists(pk)`), plus the key's names.
 */
function expressionNames(input: UpdateItemCommandInput | GetItemCommandInput): string[] {
  const text = [
    (input as UpdateItemCommandInput).UpdateExpression ?? "",
    (input as UpdateItemCommandInput).ConditionExpression ?? "",
    (input as GetItemCommandInput).ProjectionExpression ?? "",
  ].join(" ");
  const placeholders = (text.match(/#[A-Za-z]+/g) ?? []).map((placeholder) => input.ExpressionAttributeNames?.[placeholder] ?? placeholder);
  const keywords = new Set(["SET", "REMOVE", "ADD", "DELETE", "AND", "OR", "NOT", "IN", "attribute_exists", "attribute_not_exists", "list_append", "if_not_exists"]);
  const bare = (text.replace(/[#:][A-Za-z]+/g, " ").match(/[A-Za-z_]+/g) ?? []).filter((word) => !keywords.has(word));
  return [...new Set([...placeholders, ...bare, ...Object.keys(input.Key ?? {})])].sort();
}

/** Every placeholder used in the expressions is defined, and every defined one is used (DynamoDB refuses either). */
function placeholdersMatch(input: UpdateItemCommandInput | GetItemCommandInput): void {
  const text = [
    (input as UpdateItemCommandInput).UpdateExpression ?? "",
    (input as UpdateItemCommandInput).ConditionExpression ?? "",
    (input as GetItemCommandInput).ProjectionExpression ?? "",
  ].join(" ");
  const usedNames = new Set(text.match(/#[A-Za-z]+/g) ?? []);
  const usedValues = new Set(text.match(/:[A-Za-z]+/g) ?? []);
  expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(usedNames);
  expect(new Set(Object.keys((input as UpdateItemCommandInput).ExpressionAttributeValues ?? {}))).toEqual(usedValues);
}

const step: FeedEvent = { kind: "step", step: "preparing", at: NOW };

describe("DynamoBuildRecords (ticket 2.8)", () => {
  it("ticket 3.4 try 2: WHEN the builder marks its build failed THEN it writes only the build (one UpdateItem): it never touches the build slots, which the launcher's minute check frees", async () => {
    const { client, sent } = stub([{}]);
    const records = new DynamoBuildRecords(client, TABLE);
    expect(await records.markFailed("b-1", ATTEMPT, ["x"], NOW)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateItemCommand);
    expect((sent[0]?.input as UpdateItemCommandInput).Key).toEqual({ pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } });
    expect(JSON.stringify(sent.map((command) => command.input))).not.toContain("BUILD_SLOTS");
  });

  it("ticket 3.7: reads a change build's number and input (copied by the launcher), and only a complete one", async () => {
    const change = { kind: { S: "change" }, changeNumber: { N: "2" }, changeSpec: { S: "# Run Log v3" }, changeList: { L: [{ S: "Adds a weekly chart" }] } };
    const base = { nickname: { S: "Ada" }, participantId: { S: "p-1" }, status: { S: "building" } };
    const { client } = stub([
      { Item: { ...base, ...change } },
      { Item: { ...base, ...change, changeList: { L: [] } } },
      { Item: { ...base, ...change, changeNumber: { N: "0" } } },
      { Item: { ...base, kind: { S: "change" }, changeNumber: { N: "1" } } },
      { Item: { ...base, kind: { S: "first" }, changeSpec: { S: "x" } } },
    ]);
    const records = new DynamoBuildRecords(client, TABLE);
    const plain = { nickname: "Ada", participantId: "p-1", status: "building" };
    expect(await records.read("b-1")).toEqual({ ...plain, kind: "change", change: { number: 2, spec: "# Run Log v3", whatChanges: ["Adds a weekly chart"] } });
    for (let i = 0; i < 3; i += 1) expect(await records.read("b-1")).toEqual({ ...plain, kind: "change" });
    expect(await records.read("b-1")).toEqual({ ...plain, kind: "first" });
  });

  it("names exactly BUILDER_BUILD_READ_ATTRIBUTES (GetItem) and BUILDER_BUILD_UPDATE_ATTRIBUTES (UpdateItem) in BUILD#, only BUILDER_USAGE_UPDATE_ATTRIBUTES in the usage item, and returns no attributes", async () => {
    const { client, sent } = stub([{ Item: { nickname: { S: "Ada" }, participantId: { S: "p-1" }, status: { S: "queued" } } }]);
    const records = new DynamoBuildRecords(client, TABLE);
    expect(await records.read("b-1")).toEqual({ nickname: "Ada", participantId: "p-1", status: "queued", kind: "first" });
    expect(await records.claim("b-1", ATTEMPT, "Ada", step, NOW)).toBe(true);
    expect(await records.addFeed("b-1", ATTEMPT, [{ kind: "file", path: "index.html", at: NOW }, { kind: "fetch", host: "en.wikipedia.org", at: NOW }], NOW)).toBe(true);
    expect(await records.handOver("b-1", ATTEMPT, COMMIT, [{ kind: "step", step: "deploying", at: NOW }], NOW)).toBe(true);
    expect(await records.markFailed("b-1", ATTEMPT, ["The build took too long."], NOW)).toBe(true);
    await records.addUsage("p-1", { inputTokens: 10, outputTokens: 2, costUsd: 0.01 }, NOW);
    expect(sent).toHaveLength(6);
    const [read, ...updates] = sent;
    expect(read).toBeInstanceOf(GetItemCommand);
    const readInput = read?.input as GetItemCommandInput;
    expect(readInput).toMatchObject({ TableName: TABLE, Key: { pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } }, ConsistentRead: true });
    placeholdersMatch(readInput);
    expect(expressionNames(readInput)).toEqual([...BUILDER_BUILD_READ_ATTRIBUTES].sort());
    const buildNames = new Set<string>();
    for (const command of updates) {
      expect(command).toBeInstanceOf(UpdateItemCommand);
      const input = command.input as UpdateItemCommandInput;
      expect(input.ReturnValues).toBe("NONE");
      placeholdersMatch(input);
      const usage = input.Key?.pk?.S === "PARTICIPANT#p-1";
      if (usage) expect(input.Key?.sk?.S).toBe("USAGE");
      else expect(input.Key).toEqual({ pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } });
      const allowed: readonly string[] = usage ? BUILDER_USAGE_UPDATE_ATTRIBUTES : BUILDER_BUILD_UPDATE_ATTRIBUTES;
      for (const name of namesOf(input)) expect(allowed, name).toContain(name);
      for (const name of expressionNames(input)) expect(allowed, name).toContain(name);
      if (!usage) for (const name of expressionNames(input)) buildNames.add(name);
    }
    // The update list is exactly what the builder's BUILD# updates name: nothing more for 2.9's role to touch.
    expect([...buildNames].sort()).toEqual([...BUILDER_BUILD_UPDATE_ATTRIBUTES].sort());
    expect(BUILDER_BUILD_UPDATE_ATTRIBUTES).not.toContain("participantId");
    // Ticket 2.15: a web fetch is stored with its host only.
    expect((updates[1]?.input as UpdateItemCommandInput).ExpressionAttributeValues?.[":events"]).toEqual({
      L: [{ M: { kind: { S: "file" }, at: { S: NOW }, path: { S: "index.html" } } }, { M: { kind: { S: "fetch" }, at: { S: NOW }, host: { S: "en.wikipedia.org" } } }],
    });
  });

  it("claims only an existing build of the nickname, building under this launch, that has no pushed commit, with a new feed", async () => {
    const { client, sent } = stub([]);
    await new DynamoBuildRecords(client, TABLE).claim("b-1", ATTEMPT, "Ada", step, NOW);
    const input = sent[0]?.input as UpdateItemCommandInput;
    expect(input.ConditionExpression).toBe("attribute_exists(pk) AND #nickname = :nickname AND #status = :building AND #attemptId = :attemptId AND attribute_not_exists(#pushedCommit)");
    expect(input.UpdateExpression).toBe("SET #feed = :feed, #updatedAt = :now REMOVE #failureReasons, #finishedAt");
    expect(input.ExpressionAttributeValues?.[":attemptId"]).toEqual({ S: ATTEMPT });
    expect(input.ExpressionAttributeValues?.[":feed"]).toEqual({ L: [{ M: { kind: { S: "step" }, at: { S: NOW }, step: { S: "preparing" } } }] });
    expect(input.ExpressionAttributeValues?.[":nickname"]).toEqual({ S: "Ada" });
  });

  it("appends to the feed, hands over and fails only while the build is building under this launch; the hand-over only once", async () => {
    const { client, sent } = stub([]);
    const records = new DynamoBuildRecords(client, TABLE);
    await records.addFeed("b-1", ATTEMPT, [{ kind: "commit", sha: COMMIT, message: "Build", at: NOW }], NOW);
    await records.handOver("b-1", ATTEMPT, COMMIT, [], NOW);
    await records.markFailed("b-1", ATTEMPT, ["x"], NOW);
    const [feed, handOver, failed] = sent.map((command) => command.input as UpdateItemCommandInput);
    for (const input of [feed, handOver, failed]) expect(input?.ExpressionAttributeValues?.[":attemptId"]).toEqual({ S: ATTEMPT });
    expect(feed?.ConditionExpression).toBe("attribute_exists(pk) AND #status = :building AND #attemptId = :attemptId");
    expect(feed?.UpdateExpression).toBe("SET #feed = list_append(if_not_exists(#feed, :empty), :events), #updatedAt = :now");
    expect(feed?.ExpressionAttributeValues?.[":events"]).toEqual({ L: [{ M: { kind: { S: "commit" }, at: { S: NOW }, sha: { S: COMMIT }, message: { S: "Build" } } }] });
    expect(handOver?.ConditionExpression).toBe("attribute_exists(pk) AND #status = :building AND #attemptId = :attemptId AND attribute_not_exists(#pushedCommit)");
    expect(handOver?.ExpressionAttributeValues?.[":commit"]).toEqual({ S: COMMIT });
    expect(failed?.ConditionExpression).toBe("attribute_exists(pk) AND #status = :building AND #attemptId = :attemptId");
    expect(failed?.ExpressionAttributeValues?.[":failed"]).toEqual({ S: "failed" });
    // The builder never sets the deployer's statuses or attributes.
    for (const input of [feed, handOver, failed]) {
      expect(input?.UpdateExpression).not.toMatch(/deployedCommit|liveAt|#nickname =/);
    }
  });

  it("answers false when a condition fails, undefined for a missing build, and passes other errors on", async () => {
    const conditionFailed = Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" });
    const { client } = stub([{}, conditionFailed, Object.assign(new Error("x"), { name: "InternalServerError" })]);
    const records = new DynamoBuildRecords(client, TABLE);
    expect(await records.read("b-1")).toBeUndefined();
    expect(await records.claim("b-1", ATTEMPT, "Ada", step, NOW)).toBe(false);
    await expect(records.addFeed("b-1", ATTEMPT, [], NOW)).rejects.toThrow("x");
  });

  it("adds usage with one atomic ADD, and nothing for a run that spent no tokens", async () => {
    const { client, sent } = stub([]);
    const records = new DynamoBuildRecords(client, TABLE);
    await records.addUsage("p-1", { inputTokens: 0, outputTokens: 0, costUsd: 0 }, NOW);
    expect(sent).toEqual([]);
    await records.addUsage("p-1", { inputTokens: 641_000, outputTokens: 20_000, costUsd: 0.6963 }, NOW);
    const input = sent[0]?.input as UpdateItemCommandInput;
    expect(input.UpdateExpression).toBe(
      "SET #type = :type, #participantId = :participantId, #updatedAt = :now ADD #inputTokens :inputTokens, #outputTokens :outputTokens, #costUsd :costUsd",
    );
    expect(input.ExpressionAttributeValues).toMatchObject({ ":inputTokens": { N: "641000" }, ":outputTokens": { N: "20000" }, ":costUsd": { N: "0.6963" } });
    expect(input.ConditionExpression).toBeUndefined();
  });
});

describe("the deploy message (decision \"(2.5) Deploy message\")", () => {
  it("goes to ssd-workshop-deploys.fifo with exactly {buildId, nickname, commit}, deduplicated by build id, grouped by lower-cased nickname", async () => {
    const sent: SendMessageCommandInput[] = [];
    const client: DeploySender = { send: async (command) => (sent.push(command.input), { $metadata: {} }) };
    await new SqsDeployQueue(client, DEPLOY_QUEUE_URL).send({ buildId: "b-1", nickname: "AdaL", commit: COMMIT });
    expect(DEPLOY_QUEUE_URL.endsWith(`/${DEPLOY_QUEUE_NAME}`)).toBe(true);
    expect(sent).toEqual([
      { QueueUrl: DEPLOY_QUEUE_URL, MessageBody: JSON.stringify({ buildId: "b-1", nickname: "AdaL", commit: COMMIT }), MessageDeduplicationId: "b-1", MessageGroupId: "adal" },
    ]);
    // The deployer reads it as a valid job.
    expect(parseDeployJob(deployRequest(DEPLOY_QUEUE_URL, { buildId: "b-1", nickname: "AdaL", commit: COMMIT }).input.MessageBody)).toEqual({ buildId: "b-1", nickname: "AdaL", commit: COMMIT });
  });
});

describe("the job from the task's environment (for ticket 2.9)", () => {
  it("reads BUILD_ID, BUILDER_GITHUB_TOKEN, BUILDER_BASE_COMMIT and BUILDER_ATTEMPT_ID, and removes the token from the environment", () => {
    const rest = { BUILDER_BASE_COMMIT: COMMIT, BUILDER_ATTEMPT_ID: ATTEMPT };
    const env: Record<string, string | undefined> = { BUILD_ID: "b-1", BUILDER_GITHUB_TOKEN: "ghs_secret", PATH: "/bin", ...rest };
    expect(jobFromEnvironment(env)).toEqual({ buildId: "b-1", token: "ghs_secret", baseCommit: COMMIT, attemptId: ATTEMPT });
    expect(env).toEqual({ BUILD_ID: "b-1", PATH: "/bin", ...rest });
    expect(jobFromEnvironment({ BUILDER_GITHUB_TOKEN: "x", ...rest })).toEqual({ error: "BUILD_ID is missing or not a build id" });
    expect(jobFromEnvironment({ BUILD_ID: "../x", BUILDER_GITHUB_TOKEN: "x", ...rest })).toEqual({ error: "BUILD_ID is missing or not a build id" });
    const noToken = jobFromEnvironment({ BUILD_ID: "b-1", ...rest });
    expect(noToken).toEqual({ error: "BUILDER_GITHUB_TOKEN is missing" });
    for (const commit of [undefined, "main", COMMIT.toUpperCase(), `${COMMIT}0`]) {
      expect(jobFromEnvironment({ BUILD_ID: "b-1", BUILDER_GITHUB_TOKEN: "x", BUILDER_ATTEMPT_ID: ATTEMPT, BUILDER_BASE_COMMIT: commit }), String(commit)).toEqual({
        error: "BUILDER_BASE_COMMIT is missing or not a commit id",
      });
    }
    for (const attempt of [undefined, "", "x", ATTEMPT.toUpperCase()]) {
      expect(jobFromEnvironment({ BUILD_ID: "b-1", BUILDER_GITHUB_TOKEN: "x", BUILDER_BASE_COMMIT: COMMIT, BUILDER_ATTEMPT_ID: attempt }), String(attempt)).toEqual({
        error: "BUILDER_ATTEMPT_ID is missing or not an attempt id",
      });
    }
  });
});
