// `npm run -s smoke -- <command>`: proves the account can reach Bedrock, read its quotas and send email.
// The AWS calls stay thin; the rules live in ./logic.ts.
// Always run it with `-s`: without it npm echoes the command line, so `ses <address>` would print the
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
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  REGION,
  SENDER,
  USAGE,
  buildTestEmail,
  findModelQuotas,
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
const clientConfig = {
  region: REGION,
  ...(proxyFromEnv(process.env) !== undefined && {
    requestHandler: { httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) },
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
