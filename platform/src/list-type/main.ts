// `npm run backfill-list-type` (ticket 3.10): run once by Franck after the deploy that adds the dashboard index, with his
// own AWS credentials (`AWS_PROFILE=franck`). Prints counts only. The work lives in ./backfill.ts.
import { Agent, type AgentOptions } from "node:https";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { REGION, TABLE_NAME } from "../../api/settings.js";
import { proxyFromEnv } from "../smoke/logic.js";
import { backfillListType, formatBackfill } from "./backfill.js";

// The AWS SDK ignores HTTPS_PROXY / https_proxy: route through it where one is set (see .claude/rules/platform.md).
const client = new DynamoDBClient({
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
  }),
});

backfillListType(client, TABLE_NAME).then(
  (counts) => {
    console.log(formatBackfill(counts));
  },
  (error: unknown) => {
    // The error's name only: a message could quote a key.
    console.error(`Backfill failed: ${error instanceof Error ? error.name : "unknown error"}`);
    process.exitCode = 1;
  },
);
