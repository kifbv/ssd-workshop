// The AI tasks' budgets (ticket 3.21, question 7): each UTC day, at most $1 of AI per app, $1 per signed-in writer
// across all apps (try 2, decided by Franck 2026-11-27: WRITER_AI_DAILY_BUDGET_USD) and $10 for all apps together, kept apart from every participant's own $5 (ticket 3.3). Pure: what a call may cost at most (reserved
// before it runs, so parallel calls cannot pass a budget by more than one call), what it did cost (tokens x Haiku 4.5's
// EU price, or Amazon Transcribe's $0.024 a minute), and whether a budget is spent. The table side is ./store.ts.
import { MAX_RECORDING_SECONDS, RECORDING_MARGIN_SECONDS } from "../app-media/media.js";
import { MODELS, TRANSCRIBE_MINIMUM_SECONDS, TRANSCRIBE_PRICE_PER_MINUTE } from "../settings.js";
import { requestTextBytes, type AppAiRequest } from "./tasks.js";

/** What one app may spend on AI tasks per UTC day (question 7: doubled to $1). */
export const APP_AI_DAILY_BUDGET_USD = 1;
/**
 * What one signed-in writer (the nickname stored with the app write token) may spend on AI tasks per UTC day, across
 * every app (ticket 3.21 try 2; decided by Franck 2026-11-27 04:15 UTC, ADDED to question 7's answer in docs/decisions.md). Without it,
 * one participant holding tokens for ten apps could use the whole $10 alone.
 */
export const WRITER_AI_DAILY_BUDGET_USD = 1;
/** What all apps together may spend on AI tasks per UTC day (question 7: doubled to $10). */
export const ALL_APPS_AI_DAILY_BUDGET_USD = 10;
/** The model's answer is at most this many tokens (a tool call with up to 12 values of 200 characters fits). */
export const MAX_OUTPUT_TOKENS = 1024;
/**
 * At most this many input tokens for a call's fixed parts (system prompt, tool definition and its schema, framing), on
 * top of the app's own texts: the longest prompt is ~500 tokens and Bedrock adds ~350 for tool use, so 2,000 is ample.
 */
export const PROMPT_TOKENS_BOUND = 2000;
/**
 * At most this many tokens for one photo: Claude scales an image down to at most ~1.15 megapixels (about 1,600 tokens,
 * width x height / 750) before reading it.
 */
export const IMAGE_TOKENS_BOUND = 1800;
/** Bedrock's Converse API takes images of at most 3.75 MB; a larger stored photo (up to 4 MB) is refused before the call. */
export const BEDROCK_MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
/** Amazon Transcribe reads at most the media API's longest recording: 5 minutes plus its 5 s margin. */
export const MAX_TRANSCRIBE_SECONDS = MAX_RECORDING_SECONDS + RECORDING_MARGIN_SECONDS;

const round = (usd: number): number => Math.round(usd * 1e8) / 1e8;

/** US dollars for one Haiku 4.5 call's tokens at the EU profile's prices. */
export function modelCost(inputTokens: number, outputTokens: number): number {
  const price = MODELS.appAi.price;
  return round((Math.max(0, inputTokens) * price.input + Math.max(0, outputTokens) * price.output) / 1_000_000);
}

/**
 * The most a model call for this request can cost, reserved against both budgets before it runs: the fixed parts, a
 * photo, the app's texts counted twice (in the user block and, as enums or descriptions, in the tool schema; a token is
 * at least one UTF-8 byte) and the longest answer.
 */
export function modelReservation(request: Exclude<AppAiRequest, { task: "transcribe" }>): number {
  const photo = request.task === "sort-text" ? 0 : IMAGE_TOKENS_BOUND;
  return modelCost(PROMPT_TOKENS_BOUND + photo + 2 * requestTextBytes(request), MAX_OUTPUT_TOKENS);
}

/** US dollars Amazon Transcribe bills for a recording of this length: per second, at least 15 s. */
export function transcribeCost(seconds: number): number {
  const billed = Math.max(TRANSCRIBE_MINIMUM_SECONDS, Math.ceil(seconds));
  return round((billed * TRANSCRIBE_PRICE_PER_MINUTE) / 60);
}

/** One budget's counter: the UTC day it counts and the dollars spent that day (absent before the first call). */
export interface DaySpend {
  day: string | undefined;
  usd: number;
}

/** The app's counter, the writer's counter and the all-apps counter, as read. */
export interface AiSpend {
  app: DaySpend;
  writer: DaySpend;
  all: DaySpend;
}

export type SpentBudget = "app-budget" | "writer-budget" | "workshop-budget";

export const utcDay = (time: Date): string => time.toISOString().slice(0, 10);

/** Spent today: the counter's dollars when it counts today, else 0; a broken counter reads as the whole budget (closed). */
export function spentToday(spend: DaySpend, today: string, budget: number): number {
  if (spend.day !== today) return spend.day !== undefined && spend.day > today ? budget : 0;
  return Number.isFinite(spend.usd) && spend.usd >= 0 ? spend.usd : budget;
}

/** Which budget is spent (the app's, then the writer's, then all apps'), or undefined when all have room. At or over a budget, no AI call runs. */
export function spentBudget(spend: AiSpend, today: string): SpentBudget | undefined {
  if (spentToday(spend.app, today, APP_AI_DAILY_BUDGET_USD) >= APP_AI_DAILY_BUDGET_USD) return "app-budget";
  if (spentToday(spend.writer, today, WRITER_AI_DAILY_BUDGET_USD) >= WRITER_AI_DAILY_BUDGET_USD) return "writer-budget";
  if (spentToday(spend.all, today, ALL_APPS_AI_DAILY_BUDGET_USD) >= ALL_APPS_AI_DAILY_BUDGET_USD) return "workshop-budget";
  return undefined;
}
