import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { clientSettings } from "../aws.js";
import { SqsMessageQueue } from "../conversation/queue.js";
import { handleFacilitatorRequest, type FacilitatorDeps, type FacilitatorLogEntry } from "../facilitator/facilitator.js";
import { DynamoFacilitatorStore } from "../facilitator/store.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import type { MessageQueue } from "../conversation/state.js";
import { DynamoParticipantStore } from "../participant/store.js";
import { AI_QUEUE_URL, TABLE_NAME } from "../settings.js";

/**
 * The facilitator routes (ticket 3.10): the dashboard's list (`GET /api/facilitator/participants`), a participant's
 * conversation log and the actions (Retry, Pause, Resume, Add budget, Approve, Reject), behind the one session check and
 * for facilitators and the admin only. Rules in ../facilitator/. Its own function, so its writes are on a role no
 * participant route runs as.
 */

/** One JSON line per request: route and outcome only (never a token, an id, a nickname, a text or the body). */
export function logEntry(entry: FacilitatorLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The handler on given dependencies (tests pass in-memory fakes). */
export function createHandler(deps: FacilitatorDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => handleFacilitatorRequest(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The clients are created once per Lambda instance, on first use (the queue's only when an approval needs it). */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  if (live === undefined) {
    const client = new DynamoDBClient(clientSettings());
    let queue: MessageQueue | undefined;
    live = createHandler({
      // The session check's reads and deletes only (this role cannot claim nicknames).
      sessions: new DynamoParticipantStore(client, TABLE_NAME),
      store: new DynamoFacilitatorStore(client, TABLE_NAME),
      queue: () => (queue ??= new SqsMessageQueue(new SQSClient(clientSettings()), AI_QUEUE_URL)),
      now: () => new Date(),
      log: logEntry,
    });
  }
  return live(event);
}
