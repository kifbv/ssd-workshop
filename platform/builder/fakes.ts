// In-memory stand-ins for the builder's outside world (ticket 2.8), for its tests and the build eval (not bundled):
// the build record with its feed, the usage totals, the deploy queue and a scripted coding agent.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addUsage } from "../api/conversation/model.js";
import type { BuildStatus, TokenUsage } from "../api/types.js";
import type { AgentResult, AgentRun, CodingAgent } from "./agent.js";
import type { BuildRecords, BuildToRun, FeedEvent } from "./records.js";
import type { DeployMessage, DeployQueue } from "./runner.js";
import { NO_TOKENS, type AgentTokens } from "./usage.js";

export interface FakeBuildItem {
  nickname: string;
  participantId: string;
  status: BuildStatus;
  feed?: FeedEvent[];
  pushedCommit?: string;
  failureReasons?: string[];
  finishedAt?: string;
  updatedAt?: string;
}

/** Follows DynamoBuildRecords' conditions. */
export class FakeBuildRecords implements BuildRecords {
  readonly builds = new Map<string, FakeBuildItem>();
  /** Usage totals by participant id. */
  readonly usage = new Map<string, TokenUsage>();
  /** Every write, in order, for "what was written" checks. */
  readonly writes: { method: string; value: unknown }[] = [];

  async read(buildId: string): Promise<BuildToRun | undefined> {
    const build = this.builds.get(buildId);
    return build && { nickname: build.nickname, participantId: build.participantId, status: build.status };
  }

  async claim(buildId: string, nickname: string, first: FeedEvent, nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.nickname !== nickname || (build.status !== "queued" && build.status !== "building") || build.pushedCommit !== undefined) return false;
    const next: FakeBuildItem = { ...build, status: "building", feed: [first], updatedAt: nowIso };
    delete next.failureReasons;
    delete next.finishedAt;
    this.builds.set(buildId, next);
    this.writes.push({ method: "claim", value: first });
    return true;
  }

  async addFeed(buildId: string, events: readonly FeedEvent[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building") return false;
    build.feed = [...(build.feed ?? []), ...events];
    build.updatedAt = nowIso;
    this.writes.push({ method: "addFeed", value: events });
    return true;
  }

  async handOver(buildId: string, commit: string, events: readonly FeedEvent[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building" || build.pushedCommit !== undefined) return false;
    build.pushedCommit = commit;
    build.feed = [...(build.feed ?? []), ...events];
    build.updatedAt = nowIso;
    this.writes.push({ method: "handOver", value: { commit, events } });
    return true;
  }

  async markFailed(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building") return false;
    build.status = "failed";
    build.failureReasons = [...reasons];
    build.finishedAt = nowIso;
    build.updatedAt = nowIso;
    this.writes.push({ method: "markFailed", value: reasons });
    return true;
  }

  async addUsage(participantId: string, usage: TokenUsage): Promise<void> {
    this.usage.set(participantId, addUsage(this.usage.get(participantId), usage));
    this.writes.push({ method: "addUsage", value: usage });
  }
}

export class FakeDeployQueue implements DeployQueue {
  readonly sent: DeployMessage[] = [];
  /** Sends that fail before one succeeds. */
  failures = 0;

  async send(message: DeployMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw Object.assign(new Error("queue is down"), { name: "ServiceUnavailable" });
    }
    this.sent.push({ ...message });
  }
}

/** One step of a scripted agent: write a file (relative path), spend tokens, or wait until aborted. */
export type AgentStep = { write: string; content: string } | { tokens: AgentTokens } | { hang: true } | { fail: true };

/** A coding agent that follows a script, writing into the workspace as the real one would. */
export class FakeAgent implements CodingAgent {
  readonly runs: AgentRun[] = [];

  constructor(private readonly script: AgentStep[]) {}

  async run(run: AgentRun): Promise<AgentResult> {
    this.runs.push(run);
    let tokens = NO_TOKENS;
    for (const step of this.script) {
      if ("write" in step) {
        const target = join(run.workspace, ...step.write.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, step.content);
        run.onFileWritten(step.write);
      } else if ("tokens" in step) {
        tokens = step.tokens;
        run.onTokens(tokens);
      } else if ("hang" in step) {
        await new Promise<void>((resolve) => {
          if (run.signal.aborted) resolve();
          run.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { outcome: "error", tokens };
      } else {
        return { outcome: "error", tokens };
      }
    }
    return { outcome: "done", tokens };
  }
}
