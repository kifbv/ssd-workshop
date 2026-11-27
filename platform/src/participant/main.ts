// `npm run participant -- reset <nickname> [--yes]` (ticket 2.13). Run from your own machine with your own AWS
// credentials (AWS_PROFILE=franck). The flow lives in ./command.ts; this file only wires in the real world. Node's
// fetch (GitHub) does not use HTTPS_PROXY: run it from your own machine, as `npm run smoke -- github`.
import { Agent, type AgentOptions } from "node:https";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseGitHubSecret } from "../../api/github/app.js";
import { openRepositoryAdmin } from "../../api/github/repository.js";
import { MEDIA_KEY_PREFIX } from "../../api/app-media/media.js";
import { CloudFrontCdn, S3AppObjects } from "../../api/deploy/aws.js";
import { APP_MEDIA_BUCKET_NAME, DISTRIBUTION_ID, GITHUB_SECRET_NAME, REGION, TABLE_NAME } from "../../api/settings.js";
import { proxyFromEnv } from "../smoke/logic.js";
import { runParticipant, type AppMediaFiles } from "./command.js";
import { DynamoParticipantResetStore } from "./store.js";

// The AWS SDK ignores HTTPS_PROXY / https_proxy: route through it where one is set (see .claude/rules/platform.md).
const clientConfig = () => ({
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
  }),
});

/** Ticket 3.18: the app's files in the media bucket, and the distribution (CloudFront's API lives in us-east-1). */
function mediaFiles(): AppMediaFiles {
  const objects = new S3AppObjects(new S3Client(clientConfig()), APP_MEDIA_BUCKET_NAME);
  const cdn = new CloudFrontCdn(new CloudFrontClient({ ...clientConfig(), region: "us-east-1" }), DISTRIBUTION_ID);
  const prefix = (nickname: string) => `${MEDIA_KEY_PREFIX}${nickname.toLowerCase()}/`;
  return {
    list: async (nickname) => (await objects.list(prefix(nickname))).map((object) => object.key),
    remove: (keys) => objects.remove(keys),
    forget: (nickname) => cdn.invalidate([`/${prefix(nickname)}*`], `participant-reset-${nickname.toLowerCase()}-${Date.now()}`),
  };
}

runParticipant(process.argv.slice(2), {
  createStore: () => new DynamoParticipantResetStore(new DynamoDBClient(clientConfig()), TABLE_NAME),
  createMediaFiles: mediaFiles,
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
