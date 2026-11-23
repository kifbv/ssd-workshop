// The AI model behind the conversation (ticket 1.7): a small interface, so the worker, the guardrail
// check and the eval run against an in-memory fake in tests and against Claude on Bedrock for real.
import { ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { PRICE_PER_MILLION_TOKENS } from "../settings.js";
import type { TokenUsage } from "../types.js";

export interface ModelTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ModelRequest {
  system: string;
  /** Alternating turns, the first and the last from the user. */
  messages: ModelTurn[];
  maxTokens: number;
  temperature: number;
}

export interface ModelReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelClient {
  /** One call; `signal` aborts it (the worker's deadline). Throws on any failure. */
  converse(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
}

/** US dollars for the tokens of one call at MODEL_ID's EU prices, rounded to 1e-8. */
export function costOf(inputTokens: number, outputTokens: number): number {
  const raw = (inputTokens * PRICE_PER_MILLION_TOKENS.input + outputTokens * PRICE_PER_MILLION_TOKENS.output) / 1_000_000;
  return Math.round(raw * 1e8) / 1e8;
}

export function usageOf(reply: Pick<ModelReply, "inputTokens" | "outputTokens">): TokenUsage {
  return { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costUsd: costOf(reply.inputTokens, reply.outputTokens) };
}

/** Sum of usages (the guardrail call and the answer call). */
export function addUsage(...usages: (TokenUsage | undefined)[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const u of usages) {
    if (u === undefined) continue;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    costUsd += u.costUsd;
  }
  return { inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e8) / 1e8 };
}

/** The one method of BedrockRuntimeClient the adapter uses, so tests can stub it. */
export interface ConverseSender {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

/** Claude on Bedrock through the Converse API (one inference profile, `eu.anthropic.*`). */
export class BedrockModel implements ModelClient {
  constructor(
    private readonly client: ConverseSender,
    private readonly modelId: string,
  ) {
    if (!modelId.startsWith("eu.anthropic.")) throw new Error("the model must be an EU inference profile (eu.anthropic.*)");
  }

  async converse(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    const output = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: request.system }],
        messages: request.messages.map((m) => ({ role: m.role, content: [{ text: m.text }] })),
        inferenceConfig: { maxTokens: request.maxTokens, temperature: request.temperature },
      }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
    const text = (output.output?.message?.content ?? [])
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    return { text, inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0 };
  }
}
