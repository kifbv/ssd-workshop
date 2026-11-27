// `npm run eval -- <suite>` (ticket 1.7): runs a suite of examples against the real model and
// scores the answers. `guardrails` (ticket 1.7), `clarify` (ticket 1.8), `spec` (ticket 1.9), `readiness` (ticket 2.7)
// and `build` (ticket 2.8: the coding agent and the runner, with GitHub, the table and the queue in memory), and
// `suggestions` (ticket 3.6: three suggested changes for each workshop example spec), and `change` (ticket 3.7: a change
// build on a built example).
// The scoring is pure and unit tested; ./main.ts calls Bedrock.
import type { Exchange } from "../../api/conversation/answer.js";
import { addUsage } from "../../api/conversation/model.js";
import type { ReadinessVerdict } from "../../api/conversation/readiness.js";
import { checkSpec, extractSpec, parseSpec } from "../../api/conversation/spec.js";
import type { GuardrailVerdict, TokenUsage } from "../../api/types.js";

export const SUITES = ["guardrails", "clarify", "spec", "readiness", "build", "suggestions", "change", "app-ai"] as const;
export type Suite = (typeof SUITES)[number];

export const USAGE = `Usage: npm run eval -- <suite>
       npm run eval -- build [--model <eu.anthropic.* profile>] [--example <1-6>]

Suites:
  guardrails   every example in platform/api/eval/guardrails.json through the real guardrail check:
               off-path examples must be declined, in-scope ones pass, unusual ones are flagged
  clarify      every example in platform/api/eval/clarify.json through the real step 1 answer call:
               a first reply holds 3 to 5 numbered questions (and names its mentions, none of its
               avoids, and each atMostOnce word at most once: ticket 3.20's photo reminder), a changed
               idea gets questions about
               the new idea only, and a fully answered idea gets the offer to write the spec
  spec         every example in platform/api/eval/spec.json through the real step 2 answer call:
               a new spec has the sections and a Mermaid diagram that parses and draws (Mermaid in
               Chromium, the page's own diagram.js), a question leaves the spec unchanged, and a
               change request gives a new version
  readiness    every approved spec in platform/api/eval/readiness.json, then platform/api/eval/build.json's
               photo and voice specs (ticket 3.20), through the real readiness check: the workshop's four
               example specs, specs reading a free keyless service and apps keeping photos or voice messages
               pass, and specs
               needing a login, a payment, an outside service (a key, a sign-in elsewhere, emails,
               notifications, AI) or a server, or leaving a question open, fail with a reason that names it
               (and none of the example's avoids: ticket 3.23's business cards are never typed in)
  build        the readiness file's four workshop example specs through the real runner and coding agent
               (GitHub, the table and the deploy queue in memory): each result must pass the deploy check,
               load at 375 px under the apps' sandbox CSP in Chromium (network open: the fourth reads
               Wikipedia) with no console error and nothing
               scrolling sideways, and show its title and every screen its spec names; then (ticket 3.19)
               platform/api/eval/build.json's photo gallery and voice-message cases, which must also show a photo
               or Record button and have a tag or topic filter (a list, a field, or buttons, links, tabs or radios
               whose label, text, group or the element before them holds "tag"/"topic" with "filter", "show", "only",
               "browse" or "search", or a list starting with "All"; a Tags field alone fails) and, signed in, upload a
               photo or recording, keep its address in the data and show it; prints the duration, tokens and cost
               of each. --model tries another EU profile (priced at the build role's prices), --example runs one
               spec only
  suggestions  the readiness file's workshop example specs through the real suggestions call (ticket 3.6): each
               gets exactly three suggested changes, each under 80 characters, and each passes the real
               guardrail check as on-path (a suggestion is sent as a change request when tapped)
  change       ticket 3.7: builds the fitness example (the readiness file's first workshop example) with the real
               runner and coding agent, asks the real change conversation to add a weekly chart, then runs the
               change build on the repository's main: the result must pass the deploy check, load at 375 px with
               no console error and nothing scrolling sideways, show the new spec's title and screens and every
               screen of the previous spec, and be one commit "Change 1: ..." holding the new SPEC.md; prints the
               duration, tokens and cost of each step (about $0.50 in all)
  app-ai       ticket 3.21: the AI task read-photo on two synthetic receipts (made-up shops, drawn in Chromium,
               stored as the media API would), through Claude Haiku 4.5's EU profile with the route's prompt, tool
               and answer check: shop, date and total must come back right (about $0.01)

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
  /**
   * Ticket 3.16, a decline in the participant's language: when not empty, the decline sentence shown must be the
   * model's own (not the English template) and name at least one of these words (start of a word, any case).
   */
  declineWords?: string[];
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
    const { category, text, expected, declineWords = [] } = (e ?? {}) as Record<string, unknown>;
    if (
      typeof category !== "string" ||
      typeof text !== "string" ||
      text.trim() === "" ||
      typeof expected !== "string" ||
      !VERDICTS.includes(expected) ||
      !isStringList(declineWords) ||
      (declineWords.length > 0 && expected !== "decline")
    ) {
      return { error: `example ${i + 1} needs a category, a text and an expected verdict (on-path, decline or flag), and declineWords only on a decline` };
    }
    result.push({ category, text, expected: expected as GuardrailVerdict, ...(declineWords.length > 0 ? { declineWords } : {}) });
  }
  return result;
}

export interface GuardrailOutcome {
  verdict: GuardrailVerdict;
  reason: string;
  usage: TokenUsage;
  /** A decline: the sentence the participant would see (declineReply), and whether it is the model's own (ticket 3.16). */
  reply?: string;
  localized?: boolean;
}

export interface EvalResult {
  example: GuardrailExample;
  verdict: GuardrailVerdict | "error";
  reason: string;
  usage?: TokenUsage;
  reply?: string;
  pass: boolean;
  /** Why a matching verdict still failed (the decline's language). */
  problem?: string;
}

/** Ticket 3.16: a decline expected in the participant's language is the model's sentence and names one of the words. */
export function declineLanguageProblem(example: GuardrailExample, outcome: Pick<GuardrailOutcome, "verdict" | "reply" | "localized">): string | undefined {
  const words = example.declineWords ?? [];
  if (words.length === 0 || outcome.verdict !== "decline") return undefined;
  if (outcome.localized !== true) return "the decline is the English template, not the participant's language";
  if (!words.some((w) => startsWord(outcome.reply ?? "", w))) return `the decline names none of (${words.join(", ")})`;
  return undefined;
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
      const problem = declineLanguageProblem(example, outcome);
      result = {
        example,
        verdict: outcome.verdict,
        reason: outcome.reason,
        usage: outcome.usage,
        ...(outcome.reply === undefined ? {} : { reply: outcome.reply }),
        pass: outcome.verdict === example.expected && problem === undefined,
        ...(problem === undefined ? {} : { problem }),
      };
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
  const verdict = result.verdict === result.example.expected ? result.verdict : `${result.verdict} (expected ${result.example.expected})`;
  const head = `${mark} ${String(index + 1).padStart(2)} [${result.example.category}] ${verdict}: ${clip(result.example.text, 70)} | ${clip(result.reason, 80)}`;
  // Ticket 3.16: a decline's sentence is shown, so a reviewer sees its language.
  const lines = [head, ...(result.problem === undefined ? [] : [`     ! ${result.problem}`]), ...(result.reply === undefined ? [] : [`     | ${result.reply}`])];
  return lines.join("\n");
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

/** `answers-question` (ticket 3.16): a question in the middle of a conversation; the reply may go on asking (at most 5). */
export type ClarifyCheck = "first-reply" | "change-of-mind" | "offers-spec" | "answers-question";
const CLARIFY_CHECKS: readonly string[] = ["first-reply", "change-of-mind", "offers-spec", "answers-question"];

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
  /** first-reply: when not empty, the reply names at least one of these (start of a word), e.g. a free service that needs no key. */
  mentions: string[];
  /** Any check: the reply names none of these (start of a word, any case), e.g. "cannot reach" or a technical word (ticket 2.14). */
  avoids: string[];
  /** Any check (ticket 3.16): for each group, the reply names at least one of its words (start of a word, any case). */
  mentionsEach?: string[][];
  /** Any check (ticket 3.20): each of these words is named at most once (start of a word, any case): a reminder said once. */
  atMostOnce?: string[];
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
    const { name, check, history = [], text, newKeywords = [], oldKeywords = [], mentions = [], avoids = [], mentionsEach = [], atMostOnce = [] } = (e ?? {}) as Record<string, unknown>;
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
      !isStringList(mentions) ||
      !isStringList(avoids) ||
      !isStringList(atMostOnce) ||
      !Array.isArray(mentionsEach) ||
      !mentionsEach.every((group) => isStringList(group) && group.length > 0) ||
      (check === "answers-question" && (history as unknown[]).length === 0) ||
      (check === "change-of-mind" && (newKeywords.length === 0 || oldKeywords.length === 0 || (history as unknown[]).length === 0));
    if (bad) {
      return {
        error: `example ${i + 1} needs a name, a check (first-reply, change-of-mind, offers-spec or answers-question), a text, a history of question/answer pairs, for change-of-mind and answers-question a history, for change-of-mind new and old keywords, mentionsEach as non-empty word lists, and atMostOnce as a word list`,
      };
    }
    result.push({ name, check: check as ClarifyCheck, history: history as Exchange[], text, newKeywords, oldKeywords, mentions, avoids,
      ...(mentionsEach.length > 0 ? { mentionsEach: mentionsEach as string[][] } : {}),
      ...(atMostOnce.length > 0 ? { atMostOnce } : {}),
    });
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
/** How many words start with the keyword (ticket 3.20). */
const countWords = (text: string, keyword: string): number => text.match(new RegExp(`\\b${escapeRegExp(keyword)}`, "gi"))?.length ?? 0;
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
  if (example.check === "first-reply" && example.mentions.length > 0 && !example.mentions.some((k) => startsWord(answer.text, k))) {
    problems.push(`never mentions (${example.mentions.join(", ")})`);
  }
  if (example.check === "answers-question") {
    if (items.length > 5) problems.push(`${items.length} numbered questions (expected at most 5)`);
    if (questions < items.length) problems.push(`${items.length - questions} numbered item(s) without a question mark`);
  }
  for (const group of example.mentionsEach ?? []) {
    if (!group.some((k) => startsWord(answer.text, k))) problems.push(`never mentions (${group.join(", ")})`);
  }
  const repeated = (example.atMostOnce ?? []).map((k) => [k, countWords(answer.text, k)] as const).filter(([, n]) => n > 1);
  if (repeated.length > 0) problems.push(`says more than once (${repeated.map(([k, n]) => `${k} ${n} times`).join(", ")})`);
  const avoided = example.avoids.filter((k) => startsWord(answer.text, k));
  if (avoided.length > 0) problems.push(`says what it should not (${avoided.join(", ")})`);
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
  if (example.check === "answers-question") return { pass: true, detail: `answers, names what it must${items.length > 0 ? `, then ${items.length} numbered questions` : ""}` };
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
  /** Ticket 3.16: the participant's latest message, sent along only for the reasons' language. */
  participantText?: string;
  /** Ticket 3.16, not-ready: every reason names at least one of these words (start of a word, any case): its language. */
  languageWords?: string[];
  /** Ticket 3.23 try 2, not-ready: phrases no reason may name (start of a word, any case), such as advice the guardrail declines. */
  avoids?: string[];
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
    const { name, category, expected, spec, keywords = [], participantText, languageWords = [], avoids = [] } = (e ?? {}) as Record<string, unknown>;
    const bad =
      typeof name !== "string" ||
      typeof category !== "string" ||
      (expected !== "ready" && expected !== "not-ready") ||
      typeof spec !== "string" ||
      checkSpec(spec).length > 0 ||
      !isStringList(keywords) ||
      (expected === "not-ready" && keywords.length === 0) ||
      (participantText !== undefined && (typeof participantText !== "string" || participantText.trim() === "")) ||
      !isStringList(languageWords) ||
      (languageWords.length > 0 && expected !== "not-ready") ||
      !isStringList(avoids) ||
      (avoids.length > 0 && expected !== "not-ready");
    if (bad) {
      return {
        error: `example ${i + 1} needs a name, a category, an expected verdict (ready or not-ready), a spec of the right shape, for not-ready keywords, and languageWords and avoids only on not-ready`,
      };
    }
    result.push({
      name,
      category,
      expected,
      spec,
      keywords,
      ...(languageWords.length > 0 ? { languageWords } : {}),
      ...(avoids.length > 0 ? { avoids } : {}),
      ...(typeof participantText === "string" ? { participantText } : {}),
    });
  }
  return result;
}

/**
 * The readiness suite's examples (ticket 3.20): the readiness file's, then every build file spec (a photo gallery, voice
 * messages and, since ticket 3.23 taught the readiness prompt the AI tasks, the AI cases of ticket 3.22), which the
 * builder is proved to build, so the check must let them through. An error names the file.
 */
export function readinessSuiteExamples(readinessJson: string, buildJson: string): ReadinessExample[] | { error: string } {
  const readiness = parseReadinessExamples(readinessJson);
  if ("error" in readiness) return { error: `readiness.json: ${readiness.error}` };
  const build = parseReadinessExamples(buildJson);
  if ("error" in build) return { error: `build.json: ${build.error}` };
  return [...readiness, ...build];
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
  const avoided = (example.avoids ?? []).filter((k) => outcome.reasons.some((r) => startsWord(r, k)));
  if (avoided.length > 0) return { pass: false, detail: `not-ready, but a reason says what it should not (${avoided.join(", ")})` };
  const languageWords = example.languageWords ?? [];
  if (languageWords.length > 0) {
    const other = outcome.reasons.filter((r) => !languageWords.some((w) => startsWord(r, w)));
    if (other.length > 0) return { pass: false, detail: `not-ready, but ${other.length} reason(s) name none of (${languageWords.join(", ")})` };
    return { pass: true, detail: `not-ready, naming ${named.join(", ")}, every reason in the participant's language` };
  }
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

