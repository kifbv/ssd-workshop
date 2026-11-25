import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { handleAdminRequest, type AdminDeps, type AdminLogEntry } from "../admin/admin.js";
import { clientSettings } from "../aws.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { DynamoParticipantStore } from "../participant/store.js";
import { TABLE_NAME } from "../settings.js";
import { DynamoSettingsStore } from "../workshop/store.js";

/**
 * The admin routes (ticket 3.2): `GET` and `PUT /api/admin/settings` (and, ticket 3.5, `POST /api/admin/stop` and
 * `/api/admin/resume`), behind the one session check and for the admin only. Rules in ../admin/. Its own function, so only this role may write the `SETTINGS` item.
 */

/** One JSON line per request: route and outcome only (never a token, an id, a value or the body). */
export function logEntry(entry: AdminLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The handler on given dependencies (tests pass in-memory fakes). */
export function createHandler(deps: AdminDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => handleAdminRequest(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The client is created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  if (live === undefined) {
    const client = new DynamoDBClient(clientSettings());
    live = createHandler({
      // The session check's reads and deletes only (this role cannot claim nicknames).
      sessions: new DynamoParticipantStore(client, TABLE_NAME),
      settings: new DynamoSettingsStore(client, TABLE_NAME),
      now: () => new Date(),
      log: logEntry,
    });
  }
  return live(event);
}
