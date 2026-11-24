/**
 * The builder's runner (ticket 2.8): turns one build into a commit the deployer publishes.
 *
 * 1. reads the build (nickname and participant come only from the stored record, decision "(2.6) For 2.7 to 2.9")
 *    and claims it (`building`, a new feed starting with the step `preparing`);
 * 2. preparing: reads `main` and downloads the repository at that commit into a fresh workspace folder;
 * 3. writing: runs the coding agent (./agent.ts) with AGENTS.md and SPEC.md, at most BUILD_AGENT_TIMEOUT_MS (12
 *    minutes); every file it writes goes into the feed; its tokens and their cost go to the participant's usage;
 * 4. checking: the deploy check (../api/build/check.ts) on the workspace;
 * 5. committing: the agent's work as a few commits (./repository.ts), each in the feed with its id and message;
 * 6. deploying: stores the pushed commit on the build (`pushedCommit`, which the deployer's start condition requires)
 *    and sends `{buildId, nickname, commit}` to the deploy queue; the deployer then marks the build live or failed.
 *
 * Any failure marks the build `failed` with one plain reason ("The build took too long." at the time limit), only
 * while it is still `building`. When a feed write is refused (the build is no longer `building`: someone else marked
 * it failed), the runner stops at once (try 3): it aborts the agent, pushes no commit, sends no message, writes nothing
 * more on the build and ends with `no-build`. Logs are one JSON line per phase: the phase, its outcome, counts, the duration and an
 * error name; never a token, nickname, build id, path, spec text or error message.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkApp, readAppFolder } from "../api/build/check.js";
import { storedReason, storedReasons } from "../api/deploy/deploy.js";
import { ArchiveProblem, readTarGz } from "../api/deploy/tar.js";
import { DownloadProblem } from "../api/deploy/deploy.js";
import { GitHubProblem, type GitHubDeps } from "../api/github/app.js";
import { removeEmailAddresses, type RepositoryFile } from "../api/github/repository.js";
import { BUILD_ID_PATTERN } from "../api/keys.js";
import { appArchiveUrl, BUILD_AGENT_TIMEOUT_MS, type ModelSetting } from "../api/settings.js";
import { errorName } from "../api/sign-in/code-request.js";
import type { TokenUsage } from "../api/types.js";
import { buildPrompt, type CodingAgent } from "./agent.js";
import { MAX_FEED_FILES, type BuildRecords, type BuildStep, type FeedEvent } from "./records.js";
import { planCommits, pushCommits, readMain } from "./repository.js";
import { NO_TOKENS, usageOfTokens, type AgentTokens } from "./usage.js";

/** The deploy message, exactly as the deployer reads it (decision "(2.5) Deploy message"). */
export interface DeployMessage {
  buildId: string;
  nickname: string;
  commit: string;
}

export interface DeployQueue {
  /** Sends the message; the queue is FIFO, deduplicated by the build id, grouped by the lower-cased nickname. */
  send(message: DeployMessage): Promise<void>;
}

export type BuilderPhase = "start" | BuildStep | "usage" | "finish";

export interface BuilderLogEntry {
  event: "builder";
  phase: BuilderPhase;
  outcome: "ok" | "no-build" | "failed" | "timeout" | "error";
  files?: number;
  commits?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
  durationMs: number;
}

export interface RunnerDeps {
  records: BuildRecords;
  /** GitHub calls (fetch, clock, log, retries' sleep). */
  github: GitHubDeps;
  /** Downloads a tarball (size-capped, ../api/deploy/github.ts). */
  download: (url: string) => Promise<Uint8Array>;
  agent: CodingAgent;
  queue: DeployQueue;
  /** A new empty folder for the workspace. */
  makeWorkspace: () => Promise<string>;
  removeWorkspace: (path: string) => Promise<void>;
  model: ModelSetting;
  now: () => Date;
  log: (entry: BuilderLogEntry) => void;
  /** Default BUILD_AGENT_TIMEOUT_MS. */
  agentTimeoutMs?: number;
}

export interface BuildJob {
  buildId: string;
  /** The build's one-repository GitHub token (ticket 2.6's `builderToken`, minted by the launcher). */
  token: string;
}

/**
 * The job from the task's environment (ticket 2.9 sets it): `BUILD_ID` and `BUILDER_GITHUB_TOKEN`. The token is removed
 * from `env` as soon as it is read. An error names the variable only.
 */
export function jobFromEnvironment(env: Record<string, string | undefined>): { buildId: string; token: string } | { error: string } {
  const buildId = env.BUILD_ID;
  const token = env.BUILDER_GITHUB_TOKEN;
  delete env.BUILDER_GITHUB_TOKEN;
  if (buildId === undefined || !BUILD_ID_PATTERN.test(buildId)) return { error: "BUILD_ID is missing or not a build id" };
  if (token === undefined || token.trim() === "") return { error: "BUILDER_GITHUB_TOKEN is missing" };
  return { buildId, token: token.trim() };
}

/** `handed-over`: the deployer has the commit; `failed`: the build was marked failed; `no-build`: nothing to do. */
export type BuildOutcome = "handed-over" | "failed" | "no-build";

