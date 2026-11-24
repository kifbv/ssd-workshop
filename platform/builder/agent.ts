/**
 * The coding agent (ticket 2.8): Claude Code through the Claude Agent SDK, on Bedrock (the build role's EU inference
 * profile), working in one workspace folder with file tools only (./permissions.ts).
 *
 * How the "no rights" rule holds (decision "Spec delta, CHANGED ... Builder"):
 * - the tool set is Read, Write, Edit and Glob (`tools`), the shell, network, notebook, subagent and other tools are
 *   also `disallowedTools`, and a PreToolUse hook (`onFailure: "block"`) denies any call `checkToolCall` refuses (any
 *   other tool, any path outside the workspace) before Claude Code's own rules run. It is the only gate: `canUseTool`
 *   is never consulted for tools listed in `allowedTools`, so it is not set (the SDK warns when it is);
 * - `permissionMode: "dontAsk"` never auto-approves anything not listed; no settings files (`settingSources: []`), no
 *   MCP servers (`strictMcpConfig`), no skills, no plugins, no saved session;
 * - the process gets an explicit, minimal environment (`agentEnvironment`): `PATH`, a fresh home folder and Bedrock's
 *   settings pointing at the runner's local Bedrock proxy (./bedrock-proxy.ts, `ANTHROPIC_BEDROCK_BASE_URL` with
 *   `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`), which signs the build model's calls with the runner's credentials and refuses
 *   anything else. No AWS credential or credential-endpoint variable, no GitHub token, no proxy setting.
 */
import type { Agent as HttpAgent } from "node:http";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { startBedrockProxy, type BedrockProxyLogEntry, type CredentialSource } from "./bedrock-proxy.js";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, checkToolCall, insideWorkspace, workspacePath } from "./permissions.js";
import { NO_TOKENS, addTokens, type AgentTokens } from "./usage.js";

export interface AgentRun {
  /** The folder holding the app (the repository's files); the agent works only there. */
  workspace: string;
  prompt: string;
  /** The build role's model (an `eu.anthropic.*` inference profile). */
  modelId: string;
  /** Aborted at the build's time limit: the agent must stop. */
  signal: AbortSignal;
  /** A file the agent wrote or edited (workspace-relative, `/` between folders), after the tool succeeded. */
  onFileWritten: (path: string) => void;
  /** The tokens so far (cumulative), whenever they change: kept even when the run is cut off. */
  onTokens: (tokens: AgentTokens) => void;
}

/** `done`: the agent finished its turn; `error`: it stopped on an error (Bedrock, the SDK, a limit). */
export interface AgentResult {
  outcome: "done" | "error";
  tokens: AgentTokens;
}

export interface CodingAgent {
  /** Never throws: a failure is `outcome: "error"`. Stops (and resolves) when `signal` aborts. */
  run(run: AgentRun): Promise<AgentResult>;
}

/** What the agent is asked: the instructions live in AGENTS.md and the app in SPEC.md, both in the workspace. */
export function buildPrompt(workspace: string): string {
  return [
    `Your working folder is ${workspace}. It holds a small web app's starter files.`,
    "Read AGENTS.md first and follow it exactly, then read SPEC.md and build the app it describes in this folder.",
    "Use only the files in this folder. When the app is complete and checked against AGENTS.md, stop.",
  ].join("\n");
}

/** At most this many agent turns (a small app takes 30 to 50). */
export const MAX_AGENT_TURNS = 120;

/**
 * Environment variables passed through to the agent's process when set: only `PATH`. The agent calls nothing but the
 * local Bedrock proxy (plain HTTP on 127.0.0.1), so it needs no AWS credential, proxy or CA setting.
 */
export const PASSED_ENVIRONMENT = ["PATH"] as const;

/**
 * The agent process's whole environment: Bedrock through the runner's local proxy (`bedrockUrl`, no AWS credential:
 * `CLAUDE_CODE_SKIP_BEDROCK_AUTH`), every model alias set to the build model (the proxy forwards no other), no
 * non-essential traffic (telemetry, error reports, updates), a fresh home and configuration folder, and `PATH`.
 * Nothing else.
 */
export function agentEnvironment(source: Readonly<Record<string, string | undefined>>, modelId: string, home: string, bedrockUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ENVIRONMENT) {
    const value = source[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_BEDROCK_BASE_URL: bedrockUrl,
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    AWS_REGION: "eu-central-1",
    ANTHROPIC_MODEL: modelId,
    ANTHROPIC_SMALL_FAST_MODEL: modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}

type HookOutput = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } } | Record<string, never>;

/** The PreToolUse hook: deny (with the reason, which the agent sees) whatever `checkToolCall` refuses. */
export function preToolUse(workspace: string, toolName: unknown, toolInput: unknown): HookOutput {
  const decision = checkToolCall(workspace, typeof toolName === "string" ? toolName : "", toolInput);
  if (decision.allow) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } };
}

