// `npm run flags -- list | approve <nickname> | reject <nickname>` (ticket 1.7). Run from your own
// machine with your own AWS credentials (AWS_PROFILE). The flow lives in ./command.ts; this file
// only wires in the real world.
import { Agent, type AgentOptions } from "node:https";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { SqsMessageQueue } from "../../api/conversation/queue.js";
import { AI_QUEUE_URL, REGION, TABLE_NAME } from "../../api/settings.js";
import { proxyFromEnv } from "../smoke/logic.js";
import { runFlags } from "./command.js";
import { DynamoFlagsStore } from "./store.js";

// The AWS SDK ignores HTTPS_PROXY / https_proxy: route through it where one is set (see .claude/rules/platform.md).
const clientConfig = () => ({
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
  }),
});

runFlags(process.argv.slice(2), {
  createStore: () => new DynamoFlagsStore(new DynamoDBClient(clientConfig()), TABLE_NAME),
  createQueue: () => new SqsMessageQueue(new SQSClient(clientConfig()), AI_QUEUE_URL),
  now: () => new Date(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then((code) => {
  process.exitCode = code;
});
