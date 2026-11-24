// `npm run eval -- guardrails | clarify | spec | readiness` (tickets 1.7, 1.8, 1.9 and 2.7): the real guardrail
// check, the real step 1 or step 2 answer call, or the real readiness check, against Claude on Bedrock with your
// own AWS credentials.
// The scoring lives in ./logic.ts; spec diagrams are parsed and drawn by Mermaid in Chromium (./diagram.ts).
import { readFileSync } from "node:fs";
import { Agent, type AgentOptions } from "node:https";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { answerMessage, answerRequest } from "../../api/conversation/answer.js";
import { extractSpec, parseSpec } from "../../api/conversation/spec.js";
import { checkGuardrail } from "../../api/conversation/guardrail.js";
import { checkReadiness } from "../../api/conversation/readiness.js";
import { BedrockModel, usageOf } from "../../api/conversation/model.js";
import { MODEL_ID, REGION } from "../../api/settings.js";
import { proxyFromEnv, redactError } from "../smoke/logic.js";
import { openDiagramChecker } from "./diagram.js";
import {
  exitCode,
  formatClarifyResult,
  formatClarifySummary,
  formatResult,
  formatSpecResult,
  formatSpecSummary,
  formatSummary,
  formatReadinessResult,
  formatReadinessSummary,
  parseReadinessExamples,
  runReadinessEval,
  parseClarifyExamples,
  parseSpecExamples,
  runSpecEval,
  parseEvalArgs,
  parseGuardrailExamples,
  runClarifyEval,
  runGuardrailEval,
  USAGE,
} from "./logic.js";

const examplesFile = (suite: string): URL => new URL(`../../api/eval/${suite}.json`, import.meta.url);

async function main(): Promise<number> {
  const parsed = parseEvalArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
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
  const file = readFileSync(examplesFile(parsed.suite), "utf8");
  if (parsed.suite === "spec") {
    const examples = parseSpecExamples(file);
    if ("error" in examples) {
      console.error(examples.error);
      return 1;
    }
    console.log(`Model: ${MODEL_ID} (${REGION}), ${examples.length} examples`);
    const diagrams = await openDiagramChecker();
    try {
      const results = await runSpecEval(
        examples,
        async (example) => {
          // The raw answer to the same request the AI worker sends, so a wrong one can be shown and scored.
          const { request } = answerRequest("spec", example.history, example.text, example.currentSpec);
          const reply = await model.converse(request);
          const spec = extractSpec(reply.text).spec;
          const diagram = spec === undefined ? undefined : await diagrams.check(parseSpec(spec).diagram);
          return { text: reply.text, usage: usageOf(reply), ...(diagram === undefined ? {} : { diagram }) };
        },
        (result, index) => console.log(formatSpecResult(result, index)),
      );
      for (const line of formatSpecSummary(results)) console.log(line);
      return exitCode(results);
    } finally {
      await diagrams.close();
    }
  }
  if (parsed.suite === "readiness") {
    const examples = parseReadinessExamples(file);
    if ("error" in examples) {
      console.error(examples.error);
      return 1;
    }
    console.log(`Model: ${MODEL_ID} (${REGION}), ${examples.length} examples`);
    const results = await runReadinessEval(
      examples,
      (example) => checkReadiness(model, example.spec),
      (result, index) => console.log(formatReadinessResult(result, index)),
    );
    for (const line of formatReadinessSummary(results)) console.log(line);
    return exitCode(results);
  }
  if (parsed.suite === "clarify") {
    const examples = parseClarifyExamples(file);
    if ("error" in examples) {
      console.error(examples.error);
      return 1;
    }
    console.log(`Model: ${MODEL_ID} (${REGION}), ${examples.length} examples`);
    const results = await runClarifyEval(
      examples,
      async (example) => {
        const answer = await answerMessage(model, "clarify", example.history, example.text);
        return { text: answer.text, offersSpec: answer.offersSpec, usage: usageOf(answer) };
      },
      (result, index) => console.log(formatClarifyResult(result, index)),
    );
    for (const line of formatClarifySummary(results)) console.log(line);
    return exitCode(results);
  }
  const examples = parseGuardrailExamples(file);
  if ("error" in examples) {
    console.error(examples.error);
    return 1;
  }
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
