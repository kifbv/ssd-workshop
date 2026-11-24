// `npm run eval -- <suite>` (ticket 1.7): runs a suite of examples against the real model and
// scores the answers. `guardrails` (ticket 1.7), `clarify` (ticket 1.8), `spec` (ticket 1.9), `readiness` (ticket 2.7)
// and `build` (ticket 2.8: the coding agent and the runner, with GitHub, the table and the queue in memory).
// The scoring is pure and unit tested; ./main.ts calls Bedrock.
import type { Exchange } from "../../api/conversation/answer.js";
import { addUsage } from "../../api/conversation/model.js";
import type { ReadinessVerdict } from "../../api/conversation/readiness.js";
import { checkSpec, extractSpec, parseSpec } from "../../api/conversation/spec.js";
import type { GuardrailVerdict, TokenUsage } from "../../api/types.js";

export const SUITES = ["guardrails", "clarify", "spec", "readiness", "build"] as const;
export type Suite = (typeof SUITES)[number];

export const USAGE = `Usage: npm run eval -- <suite>
       npm run eval -- build [--model <eu.anthropic.* profile>] [--example <1-3>]

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
  readiness    every approved spec in platform/api/eval/readiness.json through the real readiness check:
               the workshop's three example specs pass, and specs needing a login, a payment, an outside
               service or a server, or leaving a question open, fail with a reason that names it
  build        the readiness file's three workshop example specs through the real runner and coding agent
               (GitHub, the table and the deploy queue in memory): each result must pass the deploy check,
               load at 375 px under the apps' sandbox CSP in Chromium with no console error and nothing
               scrolling sideways, and show its title and every screen its spec names; prints the duration,
               tokens and cost of each. --model tries another EU profile (priced at the build role's prices),
               --example runs one spec only

Calls Claude on Bedrock with your own AWS credentials (up to a few cents per example; build about $1 per spec).`;

export interface EvalArgs {
  suite: Suite;
  /** build only: the model to try instead of the build role's. */
  model?: string;
  /** build only: run this example only (1-based). */
  example?: number;
}

export function parseEvalArgs(args: readonly string[]): EvalArgs | { error: string } {
  const [suite, ...rest] = args;
  if (suite === undefined) return { error: "no suite given" };
  if (!(SUITES as readonly string[]).includes(suite)) return { error: "unknown suite" };
  if (suite !== "build") {
    if (rest.length > 0) return { error: `${suite} takes no arguments` };
    return { suite: suite as Suite };
  }
  const parsed: EvalArgs = { suite: "build" };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === "--model" && value !== undefined && /^eu\.anthropic\.[a-z0-9.:-]+$/.test(value) && parsed.model === undefined) parsed.model = value;
    else if (flag === "--example" && value !== undefined && /^[1-9][0-9]?$/.test(value) && parsed.example === undefined) parsed.example = Number(value);
    else return { error: "build takes --model <eu.anthropic.* profile> and --example <number>" };
  }
  return parsed;
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

// ---- readiness (ticket 2.7) ----

export interface ReadinessExample {
  name: string;
  /** "example" for the workshop's example specs; otherwise what makes the spec not ready (login, payment, ...). */
  category: string;
  expected: "ready" | "not-ready";
  /** The approved spec (it must have the spec's shape). */
  spec: string;
  /** not-ready: some reason names one of these (any case). */
  keywords: string[];
}

/** The examples of a readiness file, or an error naming the first bad entry. */
export function parseReadinessExamples(json: string): ReadinessExample[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "the examples file is not JSON" };
  }
  const examples = (parsed as { examples?: unknown } | null)?.examples;
  if (!Array.isArray(examples) || examples.length === 0) return { error: "the examples file has no examples list" };
  const result: ReadinessExample[] = [];
  for (const [i, e] of examples.entries()) {
    const { name, category, expected, spec, keywords = [] } = (e ?? {}) as Record<string, unknown>;
    const bad =
      typeof name !== "string" ||
      typeof category !== "string" ||
      (expected !== "ready" && expected !== "not-ready") ||
      typeof spec !== "string" ||
      checkSpec(spec).length > 0 ||
      !isStringList(keywords) ||
      (expected === "not-ready" && keywords.length === 0);
    if (bad) {
      return { error: `example ${i + 1} needs a name, a category, an expected verdict (ready or not-ready), a spec of the right shape, and for not-ready keywords` };
    }
    result.push({ name, category, expected, spec, keywords });
  }
  return result;
}

