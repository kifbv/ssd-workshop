import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseGitHubSecret } from "../github/app.js";
import { readTemplateFolder } from "../github/template-files.js";
import { DynamoLaunchRecords, EcsBuildTasks, SqsDeadLetters, SqsLaunchVisibility } from "../launcher/aws.js";
import { processLaunch, processSpecRead, runCheck, type LaunchOutcome, type LauncherDeps, type LauncherLogEntry } from "../launcher/launcher.js";
import { SqsMessageQueue } from "../conversation/queue.js";
import { parseSpecReadJob } from "../conversation/state.js";
import {
  AI_QUEUE_URL,
  BUILD_CHECK_QUEUE_NAME,
  BUILD_DLQ_URL,
  BUILD_QUEUE_NAME,
  BUILD_QUEUE_URL,
  DEPLOY_DLQ_URL,
  GITHUB_SECRET_NAME,
  LAUNCH_WAIT_SECONDS,
  REGION,
  TABLE_NAME,
} from "../settings.js";

/**
 * The build launcher Lambda `ssd-workshop-builds-launcher` (ticket 2.9), fed by two queues (batch size 1):
 *
 * - the launch queue `ssd-workshop-builds.fifo`: one build to launch (../launcher/launcher.ts `processLaunch`);
 * - the check queue `ssd-workshop-builds-check`, filled every minute by EventBridge Scheduler: the stuck-build check
 *   (`runCheck`); the message's body is ignored.
 *
 * A record from any other source (an event source mapping someone added) is logged and ignored. Only bare errors are
 * thrown (the runtime would print a message). The environment holds the task definition's ARN and the builds security
 * group's id (`BUILDER_TASK_DEFINITION_ARN`, `BUILDS_SECURITY_GROUP_ID`): no secret. The GitHub App's key is read from
 * Secrets Manager for each launch and never leaves this process; the template's files are bundled next to the code
 * (`template/`, copied from templates/basic at synth time).
 *
 * Ticket 3.4: a build that must wait for a slot (outcome `waiting`) stays `queued`; its message is made visible again
 * after LAUNCH_WAIT_SECONDS and reported as a batch item failure (the launch queue's event source reports batch item
 * failures), so SQS delivers it again then. The message group is the participant's, so a waiting message holds back
 * only that participant's own later launch messages, never another participant's. Ticket 3.5: a build held by the
 * global Stop (outcome `paused`) waits the same way. A running build the Stop put back in the queue has no launch message
 * (the access boundary lets only the AI worker and the scheduler send to the launch queue): after Resume the check
 * launches it itself, with the same deps as a launch, while at least RELAUNCH_MIN_LEFT_MS of the invocation is left.
 * Ticket 3.10: a build held by a facilitator's Pause (outcome `held`) waits the same way; builds a facilitator's Retry
 * put back in the queue are launched by the check like the Stop's.
 *
 * Ticket 3.9: the launch queue also carries spec-read requests (`{"readSpec": {...}}`, from the AI worker, the queue's
 * only sender) for Rebuild from my repository: the launcher, the GitHub App key's only reader, reads the participant's
 * SPEC.md (read-only token), stores it on their request and sends the job back to the AI worker's queue.
 */

export interface LauncherRecord {
  body?: string;
  eventSourceARN?: string;
  messageId?: string;
  receiptHandle?: string;
}

export interface LauncherEvent {
  Records?: LauncherRecord[];
}

/** SQS's partial batch answer: the messages to deliver again. */
export interface LauncherResult {
  batchItemFailures: { itemIdentifier: string }[];
}

export interface LaunchVisibility {
  comeBackAfter(receiptHandle: string, seconds: number): Promise<void>;
}

/**
 * The answer for one launch record: nothing to deliver again, unless the build waits for a slot (or, ticket 3.5, for the
 * end of the global Stop). Then its message
 * comes back after LAUNCH_WAIT_SECONDS (if setting that fails, after the queue's own visibility timeout).
 */
export async function answerLaunch(record: LauncherRecord, outcome: LaunchOutcome, visibility: LaunchVisibility): Promise<LauncherResult> {
  // Ticket 3.10: a build held by a facilitator's Pause of its participant (`held`) waits the same way.
  if ((outcome !== "waiting" && outcome !== "paused" && outcome !== "held") || record.messageId === undefined) return { batchItemFailures: [] };
  if (record.receiptHandle !== undefined) await visibility.comeBackAfter(record.receiptHandle, LAUNCH_WAIT_SECONDS).catch(() => undefined);
  return { batchItemFailures: [{ itemIdentifier: record.messageId }] };
}

export interface LauncherContext {
  getRemainingTimeInMillis(): number;
}

/** GitHub calls stop this long before the Lambda's own timeout, so the build's failure is still written. */
export const LAUNCH_RESERVE_MS = 20_000;

/**
 * Ticket 3.5: the check starts a launch of a build the global Stop put back in the queue only with this much of the
 * invocation left (a launch's GitHub steps and RunTask, plus LAUNCH_RESERVE_MS); the others wait for the next minute.
 */
export const RELAUNCH_MIN_LEFT_MS = 60_000;