/** The workspace-relative path a successful Write or Edit touched, or undefined. */
export function writtenPath(workspace: string, toolName: unknown, toolInput: unknown): string | undefined {
  if (toolName !== "Write" && toolName !== "Edit") return undefined;
  const path = (toolInput as { file_path?: unknown } | null)?.file_path;
  if (typeof path !== "string" || !insideWorkspace(workspace, path)) return undefined;
  return workspacePath(workspace, path);
}

/** The SDK options of one run (exported for the test that pins them). */
export function agentOptions(run: Omit<AgentRun, "prompt" | "onTokens">, abortController: AbortController, env: Record<string, string>): Options {
  return {
    cwd: run.workspace,
    model: run.modelId,
    tools: [...ALLOWED_TOOLS],
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    skills: [],
    plugins: [],
    agents: {},
    persistSession: false,
    maxTurns: MAX_AGENT_TURNS,
    env,
    abortController,
    hooks: {
      PreToolUse: [{ onFailure: "block", hooks: [async (input) => preToolUse(run.workspace, (input as { tool_name?: unknown }).tool_name, (input as { tool_input?: unknown }).tool_input)] }],
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              const path = writtenPath(run.workspace, (input as { tool_name?: unknown }).tool_name, (input as { tool_input?: unknown }).tool_input);
              if (path !== undefined) run.onFileWritten(path);
              return {};
            },
          ],
        },
      ],
    },
    // The agent's own output is never printed (it could quote the spec).
    stderr: () => undefined,
  };
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Tracks the tokens of a run from the SDK's messages: each API response's usage by message id while it streams (so a
 * run cut off still counts what it used), replaced by the result's per-model totals when the run ends.
 */
export class TokenTracker {
  private readonly byMessage = new Map<string, AgentTokens>();
  private final: AgentTokens | undefined;

  /** True when the total changed. */
  see(message: SDKMessage): boolean {
    if (message.type === "assistant") {
      const usage = message.message.usage as unknown as Record<string, unknown> | undefined;
      if (usage === undefined) return false;
      this.byMessage.set(message.message.id, {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
      });
      return true;
    }
    if (message.type === "result") {
      const models = Object.values(message.modelUsage ?? {});
      if (models.length === 0) return false;
      this.final = addTokens(
        ...models.map((m) => ({ input: count(m.inputTokens), output: count(m.outputTokens), cacheRead: count(m.cacheReadInputTokens), cacheWrite: count(m.cacheCreationInputTokens) })),
      );
      return true;
    }
    return false;
  }

  get total(): AgentTokens {
    return this.final ?? addTokens(NO_TOKENS, ...this.byMessage.values());
  }
}

/** How the runner's Bedrock proxy reaches Bedrock: the runner's credentials and, in local runs, the HTTPS proxy agent. */
export interface BedrockAccess {
  credentials: CredentialSource;
  agent?: HttpAgent;
  log?: (entry: BedrockProxyLogEntry) => void;
}

/**
 * The real agent: one `query()` of the Claude Agent SDK, talking to Bedrock only through a local proxy started for
 * the run and closed after it.
 */
export class ClaudeAgent implements CodingAgent {
  constructor(
    private readonly source: Readonly<Record<string, string | undefined>>,
    private readonly makeHome: () => Promise<string>,
    private readonly bedrock: BedrockAccess,
  ) {}

  async run(run: AgentRun): Promise<AgentResult> {
    const tracker = new TokenTracker();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (run.signal.aborted) return { outcome: "error", tokens: NO_TOKENS };
    run.signal.addEventListener("abort", stop, { once: true });
    let outcome: AgentResult["outcome"] = "error";
    let proxy: Awaited<ReturnType<typeof startBedrockProxy>> | undefined;
    try {
      proxy = await startBedrockProxy({
        modelId: run.modelId,
        credentials: this.bedrock.credentials,
        ...(this.bedrock.agent === undefined ? {} : { agent: this.bedrock.agent }),
        ...(this.bedrock.log === undefined ? {} : { log: this.bedrock.log }),
      });
      const env = agentEnvironment(this.source, run.modelId, await this.makeHome(), proxy.url);
      for await (const message of query({ prompt: run.prompt, options: agentOptions(run, controller, env) })) {
        if (tracker.see(message)) run.onTokens(tracker.total);
        if (message.type === "result") outcome = message.subtype === "success" && !message.is_error ? "done" : "error";
      }
    } catch {
      outcome = "error";
    } finally {
      run.signal.removeEventListener("abort", stop);
      await proxy?.close();
    }
    return { outcome: run.signal.aborted ? "error" : outcome, tokens: tracker.total };
  }
}