export interface ReadinessOutcome {
  verdict: ReadinessVerdict;
  reasons: string[];
  usage: TokenUsage;
}

export interface ReadinessResult extends ClarifyScore {
  example: ReadinessExample;
  outcome?: ReadinessOutcome;
}

/** Scores one verdict: the expected verdict, and for a failing spec a reason naming the problem. */
export function scoreReadiness(example: ReadinessExample, outcome: Pick<ReadinessOutcome, "verdict" | "reasons">): ClarifyScore {
  if (outcome.verdict !== example.expected) return { pass: false, detail: `${outcome.verdict} (expected ${example.expected})` };
  if (example.expected === "ready") return { pass: true, detail: "ready" };
  const named = example.keywords.filter((k) => outcome.reasons.some((r) => r.toLowerCase().includes(k.toLowerCase())));
  if (named.length === 0) return { pass: false, detail: `not-ready, but no reason names ${example.keywords.join(" / ")}` };
  return { pass: true, detail: `not-ready, naming ${named.join(", ")}` };
}

/** Runs every example, one at a time; a failed call counts as a failure. */
export async function runReadinessEval(
  examples: readonly ReadinessExample[],
  check: (example: ReadinessExample) => Promise<ReadinessOutcome>,
  onResult: (result: ReadinessResult, index: number) => void = () => undefined,
): Promise<ReadinessResult[]> {
  const results: ReadinessResult[] = [];
  for (const [i, example] of examples.entries()) {
    let result: ReadinessResult;
    try {
      const outcome = await check(example);
      result = { example, outcome, ...scoreReadiness(example, outcome) };
    } catch (error) {
      result = { example, pass: false, detail: `error ${error instanceof Error ? error.name : "Error"}` };
    }
    results.push(result);
    onResult(result, i);
  }
  return results;
}

/** One line per example, then its reasons (indented), so a reviewer sees what was scored. */
export function formatReadinessResult(result: ReadinessResult, index: number): string {
  const head = `${result.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2)} [${result.example.category}] ${result.example.name}: ${result.detail}`;
  return [head, ...(result.outcome?.reasons ?? []).map((r) => `     | ${r}`)].join("\n");
}

export function formatReadinessSummary(results: readonly ReadinessResult[]): string[] {
  const passed = results.filter((r) => r.pass).length;
  const total = addUsage(...results.map((r) => r.outcome?.usage));
  const lines = [`Readiness: ${passed}/${results.length} passed`, `Tokens: ${total.inputTokens} in, ${total.outputTokens} out, cost $${total.costUsd.toFixed(4)}`];
  for (const expected of ["ready", "not-ready"]) {
    const group = results.filter((r) => r.example.expected === expected);
    lines.push(`  expected ${expected}: ${group.filter((r) => r.pass).length}/${group.length}`);
  }
  return lines;
}

// ---- build (ticket 2.8) ----

/** The app's name: the spec's title line (`# Name`). */
export function specTitle(spec: string): string | undefined {
  return /^# (.+)$/m.exec(spec)?.[1]?.trim();
}