/** A deadline LAUNCH_RESERVE_MS before the Lambda's own timeout (none without a context). */
function deadlineOf(context: LauncherContext | undefined): { signal: AbortSignal; clear: () => void } {
  const left = context?.getRemainingTimeInMillis();
  const deadline = new AbortController();
  const timer = typeof left === "number" && Number.isFinite(left) ? setTimeout(() => deadline.abort(), Math.max(0, left - LAUNCH_RESERVE_MS)) : undefined;
  return { signal: deadline.signal, clear: () => clearTimeout(timer) };
}

const log = (entry: LauncherLogEntry): void => {
  console.log(JSON.stringify(entry));
};

/** Ticket 3.5: true when the invocation has at least `ms` left (always, without a context, as in tests). */
export function hasTimeFor(context: LauncherContext | undefined, ms: number): boolean {
  const left = context?.getRemainingTimeInMillis();
  return typeof left !== "number" || !Number.isFinite(left) || left >= ms;
}

/** Which queue a record came from: the queue name is the ARN's last part. */
export function sourceOf(eventSourceArn: string | undefined): "launch" | "check" | "other" {
  const name = eventSourceArn?.split(":").at(-1);
  if (name === BUILD_QUEUE_NAME) return "launch";
  if (name === BUILD_CHECK_QUEUE_NAME) return "check";
  return "other";
}

const settings = () => ({
  region: REGION,
  maxAttempts: 3,
  requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 10_000 }),
});

let clients: { table: DynamoDBClient; ecs: ECSClient; sqs: SQSClient; secrets: SecretsManagerClient } | undefined;

export async function handler(event: LauncherEvent, context?: LauncherContext): Promise<LauncherResult | undefined> {
  const records = event.Records ?? [];
  const sources = records.map((record) => sourceOf(record.eventSourceARN));
  if (sources.some((source) => source === "other")) log({ event: "launcher", outcome: "invalid", durationMs: 0 });
  if (!sources.some((source) => source !== "other")) return undefined;

  const taskDefinition = process.env.BUILDER_TASK_DEFINITION_ARN;
  const securityGroup = process.env.BUILDS_SECURITY_GROUP_ID;
  if (!taskDefinition || !securityGroup) {
    log({ event: "launcher", outcome: "error", error: "MissingSetting", durationMs: 0 });
    throw new Error("launcher not configured");
  }
  clients ??= {
    table: new DynamoDBClient(settings()),
    ecs: new ECSClient(settings()),
    sqs: new SQSClient(settings()),
    secrets: new SecretsManagerClient(settings()),
  };
  const { table, ecs, sqs, secrets } = clients;
  const launchRecords = new DynamoLaunchRecords(table, TABLE_NAME);
  const tasks = new EcsBuildTasks(ecs, taskDefinition, securityGroup);
  const visibility = new SqsLaunchVisibility(sqs, BUILD_QUEUE_URL);
  const now = () => new Date();
  const result: LauncherResult = { batchItemFailures: [] };
  const launchDeps = (signal: AbortSignal): LauncherDeps => ({
    records: launchRecords,
    tasks,
    credentials: async () => {
      const secret = await secrets.send(new GetSecretValueCommand({ SecretId: GITHUB_SECRET_NAME }), { abortSignal: signal });
      return parseGitHubSecret(secret.SecretString);
    },
    github: { fetch: (url, init) => fetch(url, init), now, log: (entry) => console.log(JSON.stringify(entry)), signal },
    templateFiles: () => readTemplateFolder(join(process.env.LAMBDA_TASK_ROOT ?? ".", "template")),
    now,
    log,
    // RunTask is cut off at the reserve too, so the failure write always fits (ticket 2.9 try 2).
    signal,
  });

  for (const [index, record] of records.entries()) {
    const source = sources[index];
    if (source === "check") {
      const deadline = deadlineOf(context);
      try {
        await runCheck({
          records: launchRecords,
          tasks,
          launchDeadLetters: new SqsDeadLetters(sqs, BUILD_DLQ_URL),
          deployDeadLetters: new SqsDeadLetters(sqs, DEPLOY_DLQ_URL),
          relaunch: async (body) => (hasTimeFor(context, RELAUNCH_MIN_LEFT_MS) ? processLaunch(body, launchDeps(deadline.signal)) : undefined),
          now,
          log,
        });
      } finally {
        deadline.clear();
      }
      // One check per invocation is enough.
      return result;
    }
    if (source !== "launch") continue;
    const deadline = deadlineOf(context);
    if (parseSpecReadJob(record.body) !== undefined) {
      try {
        const deps = launchDeps(deadline.signal);
        await processSpecRead(record.body, { ...deps, aiQueue: new SqsMessageQueue(sqs, AI_QUEUE_URL) });
      } catch (error) {
        // A failed table write or send: SQS delivers it again. Only a bare error leaves this process (no message).
        log({ event: "spec-read", outcome: "error", error: error instanceof Error ? error.name : "Error", durationMs: 0 });
        // eslint-disable-next-line preserve-caught-error -- no cause: the error may name the participant's repository
        throw new Error("spec read failed");
      } finally {
        deadline.clear();
      }
      continue;
    }
    try {
      const outcome = await processLaunch(record.body, launchDeps(deadline.signal));
      result.batchItemFailures.push(...(await answerLaunch(record, outcome, visibility)).batchItemFailures);
    } finally {
      deadline.clear();
    }
  }
  return result;
}