/**
 * Ticket 3.28 (replaces 3.25's sign-in check): what the build eval saw of the edit link. The app is opened with the edit
 * link (`#edit=<secret>`) first, then without it on the data saved meanwhile, so list items with their own buttons show.
 * Each pass looks at the first screen, then opens each screen named in the spec (SCREEN_OPENERS_SCRIPT) and looks again.
 * - `editorCanSave`, `visitorCanSave`: `workshopData.canSave()` in each pass (true, then false).
 * - `editorControls`: saving controls (SAVING_CONTROLS_SCRIPT) seen with the edit link: the app has some.
 * - `savedOnOpen`: writes the app sent with the edit link before anyone did anything (AGENTS.md rule 6 forbids them).
 * - `saved`: whether a save with the edit link reached the data API (fields filled, Save or Add pressed), or undefined
 *   when not tried (a media or AI case, whose own pass saves with the edit link).
 * - `visitorControls`: the saving controls a visitor without the edit link saw (their words): none may show.
 * - `visitorRefused`: whether "This link is view only." showed while the visitor looked around: the app saved by itself,
 *   or a control the eval took for a screen tab saved.
 * - `editorOverflow`, `editorErrors`: sideways scroll and console errors with the edit link (the forms show then).
 * - `secretLeaks` (3.28 try 2, access review L2): where the edit link's secret left the workshop or showed with the edit
 *   link: requests to another origin holding it in their address, body or headers, and the page's text, title or an
 *   `href`, `src`, `srcset`, `action` or `value` (PAGE_SECRET_SCRIPT). None may: apps share `workshopData.viewLink()`.
 */
