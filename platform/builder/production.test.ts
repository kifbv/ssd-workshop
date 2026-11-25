// Ticket 2.15 try 2 (access review L3): the builder task's coding agent never gets the session's web proxy settings.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builderAgent } from "./production.js";

const PROXY_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "https_proxy", "http_proxy", "no_proxy", "node_extra_ca_certs"];

describe("the builder task's agent (platform/builder/main.ts)", () => {
  it("gets no web proxy or CA setting in its environment, even when the task's own environment holds them", () => {
    const source = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy:1",
      https_proxy: "http://proxy:1",
      HTTP_PROXY: "http://proxy:2",
      http_proxy: "http://proxy:2",
      NO_PROXY: "169.254.170.2",
      no_proxy: "169.254.170.2",
      NODE_EXTRA_CA_CERTS: "/ca.crt",
    };
    const env = builderAgent(source, () => undefined).environment("eu.anthropic.claude-sonnet-4-6", "/tmp/agent-home", "http://127.0.0.1:43123/x");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBe("http://127.0.0.1:43123/x");
    for (const name of Object.keys(env)) expect(PROXY_NAMES, name).not.toContain(name);
    expect(Object.keys(env).filter((name) => /proxy|_CA_|CERT/i.test(name))).toEqual([]);
    expect(JSON.stringify(env)).not.toMatch(/proxy:|ca\.crt|169\.254/);
  });

  it("is the agent main.ts runs: main.ts builds it only through builderAgent, never with its own ClaudeAgent", () => {
    const main = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
    expect(main).toMatch(/agent: builderAgent\(process\.env, /);
    expect(main).not.toMatch(/ClaudeAgent|webProxyEnvironment/);
  });
});
