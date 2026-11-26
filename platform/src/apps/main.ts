// `npm run apps -- refresh` (ticket 3.25). Run from Franck's machine with his own AWS credentials (`AWS_PROFILE=franck`).
// The flow lives in ./command.ts; this file only wires in the real world.
import { Agent, type AgentOptions } from "node:https";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { DEPLOY_QUEUE_URL, REGION, TABLE_NAME } from "../../api/settings.js";
import { proxyFromEnv } from "../smoke/logic.js";
import { runApps } from "./command.js";
import { DynamoLiveApps, SqsRefreshQueue } from "./store.js";

// The AWS SDK ignores HTTPS_PROXY / https_proxy: route through it where one is set (see .claude/rules/platform.md).
const clientConfig = () => ({
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
  }),
});

runApps(process.argv.slice(2), {
  connect: () => ({
    apps: new DynamoLiveApps(new DynamoDBClient(clientConfig()), TABLE_NAME),
    queue: new SqsRefreshQueue(new SQSClient(clientConfig()), DEPLOY_QUEUE_URL),
  }),
  now: () => new Date(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then((code) => {
  process.exitCode = code;
});