export const TIME_UP_REASON = "The build took too long.";
export const AGENT_FAILED_REASON = "The AI could not finish building the app this time.";
export const NOTHING_CHANGED_REASON = "The AI did not change the app, so there was nothing to publish.";
export const NOT_PLAIN_FILES_REASON = "The app's repository holds something other than plain files and folders, so it was not built.";
export const HAND_OVER_REASON = "The finished app could not be handed to the publishing step.";
export const SERVICE_REASON = "The build stopped because of a problem on the workshop's side.";

/** A feed write was refused: the build is no longer `building` (someone else finished it). The runner stops. */
class BuildGone extends Error {
  constructor() {
    super("build gone");
    this.name = "BuildGone";
  }
}

/** A failure with a plain reason for the build record. */
class BuildFailure extends Error {
  constructor(readonly reasons: string[]) {
    super("build failed");
    this.name = "BuildFailure";
  }
}

/** The build's reason for an error: plain text only (a GitHub step and status, a download's reason), never a message from elsewhere. */
function reasonsFor(error: unknown): string[] {
  if (error instanceof BuildFailure) return error.reasons;
  if (error instanceof GitHubProblem) return [storedReason(`GitHub: ${error.message}`)];
  if (error instanceof DownloadProblem || error instanceof ArchiveProblem) return [storedReason(error.reason)];
  return [SERVICE_REASON];
}

/** How many times the deploy message is sent before the build is marked failed. */
const SEND_TRIES = 3;

/** A feed path: control characters as `?`, email-shaped text removed, at most 500 characters. */
const feedPath = (path: string): string => storedReason(removeEmailAddresses(path));

