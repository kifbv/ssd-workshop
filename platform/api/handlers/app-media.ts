import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { handleAppMediaRequest, pauseBeforeUploadRetry, type AppMediaDeps, type AppMediaLogEntry } from "../app-media/media.js";
import { DynamoAppMediaStore, S3MediaBucket } from "../app-media/store.js";
import { DynamoAppTokenStore } from "../app-token/store.js";
import { clientSettings } from "../aws.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { APP_MEDIA_BUCKET_NAME, REGION, TABLE_NAME } from "../settings.js";

/**
 * The media API for participants' apps (ticket 3.18): `PUT`, `DELETE` and `OPTIONS /api/apps/{nickname}/media/{id}`.
 * No session: uploads and deletes need an app write token (ticket 3.24). Rules in ../app-media/.
 */

/**
 * S3 calls carry up to 4 MB: 1 s to connect, 8 s per request, 2 attempts, well inside the function's timeout
 * (APP_MEDIA_TIMEOUT_SECONDS in infra/lib/api-stack.ts) and API Gateway's 30 s.
 */
export const S3_TIMEOUTS = { connectionTimeout: 1000, requestTimeout: 8000 } as const;

/** One JSON line per request: method, outcome, status, size and kind, and the writer once the token passed. */
export function logEntry(entry: AppMediaLogEntry): void {
  console.log(JSON.stringify(entry));
}

export function createHandler(deps: AppMediaDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => handleAppMediaRequest(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The clients are created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  if (live === undefined) {
    const table = new DynamoDBClient(clientSettings());
    const s3 = new S3Client({ region: REGION, maxAttempts: 2, requestHandler: new NodeHttpHandler({ ...S3_TIMEOUTS }) });
    live = createHandler({
      store: new DynamoAppMediaStore(table, TABLE_NAME, () => pauseBeforeUploadRetry()),
      bucket: new S3MediaBucket(s3, APP_MEDIA_BUCKET_NAME),
      tokens: new DynamoAppTokenStore(table, TABLE_NAME),
      now: () => new Date(),
      log: logEntry,
      pause: () => pauseBeforeUploadRetry(),
    });
  }
  return live(event);
}
