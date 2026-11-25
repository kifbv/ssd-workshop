import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { SETTINGS_PARTITION, SETTINGS_UPDATE_ATTRIBUTES } from "../../../infra/lib/config.js";
import { SETTINGS_PK } from "../keys.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { DynamoSettingsStore, type SettingsSender } from "./store.js";

type Sent = GetItemCommand | UpdateItemCommand;

function stubClient(answers: (Record<string, unknown> | Error)[]): { client: SettingsSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: Sent) => {
      sent.push(command);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as SettingsSender;
  return { client, sent };
}

const TABLE = "ssd-workshop-data";
const KEY = { pk: { S: "SETTINGS" }, sk: { S: "SETTINGS" } };

describe("DynamoSettingsStore (ticket 3.2)", () => {
  it("reads the defaults $5, 5 and 15 with Stop off when no SETTINGS item exists", async () => {
    const { client, sent } = stubClient([{}]);
    await expect(new DynamoSettingsStore(client, TABLE).getSettings()).resolves.toEqual({
      aiBudgetUsd: 5,
      changeRequestsPerPerson: 5,
      buildsAtOnce: 15,
      stopped: false,
    });
    expect(sent[0]).toBeInstanceOf(GetItemCommand);
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: KEY,
      ConsistentRead: true,
      ProjectionExpression: "#aiBudgetUsd, #changeRequestsPerPerson, #buildsAtOnce, #stopped, #resumedAt",
      ExpressionAttributeNames: {
        "#aiBudgetUsd": "aiBudgetUsd",
        "#changeRequestsPerPerson": "changeRequestsPerPerson",
        "#buildsAtOnce": "buildsAtOnce",
        "#stopped": "stopped",
        "#resumedAt": "resumedAt",
      },
    });
    expect(SETTINGS_PK).toBe(SETTINGS_PARTITION);
  });

  it("reads stored values, and Stop when it is on", async () => {
    const { client } = stubClient([
      { Item: { aiBudgetUsd: { N: "8.5" }, changeRequestsPerPerson: { N: "3" }, buildsAtOnce: { N: "10" }, stopped: { BOOL: true } } },
      { Item: { aiBudgetUsd: { N: "8.5" } } },
    ]);
    const store = new DynamoSettingsStore(client, TABLE);
    await expect(store.getSettings()).resolves.toEqual({ aiBudgetUsd: 8.5, changeRequestsPerPerson: 3, buildsAtOnce: 10, stopped: true });
    await expect(store.getSettings()).resolves.toEqual({ ...DEFAULT_SETTINGS, aiBudgetUsd: 8.5 });
  });

  it("stores the caps with one UpdateItem naming only SETTINGS_UPDATE_ATTRIBUTES, leaving Stop alone and returning nothing", async () => {
    const { client, sent } = stubClient([{}, new Error("down")]);
    const store = new DynamoSettingsStore(client, TABLE);
    await store.putCaps({ aiBudgetUsd: 7.5, changeRequestsPerPerson: 4, buildsAtOnce: 12 }, "2026-11-25T10:00:00.000Z");
    expect(sent[0]).toBeInstanceOf(UpdateItemCommand);
    const input = (sent[0] as UpdateItemCommand).input;
    expect(input).toEqual({
      TableName: TABLE,
      Key: KEY,
      UpdateExpression:
        "SET #type = :type, #aiBudgetUsd = :aiBudgetUsd, #changeRequestsPerPerson = :changeRequestsPerPerson, #buildsAtOnce = :buildsAtOnce, #updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#type": "type",
        "#aiBudgetUsd": "aiBudgetUsd",
        "#changeRequestsPerPerson": "changeRequestsPerPerson",
        "#buildsAtOnce": "buildsAtOnce",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":type": { S: "settings" },
        ":aiBudgetUsd": { N: "7.5" },
        ":changeRequestsPerPerson": { N: "4" },
        ":buildsAtOnce": { N: "12" },
        ":updatedAt": { S: "2026-11-25T10:00:00.000Z" },
      },
    });
    for (const name of ["pk", "sk", ...Object.values(input.ExpressionAttributeNames ?? {})]) expect(SETTINGS_UPDATE_ATTRIBUTES, name).toContain(name);
    // The caps' write never names the Stop switch (ticket 3.5 writes it with setStopped).
    expect(Object.values(input.ExpressionAttributeNames ?? {})).not.toContain("stopped");
    await expect(store.putCaps({ aiBudgetUsd: 1, changeRequestsPerPerson: 1, buildsAtOnce: 1 }, "x")).rejects.toThrow("down");
  });

  it("turns Stop on and off (ticket 3.5) with one UpdateItem of the switch and its time, naming only SETTINGS_UPDATE_ATTRIBUTES", async () => {
    const { client, sent } = stubClient([{}, {}, new Error("down")]);
    const store = new DynamoSettingsStore(client, TABLE);
    await store.setStopped(true, "2026-11-25T10:00:00.000Z");
    await store.setStopped(false, "2026-11-25T10:05:00.000Z");
    expect(sent.map((c) => c.input)).toEqual([
      {
        TableName: TABLE,
        Key: KEY,
        UpdateExpression: "SET #type = :type, #stopped = :stopped, #stoppedAt = :now, #updatedAt = :now",
        ExpressionAttributeNames: { "#type": "type", "#stopped": "stopped", "#stoppedAt": "stoppedAt", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":type": { S: "settings" }, ":stopped": { BOOL: true }, ":now": { S: "2026-11-25T10:00:00.000Z" } },
      },
      {
        TableName: TABLE,
        Key: KEY,
        UpdateExpression: "SET #type = :type, #stopped = :stopped, #resumedAt = :now, #updatedAt = :now",
        ExpressionAttributeNames: { "#type": "type", "#stopped": "stopped", "#resumedAt": "resumedAt", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":type": { S: "settings" }, ":stopped": { BOOL: false }, ":now": { S: "2026-11-25T10:05:00.000Z" } },
      },
    ]);
    for (const command of sent) {
      for (const name of ["pk", "sk", ...Object.values((command as UpdateItemCommand).input.ExpressionAttributeNames ?? {})]) expect(SETTINGS_UPDATE_ATTRIBUTES, name).toContain(name);
    }
    await expect(store.setStopped(true, "x")).rejects.toThrow("down");
  });
});