export interface EditLinkCheck {
  editorCanSave: boolean;
  editorControls: number;
  savedOnOpen: number;
  saved: boolean | undefined;
  editorOverflow: number;
  editorErrors: string[];
  visitorCanSave: boolean;
  visitorControls: string[];
  visitorRefused: boolean;
  secretLeaks: string[];
}

/**
 * Ticket 3.28 try 2 (access review L2): where the page shows the edit link's secret (run in the page, with the secret):
 * its text, its title, an `href`, `src`, `srcset`, `action` or `value` attribute, or a field's current value; each place
 * once, in that order (elements in document order).
 */
export const PAGE_SECRET_SCRIPT = `((secret) => {
  const found = [];
  if (((document.body && document.body.innerText) || "").includes(secret)) found.push("the page's text");
  if (document.title.includes(secret)) found.push("the page's title");
  for (const el of document.querySelectorAll("*")) {
    for (const name of ["href", "src", "srcset", "action", "value"]) {
      if ((el.getAttribute(name) || "").includes(secret)) found.push("the " + name + " of " + (/^[aeiou]/.test(el.localName) ? "an" : "a") + " <" + el.localName + ">");
    }
    if (typeof el.value === "string" && el.value.includes(secret)) found.push("the value of " + (/^[aeiou]/.test(el.localName) ? "an" : "a") + " <" + el.localName + ">");
  }
  return Array.from(new Set(found));
})`;

