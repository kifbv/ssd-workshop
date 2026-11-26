// Ticket 3.25: what `npm run apps` asks of DynamoDB and SQS.
import { ScanCommand, type ScanCommandOutput } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { DynamoLiveApps, SqsRefreshQueue } from "./store.js";

describe("the apps command's AWS calls (ticket 3.25)", () => {
  it("lists the live markers' nicknames only, page by page", async () => {
    const pages: ScanCommandOutput[] = [
      { Items: [{ nickname: { S: "Ada" } }, {}], LastEvaluatedKey: { pk: { S: "APP#ada" }, sk: { S: "LIVE" } }, $metadata: {} },
      { Items: [{ nickname: { S: "bob" } }], $metadata: {} },
    ];
    const commands: ScanCommand[] = [];
    const store = new DynamoLiveApps({ send: async (command: ScanCommand) => (commands.push(command), pages[commands.length - 1] as ScanCommandOutput) }, "ssd-workshop-data");
    expect(await store.listLiveApps()).toEqual(["Ada", "bob"]);
    expect(commands[0]?.input).toEqual({
      TableName: "ssd-workshop-data",
      FilterExpression: "#type = :live AND begins_with(pk, :prefix) AND sk = :sk",
      ProjectionExpression: "#nickname",
      ExpressionAttributeNames: { "#type": "type", "#nickname": "nickname" },
      ExpressionAttributeValues: { ":live": { S: "app-live" }, ":prefix": { S: "APP#" }, ":sk": { S: "LIVE" } },
    });
    expect(commands[1]?.input.ExclusiveStartKey).toEqual({ pk: { S: "APP#ada" }, sk: { S: "LIVE" } });
  });

  it("sends {refresh} to the deploy queue in the app's message group", async () => {
    const sent: SendMessageCommand[] = [];
    const queue = new SqsRefreshQueue({ send: async (command: SendMessageCommand) => (sent.push(command), { $metadata: {} } as SendMessageCommandOutput) }, "https://sqs.example/q.fifo");
    await queue.send("Ada", "refresh-ada-1");
    expect(sent[0]?.input).toEqual({ QueueUrl: "https://sqs.example/q.fifo", MessageBody: '{"refresh":"Ada"}', MessageGroupId: "ada", MessageDeduplicationId: "refresh-ada-1" });
  });
});
