// `npm run eval -- guardrails | clarify | spec | readiness | build | suggestions | change` (tickets 1.7, 1.8, 1.9, 2.7, 2.8, 3.6 and 3.7): the real
// guardrail check, the real step 1 or step 2 answer call, the real readiness check, or the real builder (./build.ts),
// against Claude on Bedrock with your own AWS credentials.
// The scoring lives in ./logic.ts; spec diagrams are parsed and drawn by Mermaid in Chromium (./diagram.ts).
import { readFileSync } from "node:fs";
import { Agent, type AgentOptions } from "node:https";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { answerMessage, answerRequest } from "../../api/conversation/answer.js";
import { extractSpec, parseSpec } from "../../api/conversation/spec.js";
import { checkGuardrail, declineReply } from "../../api/conversation/guardrail.js";
import { checkReadiness } from "../../api/conversation/readiness.js";
import { addUsage, BedrockModel, usageOf } from "../../api/conversation/model.js";
import { suggestChanges } from "../../api/conversation/suggestions.js";
import { MODEL_ID, MODELS, REGION, type ModelSetting } from "../../api/settings.js";
import { proxyFromEnv, redactError } from "../smoke/logic.js";
import { BedrockAppAiModel } from "../../api/app-ai/store.js";
import { formatReceiptResult, formatReceiptSummary, readReceipt, RECEIPT_CASES, receiptPhoto, type ReceiptResult } from "./app-ai.js";
import { evalBuild, evalChange, launchBrowser } from "./build.js";
import { openDiagramChecker } from "./diagram.js";
import {
  type BuildEvalResult,
  type ChangeEvalResult,
  CHANGE_EVAL_REQUEST,
  formatChangeResult,
  scoreChange,
  exitCode,
  formatBuildResult,
  formatBuildSummary,
  expectsWebFetch,
  scoreBuild,
  formatClarifyResult,
  formatClarifySummary,
  formatResult,
  formatSpecResult,
  formatSpecSummary,
  formatSummary,
  formatReadinessResult,
  formatReadinessSummary,
  formatSuggestionsResult,
  formatSuggestionsSummary,
  runSuggestionsEval,
  parseReadinessExamples,
  readinessSuiteExamples,
  runReadinessEval,
  parseClarifyExamples,
  parseSpecExamples,
  runSpecEval,
  parseEvalArgs,
  parseGuardrailExamples,
  runClarifyEval,
  runGuardrailEval,
  mediaKindOf,
  USAGE,
} from "./logic.js";

const examplesFile = (suite: string): URL => new URL(`../../api/eval/${suite}.json`, import.meta.url);

/** The build suite: the readiness file's workshop example specs, one at a time, through the real builder. */
async function runBuildSuite(modelId: string | undefined, only: number | undefined): Promise<number> {
  const all = parseReadinessExamples(readFileSync(examplesFile("readiness"), "utf8"));
  if ("error" in all) {
    console.error(all.error);
    return 1;
  }
  // Ticket 3.19: then the build file's media cases (a photo gallery, voice messages), examples 5 and 6.
  const media = parseReadinessExamples(readFileSync(examplesFile("build"), "utf8"));
  if ("error" in media) {
    console.error(media.error);
    return 1;
  }
  const examples = [...all.filter((example) => example.category === "example"), ...media];
  if (only !== undefined && only > examples.length) {
    console.error(`there are ${examples.length} example specs`);
    return 1;
  }
  const chosen = only === undefined ? examples : examples.slice(only - 1, only);
  const model: ModelSetting = modelId === undefined ? MODELS.build : { modelId, price: MODELS.build.price };
  console.log(`Model: ${model.modelId} (${REGION}), ${chosen.length} example spec(s)`);
  const browser = await launchBrowser();
  try {
    const results: BuildEvalResult[] = [];
    for (const [i, example] of chosen.entries()) {
      let result: BuildEvalResult;
      try {
        const outcome = await evalBuild(example.spec, model, browser, (entry) => console.log(`     . ${JSON.stringify(entry)}`), mediaKindOf(example.category));
        result = { example, outcome, ...scoreBuild(outcome, expectsWebFetch(example.spec)) };
      } catch (error) {
        result = { example, pass: false, detail: `eval failed: ${redactError(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}` };
      }
      results.push(result);
      console.log(formatBuildResult(result, i));
    }
    for (const line of formatBuildSummary(results)) console.log(line);
    return exitCode(results);
  } finally {
    await browser.close();
  }
}