/** The words of a saving control: Add, Save, Delete, Upload, Record, AI and rating buttons (ticket 3.28). */
const SAVING_WORDS = String.raw`\b(add|save|delete|remove|upload|record|post|submit|send|create|rate|vote|watched|log|done|edit|suggest|scan)\b|take a photo|choose a photo|pick a photo|[★☆]`;

/**
 * Ticket 3.28: the saving controls a visitor sees now, as their words (run in the page, with the spec's screen names):
 * a button (or `role=button`, a submit or button input) whose text, `aria-label`, value or title holds a SAVING_WORDS
 * word, and a file input, really visible (`checkVisibility` with opacity and visibility, a box larger than 0) itself or
 * through one of its labels. A screen tab is not one: `role=tab`, in a `nav` or `role=tablist`, with `aria-controls`, or
 * reading exactly a screen's name. Old sign-in elements are left out.
 */
export const SAVING_CONTROLS_SCRIPT = `((screens) => {
  const seen = (el) => {
    const box = el.getBoundingClientRect();
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && box.width > 0 && box.height > 0;
  };
  const said = (el) => ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.value || "") + " " + (el.getAttribute("title") || "")).replace(/\\s+/g, " ").trim();
  const norm = (text) => text.replace(/\\s+/g, " ").trim().toLowerCase();
  const tab = (el) => el.getAttribute("role") === "tab" || el.closest("nav, [role=tablist]") !== null || el.hasAttribute("aria-controls") || screens.some((name) => norm(el.textContent || "") === norm(name));
  const words = new RegExp(${JSON.stringify(SAVING_WORDS)}, "i");
  const found = [];
  for (const el of document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")) {
    if (el.hasAttribute("data-workshop-sign-in") || tab(el) || !words.test(said(el)) || !seen(el)) continue;
    found.push(said(el).slice(0, 40));
  }
  for (const input of document.querySelectorAll("input[type=file]")) {
    const labels = Array.from(input.labels || []);
    if (seen(input) || labels.some(seen)) found.push("file input" + (labels[0] ? " (" + said(labels[0]).slice(0, 30) + ")" : ""));
  }
  return found;
})`;

/**
 * Ticket 3.28: marks (`data-eval-opener="<i>"`) the control that opens each screen named in the spec, when one is visible
 * and is not a saving control's own screen-less button: a button, tab, link or summary reading exactly the screen's name,
 * else one that holds it. Returns how many it marked (run in the page, with the screen names).
 */
export const SCREEN_OPENERS_SCRIPT = `((screens) => {
  const seen = (el) => {
    const box = el.getBoundingClientRect();
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && box.width > 0 && box.height > 0;
  };
  const norm = (text) => text.replace(/\\s+/g, " ").trim().toLowerCase();
  document.querySelectorAll("[data-eval-opener]").forEach((el) => el.removeAttribute("data-eval-opener"));
  const all = Array.from(document.querySelectorAll("button, [role=tab], [role=button], a, summary")).filter((el) => !el.hasAttribute("data-workshop-sign-in") && seen(el));
  let marked = 0;
  screens.forEach((name, i) => {
    const n = norm(name);
    const opener = all.find((el) => norm(el.textContent || "") === n) || all.find((el) => el.getAttribute("role") === "tab" && norm(el.textContent || "").includes(n));
    if (opener !== undefined && !opener.hasAttribute("data-eval-opener")) {
      opener.setAttribute("data-eval-opener", String(i));
      marked += 1;
    }
  });
  return marked;
})`;

/**
 * Ticket 3.28: fills the visible empty fields of the page as a person would (a number within its limits, a date, a
 * time, a title; the first real option of a list; the first choice of a radio group with none chosen), leaving filters,
 * file inputs and checkboxes, then marks (`data-eval-save`) the visible button that saves: one reading Save, else Add,
 * Log, Submit, Post, Create, Send or Suggest; never a screen tab. Returns whether one was marked (run in the page).
 */
