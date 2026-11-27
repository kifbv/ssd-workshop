import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { TranscribeClient } from "@aws-sdk/client-transcribe";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { handleAppAiRequest, type AppAiDeps, type AppAiLogEntry } from "../app-ai/ai.js";
import { AwsTranscriber, BedrockAppAiModel, DynamoAppAiStore, S3MediaReader } from "../app-ai/store.js";
import { pauseBeforeUploadRetry } from "../app-media/media.js";
import { DynamoAppTokenStore } from "../app-token/store.js";
import { clientSettings } from "../aws.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { APP_MEDIA_BUCKET_NAME, MODELS, REGION, TABLE_NAME } from "../settings.js";

/**
 * The AI tasks for apps (ticket 3.21): `POST` and `OPTIONS /api/apps/{nickname}/ai`. No session: an app write token
 * (ticket 3.24). Rules in ../app-ai/.
 */

/**
 * One Bedrock attempt of at most 20 s (a Haiku call with a photo takes a few seconds), so a slow call ends inside the
 * function's timeout (APP_AI_TIMEOUT_SECONDS in infra/lib/api-stack.ts) and API Gateway's 30 s. A retry would bill twice.
 */
export const BEDROCK_TIMEOUTS = { connectionTimeout: 1000, requestTimeout: 20_000 } as const;

/** S3 reads of up to 4 MB, as the media API's (handlers/app-media.ts S3_TIMEOUTS). */
export const S3_TIMEOUTS = { connectionTimeout: 1000, requestTimeout: 8000 } as const;

/** One JSON line per request: method, task, outcome, status, cost and the writer once the token passed. */
export function logEntry(entry: AppAiLogEntry): void {
  console.log(JSON.stringify(entry));
}

export function createHandler(deps: AppAiDeps): (event: HttpRequest) => Promise<HttpResponse> {
  return (event) => handleAppAiRequest(event, deps);
}

let live: ((event: HttpRequest) => Promise<HttpResponse>) | undefined;

/** The clients are created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: HttpRequest): Promise<HttpResponse> {
  if (live === undefined) {
    const table = new DynamoDBClient(clientSettings());
    const s3 = new S3Client({ region: REGION, maxAttempts: 2, requestHandler: new NodeHttpHandler({ ...S3_TIMEOUTS }) });
    const bedrock = new BedrockRuntimeClient({ region: REGION, maxAttempts: 1, requestHandler: new NodeHttpHandler({ ...BEDROCK_TIMEOUTS }) });
    const transcribe = new TranscribeClient(clientSettings());
    live = createHandler({
      store: new DynamoAppAiStore(table, TABLE_NAME),
      tokens: new DynamoAppTokenStore(table, TABLE_NAME),
      media: new S3MediaReader(s3, APP_MEDIA_BUCKET_NAME),
      model: new BedrockAppAiModel(bedrock, MODELS.appAi.modelId),
      transcriber: new AwsTranscriber(transcribe, s3, APP_MEDIA_BUCKET_NAME),
      now: () => new Date(),
      log: logEntry,
      pause: () => pauseBeforeUploadRetry(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  }
  return live(event);
}
