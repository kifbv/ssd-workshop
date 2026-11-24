// `npm run -s smoke -- <command>`: proves the account can reach Bedrock, read its quotas and send email,
// that the live site sends sign-in codes, and which GitHub account the platform's GitHub App reaches (ticket 2.6).
// The AWS calls stay thin; the rules live in ./logic.ts.
// Always run it with `-s`: without it npm echoes the command line, so `ses <address>` or `signin <address>` would print the
// recipient address. The root script calls this workspace with `-s` already; the outer `-s` is on you.
import { randomInt } from "node:crypto";
import { Agent, type AgentOptions } from "node:https";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  ServiceQuotasClient,
  paginateListAWSDefaultServiceQuotas,
  paginateListServiceQuotas,
  type ServiceQuota,
} from "@aws-sdk/client-service-quotas";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { appJwt, findInstallation, getApp, parseGitHubSecret, type GitHubDeps } from "../../api/github/app.js";
import { GITHUB_SECRET_NAME } from "../../api/settings.js";
import {
  CONFIGURATION_SET,
  REGION,
  SENDER,
  USAGE,
  buildSignInRequest,
  buildTestEmail,
  findModelQuotas,
  formatGitHubReport,
  formatSignInResult,
  formatLatency,
  formatQuotaLine,
  maskEmail,
  parseArgs,
  proxyFromEnv,
  redactError,
  resolveModelId,
  type QuotaEntry,
} from "./logic.js";

// The AWS SDK ignores HTTPS_PROXY / https_proxy. Where one is set (Claude sessions sign requests in their proxy),
// route through it with Node's built-in proxy support (Node 22.21+); elsewhere connect directly.
// The handler is an explicit HTTP/1.1 NodeHttpHandler: the Bedrock runtime client defaults to an HTTP/2
// handler, which ignores an `httpsAgent` given as plain options and would bypass the proxy.
const clientConfig = {
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
  }),
};

async function smokeBedrock(modelId: string): Promise<void> {
  const client = new BedrockRuntimeClient(clientConfig);
  const started = performance.now();
  const response = await client.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: "Reply with the single word: ready" }] }],
      inferenceConfig: { maxTokens: 16 },
    }),
  );
  const latency = performance.now() - started;
  const answer = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  console.log(`Model:   ${modelId} (${REGION})`);
  console.log(`Answer:  ${answer || "(empty)"}`);
  console.log(`Latency: ${formatLatency(latency)}`);
  console.log(`Tokens:  ${response.usage?.inputTokens ?? "?"} in, ${response.usage?.outputTokens ?? "?"} out`);
}

function toEntries(quotas: readonly ServiceQuota[]): QuotaEntry[] {
  return quotas.flatMap((q) =>
    q.QuotaCode && q.QuotaName && q.Value !== undefined
      ? [{ code: q.QuotaCode, name: q.QuotaName, value: q.Value }]
      : [],
  );
}

async function smokeQuota(modelId: string): Promise<void> {
  const client = new ServiceQuotasClient(clientConfig);
  const applied: ServiceQuota[] = [];
  for await (const page of paginateListServiceQuotas({ client }, { ServiceCode: "bedrock" })) {
    applied.push(...(page.Quotas ?? []));
  }
  const defaults: ServiceQuota[] = [];
  for await (const page of paginateListAWSDefaultServiceQuotas({ client }, { ServiceCode: "bedrock" })) {
    defaults.push(...(page.Quotas ?? []));
  }
  const quotas = findModelQuotas(modelId, toEntries(applied), toEntries(defaults));
  console.log(`Model: ${modelId} (${REGION}, cross-region inference)`);
  console.log(formatQuotaLine("Tokens per minute", quotas.tokens));
  console.log(formatQuotaLine("Requests per minute", quotas.requests));
}

async function smokeSes(address: string): Promise<void> {
  const client = new SESv2Client(clientConfig);
  const email = buildTestEmail(String(randomInt(100000, 1000000)));
  const response = await client.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER,
      // Without it SES uses the rankly.games identity's default set (rankly-dev), which we may not use.
      ConfigurationSetName: CONFIGURATION_SET,
      Destination: { ToAddresses: [address] },
      Content: {
        Simple: {
          Subject: { Data: email.subject, Charset: "UTF-8" },
          Body: { Text: { Data: email.text, Charset: "UTF-8" } },
        },
      },
    }),
  );
  console.log(`Sent from ${SENDER} to ${maskEmail(address)} (${REGION})`);
  console.log(`MessageId: ${response.MessageId ?? "(none)"}`);
}

// Plain fetch: no AWS call, so no credentials. Node's fetch does not use HTTPS_PROXY (Claude sessions
// cannot reach workshop.rankly.games anyway); run it from your own machine.
async function smokeSignIn(address: string): Promise<boolean> {
  const request = buildSignInRequest(address);
  const response = await fetch(request.url, request.init);
  console.log(formatSignInResult(address, response.status, await response.text()));
  return response.status === 202;
}

// Reads the GitHub App's secret with the caller's AWS credentials (Franck's), signs the app's JWT and asks GitHub
// which account the app is installed on and with which rights. It mints no installation token, and prints only
// the report's fields: never the secret, the key or the JWT. Node's fetch does not use HTTPS_PROXY: run it from
// your own machine.
async function smokeGitHub(): Promise<void> {
  const client = new SecretsManagerClient(clientConfig);
  const secret = await client.send(new GetSecretValueCommand({ SecretId: GITHUB_SECRET_NAME }));
  const credentials = parseGitHubSecret(secret.SecretString);
  const deps: GitHubDeps = { fetch: (url, init) => fetch(url, init), now: () => new Date(), log: () => undefined };
  const jwt = appJwt(credentials, deps.now());
  const app = await getApp(deps, jwt);
  const installation = await findInstallation(deps, jwt);
  console.log(formatGitHubReport(app, installation));
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  switch (parsed.command) {
    case "bedrock":
      await smokeBedrock(resolveModelId(process.env));
      break;
    case "quota":
      await smokeQuota(resolveModelId(process.env));
      break;
    case "ses":
      await smokeSes(parsed.address);
      break;
    case "github":
      await smokeGitHub();
      break;
    case "signin":
      return (await smokeSignIn(parsed.address)) ? 0 : 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`Smoke check failed: ${redactError(message)}`);
    process.exitCode = 1;
  },
);