export const FILL_AND_MARK_SAVE_SCRIPT = `((screens) => {
  const seen = (el) => {
    const box = el.getBoundingClientRect();
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && box.width > 0 && box.height > 0;
  };
  const norm = (text) => text.replace(/\\s+/g, " ").trim().toLowerCase();
  const hint = (el) => [el.id, el.getAttribute("name"), el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.className, ...Array.from(el.labels || []).map((l) => l.textContent || "")].join(" ").toLowerCase();
  const fire = (el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const numberFor = (el) => {
    const h = hint(el);
    const guess = /year/.test(h) ? 1942 : /lat/.test(h) ? 52.52 : /lon|lng/.test(h) ? 13.4 : /calor|kcal|goal/.test(h) ? 2000 : 5;
    const min = el.min === "" ? -Infinity : Number(el.min);
    const max = el.max === "" ? Infinity : Number(el.max);
    return String(Math.max(min, Math.min(max, guess)));
  };
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (!seen(el) || el.disabled || el.readOnly || /filter/.test(hint(el))) continue;
    const type = (el.getAttribute("type") || (el.tagName === "SELECT" ? "select" : "text")).toLowerCase();
    if (type === "select") {
      if (el.value === "") {
        const option = Array.from(el.options).find((o) => o.value !== "" && !o.disabled);
        if (option) { el.value = option.value; fire(el); }
      }
      continue;
    }
    if (type === "radio") {
      const group = el.name ? document.querySelectorAll('input[type=radio][name="' + CSS.escape(el.name) + '"]') : [el];
      if (!Array.from(group).some((r) => r.checked)) { el.checked = true; el.dispatchEvent(new MouseEvent("click", { bubbles: true })); fire(el); }
      continue;
    }
    if (el.value.trim() !== "") continue;
    const h = hint(el);
    let value;
    if (type === "number" || type === "range") value = numberFor(el);
    else if (type === "date") value = "2026-11-27";
    else if (type === "time") value = "00:30";
    else if (type === "datetime-local") value = "2026-11-27T10:00";
    else if (type === "month") value = "2026-11";
    else if (type === "text" || type === "search" || el.tagName === "TEXTAREA") {
      value = /year/.test(h) ? "1942" : /lat/.test(h) ? "52.52" : /lon|lng/.test(h) ? "13.4" : /km|distance|minute|time|duration|calor|amount|total|price|count|number|goal/.test(h) ? "5" : "Casablanca";
    }
    if (value === undefined) continue;
    el.value = value;
    fire(el);
  }
  const tab = (el) => el.getAttribute("role") === "tab" || el.closest("nav, [role=tablist]") !== null || screens.some((name) => norm(el.textContent || "") === norm(name));
  const buttons = Array.from(document.querySelectorAll("button, input[type=submit], [role=button]")).filter((b) => !b.hasAttribute("data-workshop-sign-in") && !b.disabled && !tab(b) && seen(b));
  const text = (b) => (b.textContent || b.value || "") + " " + (b.getAttribute("aria-label") || "");
  const save = buttons.find((b) => /\\bsave\\b/i.test(text(b))) || buttons.find((b) => /^\\s*(add|log|submit|post|create|send|suggest)\\b/i.test(text(b)));
  document.querySelectorAll("[data-eval-save]").forEach((el) => el.removeAttribute("data-eval-save"));
  if (save === undefined) return false;
  save.setAttribute("data-eval-save", "");
  return true;
})`;

/**
 * Ticket 3.28: marks (`data-eval-search`) the visible button that searches (Search, Find, Look up), never a screen tab
 * (live eval run 1: the "Find a film" tab was pressed instead of the Search button). Returns whether one was marked.
 */
export const SEARCH_BUTTON_SCRIPT = `((screens) => {
  const seen = (el) => {
    const box = el.getBoundingClientRect();
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && box.width > 0 && box.height > 0;
  };
  const norm = (text) => text.replace(/\\s+/g, " ").trim().toLowerCase();
  const tab = (el) => el.getAttribute("role") === "tab" || el.closest("nav, [role=tablist]") !== null || el.hasAttribute("aria-controls") || screens.some((name) => norm(el.textContent || "") === norm(name));
  document.querySelectorAll("[data-eval-search]").forEach((el) => el.removeAttribute("data-eval-search"));
  const said = (el) => (el.textContent || "") + " " + (el.value || "") + " " + (el.getAttribute("aria-label") || "");
  const button = Array.from(document.querySelectorAll("button, input[type=submit], [role=button]")).find((el) => !el.disabled && !tab(el) && seen(el) && /search|find|look up/i.test(said(el)));
  if (button === undefined) return false;
  button.setAttribute("data-eval-search", "");
  return true;
})`;

/** The edit-link problems of a published app, if any (ticket 3.28). */
export function editLinkProblem(check: EditLinkCheck): string | undefined {
  const problems: string[] = [];
  if (!check.editorCanSave || check.visitorCanSave) problems.push(`workshopData.canSave() is ${check.editorCanSave} with the edit link and ${check.visitorCanSave} without it`);
  if (check.savedOnOpen > 0) problems.push(`saves when the page opens (${check.savedOnOpen} write(s) before anyone did anything)`);
  if (check.editorControls === 0) problems.push("no saving control (Save, Add, photo or Record button) with the edit link");
  if (check.saved === false) problems.push("with the edit link, filling the fields and pressing Save or Add saved nothing");
  if (check.editorOverflow > 0) problems.push(`with the edit link, scrolls sideways by ${check.editorOverflow} px`);
  if (check.editorErrors.length > 0) problems.push(`${check.editorErrors.length} console error(s) with the edit link: ${check.editorErrors.join(" | ").slice(0, 300)}`);
  if (check.visitorControls.length > 0) problems.push(`a visitor without the edit link sees saving controls: ${check.visitorControls.join(", ").slice(0, 200)}`);
  if (check.visitorRefused) problems.push('a visitor without the edit link got "This link is view only." (the app saved by itself, or a screen tab saves)');
  if (check.secretLeaks.length > 0) problems.push(`the edit link's secret left the workshop or showed in the page: ${check.secretLeaks.join(", ").slice(0, 300)}`);
  return problems.length === 0 ? undefined : problems.join("; ");
}

/** Ticket 3.19: the media a build eval case keeps (its category in platform/api/eval/build.json). */
export type MediaCase = "photo" | "voice";

/** The filter a media case's app must have: photos by tag, voice messages by topic. */
export const MEDIA_FILTER: Record<MediaCase, string> = { photo: "tag", voice: "topic" };

export const mediaKindOf = (category: string): MediaCase | undefined => (category === "photo" || category === "voice" ? category : undefined);

/**
 * Ticket 3.19: what the build eval saw of a media case, signed in (src/eval/build.ts): the photo button (a file input
 * accepting images) or a Record button; after picking a photo (or a recording, in the recorder Chromium opens in the
 * sandbox), whether the media API stored it, whether a saved value of the data API holds its address, and whether the
 * page then shows it (`<img>` or `<audio>` with that address); whether it has the case's filter (a control, below); console
 * errors meanwhile. The filter is a list (`<select>`), a text or search field, or a button, link, tab, radio or checkbox
 * whose own words (text, label, `aria-label`, `aria-labelledby`, title, placeholder, id, name, class, `data-*` names),
 * the element just before it, or the group it sits in (fieldset and legend, `role=group|radiogroup|toolbar|tablist`,
 * nav, menu, else its parent: their own words and the element just before them) hold the case's word ("tag", "topic")
 * AND "filter", "show", "only", "browse" or "search"; a list whose first option starts with "All", "Any" or "Every" also
 * counts as a filter. A Tags field in the add form, or a tag list without "All", does not.
 */
