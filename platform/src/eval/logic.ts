// `npm run eval -- <suite>` (ticket 1.7): runs a suite of examples against the real model and
// scores the answers. `guardrails` (ticket 1.7), `clarify` (ticket 1.8) and `spec` (ticket 1.9).
// The scoring is pure and unit tested; ./main.ts calls Bedrock.
import type { Exchange } from "../../api/conversation/answer.js";
import { addUsage } from "../../api/conversation/model.js";
import { checkSpec, extractSpec, parseSpec } from "../../api/conversation/spec.js";
import type { GuardrailVerdict, TokenUsage } from "../../api/types.js";

export const SUITES = ["guardrails", "clarify", "spec"] as const;
export type Suite = (typeof SUITES)[number];

export const USAGE = `Usage: npm run eval -- <suite>

Suites:
  guardrails   every example in platform/api/eval/guardrails.json through the real guardrail check:
               off-path examples must be declined, in-scope ones pass, unusual ones are flagged
  clarify      every example in platform/api/eval/clarify.json through the real step 1 answer call:
               a first reply holds 3 to 5 numbered questions, a changed idea gets questions about
               the new idea only, and a fully answered idea gets the offer to write the spec
  spec         every example in platform/api/eval/spec.json through the real step 2 answer call:
               a new spec has the sections and a Mermaid diagram that parses and draws (Mermaid in
               Chromium, the page's own diagram.js), a question leaves the spec unchanged, and a
               change request gives a new version

Calls Claude on Bedrock with your own AWS credentials (up to a few cents per example).`;

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
export const exitCode = (results: readonly { pass: boolean }[]): number => (results.length > 0 && results.every((r) => r.pass) ? 0 : 1);

// ---- clarify (ticket 1.8) ----

export type ClarifyCheck = "first-reply" | "change-of-mind" | "offers-spec";
const CLARIFY_CHECKS: readonly string[] = ["first-reply", "change-of-mind", "offers-spec"];

export interface ClarifyExample {
  name: string;
  check: ClarifyCheck;
  /** Earlier answered exchanges, oldest first. */
  history: Exchange[];
  text: string;
  /** change-of-mind: the reply names at least one of these (start of a word: "water" matches "watering"). */
  newKeywords: string[];
  /** change-of-mind: no numbered question names any of these (whole word, plural allowed). */
  oldKeywords: string[];
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "");

/** The examples of a clarify file, or an error naming the first bad entry. */
export function parseClarifyExamples(json: string): ClarifyExample[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "the examples file is not JSON" };
  }
  const examples = (parsed as { examples?: unknown } | null)?.examples;
  if (!Array.isArray(examples) || examples.length === 0) return { error: "the examples file has no examples list" };
  const result: ClarifyExample[] = [];
  for (const [i, e] of examples.entries()) {
    const { name, check, history = [], text, newKeywords = [], oldKeywords = [] } = (e ?? {}) as Record<string, unknown>;
    const historyOk =
      Array.isArray(history) &&
      history.every((h) => {
        const { question, answer } = (h ?? {}) as Record<string, unknown>;
        return typeof question === "string" && typeof answer === "string" && question !== "" && answer !== "";
      });
    const bad =
      typeof name !== "string" ||
      typeof check !== "string" ||
      !CLARIFY_CHECKS.includes(check) ||
      typeof text !== "string" ||
      text.trim() === "" ||
      !historyOk ||
      !isStringList(newKeywords) ||
      !isStringList(oldKeywords) ||
      (check === "change-of-mind" && (newKeywords.length === 0 || oldKeywords.length === 0 || (history as unknown[]).length === 0));
    if (bad) {
      return {
        error: `example ${i + 1} needs a name, a check (first-reply, change-of-mind or offers-spec), a text, a history of question/answer pairs, and for change-of-mind a history and new and old keywords`,
      };
    }
    result.push({ name, check: check as ClarifyCheck, history: history as Exchange[], text, newKeywords, oldKeywords });
  }
  return result;
}

/** The numbered list items of a reply ("1. ..." or "1) ..."), in order. */
export function numberedItems(text: string): { number: number; text: string }[] {
  const items: { number: number; text: string }[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d{1,2})[.)]\s+(\S.*)$/.exec(line);
    if (match) items.push({ number: Number(match[1]), text: (match[2] ?? "").trim() });
  }
  return items;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The word starts with the keyword ("water" matches "watering"). */
const startsWord = (text: string, keyword: string): boolean => new RegExp(`\\b${escapeRegExp(keyword)}`, "i").test(text);
/** The keyword as a whole word, plural allowed ("film" matches "films", "rate" does not match "separate"). */
const wholeWord = (text: string, keyword: string): boolean => new RegExp(`\\b${escapeRegExp(keyword)}(s|es)?\\b`, "i").test(text);

export interface ClarifyAnswer {
  text: string;
  offersSpec: boolean;
  usage: TokenUsage;
}

