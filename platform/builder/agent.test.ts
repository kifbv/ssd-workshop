// Ticket 2.8: the coding agent's settings (tools, permissions, environment) and its token count, without calling Claude.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { agentEnvironment, agentOptions, buildPrompt, preToolUse, TokenTracker, writtenPath } from "./agent.js";

const ws = mkdtempSync(join(tmpdir(), "ssd-agent-test-"));
writeFileSync(join(ws, "index.html"), "x");
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const MODEL = "eu.anthropic.claude-sonnet-4-6";

describe("the agent's settings (criterion 2)", () => {
  const run = { workspace: ws, modelId: MODEL, signal: new AbortController().signal, onFileWritten: () => undefined };
  const options = agentOptions(run, new AbortController(), { PATH: "/bin" });

  it("gives file tools only, never asks, loads no settings, MCP servers, skills, plugins or subagents, and saves nothing", () => {
    expect(options.tools).toEqual(["Read", "Write", "Edit", "Glob"]);
    expect(options.allowedTools).toEqual(["Read", "Write", "Edit", "Glob"]);
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"]) expect(options.disallowedTools).toContain(tool);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect(options.agents).toEqual({});
    expect(options.persistSession).toBe(false);
    expect(options.cwd).toBe(ws);
    expect(options.model).toBe(MODEL);
    expect(options.hooks?.PreToolUse?.[0]?.onFailure).toBe("block");
  });

  it("the PreToolUse hook denies what the permission check refuses (the only gate: canUseTool is skipped for allowedTools)", async () => {
    expect(preToolUse(ws, "Bash", { command: "ls" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.any(String) },
    });
    expect(preToolUse(ws, "Read", { file_path: "/etc/passwd" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(preToolUse(ws, "WebFetch", { url: "https://example.org" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(preToolUse(ws, undefined, {})).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(preToolUse(ws, "Read", { file_path: join(ws, "index.html") })).toEqual({});
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const signal = new AbortController().signal;
    expect(await hook?.({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "id" }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: ws }, "t", { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await hook?.({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/x", content: "x" }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: ws }, "t", { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await hook?.({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(ws, "app.js"), content: "x" }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: ws }, "t", { signal })).toEqual({});
    expect(options.canUseTool).toBeUndefined();
  });

  it("reports files written or edited inside the workspace only", () => {
    expect(writtenPath(ws, "Write", { file_path: join(ws, "app.js") })).toBe("app.js");
    expect(writtenPath(ws, "Edit", { file_path: join(ws, "index.html") })).toBe("index.html");
    expect(writtenPath(ws, "Read", { file_path: join(ws, "index.html") })).toBeUndefined();
    expect(writtenPath(ws, "Write", { file_path: "/tmp/elsewhere.js" })).toBeUndefined();
  });

  it("asks the agent to follow AGENTS.md and build SPEC.md in its folder", () => {
    expect(buildPrompt(ws)).toContain(ws);
    expect(buildPrompt(ws)).toMatch(/AGENTS\.md[\s\S]*SPEC\.md/);
  });
});

describe("the agent's environment", () => {
  const source = {
    PATH: "/usr/bin",
    AWS_ACCESS_KEY_ID: "AKIA",
    AWS_SECRET_ACCESS_KEY: "s",
    AWS_SESSION_TOKEN: "t",
    AWS_PROFILE: "default",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
    AWS_CONTAINER_AUTHORIZATION_TOKEN: "x",
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/token",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/web",
    AWS_ROLE_ARN: "arn:aws:iam::1:role/x",
    ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/x",
    HTTPS_PROXY: "http://proxy:1",
    NODE_EXTRA_CA_CERTS: "/ca.crt",
    BUILDER_GITHUB_TOKEN: "ghs_secret",
    GITHUB_TOKEN: "ghs_other",
    GH_TOKEN: "gh",
    ANTHROPIC_API_KEY: "sk-ant",
    ANTHROPIC_BASE_URL: "https://somewhere",
    HOME: "/root",
    CLAUDE_CODE_SOMETHING: "1",
  };
  const PROXY = "http://127.0.0.1:43123";

  it("is Bedrock through the runner's local proxy on the build model only, with no GitHub token, no API key and a fresh home", () => {
    const env = agentEnvironment(source, MODEL, "/tmp/agent-home", PROXY);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/agent-home",
      CLAUDE_CONFIG_DIR: "/tmp/agent-home",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BEDROCK_BASE_URL: PROXY,
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      AWS_REGION: "eu-central-1",
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    });
    expect(JSON.stringify(env)).not.toContain("ghs_");
  });

  it("holds no AWS credential, credential endpoint or profile variable (finding 1): AWS_REGION is the only AWS_ name", () => {
    const env = agentEnvironment(source, MODEL, "/tmp/agent-home", PROXY);
    expect(Object.keys(env).filter((name) => name.startsWith("AWS_"))).toEqual(["AWS_REGION"]);
    expect(Object.keys(env).filter((name) => /CREDENTIAL|TOKEN|SECRET|KEY|ECS_|PROXY|CA_/.test(name))).toEqual([]);
    for (const value of ["AKIA", "/v2/credentials/x", "169.254.170", "/var/run/"]) expect(JSON.stringify(env)).not.toContain(value);
  });
});

describe("TokenTracker (criterion 5)", () => {
  const assistant = (id: string, usage: Record<string, number>) => ({ type: "assistant", message: { id, usage } }) as unknown as SDKMessage;

  it("counts each API answer once (the last usage seen for its id) while the run streams", () => {
    const tracker = new TokenTracker();
    tracker.see(assistant("m1", { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }));
    tracker.see(assistant("m1", { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }));
    tracker.see(assistant("m2", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 150, cache_creation_input_tokens: 0 }));
    expect(tracker.total).toEqual({ input: 6, output: 32, cacheRead: 250, cacheWrite: 50 });
  });

  it("takes the result's per-model totals when the run ends", () => {
    const tracker = new TokenTracker();
    tracker.see(assistant("m1", { input_tokens: 5, output_tokens: 10 }));
    tracker.see({
      type: "result",
      modelUsage: { [MODEL]: { inputTokens: 7, outputTokens: 40, cacheReadInputTokens: 300, cacheCreationInputTokens: 60, webSearchRequests: 0, costUSD: 1, contextWindow: 1, maxOutputTokens: 1 } },
    } as unknown as SDKMessage);
    expect(tracker.total).toEqual({ input: 7, output: 40, cacheRead: 300, cacheWrite: 60 });
  });
});
