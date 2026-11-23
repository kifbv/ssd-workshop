import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { clientSettings } from "../aws.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { TABLE_NAME } from "../settings.js";
import { verifySignIn, type VerifyDeps, type VerifyLogEntry } from "../sign-in/verify.js";
import { DynamoVerifyStore } from "../sign-in/verify-store.js";

/**
 * `POST /api/sign-in/verify` (ticket 1.5): checks a sign-in code and starts a session in an
 * HttpOnly cookie. Rules in ../sign-in/verify.ts.
 */

/** One JSON line per request, holding only the outcome (never the address, the code, the token or the body). */
export function logEntry(entry: VerifyLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The handler on given dependencies (tests pass in-memory fakes). */
export function createHandler(deps: VerifyDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => verifySignIn(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The client is created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  live ??= createHandler({
    store: new DynamoVerifyStore(new DynamoDBClient(clientSettings()), TABLE_NAME),
    now: () => new Date(),
    randomBytes,
    randomUUID,
    log: logEntry,
    sleep: async (ms) => {
      await delay(ms);
    },
  });
  return live(event);
}
