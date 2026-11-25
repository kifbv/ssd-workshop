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
      ProjectionExpression: "#aiBudgetUsd, #changeRequestsPerPerson, #buildsAtOnce, #stopped",
      ExpressionAttributeNames: {
        "#aiBudgetUsd": "aiBudgetUsd",
        "#changeRequestsPerPerson": "changeRequestsPerPerson",
        "#buildsAtOnce": "buildsAtOnce",
        "#stopped": "stopped",
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
    expect(SETTINGS_UPDATE_ATTRIBUTES).not.toContain("stopped");
    await expect(store.putCaps({ aiBudgetUsd: 1, changeRequestsPerPerson: 1, buildsAtOnce: 1 }, "x")).rejects.toThrow("down");
  });
});
