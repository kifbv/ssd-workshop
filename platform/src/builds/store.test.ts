// Ticket 2.9: the requests `npm run builds` sends (placeholders defined and used, the retry's condition and removals,
// the launch message's shape).
import { ScanCommand, UpdateItemCommand, type ScanCommandInput, type UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { parseLaunchMessage } from "../../api/launcher/launcher.js";
import { BUILD_QUEUE_URL } from "../../api/settings.js";
import { DynamoBuildsStore, REQUEUE_REMOVED, SqsLaunchQueue, type BuildsTableSender } from "./store.js";

function placeholdersMatch(input: { UpdateExpression?: string | undefined; ConditionExpression?: string | undefined; FilterExpression?: string | undefined; ProjectionExpression?: string | undefined; ExpressionAttributeNames?: Record<string, string> | undefined; ExpressionAttributeValues?: Record<string, unknown> | undefined }): void {
  const text = [input.UpdateExpression, input.ConditionExpression, input.FilterExpression, input.ProjectionExpression].join(" ");
  expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(new Set(text.match(/#[A-Za-z]+/g) ?? []));
  expect(new Set(Object.keys(input.ExpressionAttributeValues ?? {}))).toEqual(new Set(text.match(/:[A-Za-z]+/g) ?? []));
}

describe("npm run builds on AWS (ticket 2.9)", () => {
  it("requeues only a build still in the read status, removing the earlier run's task, commits, feed and failure", async () => {
    const sent: (UpdateItemCommand | ScanCommand)[] = [];
    const client = { send: async (command: UpdateItemCommand | ScanCommand) => (sent.push(command), {}) } as unknown as BuildsTableSender;
    const store = new DynamoBuildsStore(client, "ssd-workshop-data");
    expect(await store.requeue("b-1", "failed", "2026-11-24T10:00:00.000Z")).toBe(true);
    await store.listBuilds();
    const update = sent[0]?.input as UpdateItemCommandInput;
    expect(update.Key).toEqual({ pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } });
    expect(update.ConditionExpression).toBe("#status = :from");
    expect(update.ExpressionAttributeValues?.[":from"]).toEqual({ S: "failed" });
    expect(update.UpdateExpression).toBe("SET #status = :queued, #updatedAt = :now REMOVE #failureReasons, #finishedAt, #pushedCommit, #deployedCommit, #taskArn, #launchedAt, #feed");
    expect([...REQUEUE_REMOVED]).toContain("pushedCommit");
    placeholdersMatch(update);
    placeholdersMatch(sent[1]?.input as ScanCommandInput);
    // The list reads no failure text or participant data beyond the nickname.
    expect((sent[1]?.input as ScanCommandInput).ProjectionExpression).toBe("#buildId, #nickname, #status, #createdAt");
  });

  it("sends the launch message the launcher accepts, in the participant's group, with the retry's own deduplication id", async () => {
    const sent: SendMessageCommand[] = [];
    await new SqsLaunchQueue({ send: async (command: SendMessageCommand) => (sent.push(command), { $metadata: {} }) }, BUILD_QUEUE_URL).send("b-1", "p-1", "b-1-retry-1");
    expect(sent[0]?.input).toEqual({ QueueUrl: BUILD_QUEUE_URL, MessageBody: '{"buildId":"b-1"}', MessageGroupId: "p-1", MessageDeduplicationId: "b-1-retry-1" });
    expect(parseLaunchMessage(sent[0]?.input.MessageBody)).toBe("b-1");
  });
});
