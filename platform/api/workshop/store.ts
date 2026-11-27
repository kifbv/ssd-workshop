// The `SETTINGS` item's table access (ticket 3.2). Every phase 3 reader (AI worker, launcher, dashboard) reads it
// through `getSettings`; only the admin function writes it, and only SETTINGS_UPDATE_ATTRIBUTES (infra/lib/config.ts).
import {
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { settingsKey } from "../keys.js";
import { settingsFromItem, type WorkshopCaps, type WorkshopSettings } from "./settings.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface SettingsSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
}

export interface SettingsStore {
  /** The settings now (consistent read); a missing item or value reads as its default. */
  getSettings(): Promise<WorkshopSettings>;
  /** Stores the three caps (creating the item when it is missing); leaves Stop as it is. */
  putCaps(caps: WorkshopCaps, nowIso: string): Promise<void>;
  /**
   * Ticket 3.5: turns the global Stop on (noting `stoppedAt`) or off (noting `resumedAt`), creating the item when it is
   * missing; leaves the caps as they are.
   */
  setStopped(stopped: boolean, nowIso: string): Promise<void>;
  /** Ticket 3.21: turns the switch "Apps may use AI" on or off (noting `appAiChangedAt`), creating the item when missing. */
  setAppAi(enabled: boolean, nowIso: string): Promise<void>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const key = (): Record<string, AttributeValue> => {
  const k = settingsKey();
  return { pk: str(k.pk), sk: str(k.sk) };
};

/**
 * The settings now, for any store that can send a GetItem (the conversation store reads them for the AI budget, ticket
 * 3.3): a consistent read projected to the caps, Stop and the last Resume's time (`SETTINGS_READ_ATTRIBUTES` in infra/lib/config.ts, which a
 * reader's role is limited to), so an admin's change applies at the very next read.
 */
export async function readSettings(client: { send(command: GetItemCommand): Promise<GetItemCommandOutput> }, tableName: string): Promise<WorkshopSettings> {
  const output = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: key(),
      ConsistentRead: true,
      ProjectionExpression: "#aiBudgetUsd, #changeRequestsPerPerson, #buildsAtOnce, #stopped, #resumedAt, #appAiEnabled",
      ExpressionAttributeNames: {
        "#aiBudgetUsd": "aiBudgetUsd",
        "#changeRequestsPerPerson": "changeRequestsPerPerson",
        "#buildsAtOnce": "buildsAtOnce",
        "#stopped": "stopped",
        "#resumedAt": "resumedAt",
        "#appAiEnabled": "appAiEnabled",
      },
    }),
  );
  return settingsFromItem(output.Item);
}

export class DynamoSettingsStore implements SettingsStore {
  constructor(
    private readonly client: SettingsSender,
    private readonly tableName: string,
  ) {}

  async getSettings(): Promise<WorkshopSettings> {
    return readSettings(this.client, this.tableName);
  }

  async putCaps(caps: WorkshopCaps, nowIso: string): Promise<void> {
    // An UpdateItem (never a Put), so `stopped` keeps its value; nothing comes back.
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: key(),
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
          ":type": str("settings"),
          ":aiBudgetUsd": num(caps.aiBudgetUsd),
          ":changeRequestsPerPerson": num(caps.changeRequestsPerPerson),
          ":buildsAtOnce": num(caps.buildsAtOnce),
          ":updatedAt": str(nowIso),
        },
      }),
    );
  }

  async setStopped(stopped: boolean, nowIso: string): Promise<void> {
    // One UpdateItem of the switch and its time only (the caps keep their values); nothing comes back.
    const at = stopped ? "stoppedAt" : "resumedAt";
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: key(),
        UpdateExpression: `SET #type = :type, #stopped = :stopped, #${at} = :now, #updatedAt = :now`,
        ExpressionAttributeNames: { "#type": "type", "#stopped": "stopped", [`#${at}`]: at, "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":type": str("settings"), ":stopped": { BOOL: stopped }, ":now": str(nowIso) },
      }),
    );
  }

  async setAppAi(enabled: boolean, nowIso: string): Promise<void> {
    // One UpdateItem of the switch and its time only (the caps and Stop keep their values); nothing comes back.
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: key(),
        UpdateExpression: "SET #type = :type, #appAiEnabled = :enabled, #appAiChangedAt = :now, #updatedAt = :now",
        ExpressionAttributeNames: { "#type": "type", "#appAiEnabled": "appAiEnabled", "#appAiChangedAt": "appAiChangedAt", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":type": str("settings"), ":enabled": { BOOL: enabled }, ":now": str(nowIso) },
      }),
    );
  }
}
