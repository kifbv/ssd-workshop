// `npm run eval -- <suite>` (ticket 1.7): runs a suite of examples against the real model and
// scores the answers. Only `guardrails` exists now; later tickets add `clarify` and `spec` as
// further suites. The scoring is pure and unit tested; ./main.ts calls Bedrock.
import { addUsage } from "../../api/conversation/model.js";
import type { GuardrailVerdict, TokenUsage } from "../../api/types.js";

export const SUITES = ["guardrails"] as const;
export type Suite = (typeof SUITES)[number];

export const USAGE = `Usage: npm run eval -- <suite>

Suites:
  guardrails   every example in platform/api/eval/guardrails.json through the real guardrail check:
               off-path examples must be declined, in-scope ones pass, unusual ones are flagged

Calls Claude on Bedrock with your own AWS credentials (well under one cent per example).`;

export function parseEvalArgs(args: readonly string[]): { suite: Suite } | { error: string } {
  const [suite, ...rest] = args;
  if (suite === undefined) return { error: "no suite given" };
  if (!(SUITES as readonly string[]).includes(suite)) return { error: "unknown suite" };
  if (rest.length > 0) return { error: `${suite} takes no arguments` };
  return { suite: suite as Suite };
}

export interface GuardrailExample {
  category: string;
  text: string;
  expected: GuardrailVerdict;
}

const VERDICTS: readonly string[] = ["on-path", "decline", "flag"];

/** The examples of a guardrails file, or an error naming the first bad entry. */
export function parseGuardrailExamples(json: string): GuardrailExample[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "the examples file is not JSON" };
  }
  const examples = (parsed as { examples?: unknown } | null)?.examples;
  if (!Array.isArray(examples) || examples.length === 0) return { error: "the examples file has no examples list" };
  const result: GuardrailExample[] = [];
  for (const [i, e] of examples.entries()) {
    const { category, text, expected } = (e ?? {}) as Record<string, unknown>;
    if (
      typeof category !== "string" ||
      typeof text !== "string" ||
      text.trim() === "" ||
      typeof expected !== "string" ||
      !VERDICTS.includes(expected)
    ) {
      return { error: `example ${i + 1} needs a category, a text and an expected verdict (on-path, decline or flag)` };
    }
    result.push({ category, text, expected: expected as GuardrailVerdict });
  }
  return result;
}

export interface GuardrailOutcome {
  verdict: GuardrailVerdict;
  reason: string;
  usage: TokenUsage;
}

export interface EvalResult {
  example: GuardrailExample;
  verdict: GuardrailVerdict | "error";
  reason: string;
  usage?: TokenUsage;
  pass: boolean;
}

/** Runs every example, one at a time (gentle on the quota); a failed call counts as a mismatch. */
export async function runGuardrailEval(
  examples: readonly GuardrailExample[],
  classify: (text: string) => Promise<GuardrailOutcome>,
  onResult: (result: EvalResult, index: number) => void = () => undefined,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const [i, example] of examples.entries()) {
    let result: EvalResult;
    try {
      const outcome = await classify(example.text);
      result = { example, verdict: outcome.verdict, reason: outcome.reason, usage: outcome.usage, pass: outcome.verdict === example.expected };
    } catch (error) {
      result = { example, verdict: "error", reason: error instanceof Error ? error.name : "Error", pass: false };
    }
    results.push(result);
    onResult(result, i);
  }
  return results;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function formatResult(result: EvalResult, index: number): string {
  const mark = result.pass ? "PASS" : "FAIL";
  const verdict = result.pass ? result.verdict : `${result.verdict} (expected ${result.example.expected})`;
  return `${mark} ${String(index + 1).padStart(2)} [${result.example.category}] ${verdict}: ${clip(result.example.text, 70)} | ${clip(result.reason, 80)}`;
}

export function formatSummary(results: readonly EvalResult[]): string[] {
  const passed = results.filter((r) => r.pass).length;
  const total = addUsage(...results.map((r) => r.usage));
  const lines = [
    `Guardrails: ${passed}/${results.length} passed`,
    `Tokens: ${total.inputTokens} in, ${total.outputTokens} out, cost $${total.costUsd.toFixed(4)}`,
  ];
  for (const expected of VERDICTS) {
    const group = results.filter((r) => r.example.expected === expected);
    lines.push(`  expected ${expected}: ${group.filter((r) => r.pass).length}/${group.length}`);
  }
  return lines;
}

/** 0 only when every example matched. */
export const exitCode = (results: readonly EvalResult[]): number => (results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
