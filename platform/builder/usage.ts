/**
 * The coding agent's tokens as the participant's usage (ticket 2.8): every kind of input (plain, prompt-cache reads,
 * prompt-cache writes) counts in `inputTokens`, and the cost is computed from the build role's EU prices in
 * ../api/settings.ts (MODELS.build), never from the Agent SDK's own dollar estimate (list prices, not Bedrock's EU
 * profile).
 */
import type { ModelPrice } from "../api/settings.js";
import type { TokenUsage } from "../api/types.js";

/** Tokens of one agent run, by how Bedrock bills them. */
export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const NO_TOKENS: AgentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** The sum of token counts (bad values count as 0). */
export function addTokens(...parts: readonly AgentTokens[]): AgentTokens {
  return parts.reduce<AgentTokens>(
    (sum, part) => ({
      input: sum.input + whole(part.input),
      output: sum.output + whole(part.output),
      cacheRead: sum.cacheRead + whole(part.cacheRead),
      cacheWrite: sum.cacheWrite + whole(part.cacheWrite),
    }),
    NO_TOKENS,
  );
}

/** US dollars for the tokens at `price` (per million), rounded to 1e-8 like the conversation's costs. */
export function costOfTokens(tokens: AgentTokens, price: ModelPrice): number {
  const raw = (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / 1_000_000;
  return Math.round(raw * 1e8) / 1e8;
}

/** The usage added to the participant's totals. */
export function usageOfTokens(tokens: AgentTokens, price: ModelPrice): TokenUsage {
  return {
    inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
    outputTokens: tokens.output,
    costUsd: costOfTokens(tokens, price),
  };
}
