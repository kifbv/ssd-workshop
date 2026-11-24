/**
 * The builder's entry point (ticket 2.8; ticket 2.9 packages it as the `ssd-workshop-builder` image and starts it as a
 * Fargate task): `tsx platform/builder/main.ts`, with
 *
 * - `BUILD_ID`: the build to run (the nickname and participant come from the stored build record, never from here);
 * - `BUILDER_GITHUB_TOKEN`: the build's one-repository token (`builderToken`, ticket 2.6), minted by the launcher.
 *
 * The token is removed from this process's environment as soon as it is read, so the agent's process can never inherit
 * it (its environment is built from an allow-list anyway). AWS credentials are the task role's. Exit code 0 when the
 * build was handed to the deployer or there was nothing to do, 1 when it failed. Output: one JSON line per phase
 * (./runner.ts), never a token, nickname, build id, path or error message.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, type AgentOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { downloadArchive } from "../api/deploy/github.js";
import { DEPLOY_QUEUE_URL, MODELS, REGION, TABLE_NAME } from "../api/settings.js";
import { errorName } from "../api/sign-in/code-request.js";
import { ClaudeAgent } from "./agent.js";
import { SqsDeployQueue } from "./queue.js";
import { DynamoBuildRecords } from "./records.js";
import { jobFromEnvironment, runBuild, type RunnerDeps } from "./runner.js";

/** AWS clients: explicit region, bounded tries, and the session's proxy when one is set (local runs). */
function awsSettings() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return {
    region: REGION,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 3000,
      requestTimeout: 10_000,
      ...(proxy ? { httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) } : {}),
    }),
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
    agent: new ClaudeAgent(process.env, () => mkdtemp(join(tmpdir(), "ssd-agent-home-"))),
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

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(JSON.stringify({ event: "builder", phase: "finish", outcome: "error", error: errorName(error) }));
    process.exitCode = 1;
  },
);
