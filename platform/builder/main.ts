/**
 * The builder's entry point (ticket 2.8; ticket 2.9 packages it as the `ssd-workshop-builder` image and starts it as a
 * Fargate task, image platform/builder/Dockerfile, which runs this file bundled): `tsx platform/builder/main.ts`, with
 *
 * - `BUILD_ID`: the build to run (the nickname and participant come from the stored build record, never from here);
 * - `BUILDER_GITHUB_TOKEN`: the build's one-repository token (`builderToken`, ticket 2.6), minted by the launcher and
 *   passed in RunTask's container override (ticket 2.9; Franck accepted that ECS and CloudTrail show it for its hour,
 *   decision "(2.9) Token hand-off"). Never the app's key or the organization-wide token;
 * - `BUILDER_BASE_COMMIT`: the commit the launcher prepared on `main` (the build starts from it or fails);
 * - `BUILDER_ATTEMPT_ID`: the launch this task belongs to (every write on the build is conditional on it).
 *
 * The token is deleted from `process.env` as soon as it is read. That keeps it out of anything that copies the
 * environment later, but it is not what keeps it from the agent: the agent's process gets an explicit environment
 * built from an allow-list (./agent.ts), and `/proc/<pid>/environ` of this process still holds the original value,
 * which the agent cannot read because its file tools are confined to the workspace (./permissions.ts). AWS
 * credentials are the task role's and stay in this process: the agent reaches Bedrock only through the local proxy
 * (./bedrock-proxy.ts). Exit code 0 when the build was handed to the deployer or there was nothing to do, 1 when it
 * failed; the process exits as soon as the outcome is recorded, so a stray child process cannot keep the task alive.
 * Output: one JSON line per phase (./runner.ts), never a token, nickname, build id, path or error message.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { downloadArchive } from "../api/deploy/github.js";
import { DEPLOY_QUEUE_URL, MODELS, REGION, TABLE_NAME } from "../api/settings.js";
import { errorName } from "../api/sign-in/code-request.js";
import { SqsDeployQueue } from "./queue.js";
import { builderAgent, proxyAgent } from "./production.js";
import { DynamoBuildRecords } from "./records.js";
import { exitWhenDone, jobFromEnvironment, runBuild, type RunnerDeps } from "./runner.js";

/** AWS clients: explicit region, bounded tries, and the session's proxy when one is set (local runs). */
function awsSettings() {
  const agent = proxyAgent();
  return {
    region: REGION,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 10_000, ...(agent ? { httpsAgent: agent } : {}) }),
  };
}

async function main(): Promise<number> {
  const job = jobFromEnvironment(process.env);
  if ("error" in job) {
    console.error(JSON.stringify({ event: "builder", phase: "start", outcome: "error", error: job.error }));
    return 1;
  }
  const deps: RunnerDeps = {
    records: new DynamoBuildRecords(new DynamoDBClient(awsSettings()), TABLE_NAME),
    github: { fetch: (url, init) => fetch(url, init), now: () => new Date(), log: (entry) => console.log(JSON.stringify(entry)) },
    download: (url) => downloadArchive(url),
    // No web proxy settings for the agent (./production.ts). The Bedrock proxy logs only what it refused or could not
    // forward (a path's shape and a status), never a header or body.
    agent: builderAgent(process.env, (entry) => {
      if (entry.outcome !== "forwarded") console.log(JSON.stringify(entry));
    }),
    queue: new SqsDeployQueue(new SQSClient(awsSettings()), DEPLOY_QUEUE_URL),
    makeWorkspace: () => mkdtemp(join(tmpdir(), "ssd-build-")),
    removeWorkspace: (dir) => rm(dir, { recursive: true, force: true }),
    model: MODELS.build,
    now: () => new Date(),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
  const outcome = await runBuild(job, deps);
  return outcome === "failed" ? 1 : 0;
}

void exitWhenDone(main, (code) => process.exit(code), (error) => {
  console.error(JSON.stringify({ event: "builder", phase: "finish", outcome: "error", error: errorName(error) }));
});