export interface ClarifyScore {
  pass: boolean;
  /** What failed, or a short description of what passed. */
  detail: string;
}

/** Scores one answer for its example's check. */
export function scoreClarify(example: ClarifyExample, answer: Pick<ClarifyAnswer, "text" | "offersSpec">): ClarifyScore {
  const items = numberedItems(answer.text);
  const numbered = items.every((item, i) => item.number === i + 1);
  const questions = items.filter((item) => item.text.includes("?")).length;
  const problems: string[] = [];
  if (!numbered) problems.push(`numbering is not 1, 2, 3... (${items.map((i) => i.number).join(",")})`);
  if (example.check === "first-reply" || example.check === "change-of-mind") {
    const [min, max] = example.check === "first-reply" ? [3, 5] : [1, 5];
    if (items.length < min || items.length > max) problems.push(`${items.length} numbered questions (expected ${min} to ${max})`);
    if (questions < items.length) problems.push(`${items.length - questions} numbered item(s) without a question mark`);
    if (answer.offersSpec) problems.push("offered the spec too early");
  }
  if (example.check === "change-of-mind") {
    if (!example.newKeywords.some((k) => startsWord(answer.text, k))) problems.push(`never names the new idea (${example.newKeywords.join(", ")})`);
    const old = example.oldKeywords.filter((k) => items.some((item) => wholeWord(item.text, k)));
    if (old.length > 0) problems.push(`questions still about the old idea (${old.join(", ")})`);
  }
  if (example.check === "offers-spec") {
    if (!answer.offersSpec) problems.push("did not offer to write the spec");
    if (items.length > 0) problems.push(`still asks ${items.length} numbered question(s)`);
    if (!/write my spec/i.test(answer.text)) problems.push('does not mention the "Write my spec" button');
  }
  if (problems.length > 0) return { pass: false, detail: problems.join("; ") };
  if (example.check === "offers-spec") return { pass: true, detail: "offers to write the spec" };
  return { pass: true, detail: `${items.length} numbered questions` };
}

export interface ClarifyResult extends ClarifyScore {
  example: ClarifyExample;
  answer?: ClarifyAnswer;
}

/** Runs every example, one at a time; a failed call counts as a failure. */
export async function runClarifyEval(
  examples: readonly ClarifyExample[],
  answer: (example: ClarifyExample) => Promise<ClarifyAnswer>,
  onResult: (result: ClarifyResult, index: number) => void = () => undefined,
): Promise<ClarifyResult[]> {
  const results: ClarifyResult[] = [];
  for (const [i, example] of examples.entries()) {
    let result: ClarifyResult;
    try {
      const reply = await answer(example);
      result = { example, answer: reply, ...scoreClarify(example, reply) };
    } catch (error) {
      result = { example, pass: false, detail: `error ${error instanceof Error ? error.name : "Error"}` };
    }
    results.push(result);
    onResult(result, i);
  }
  return results;
}

/** One line per example, then the reply itself (indented), so a reviewer sees what was scored. */
export function formatClarifyResult(result: ClarifyResult, index: number): string {
  const head = `${result.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2)} [${result.example.check}] ${result.example.name}: ${result.detail}`;
  if (result.answer === undefined) return head;
  const body = result.answer.text.split("\n").map((l) => `     | ${l}`);
  return [head, ...body, ...(result.answer.offersSpec ? ["     | (offers to write the spec)"] : [])].join("\n");
}

export function formatClarifySummary(results: readonly ClarifyResult[]): string[] {
  const passed = results.filter((r) => r.pass).length;
  const total = addUsage(...results.map((r) => r.answer?.usage));
  const lines = [
    `Clarify: ${passed}/${results.length} passed`,
    `Tokens: ${total.inputTokens} in, ${total.outputTokens} out, cost $${total.costUsd.toFixed(4)}`,
  ];
  for (const check of CLARIFY_CHECKS) {
    const group = results.filter((r) => r.example.check === check);
    lines.push(`  ${check}: ${group.filter((r) => r.pass).length}/${group.length}`);
  }
  return lines;
}

// ---- spec (ticket 1.9) ----

export type SpecCheck = "new-spec" | "keeps-spec";
const SPEC_CHECKS: readonly string[] = ["new-spec", "keeps-spec"];

export interface SpecExample {
  name: string;
  check: SpecCheck;
  /** Earlier answered exchanges, oldest first (step 1's conversation, then step 2's). */
  history: Exchange[];
  text: string;
  /** The spec the model sees as the current one; absent for the first version. */
  currentSpec?: string;
  /** new-spec: the new spec names each of these (start of a word, any case). */
  keywords: string[];
}