/** Writes the repository's files into the workspace (folders made as needed). */
async function writeWorkspace(workspace: string, files: readonly RepositoryFile[]): Promise<void> {
  for (const file of files) {
    const target = join(workspace, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}

export async function runBuild(job: BuildJob, deps: RunnerDeps): Promise<BuildOutcome> {
  const started = deps.now().getTime();
  let phaseStarted = started;
  const nowIso = (): string => deps.now().toISOString();
  const log = (phase: BuilderPhase, outcome: BuilderLogEntry["outcome"], extra: Partial<BuilderLogEntry> = {}): void => {
    const now = deps.now().getTime();
    deps.log({ event: "builder", phase, outcome, ...extra, durationMs: Math.max(0, now - phaseStarted) });
    phaseStarted = now;
  };
  const step = (name: BuildStep): FeedEvent => ({ kind: "step", step: name, at: nowIso() });

  let build;
  try {
    build = await deps.records.read(job.buildId);
  } catch (error) {
    log("start", "error", { error: errorName(error) });
    // Deliberately no cause: only the error's name is ever printed.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("build failed");
  }
  if (build === undefined || (build.status !== "queued" && build.status !== "building")) {
    log("start", "no-build");
    return "no-build";
  }
  const { nickname, participantId } = build;
  if (!(await deps.records.claim(job.buildId, nickname, step("preparing"), nowIso()))) {
    log("start", "no-build");
    return "no-build";
  }
  log("start", "ok");

  // Feed writes run one after the other, in order. A refused one (the build is no longer `building`) rejects with
  // BuildGone, and the run stops: nothing more is written, pushed or sent.
  let feedQueue: Promise<unknown> = Promise.resolve();
  const feed = (...events: FeedEvent[]): Promise<void> => {
    const next = feedQueue.then(() => deps.records.addFeed(job.buildId, events, nowIso()));
    feedQueue = next.catch(() => undefined);
    return next.then((written) => {
      if (!written) throw new BuildGone();
    });
  };

  let workspace: string | undefined;
  let phase: BuilderPhase = "preparing";
  try {
    // preparing
    workspace = await deps.makeWorkspace();
    const head = await readMain(deps.github, job.token, nickname);
    const entries = readTarGz(await deps.download(appArchiveUrl(nickname, head)));
    if (entries.some((entry) => entry.kind !== "file" && entry.kind !== "dir")) throw new BuildFailure([NOT_PLAIN_FILES_REASON]);
    const base: RepositoryFile[] = entries.filter((entry) => entry.kind === "file").map((entry) => ({ path: entry.path, bytes: entry.bytes }));
    await writeWorkspace(workspace, base);
    log("preparing", "ok", { files: base.length });

    // writing
    phase = "writing";
    await feed(step("writing"));
    const written = new Set<string>();
    const fileWrites: Promise<void>[] = [];
    let tokens: AgentTokens = NO_TOKENS;
    const controller = new AbortController();
    const limit = deps.agentTimeoutMs ?? BUILD_AGENT_TIMEOUT_MS;
    let timedOut = false;
    // Set when a file event is refused (the build was finished elsewhere): the agent is aborted and not waited for.
    let gone = false;
    let stopGone: (() => void) | undefined;
    const goneNow = new Promise<"gone">((resolve) => {
      stopGone = () => resolve("gone");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeUp = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve("timeout");
      }, limit);
    });
    const ws = workspace;
    const result = await Promise.race([
      deps.agent
        .run({
          workspace: ws,
          prompt: buildPrompt(ws),
          modelId: deps.model.modelId,
          signal: controller.signal,
          onFileWritten: (path) => {
            if (written.has(path) || written.size >= MAX_FEED_FILES || controller.signal.aborted) return;
            written.add(path);
            fileWrites.push(
              feed({ kind: "file", path: feedPath(path), at: nowIso() }).catch((error: unknown) => {
                if (!(error instanceof BuildGone)) {
                  // The build goes on without this file in its feed: say so (error name only, no path).
                  log("writing", "error", { error: errorName(error) });
                  return;
                }
                gone = true;
                controller.abort();
                stopGone?.();
              }),
            );
          },
          onTokens: (total) => {
            tokens = total;
          },
        })
        .then(
          (outcome) => outcome,
          () => ({ outcome: "error" as const, tokens }),
        ),
      timeUp,
      goneNow,
    ]);
    clearTimeout(timer);
    if (result !== "timeout" && result !== "gone") tokens = result.tokens;
    await Promise.all(fileWrites);
    const usage: TokenUsage = usageOfTokens(tokens, deps.model.price);
    if (!gone) log("writing", timedOut ? "timeout" : result === "timeout" || result === "gone" || result.outcome !== "done" ? "error" : "ok", { files: written.size });
    try {
      await deps.records.addUsage(participantId, usage, nowIso());
      log("usage", "ok", { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
    } catch (error) {
      log("usage", "error", { error: errorName(error), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
    }
    if (gone) throw new BuildGone();
    if (timedOut) throw new BuildFailure([TIME_UP_REASON]);
    if (result === "timeout" || result === "gone" || result.outcome !== "done") throw new BuildFailure([AGENT_FAILED_REASON]);

    // checking
    phase = "checking";
    await feed(step("checking"));
    const files = await readAppFolder(workspace);
    const check = checkApp(files);
    if (!check.ok) throw new BuildFailure(storedReasons(check.problems));
    const final: RepositoryFile[] = files.filter((file) => file.kind === "file").map((file) => ({ path: file.path, bytes: file.bytes }));
    const planned = planCommits(base, final);
    if (planned.length === 0) throw new BuildFailure([NOTHING_CHANGED_REASON]);
    log("checking", "ok", { files: final.length });

    // committing
    phase = "committing";
    await feed(step("committing"));
    const pushed = await pushCommits(deps.github, job.token, nickname, head, planned);
    const last = pushed[pushed.length - 1];
    if (last === undefined) throw new BuildFailure([NOTHING_CHANGED_REASON]);
    await feed(...pushed.map((commit): FeedEvent => ({ kind: "commit", sha: commit.sha, message: commit.message, at: nowIso() })));
    log("committing", "ok", { commits: pushed.length });

    // deploying
    phase = "deploying";
    await feedQueue;
    if (!(await deps.records.handOver(job.buildId, last.sha, [step("deploying")], nowIso()))) {
      log("deploying", "no-build");
      return "no-build";
    }
    let sendError: unknown;
    for (let attempt = 0; attempt < SEND_TRIES; attempt += 1) {
      try {
        await deps.queue.send({ buildId: job.buildId, nickname, commit: last.sha });
        sendError = undefined;
        break;
      } catch (error) {
        sendError = error;
      }
    }
    if (sendError !== undefined) {
      log("deploying", "error", { error: errorName(sendError) });
      throw new BuildFailure([HAND_OVER_REASON]);
    }
    log("deploying", "ok");
    phaseStarted = started;
    log("finish", "ok");
    return "handed-over";
  } catch (error) {
    await feedQueue;
    if (error instanceof BuildGone) {
      // Finished elsewhere: nothing more is written on it (a markFailed would be refused anyway).
      log(phase, "no-build");
      return "no-build";
    }
    // Reasons quote file names and lines of the app: email-shaped text is removed, as in the feed.
    const reasons = reasonsFor(error).map((reason) => storedReason(removeEmailAddresses(reason)));
    let marked: boolean;
    try {
      marked = await deps.records.markFailed(job.buildId, reasons, nowIso());
    } catch (markError) {
      log(phase, "error", { error: errorName(markError) });
      // eslint-disable-next-line preserve-caught-error -- no cause, as above
      throw new Error("build failed");
    }
    log(phase, reasons[0] === TIME_UP_REASON ? "timeout" : "failed", { error: errorName(error) });
    return marked ? "failed" : "no-build";
  } finally {
    if (workspace !== undefined) await deps.removeWorkspace(workspace).catch(() => undefined);
  }
}

/**
 * Runs the task's work and then ends the process with its exit code (1 when it throws, after `onError`), so nothing
 * left running (a stray child process, an open socket) keeps the Fargate task alive after the outcome is recorded.
 */
export async function exitWhenDone(work: () => Promise<number>, exit: (code: number) => void, onError: (error: unknown) => void): Promise<void> {
  let code: number;
  try {
    code = await work();
  } catch (error) {
    onError(error);
    code = 1;
  }
  exit(code);
}
