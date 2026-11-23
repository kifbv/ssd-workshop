import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { HTTP_TIMEOUTS, clientSettings } from "../aws.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { TABLE_NAME } from "../settings.js";
import { requestCode, type CodeRequestDeps, type LogEntry } from "../sign-in/code-request.js";
import { SesCodeMailer } from "../sign-in/mailer.js";
import { DynamoSignInStore } from "../sign-in/store.js";

/**
 * `POST /api/sign-in/code` (ticket 1.4): emails a sign-in code to an allow-listed address and
 * answers every well-formed request the same way. Rules in ../sign-in/code-request.ts.
 */

/** One JSON line per request, holding only the outcome (never the address, the code or the body). */
export function logEntry(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The handler on given dependencies (tests pass in-memory fakes). */
export function createHandler(deps: CodeRequestDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => requestCode(event, deps);
}

/** Bounded SDK calls, shared by the API functions (../aws.ts). */
export { HTTP_TIMEOUTS, clientSettings };

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** Clients are created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  live ??= createHandler({
    store: new DynamoSignInStore(new DynamoDBClient(clientSettings()), TABLE_NAME),
    mailer: new SesCodeMailer(new SESv2Client(clientSettings())),
    now: () => new Date(),
    randomInt,
    randomBytes,
    log: logEntry,
    sleep: async (ms) => {
      await delay(ms);
    },
  });
  return live(event);
}
