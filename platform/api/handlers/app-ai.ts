import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { TranscribeClient } from "@aws-sdk/client-transcribe";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { handleAppAiRequest, MODEL_CALL_LIMIT_MS, S3_CALL_LIMIT_MS, TRANSCRIBE_CALL_LIMIT_MS, type AppAiDeps, type AppAiLogEntry } from "../app-ai/ai.js";
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
 * One Bedrock attempt (a retry would bill twice). The socket limits below are a backstop: the call itself is aborted at
 * its `timeoutMs` (at most MODEL_CALL_LIMIT_MS, 20 s, and never past the request's deadline less one settlement), so it
 * ends inside the function's timeout (APP_AI_TIMEOUT_SECONDS in infra/lib/api-stack.ts) and API Gateway's 30 s; the
 * arithmetic is in ../app-ai/ai.ts.
 */
export const BEDROCK_TIMEOUTS = { connectionTimeout: 1000, requestTimeout: MODEL_CALL_LIMIT_MS } as const;

/**
 * S3 (try 2): one attempt, 1 s to connect and 3 s of socket silence, each call raced and aborted at S3_CALL_LIMIT_MS
 * (4 s, body included; a 4 MB read takes well under a second inside the region).
 */
export const S3_TIMEOUTS = { connectionTimeout: 1000, requestTimeout: S3_CALL_LIMIT_MS - 1000 } as const;
export const S3_MAX_ATTEMPTS = 1;

/** Transcribe (try 2): one attempt, each call raced and aborted at TRANSCRIBE_CALL_LIMIT_MS (3 s). */
export const TRANSCRIBE_TIMEOUTS = { connectionTimeout: 1000, requestTimeout: TRANSCRIBE_CALL_LIMIT_MS - 1000 } as const;
export const TRANSCRIBE_MAX_ATTEMPTS = 1;

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
    const s3 = new S3Client({ region: REGION, maxAttempts: S3_MAX_ATTEMPTS, requestHandler: new NodeHttpHandler({ ...S3_TIMEOUTS }) });
    const bedrock = new BedrockRuntimeClient({ region: REGION, maxAttempts: 1, requestHandler: new NodeHttpHandler({ ...BEDROCK_TIMEOUTS }) });
    const transcribe = new TranscribeClient({ region: REGION, maxAttempts: TRANSCRIBE_MAX_ATTEMPTS, requestHandler: new NodeHttpHandler({ ...TRANSCRIBE_TIMEOUTS }) });
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
