import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseGitHubSecret } from "../github/app.js";
import { readTemplateFolder } from "../github/template-files.js";
import { DynamoLaunchRecords, EcsBuildTasks, SqsDeadLetters } from "../launcher/aws.js";
import { processLaunch, runCheck, type LauncherLogEntry } from "../launcher/launcher.js";
import { BUILD_CHECK_QUEUE_NAME, BUILD_DLQ_URL, BUILD_QUEUE_NAME, DEPLOY_DLQ_URL, GITHUB_SECRET_NAME, REGION, TABLE_NAME } from "../settings.js";

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
 */

export interface LauncherEvent {
  Records?: { body?: string; eventSourceARN?: string }[];
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

export async function handler(event: LauncherEvent, context?: LauncherContext): Promise<void> {
  const records = event.Records ?? [];
  const sources = records.map((record) => sourceOf(record.eventSourceARN));
  if (sources.some((source) => source === "other")) log({ event: "launcher", outcome: "invalid", durationMs: 0 });
  if (!sources.some((source) => source !== "other")) return;

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
  const now = () => new Date();

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
      return;
    }
    if (source !== "launch") continue;
    const left = context?.getRemainingTimeInMillis();
    const deadline = new AbortController();
    const timer =
      typeof left === "number" && Number.isFinite(left) ? setTimeout(() => deadline.abort(), Math.max(0, left - LAUNCH_RESERVE_MS)) : undefined;
    try {
      await processLaunch(record.body, {
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
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
