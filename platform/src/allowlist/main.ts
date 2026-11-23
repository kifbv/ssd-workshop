// `npm run -s allowlist -- import <file.csv> | list`: loads and counts the allow-list (ticket 1.3).
// Franck runs it from his own machine with his own AWS credentials (default credential chain).
// The flow lives in ./command.ts and the rules in ./logic.ts; this file only wires in the real world.
import { Agent, type AgentOptions } from "node:https";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { proxyFromEnv } from "../smoke/logic.js";
import { findRepoRoot, runAllowlist } from "./command.js";
import { REGION, TABLE_NAME } from "./logic.js";
import { DynamoAllowListStore } from "./store.js";

// The AWS SDK ignores HTTPS_PROXY / https_proxy: route through it where one is set (see .claude/rules/platform.md).
const clientConfig = {
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
  }),
};

runAllowlist(process.argv.slice(2), {
  repoRoot: findRepoRoot(dirname(fileURLToPath(import.meta.url))),
  createStore: () => new DynamoAllowListStore(new DynamoDBClient(clientConfig), TABLE_NAME),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then((code) => {
  process.exitCode = code;
});
