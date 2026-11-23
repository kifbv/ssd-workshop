import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { clientSettings } from "../aws.js";
import { BedrockModel } from "../conversation/model.js";
import { parseJob } from "../conversation/state.js";
import { DynamoConversationStore } from "../conversation/store.js";
import { errorName } from "../sign-in/code-request.js";
import { processJob, type WorkerDeps, type WorkerLogEntry } from "../conversation/worker.js";
import { MODEL_ID, REGION, TABLE_NAME } from "../settings.js";

/**
 * The AI worker (ticket 1.7): one SQS record per invocation (batch size 1), holding a participant id
 * and a message id. Rules in ../conversation/worker.ts.
 */

/** The parts of an SQS event the worker reads. */
export interface SqsEvent {
  Records?: { body?: string }[];
}

/** The part of the Lambda context the worker reads. */
export interface WorkerContext {
  getRemainingTimeInMillis(): number;
}

/** Time kept back from the Lambda timeout to store the outcome after the AI calls are cut off. */
export const WRITE_RESERVE_MS = 30_000;

/** How long the AI calls of a job may take: the Lambda's remaining time less the write reserve (at least 1 s). */
export function aiDeadlineMs(remainingMs: number): number {
  return Math.max(1000, remainingMs - WRITE_RESERVE_MS);
}

/** One JSON line per job: outcome, verdict and an error name only (never text, prompt, reply or ids). */
export function logEntry(entry: WorkerLogEntry | { event: "ai-worker"; outcome: "error"; error: string }): void {
  console.log(JSON.stringify(entry));
}

/** What the Lambda runtime sees of a job that failed: no message or stack of the original error. */
export const JOB_FAILED = "job failed";

/**
 * The handler on given dependencies (tests pass in-memory fakes). A thrown error makes SQS deliver
 * the job again. The original error is logged by name only, and a new, bare error is thrown: the
 * Lambda runtime would otherwise write the original's message and stack to CloudWatch.
 */
export function createHandler(deps: WorkerDeps): (event: SqsEvent, context?: WorkerContext) => Promise<void> {
  return async (event, context) => {
    const signal = AbortSignal.timeout(aiDeadlineMs(context?.getRemainingTimeInMillis() ?? 300_000));
    for (const record of event.Records ?? []) {
      // The original error goes no further than its name (deliberately not attached as a cause).
      const failed = await processJob(parseJob(record.body), deps, signal).then(
        () => undefined,
        (error: unknown) => errorName(error),
      );
      if (failed !== undefined) {
        logEntry({ event: "ai-worker", outcome: "error", error: failed });
        throw new Error(JOB_FAILED);
      }
    }
  };
}

let live: ((event: SqsEvent, context?: WorkerContext) => Promise<void>) | undefined;

/** The clients are created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: SqsEvent, context?: WorkerContext): Promise<void> {
  live ??= createHandler({
    store: new DynamoConversationStore(new DynamoDBClient(clientSettings()), TABLE_NAME),
    // Up to 3 attempts (throttling backs off); each call is also cut off at the job's deadline.
    model: new BedrockModel(
      new BedrockRuntimeClient({
        region: REGION,
        maxAttempts: 3,
        requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 120_000 }),
      }),
      MODEL_ID,
    ),
    modelId: MODEL_ID,
    now: () => new Date(),
    log: logEntry,
  });
  return live(event, context);
}
