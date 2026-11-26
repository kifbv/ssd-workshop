import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { clientSettings } from "../aws.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { handleParticipantRequest, type ParticipantDeps, type ParticipantLogEntry } from "../participant/participant.js";
import { DynamoParticipantStore } from "../participant/store.js";
import { TABLE_NAME } from "../settings.js";

/**
 * The protected participant routes (ticket 1.5): `GET /api/me`, `POST /api/me/nickname` and
 * `GET /api/participants/{id}`, `POST /api/sign-out` and `POST /api/app-tokens` (ticket 3.24), each behind the one
 * session check. Rules in ../participant/.
 */

/** One JSON line per request: route and outcome only (never a token, a nickname, an id or the body). */
export function logEntry(entry: ParticipantLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The handler on given dependencies (tests pass in-memory fakes). */
export function createHandler(deps: ParticipantDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => handleParticipantRequest(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The client is created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  live ??= createHandler({
    store: new DynamoParticipantStore(new DynamoDBClient(clientSettings()), TABLE_NAME),
    now: () => new Date(),
    randomBytes,
    log: logEntry,
  });
  return live(event);
}