export interface MediaCheck {
  kind: MediaCase;
  button: boolean;
  uploaded: boolean;
  keptInData: boolean;
  shown: boolean;
  filter: boolean;
  errors: string[];
}

/** The media problems of a published app, if any. */
export function mediaProblem(check: MediaCheck): string | undefined {
  const what = check.kind === "photo" ? "photo" : "recording";
  const problems: string[] = [];
  if (!check.button) problems.push(check.kind === "photo" ? "no photo button (a file input accepting images)" : "no Record button");
  else if (!check.uploaded) problems.push(`the ${what} was not uploaded`);
  else if (!check.keptInData) problems.push(`the ${what}'s address was not saved in the data`);
  else if (!check.shown) problems.push(`the saved ${what} is not shown from its address`);
  const word = MEDIA_FILTER[check.kind];
  if (!check.filter) problems.push(`no ${word} filter (a list, buttons or a field named "filter", "show", "only", "browse" or "search", or a list starting with "All", together with "${word}")`);
  if (check.errors.length > 0) problems.push(`${check.errors.length} console error(s) while uploading: ${check.errors.join(" | ").slice(0, 300)}`);
  return problems.length === 0 ? undefined : problems.join("; ");
}

/**
 * Ticket 3.22: the AI case a build eval case is (its category in platform/api/eval/build.json): a gallery that suggests
 * tags for a photo (`ai-tags`, AI task tag-photo) or an expense app that reads receipts (`ai-receipt`, read-photo).
 */
export type AiCase = "ai-tags" | "ai-receipt";

export const aiKindOf = (category: string): AiCase | undefined => (category === "ai-tags" || category === "ai-receipt" ? category : undefined);

/** The helper an AI case's app must call, and the AI task it asks. */
export const AI_HELPER: Record<AiCase, { helper: string; task: string }> = {
  "ai-tags": { helper: "tagPhoto", task: "tag-photo" },
  "ai-receipt": { helper: "readPhoto", task: "read-photo" },
};

/**
 * Ticket 3.22: what the build eval saw of an AI case, signed in (src/eval/build.ts `exerciseAi`), on the in-memory
 * workshop whose AI route gives fixed answers: the photo button (a file input accepting images); whether the app's code
 * calls the case's helper (`workshopData.ai.tagPhoto(` or `.readPhoto(`); whether the picked photo was uploaded; whether
 * the app then asked the AI route for the case's task (by itself, or from a button that asks for a suggestion); whether
 * the answer shows on the page (in a field's value or the page's text); whether a value holding it was saved before the
 * visitor accepted it (before the eval pressed Save); whether one was saved after the eval accepted it (Save, after
 * tapping a suggested tag or an Accept button when no field holds it); console errors meanwhile.
 */
export interface AiCheck {
  kind: AiCase;
  button: boolean;
  helper: boolean;
  uploaded: boolean;
  called: boolean;
  shown: boolean;
  savedEarly: boolean;
  saved: boolean;
  errors: string[];
}

/** The AI problems of a published app, if any. */
export function aiProblem(check: AiCheck): string | undefined {
  const { helper, task } = AI_HELPER[check.kind];
  const problems: string[] = [];
  if (!check.helper) problems.push(`the app's code does not call workshopData.ai.${helper}`);
  if (!check.button) problems.push("no photo button (a file input accepting images)");
  else if (!check.uploaded) problems.push("the photo was not uploaded");
  else if (!check.called) problems.push(`the app did not ask the AI (${task}) for the picked photo`);
  else {
    if (!check.shown) problems.push("the AI's suggestion is not shown on the page");
    if (check.savedEarly) problems.push("the AI's suggestion was saved before the visitor accepted it");
    if (!check.saved) problems.push("the suggestion was not saved after the visitor accepted it (Save)");
  }
  if (check.errors.length > 0) problems.push(`${check.errors.length} console error(s) while using AI: ${check.errors.join(" | ").slice(0, 300)}`);
  return problems.length === 0 ? undefined : problems.join("; ");
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
  /** Hosts other than the app's own that the page asked for (ticket 2.14: free outside services), sorted. */
  outsideHosts: string[];
  /** Ticket 3.28: the edit-link check (undefined before the app was published). */
  editLink?: EditLinkCheck;
  /** Ticket 3.19: a media case's check (photo or voice), signed in; undefined for the other examples. */
  media?: MediaCheck;
  /** Ticket 3.22: an AI case's check (tag suggestions or a receipt read), signed in; undefined for the other examples. */
  ai?: AiCheck;
  /** Ticket 3.22: whether the app's code calls a `workshopData.ai` helper (only an AI case's spec asks for AI). */
  usesAi?: boolean;
  /** Pages the coding agent read with WebFetch while building (ticket 2.15), from the build feed. */
  fetches: number;
  /** The hosts it read them from, each once, sorted. */
  fetchHosts: string[];
  durationMs: number;
  usage: TokenUsage;
}

export interface BuildEvalResult extends ClarifyScore {
  example: ReadinessExample;
  outcome?: BuildEvalOutcome;
}

const STEPS_IN_ORDER = ["preparing", "writing", "checking", "committing", "deploying"];

/** The services AGENTS.md lists (ticket 2.14): a spec that names one makes the agent check it with WebFetch (2.15). */
export const NAMED_SERVICES = ["Wikipedia", "Open Library", "Open-Meteo", "Frankfurter", "TVMaze", "REST Countries"] as const;

