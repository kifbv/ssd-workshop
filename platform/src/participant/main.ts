// `npm run participant -- reset <nickname> [--yes]` (ticket 2.13). Run from your own machine with your own AWS
// credentials (AWS_PROFILE=franck). The flow lives in ./command.ts; this file only wires in the real world. Node's
// fetch (GitHub) does not use HTTPS_PROXY: run it from your own machine, as `npm run smoke -- github`.
import { Agent, type AgentOptions } from "node:https";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseGitHubSecret } from "../../api/github/app.js";
import { openRepositoryAdmin } from "../../api/github/repository.js";
import { GITHUB_SECRET_NAME, REGION, TABLE_NAME } from "../../api/settings.js";
import { proxyFromEnv } from "../smoke/logic.js";
import { runParticipant } from "./command.js";
import { DynamoParticipantResetStore } from "./store.js";

// The AWS SDK ignores HTTPS_PROXY / https_proxy: route through it where one is set (see .claude/rules/platform.md).
const clientConfig = () => ({
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
  }),
});

runParticipant(process.argv.slice(2), {
  createStore: () => new DynamoParticipantResetStore(new DynamoDBClient(clientConfig()), TABLE_NAME),
  openGitHub: async () => {
    const secret = await new SecretsManagerClient(clientConfig()).send(new GetSecretValueCommand({ SecretId: GITHUB_SECRET_NAME }));
    // GitHub's calls are not logged: the command prints its own lines (never a token or the JWT).
    return openRepositoryAdmin(parseGitHubSecret(secret.SecretString), { fetch: (url, init) => fetch(url, init), now: () => new Date(), log: () => undefined });
  },
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then((code) => {
  process.exitCode = code;
});
