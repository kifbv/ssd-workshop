import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { handleAppDataRequest, pauseBeforeRetry, type AppDataDeps, type AppDataLogEntry } from "../app-data/data.js";
import { DynamoAppDataStore } from "../app-data/store.js";
import { clientSettings } from "../aws.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { TABLE_NAME } from "../settings.js";

/**
 * The data API for participants' apps (ticket 2.4): `GET`, `PUT`, `DELETE` and `OPTIONS`
 * `/api/apps/{nickname}/data/{key}`. No session: anyone with the app's address may read and write.
 * Rules in ../app-data/.
 */

/** One JSON line per request: method, outcome, status and size only (never a nickname, a key, a value or the event). */
export function logEntry(entry: AppDataLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The handler on given dependencies (tests pass in-memory fakes). */
export function createHandler(deps: AppDataDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => handleAppDataRequest(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The client is created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  live ??= createHandler({
    store: new DynamoAppDataStore(new DynamoDBClient(clientSettings()), TABLE_NAME),
    now: () => new Date(),
    log: logEntry,
    pause: () => pauseBeforeRetry(),
  });
  return live(event);
}
