import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { clientSettings } from "../aws.js";
import { handleConversationRequest, type ConversationDeps, type ConversationLogEntry } from "../conversation/conversation.js";
import { SqsMessageQueue } from "../conversation/queue.js";
import { DynamoConversationStore } from "../conversation/store.js";
import { DynamoAppTokenStore } from "../app-token/store.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { DynamoParticipantStore } from "../participant/store.js";
import { AI_QUEUE_URL, TABLE_NAME } from "../settings.js";

/**
 * The conversation routes (ticket 1.7): `POST /api/conversation/messages` and
 * `GET /api/conversation/messages/{id}`, behind the one session check. Rules in ../conversation/.
 */

/** One JSON line per request: route, outcome and an error name only (never text, ids or tokens). */
export function logEntry(entry: ConversationLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The handler on given dependencies (tests pass in-memory fakes). */
export function createHandler(deps: ConversationDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => handleConversationRequest(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The clients are created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  if (live === undefined) {
    const dynamo = new DynamoDBClient(clientSettings());
    live = createHandler({
      sessions: new DynamoParticipantStore(dynamo, TABLE_NAME),
      store: new DynamoConversationStore(dynamo, TABLE_NAME),
      queue: new SqsMessageQueue(new SQSClient(clientSettings()), AI_QUEUE_URL),
      editLinks: new DynamoAppTokenStore(dynamo, TABLE_NAME),
      now: () => new Date(),
      randomBytes,
      log: logEntry,
    });
  }
  return live(event);
}