/** The screens the spec names: each item of its "## Screens" list, the text before the first colon. */
export function screenNames(spec: string): string[] {
  const start = spec.search(/^## Screens\s*$/m);
  if (start === -1) return [];
  const rest = spec.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end))
    .map((line) => /^\s*[-*]\s+(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:/.exec(line)?.[1]?.trim())
    .filter((name): name is string => name !== undefined && name !== "");
}

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The title check: the page's `<title>` holds the app's name, and every screen the spec names appears in the text of a
 * heading, button, tab, link, label or legend, or an `aria-label`, anywhere in the page (a screen may be hidden until
 * chosen). Case and spacing are ignored. Returns what was not found.
 */
export function missingScreens(title: string | undefined, screens: readonly string[], page: { title: string; labels: readonly string[] }): string[] {
  const labels = page.labels.map(normalized);
  const missing: string[] = [];
  if (title !== undefined && !normalized(page.title).includes(normalized(title))) missing.push(`title "${title}"`);
  for (const screen of screens) if (!labels.some((label) => label.includes(normalized(screen)))) missing.push(screen);
  return missing;
}

export interface BuildEvalOutcome {
  /** The runner's outcome. */
  outcome: string;
  /** Why the build failed, when it did. */
  failureReasons: string[];
  steps: string[];
  files: number;
  commits: number;
  /** The deploy check on the pushed commit, as the deployer runs it. */
  checkPassed: boolean;
  consoleErrors: string[];
  /** Pixels the page is wider than 375 px (0 when nothing scrolls sideways). */
  overflow: number;
  missing: string[];
  durationMs: number;
  usage: TokenUsage;
}

export interface BuildEvalResult extends ClarifyScore {
  example: ReadinessExample;
  outcome?: BuildEvalOutcome;
}

const STEPS_IN_ORDER = ["preparing", "writing", "checking", "committing", "deploying"];

/** Scores one build: handed over, steps in order, at least one commit, check passed, no console error, no overflow, every screen found. */
export function scoreBuild(outcome: BuildEvalOutcome): ClarifyScore {
  const problems: string[] = [];
  if (outcome.outcome !== "handed-over") {
    problems.push(`build ${outcome.outcome}${outcome.failureReasons.length > 0 ? `: ${outcome.failureReasons.join(" | ")}` : ""}`);
  } else {
    if (outcome.steps.join(",") !== STEPS_IN_ORDER.join(",")) problems.push(`steps ${outcome.steps.join(",")}`);
    if (outcome.commits < 1) problems.push("no commit");
    if (!outcome.checkPassed) problems.push("deploy check failed");
    if (outcome.consoleErrors.length > 0) problems.push(`${outcome.consoleErrors.length} console error(s): ${outcome.consoleErrors.join(" | ").slice(0, 300)}`);
    if (outcome.overflow > 0) problems.push(`scrolls sideways by ${outcome.overflow} px`);
    if (outcome.missing.length > 0) problems.push(`missing ${outcome.missing.join(", ")}`);
  }
  return problems.length === 0
    ? { pass: true, detail: `${outcome.files} files written, ${outcome.commits} commits, check passed, no console error, title and all screens shown` }
    : { pass: false, detail: problems.join("; ") };
}

const minutes = (ms: number): string => `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;

export function formatBuildResult(result: BuildEvalResult, index: number): string {
  const head = `${result.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2)} ${result.example.name}: ${result.detail}`;
  const o = result.outcome;
  if (o === undefined) return head;
  return `${head}\n     | ${minutes(o.durationMs)}, ${o.usage.inputTokens} tokens in, ${o.usage.outputTokens} out, cost $${o.usage.costUsd.toFixed(4)}`;
}

export function formatBuildSummary(results: readonly BuildEvalResult[]): string[] {
  const passed = results.filter((r) => r.pass).length;
  const total = addUsage(...results.map((r) => r.outcome?.usage));
  const duration = results.reduce((sum, r) => sum + (r.outcome?.durationMs ?? 0), 0);
  return [
    `Build: ${passed}/${results.length} passed`,
    `Duration: ${minutes(duration)} in all; tokens: ${total.inputTokens} in, ${total.outputTokens} out, cost $${total.costUsd.toFixed(4)}`,
  ];
}
