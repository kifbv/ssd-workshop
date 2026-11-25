// Ticket 2.13: the full reset's DynamoDB requests, against a stubbed client.
import { BatchWriteItemCommand, DeleteItemCommand, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoParticipantResetStore, type ParticipantResetSender } from "./store.js";

function stub(answers: (Record<string, unknown> | Error)[]) {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as ParticipantResetSender;
  const waits: number[] = [];
  return { store: new DynamoParticipantResetStore(client, "ssd-workshop-data", async (ms) => void waits.push(ms)), sent, waits };
}

describe("DynamoParticipantResetStore", () => {
  it("reads the build link from the conversation item and the build's status from its record, consistently", async () => {
    const { store, sent } = stub([
      { Item: { pk: { S: "PARTICIPANT#p-1" }, updatedAt: { S: "t1" }, state: { S: "open" }, buildId: { S: "b-1" } } },
      { Item: { status: { S: "deploying" } } },
      {},
    ]);
    await expect(store.getResetState("p-1")).resolves.toEqual({ exists: true, updatedAt: "t1", state: "open", buildId: "b-1" });
    await expect(store.getBuildStatus("b-1")).resolves.toBe("deploying");
    await expect(store.getBuildStatus("b-2")).resolves.toBeUndefined();
    expect((sent[0] as GetItemCommand).input.ExpressionAttributeNames).toMatchObject({ "#buildId": "buildId" });
    expect((sent[1] as GetItemCommand).input).toMatchObject({
      Key: { pk: { S: "BUILD#b-1" }, sk: { S: "BUILD" } },
      ProjectionExpression: "#status",
      ExpressionAttributeNames: { "#status": "status" },
      ConsistentRead: true,
    });
  });

  it("lists every key of the app's lower-cased data partition, page by page, reading only sk", async () => {
    const { store, sent } = stub([
      { Items: [{ sk: { S: "DATA#a" } }, { sk: { S: "DATA#b" } }], LastEvaluatedKey: { pk: { S: "x" } } },
      { Items: [{ sk: { S: "DATA_USAGE" } }] },
    ]);
    await expect(store.listAppData("Ada")).resolves.toEqual(["DATA#a", "DATA#b", "DATA_USAGE"]);
    expect((sent[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "APPDATA#ada" } },
      ProjectionExpression: "#sk",
      ConsistentRead: true,
    });
    expect((sent[1] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: { S: "x" } });
  });

  it("deletes app data in the app's partition, in batches of 25 with retries of unprocessed items", async () => {
    const keys = Array.from({ length: 27 }, (_, i) => `DATA#k${i}`);
    const left = { UnprocessedItems: { "ssd-workshop-data": [{ DeleteRequest: { Key: { pk: { S: "APPDATA#ada" }, sk: { S: "DATA#k0" } } } }] } };
    const { store, sent, waits } = stub([left, {}, {}]);
    await store.deleteAppData("Ada", keys);
    const batches = sent as BatchWriteItemCommand[];
    expect(batches.map((b) => b.input.RequestItems?.["ssd-workshop-data"]?.length)).toEqual([25, 1, 2]);
    for (const batch of batches) {
      for (const request of batch.input.RequestItems?.["ssd-workshop-data"] ?? []) expect(request.DeleteRequest?.Key?.["pk"]).toEqual({ S: "APPDATA#ada" });
    }
    expect(waits).toEqual([200]);
  });

  it("reads and deletes the live marker at APP#<lower-cased nickname> / LIVE, saying whether this call deleted it", async () => {
    const { store, sent } = stub([{ Item: { pk: { S: "APP#ada" } } }, {}, { Attributes: { pk: { S: "APP#ada" } } }, {}]);
    await expect(store.hasLiveMarker("Ada")).resolves.toBe(true);
    await expect(store.hasLiveMarker("Ada")).resolves.toBe(false);
    await expect(store.deleteLiveMarker("Ada")).resolves.toBe(true);
    await expect(store.deleteLiveMarker("Ada")).resolves.toBe(false);
    expect((sent[0] as GetItemCommand).input.Key).toEqual({ pk: { S: "APP#ada" }, sk: { S: "LIVE" } });
    expect(sent[2]).toBeInstanceOf(DeleteItemCommand);
    expect((sent[2] as DeleteItemCommand).input).toEqual({
      TableName: "ssd-workshop-data",
      Key: { pk: { S: "APP#ada" }, sk: { S: "LIVE" } },
      ReturnValues: "ALL_OLD",
    });
  });
});
