// `npm run eval -- guardrails` (ticket 1.7): the real guardrail check against Claude on Bedrock, with
// your own AWS credentials. The scoring lives in ./logic.ts.
import { readFileSync } from "node:fs";
import { Agent, type AgentOptions } from "node:https";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { checkGuardrail } from "../../api/conversation/guardrail.js";
import { BedrockModel } from "../../api/conversation/model.js";
import { MODEL_ID, REGION } from "../../api/settings.js";
import { proxyFromEnv, redactError } from "../smoke/logic.js";
import { exitCode, formatResult, formatSummary, parseEvalArgs, parseGuardrailExamples, runGuardrailEval, USAGE } from "./logic.js";

const EXAMPLES_FILE = new URL("../../api/eval/guardrails.json", import.meta.url);

async function main(): Promise<number> {
  const parsed = parseEvalArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const examples = parseGuardrailExamples(readFileSync(EXAMPLES_FILE, "utf8"));
  if ("error" in examples) {
    console.error(examples.error);
    return 1;
  }
  // Bedrock runtime defaults to HTTP/2, which ignores a plain httpsAgent option: an explicit
  // HTTP/1.1 handler carries the session proxy where one is set (see .claude/rules/platform.md).
  const client = new BedrockRuntimeClient({
    region: REGION,
    maxAttempts: 4,
    ...(proxyFromEnv(process.env) !== undefined && {
      requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ proxyEnv: process.env } as AgentOptions) }),
    }),
  });
  const model = new BedrockModel(client, MODEL_ID);
  console.log(`Model: ${MODEL_ID} (${REGION}), ${examples.length} examples`);
  const results = await runGuardrailEval(
    examples,
    (text) => checkGuardrail(model, text),
    (result, index) => console.log(formatResult(result, index)),
  );
  for (const line of formatSummary(results)) console.log(line);
  return exitCode(results);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Eval failed: ${redactError(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`);
    process.exitCode = 1;
  },
);
