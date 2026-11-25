/**
 * The builder task's coding agent and HTTPS proxy agent (ticket 2.15 try 2, access review L3), apart from ./main.ts so
 * a test can check them without starting a build. The agent gets no web proxy settings (`webProxyEnvironment` is for
 * the build eval only): in the task it fetches straight out, and its environment never holds `HTTPS_PROXY`,
 * `HTTP_PROXY`, `NO_PROXY` or `NODE_EXTRA_CA_CERTS` (./production.test.ts).
 */
import { mkdtemp } from "node:fs/promises";
import { Agent, type AgentOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { ClaudeAgent } from "./agent.js";
import type { BedrockProxyLogEntry } from "./bedrock-proxy.js";

/** The session's HTTPS proxy agent when one is set (local runs); none on Fargate. Used for AWS calls only. */
export function proxyAgent(source: Readonly<Record<string, string | undefined>> = process.env): Agent | undefined {
  const proxy = source.HTTPS_PROXY || source.https_proxy;
  return proxy ? new Agent({ proxyEnv: source } as AgentOptions) : undefined;
}

/**
 * The builder task's coding agent: the task role's credentials for the local Bedrock proxy (through the session's
 * proxy in local runs), and no web proxy settings for the agent itself.
 */
export function builderAgent(source: Readonly<Record<string, string | undefined>>, log: (entry: BedrockProxyLogEntry) => void): ClaudeAgent {
  const upstreamAgent = proxyAgent(source);
  return new ClaudeAgent(source, () => mkdtemp(join(tmpdir(), "ssd-agent-home-")), {
    credentials: defaultProvider(),
    ...(upstreamAgent === undefined ? {} : { agent: upstreamAgent }),
    log,
  });
}