/**
 * The change suite (ticket 3.7): the fitness example (the readiness file's first workshop example) built, then changed
 * by a change build after the real change call wrote the new version.
 */
async function runChangeSuite(changeModel: BedrockModel): Promise<number> {
  const all = parseReadinessExamples(readFileSync(examplesFile("readiness"), "utf8"));
  if ("error" in all) {
    console.error(all.error);
    return 1;
  }
  const fitness = all.find((example) => example.category === "example");
  if (fitness === undefined) {
    console.error("no workshop example spec");
    return 1;
  }
  console.log(`Model: ${MODELS.build.modelId} (${REGION}) for the builds, ${MODEL_ID} for the change call; ${fitness.name}: "${CHANGE_EVAL_REQUEST}"`);
  const browser = await launchBrowser();
  try {
    let result: ChangeEvalResult;
    try {
      const outcome = await evalChange(fitness.spec, CHANGE_EVAL_REQUEST, MODELS.build, changeModel, browser, (entry) => console.log(`     . ${JSON.stringify(entry)}`));
      result = { outcome, ...scoreChange(outcome) };
    } catch (error) {
      result = { pass: false, detail: `eval failed: ${redactError(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}` };
    }
    for (const line of formatChangeResult(result)) console.log(line);
    return exitCode([result]);
  } finally {
    await browser.close();
  }
}

/** The app-ai suite (ticket 3.21): read-photo on the synthetic receipts. */
async function runAppAiSuite(model: BedrockAppAiModel): Promise<number> {
  console.log(`Model: ${MODELS.appAi.modelId} (${REGION}), ${RECEIPT_CASES.length} synthetic receipts`);
  const browser = await launchBrowser();
  try {
    const results: ReceiptResult[] = [];
    for (const [i, receipt] of RECEIPT_CASES.entries()) {
      const photo = await receiptPhoto(browser, receipt);
      console.log(`     . ${receipt.name}: JPEG of ${photo.length} bytes`);
      const result = await readReceipt(model, receipt, photo);
      results.push(result);
      console.log(formatReceiptResult(result, i));
    }
    for (const line of formatReceiptSummary(results)) console.log(line);
    return exitCode(results);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const parsed = parseEvalArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.suite === "build") return runBuildSuite(parsed.model, parsed.example);
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
  if (parsed.suite === "change") return runChangeSuite(model);
  if (parsed.suite === "app-ai") return runAppAiSuite(new BedrockAppAiModel(client, MODELS.appAi.modelId));
  if (parsed.suite === "suggestions") {
    // The workshop's example specs (the readiness file's "example" category), as the live specs of built apps.
    const all = parseReadinessExamples(readFileSync(examplesFile("readiness"), "utf8"));
    if ("error" in all) {
      console.error(all.error);
      return 1;
    }
    const examples = all.filter((example) => example.category === "example");
    console.log(`Model: ${MODEL_ID} (${REGION}), ${examples.length} example specs`);
    const results = await runSuggestionsEval(
      examples,
      async (example) => {
        const result = await suggestChanges(model, example.spec);
        const checks = [];
        for (const suggestion of result.suggestions ?? []) checks.push(await checkGuardrail(model, suggestion));
        return {
          ...(result.suggestions === undefined ? {} : { suggestions: result.suggestions }),
          verdicts: checks.map((c) => c.verdict),
          usage: addUsage(result.usage, ...checks.map((c) => c.usage)),
        };
      },
      (result, index) => console.log(formatSuggestionsResult(result, index)),
    );
    for (const line of formatSuggestionsSummary(results)) console.log(line);
    return exitCode(results);
  }
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
    // Ticket 3.20: the build file's photo and voice specs too, so a spec the builder is proved to build also passes the check.
    const examples = readinessSuiteExamples(file, readFileSync(examplesFile("build"), "utf8"));
    if ("error" in examples) {
      console.error(examples.error);
      return 1;
    }
    console.log(`Model: ${MODEL_ID} (${REGION}), ${examples.length} examples`);
    const results = await runReadinessEval(
      examples,
      (example) => checkReadiness(model, example.spec, undefined, example.participantText),
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
    async (text) => {
      const check = await checkGuardrail(model, text);
      // Ticket 3.16: a decline shows the sentence the participant would see, and whether it is the model's own.
      return check.verdict === "decline" ? { ...check, reply: declineReply(check.suggestion, check.decline), localized: check.decline !== undefined } : check;
    },
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