/** The examples of a spec file, or an error naming the first bad entry. */
export function parseSpecExamples(json: string): SpecExample[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "the examples file is not JSON" };
  }
  const examples = (parsed as { examples?: unknown } | null)?.examples;
  if (!Array.isArray(examples) || examples.length === 0) return { error: "the examples file has no examples list" };
  const result: SpecExample[] = [];
  for (const [i, e] of examples.entries()) {
    const { name, check, history = [], text, currentSpec, keywords = [] } = (e ?? {}) as Record<string, unknown>;
    const historyOk =
      Array.isArray(history) &&
      history.every((h) => {
        const { question, answer } = (h ?? {}) as Record<string, unknown>;
        return typeof question === "string" && typeof answer === "string" && question !== "" && answer !== "";
      });
    const specOk = currentSpec === undefined || (typeof currentSpec === "string" && checkSpec(currentSpec).length === 0);
    const bad =
      typeof name !== "string" ||
      typeof check !== "string" ||
      !SPEC_CHECKS.includes(check) ||
      typeof text !== "string" ||
      text.trim() === "" ||
      !historyOk ||
      !specOk ||
      !isStringList(keywords) ||
      (check === "keeps-spec" && currentSpec === undefined);
    if (bad) {
      return {
        error: `example ${i + 1} needs a name, a check (new-spec or keeps-spec), a text, a history of question/answer pairs, keywords, and a valid currentSpec (required for keeps-spec)`,
      };
    }
    result.push({ name, check: check as SpecCheck, history: history as Exchange[], text, ...(typeof currentSpec === "string" ? { currentSpec } : {}), keywords });
  }
  return result;
}

/** What the eval learns about one raw step 2 answer. */
export interface SpecAnswerFacts {
  /** The model's whole answer, as it came. */
  text: string;
  usage: TokenUsage;
  /** Whether Mermaid parsed and drew the new spec's diagram (undefined when there is no new spec). */
  diagram?: { parses: boolean; draws: boolean };
}

/** Scores one raw answer for its example's check. */
export function scoreSpec(example: SpecExample, facts: SpecAnswerFacts): ClarifyScore {
  const { answer, spec, malformed } = extractSpec(facts.text);
  const problems: string[] = [];
  if (malformed) problems.push("the spec block is not closed");
  if (example.check === "keeps-spec") {
    if (spec !== undefined) problems.push("wrote a new spec for a question");
    if (answer === "") problems.push("no answer");
  } else if (spec === undefined) {
    if (!malformed) problems.push("no new spec");
  } else {
    problems.push(...checkSpec(spec));
    if (facts.diagram?.parses !== true) problems.push("the diagram does not parse");
    else if (!facts.diagram.draws) problems.push("the diagram does not draw");
    const missing = example.keywords.filter((k) => !startsWord(spec, k));
    if (missing.length > 0) problems.push(`the spec never names ${missing.join(", ")}`);
  }
  if (problems.length > 0) return { pass: false, detail: problems.join("; ") };
  if (example.check === "keeps-spec") return { pass: true, detail: "answered, spec unchanged" };
  const parsed = parseSpec(spec ?? "");
  return { pass: true, detail: `"${parsed.title}": ${parsed.sections.map((s) => s.heading).join(", ")} and a diagram that parses and draws` };
}

export interface SpecResult extends ClarifyScore {
  example: SpecExample;
  facts?: SpecAnswerFacts;
}

/** Runs every example, one at a time; a failed call counts as a failure. */
export async function runSpecEval(
  examples: readonly SpecExample[],
  answer: (example: SpecExample) => Promise<SpecAnswerFacts>,
  onResult: (result: SpecResult, index: number) => void = () => undefined,
): Promise<SpecResult[]> {
  const results: SpecResult[] = [];
  for (const [i, example] of examples.entries()) {
    let result: SpecResult;
    try {
      const facts = await answer(example);
      result = { example, facts, ...scoreSpec(example, facts) };
    } catch (error) {
      result = { example, pass: false, detail: `error ${error instanceof Error ? error.name : "Error"}` };
    }
    results.push(result);
    onResult(result, i);
  }
  return results;
}

/** One line per example, then the answer itself (indented), so a reviewer sees what was scored. */
export function formatSpecResult(result: SpecResult, index: number): string {
  const head = `${result.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2)} [${result.example.check}] ${result.example.name}: ${result.detail}`;
  if (result.facts === undefined) return head;
  return [head, ...result.facts.text.split("\n").map((l) => `     | ${l}`)].join("\n");
}

export function formatSpecSummary(results: readonly SpecResult[]): string[] {
  const passed = results.filter((r) => r.pass).length;
  const total = addUsage(...results.map((r) => r.facts?.usage));
  const lines = [`Spec: ${passed}/${results.length} passed`, `Tokens: ${total.inputTokens} in, ${total.outputTokens} out, cost $${total.costUsd.toFixed(4)}`];
  for (const check of SPEC_CHECKS) {
    const group = results.filter((r) => r.example.check === check);
    lines.push(`  ${check}: ${group.filter((r) => r.pass).length}/${group.length}`);
  }
  return lines;
}
