// An in-memory `SETTINGS` item for tests (ticket 3.2), read through the same `settingsFromItem` as the DynamoDB store,
// so a missing item or value reads as its default exactly as in the table. Not bundled: no handler imports it.
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { settingsFromItem, type WorkshopCaps, type WorkshopSettings } from "./settings.js";
import type { SettingsStore } from "./store.js";

export class FakeSettingsTable implements SettingsStore {
  /** The stored item's attributes as DynamoDB would return them; undefined while there is no item. */
  item: Record<string, AttributeValue> | undefined;
  writes = 0;
  failure: Error | undefined;

  async getSettings(): Promise<WorkshopSettings> {
    if (this.failure !== undefined) throw this.failure;
    return settingsFromItem(this.item);
  }

  async putCaps(caps: WorkshopCaps, nowIso: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.writes++;
    this.item = {
      ...this.item,
      type: { S: "settings" },
      aiBudgetUsd: { N: String(caps.aiBudgetUsd) },
      changeRequestsPerPerson: { N: String(caps.changeRequestsPerPerson) },
      buildsAtOnce: { N: String(caps.buildsAtOnce) },
      updatedAt: { S: nowIso },
    };
  }

  async setStopped(stopped: boolean, nowIso: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.writes++;
    this.item = { ...this.item, type: { S: "settings" }, stopped: { BOOL: stopped }, [stopped ? "stoppedAt" : "resumedAt"]: { S: nowIso }, updatedAt: { S: nowIso } };
  }
}