/** True when an example spec names an outside service, so its build must have fetched at least one page (ticket 2.15). */
export function expectsWebFetch(spec: string): boolean {
  const text = spec.toLowerCase();
  return NAMED_SERVICES.some((service) => text.includes(service.toLowerCase()));
}

/**
 * Scores one build: handed over, steps in order, at least one commit, check passed, no console error, no overflow, every
 * screen found, the edit-link check (ticket 3.28: saving controls and a save with the edit link, none for a visitor), and, when `mustFetch` (the spec names an outside service, ticket 2.15), at least one web fetch.
 */
export function scoreBuild(outcome: BuildEvalOutcome, mustFetch = false): ClarifyScore {
  const problems: string[] = [];
  if (mustFetch && outcome.fetches < 1) problems.push("no web fetch, though the spec names an outside service");
  if (outcome.outcome !== "handed-over") {
    problems.push(`build ${outcome.outcome}${outcome.failureReasons.length > 0 ? `: ${outcome.failureReasons.join(" | ")}` : ""}`);
  } else {
    if (outcome.steps.join(",") !== STEPS_IN_ORDER.join(",")) problems.push(`steps ${outcome.steps.join(",")}`);
    if (outcome.commits < 1) problems.push("no commit");
    if (!outcome.checkPassed) problems.push("deploy check failed");
    if (outcome.consoleErrors.length > 0) problems.push(`${outcome.consoleErrors.length} console error(s): ${outcome.consoleErrors.join(" | ").slice(0, 300)}`);
    if (outcome.overflow > 0) problems.push(`scrolls sideways by ${outcome.overflow} px`);
    if (outcome.missing.length > 0) problems.push(`missing ${outcome.missing.join(", ")}`);
    const editLink = outcome.editLink === undefined ? "the edit-link check did not run" : editLinkProblem(outcome.editLink);
    if (editLink !== undefined) problems.push(editLink);
    const media = outcome.media === undefined ? undefined : mediaProblem(outcome.media);
    if (media !== undefined) problems.push(media);
    const ai = outcome.ai === undefined ? undefined : aiProblem(outcome.ai);
    if (ai !== undefined) problems.push(ai);
    // Live eval run 1: the drawing gallery (tags typed by the visitor) asked the AI for tags though its spec asks for no AI.
    if (outcome.ai === undefined && outcome.usesAi === true) problems.push("calls workshopData.ai though the spec asks for no AI");
  }
  return problems.length === 0
    ? {
        pass: true,
        detail: `${outcome.files} files written, ${outcome.commits} commits, check passed, no console error, title and all screens shown, ${outcome.editLink?.saved === true ? "saves with the edit link" : "saving controls with the edit link"}, none for a visitor${
          outcome.outsideHosts.length > 0 ? `, outside services: ${outcome.outsideHosts.join(", ")}` : ""
        }${mustFetch ? `, fetched ${outcome.fetchHosts.join(", ")}` : ""}${
          outcome.media === undefined ? "" : `, ${outcome.media.kind === "photo" ? "photo" : "Record"} button, upload kept in the data and shown from its address`
        }${outcome.ai === undefined ? "" : `, calls workshopData.ai.${AI_HELPER[outcome.ai.kind].helper}, suggestion shown, saved only after acceptance`}`,
      }
    : { pass: false, detail: problems.join("; ") };
}

