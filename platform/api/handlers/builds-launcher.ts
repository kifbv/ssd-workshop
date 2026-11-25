import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseGitHubSecret } from "../github/app.js";
import { readTemplateFolder } from "../github/template-files.js";
import { DynamoLaunchRecords, EcsBuildTasks, SqsDeadLetters, SqsLaunchVisibility } from "../launcher/aws.js";
import { processLaunch, runCheck, type LaunchOutcome, type LauncherLogEntry } from "../launcher/launcher.js";
import {
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
 * only that participant's own later launch messages, never another participant's.
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
 * The answer for one launch record: nothing to deliver again, unless the build waits for a slot. Then its message
 * comes back after LAUNCH_WAIT_SECONDS (if setting that fails, after the queue's own visibility timeout).
 */
export async function answerLaunch(record: LauncherRecord, outcome: LaunchOutcome, visibility: LaunchVisibility): Promise<LauncherResult> {
  if (outcome !== "waiting" || record.messageId === undefined) return { batchItemFailures: [] };
  if (record.receiptHandle !== undefined) await visibility.comeBackAfter(record.receiptHandle, LAUNCH_WAIT_SECONDS).catch(() => undefined);
  return { batchItemFailures: [{ itemIdentifier: record.messageId }] };
}

export interface LauncherContext {
  getRemainingTimeInMillis(): number;
}

/** GitHub calls stop this long before the Lambda's own timeout, so the build's failure is still written. */
export const LAUNCH_RESERVE_MS = 20_000;

const log = (entry: LauncherLogEntry): void => {
  console.log(JSON.stringify(entry));
};

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

  for (const [index, record] of records.entries()) {
    const source = sources[index];
    if (source === "check") {
      await runCheck({
        records: launchRecords,
        tasks,
        launchDeadLetters: new SqsDeadLetters(sqs, BUILD_DLQ_URL),
        deployDeadLetters: new SqsDeadLetters(sqs, DEPLOY_DLQ_URL),
        now,
        log,
      });
      // One check per invocation is enough.
      return result;
    }
    if (source !== "launch") continue;
    const left = context?.getRemainingTimeInMillis();
    const deadline = new AbortController();
    const timer =
      typeof left === "number" && Number.isFinite(left) ? setTimeout(() => deadline.abort(), Math.max(0, left - LAUNCH_RESERVE_MS)) : undefined;
    try {
      const outcome = await processLaunch(record.body, {
        records: launchRecords,
        tasks,
        credentials: async () => {
          const secret = await secrets.send(new GetSecretValueCommand({ SecretId: GITHUB_SECRET_NAME }), { abortSignal: deadline.signal });
          return parseGitHubSecret(secret.SecretString);
        },
        github: { fetch: (url, init) => fetch(url, init), now, log: (entry) => console.log(JSON.stringify(entry)), signal: deadline.signal },
        templateFiles: () => readTemplateFolder(join(process.env.LAMBDA_TASK_ROOT ?? ".", "template")),
        now,
        log,
        // RunTask is cut off at the reserve too, so the failure write always fits (ticket 2.9 try 2).
        signal: deadline.signal,
      });
      result.batchItemFailures.push(...(await answerLaunch(record, outcome, visibility)).batchItemFailures);
    } finally {
      clearTimeout(timer);
    }
  }
  return result;
}