const minutes = (ms: number): string => `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;

export function formatBuildResult(result: BuildEvalResult, index: number): string {
  const head = `${result.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2)} ${result.example.name}: ${result.detail}`;
  const o = result.outcome;
  if (o === undefined) return head;
  const fetches = `${o.fetches} web ${o.fetches === 1 ? "fetch" : "fetches"}${o.fetchHosts.length > 0 ? ` (${o.fetchHosts.join(", ")})` : ""}`;
  return `${head}\n     | ${minutes(o.durationMs)}, ${fetches}, ${o.usage.inputTokens} tokens in, ${o.usage.outputTokens} out, cost $${o.usage.costUsd.toFixed(4)}`;
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

// ---- suggestions (ticket 3.6) ----

export interface SuggestionsEvalOutcome {
  /** Undefined when the answer was unreadable (the worker would store nothing). */
  suggestions?: string[];
  /** The real guardrail's verdict on each suggestion, in order. */
  verdicts: GuardrailVerdict[];
  usage: TokenUsage;
}

export interface SuggestionsEvalResult extends ClarifyScore {
  example: ReadinessExample;
  outcome?: SuggestionsEvalOutcome;
}

/** Scores one spec's suggestions: exactly three, each under 80 characters, each on path for the guardrail. */
export function scoreSuggestions(outcome: SuggestionsEvalOutcome): ClarifyScore {
  const list = outcome.suggestions;
  if (list === undefined) return { pass: false, detail: "unreadable answer (nothing would be stored)" };
  const problems: string[] = [];
  if (list.length !== 3) problems.push(`${list.length} suggestions (expected 3)`);
  for (const s of list) if (Array.from(s).length >= 80) problems.push(`"${s}" is ${Array.from(s).length} characters`);
  outcome.verdicts.forEach((verdict, i) => {
    if (verdict !== "on-path") problems.push(`"${list[i] ?? ""}" is ${verdict} for the guardrail`);
  });
  if (outcome.verdicts.length !== list.length) problems.push("not every suggestion was checked");
  return problems.length === 0 ? { pass: true, detail: "3 suggestions, each under 80 characters and on path" } : { pass: false, detail: problems.join("; ") };
}

/** Runs every example spec, one at a time; a failed call counts as a failure. */
export async function runSuggestionsEval(
  examples: readonly ReadinessExample[],
  suggest: (example: ReadinessExample) => Promise<SuggestionsEvalOutcome>,
  onResult: (result: SuggestionsEvalResult, index: number) => void = () => undefined,
): Promise<SuggestionsEvalResult[]> {
  const results: SuggestionsEvalResult[] = [];
  for (const [i, example] of examples.entries()) {
    let result: SuggestionsEvalResult;
    try {
      const outcome = await suggest(example);
      result = { example, outcome, ...scoreSuggestions(outcome) };
    } catch (error) {
      result = { example, pass: false, detail: `error ${error instanceof Error ? error.name : "Error"}` };
    }
    results.push(result);
    onResult(result, i);
  }
  return results;
}

/** One line per example spec, then its suggestions with their length and verdict (indented). */
export function formatSuggestionsResult(result: SuggestionsEvalResult, index: number): string {
  const head = `${result.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2)} ${result.example.name}: ${result.detail}`;
  const lines = (result.outcome?.suggestions ?? []).map((s, i) => `     | ${s} (${Array.from(s).length} chars, ${result.outcome?.verdicts[i] ?? "unchecked"})`);
  return [head, ...lines].join("\n");
}

export function formatSuggestionsSummary(results: readonly SuggestionsEvalResult[]): string[] {
  const passed = results.filter((r) => r.pass).length;
  const total = addUsage(...results.map((r) => r.outcome?.usage));
  return [`Suggestions: ${passed}/${results.length} passed`, `Tokens: ${total.inputTokens} in, ${total.outputTokens} out, cost $${total.costUsd.toFixed(4)}`];
}

// ---- change (ticket 3.7) ----

/** The change the eval asks for, on the fitness example (the brief's example). */
export const CHANGE_EVAL_REQUEST = "Please add a weekly chart of the distance I ran each week.";

export interface ChangeEvalOutcome {
  /** The first build of the example (scored as the build eval scores it). */
  first: BuildEvalOutcome;
  /** The change conversation's call (ticket 3.6's answerChange) that wrote the new version. */
  specUsage: TokenUsage & { durationMs?: number };
  specProblem?: string;
  newSpec?: string;
  whatChanges: string[];
  /** The change build, scored on the new spec's title and screens. */
  change?: BuildEvalOutcome;
  /** The pushed commit's message. */
  commitMessage?: string;
  /** The pushed commit's SPEC.md is the new version (email addresses removed). */
  specCommitted: boolean;
  /** Screens of the previous spec no longer found on the changed page. */
  previousMissing: string[];
}

export interface ChangeEvalResult extends ClarifyScore {
  outcome?: ChangeEvalOutcome;
}

/**
 * Scores the change eval: the first build passes, the change call wrote a version, and the change build passes the
 * build eval's checks on the new spec (handed over, check passed, no console error, no overflow, title and screens),
 * keeps every screen of the previous spec, and is one commit "Change 1: ..." holding the new SPEC.md.
 */
export function scoreChange(outcome: ChangeEvalOutcome): ClarifyScore {
  const first = scoreBuild(outcome.first);
  if (!first.pass) return { pass: false, detail: `first build: ${first.detail}` };
  if (outcome.specProblem !== undefined) return { pass: false, detail: outcome.specProblem };
  if (outcome.change === undefined) return { pass: false, detail: "no change build" };
  const problems: string[] = [];
  const change = scoreBuild(outcome.change);
  if (!change.pass) problems.push(change.detail);
  if (outcome.change.outcome === "handed-over") {
    if (outcome.change.commits !== 1) problems.push(`${outcome.change.commits} commits (one expected)`);
    if (!/^Change 1: \S/.test(outcome.commitMessage ?? "")) problems.push(`commit message "${outcome.commitMessage ?? ""}"`);
    if (!outcome.specCommitted) problems.push("SPEC.md is not the new version");
    if (outcome.previousMissing.length > 0) problems.push(`previous screens missing: ${outcome.previousMissing.join(", ")}`);
  }
  return problems.length === 0
    ? { pass: true, detail: `"${outcome.commitMessage ?? ""}": check passed, no console error, previous and new screens shown, SPEC.md is the new version` }
    : { pass: false, detail: problems.join("; ") };
}

/** The result's lines: verdict, then the time, tokens and cost of the first build, the change call and the change build, and their total. */
export function formatChangeResult(result: ChangeEvalResult): string[] {
  const lines = [`${result.pass ? "PASS" : "FAIL"} change: ${result.detail}`];
  const o = result.outcome;
  if (o === undefined) return lines;
  const cost = (u: TokenUsage): string => `${u.inputTokens} tokens in, ${u.outputTokens} out, cost $${u.costUsd.toFixed(4)}`;
  lines.push(`     | first build: ${minutes(o.first.durationMs)}, ${cost(o.first.usage)}`);
  lines.push(`     | change call: ${minutes(o.specUsage.durationMs ?? 0)}, ${cost(o.specUsage)}${o.whatChanges.length > 0 ? `; what changes: ${o.whatChanges.join(" | ")}` : ""}`);
  if (o.change !== undefined) lines.push(`     | change build: ${minutes(o.change.durationMs)}, ${o.change.files} files written, ${cost(o.change.usage)}`);
  const total = addUsage(o.first.usage, o.specUsage, o.change?.usage);
  const duration = o.first.durationMs + (o.specUsage.durationMs ?? 0) + (o.change?.durationMs ?? 0);
  lines.push(`Change: ${result.pass ? 1 : 0}/1 passed`);
  lines.push(`Duration: ${minutes(duration)} in all (change build ${minutes(o.change?.durationMs ?? 0)}); tokens: ${total.inputTokens} in, ${total.outputTokens} out, cost $${total.costUsd.toFixed(4)}`);
  return lines;
}
