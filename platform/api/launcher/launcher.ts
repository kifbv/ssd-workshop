/**
 * The build launcher (ticket 2.9): turns a queued build into a running builder task, and its stuck-build check.
 *
 * Launch, for one message of the launch queue `ssd-workshop-builds.fifo` (body exactly `{"buildId": "<id>"}`; one
 * message group per participant, so one participant's launches run one at a time, decision "(2.6) For 2.9: one
 * preparation at a time"). Every input is untrusted: the message names only a build id, and everything else comes from
 * stored records (decision "(2.6) For 2.7 to 2.9: where the nickname comes from").
 *
 * 1. The build must be `queued`, its `nickname` must equal its participant's profile nickname, and its id must be the
 *    participant's conversation `buildId` (decision "(2.7) For 2.9"); anything else is a duplicate or ignored, dropped
 *    without a write.
 * 2. Claim: one transaction moves the build from `queued` to `building` (conditional, so a second message for the same
 *    build is a duplicate and never starts a second task) and adds it to the watch list (`LAUNCHES`).
 * 3. Reads the approved spec, prepares the repository (ticket 2.6, the template bundled with the function; ticket 3.7: a
 *    change build instead reads `main`'s current commit, writes nothing to the repository, and copies the version's text
 *    and "What changes" list onto the build for the runner, `setChangeInput`), mints the
 *    builder's one-repository token, and starts the task (cluster `ssd-workshop-builds`, the two workshop subnets, a
 *    public IP). The token goes in RunTask's container override `BUILDER_GITHUB_TOKEN` (Franck accepted the risk,
 *    decision "(2.9) Token hand-off"); the app's key and the organization-wide token never leave this process.
 * 4. Records the task on the watch list and the build.
 *
 * Any failure after the claim marks the build failed with a plain reason (and stops a task already started), and the
 * message is consumed: a new try is `npm run builds -- retry <nickname>`.
 *
 * Build slots (ticket 3.4): at most `buildsAtOnce` (SETTINGS, ticket 3.2) builds hold a slot at once. Before the claim,
 * the launcher gives a build it sees for the first time its place in the waiting line (`queueKey`, the time first seen),
 * and marks its entry seen. A build waits (outcome `waiting`: the handler makes its message come back after
 * LAUNCH_WAIT_SECONDS) while the slots in use plus the waiting builds ahead of it (seen within QUEUE_SEEN_MS) reach the
 * cap, so builds start in their order. The claim's transaction also takes the slot: it counts `running` up only while
 * the counter exists and is between 0 and the cap (two launchers can never pass it; a missing or negative counter reads
 * as full until the check repairs it), adds the build's slot holder and removes its waiting entry. The launcher's and the
 * deployer's writes that end a build free its slot (../build/slots.ts); a build the builder task marks failed keeps it
 * until the next check (try 2: the task runs next to the AI agent, so it has no right on the slots at all).
 *
 * Check (every minute, EventBridge Scheduler through the queue `ssd-workshop-builds-check`): a watched build whose task
 * has stopped (or is gone) while the build is still `building` without a pushed commit is marked failed; one still
 * `building` with a pushed commit (handed over, but no deploy started) is marked failed HANDED_OVER_GRACE_MS after its
 * task stopped; a claim that
 * never got a task within LAUNCH_UNSTARTED_MS is marked failed; a task running past BUILD_TASK_MAX_MS is stopped; the
 * launch queue's dead-letter messages fail their `queued` builds, and the deploy queue's fail their builds still
 * waiting for that deploy (decision "(2.5) Deploy message", "(2.7) For 2.9"). Ticket 3.4: it then deletes malformed
 * items among the slot holders, frees the slots of builds no longer `building` or `deploying` (failed by the builder, a
 * writer's release that failed, a build gone or queued again), sets the slot counter to the number of holders left (only
 * if no claim or release moved it meanwhile, unless the counter is missing or negative or the last
 * SLOT_REPAIR_FORCE_AFTER repairs were refused), fails builds waiting in the line longer than QUEUE_WAIT_MAX_MS, and
 * removes waiting entries of builds no longer waiting there.
 *
 * Global Stop (ticket 3.5, the admin's switch in `SETTINGS`): a launch still places its build in the waiting line, then
 * waits (outcome `paused`, its message comes back like a waiting one) without claiming a slot. The check, while Stop is
 * on, stops every running build that has not handed its commit over: one conditional write puts the build back to
 * `queued` from the beginning (no launch, task or feed; its place in the line is its claim's time, so it starts again
 * before builds queued after it) and frees its slot, then the task gets StopTask. Its watch entry stays: it marks a build
 * with no launch message (the access boundary lets only the AI worker and the scheduler send to the launch queue), so
 * after Resume the check launches it itself (`relaunch`, processLaunch with this launcher's deps) as long as time is left,
 * oldest place first; one that must wait for a slot keeps its entry for the next minute. A build that already pushed its
 * commit (handed over) or is `deploying` finishes: no AI runs there. The builder's writes are bound to the removed attempt
 * id, so the stopped task can no longer write, and the check never fails a build that is `queued`. While Stop is on, the
 * queued time limit is not applied, and afterwards a build's wait counts from its place or from the last Resume,
 * whichever is later.
 *
 * Logs: one JSON line per launch or check, with an outcome, counts and an error name; never a token, nickname, build id,
 * repository name or error message.
 */
import { randomUUID } from "node:crypto";
import { GitHubProblem, type AppCredentials, type GitHubDeps } from "../github/app.js";
import {
  builderToken,
  GIT_ID_PATTERN,
  plainLineWithoutEmails,
  prepareRepository,
  readRepositoryMain,
  readRepositorySpec,
  removeEmailAddresses,
  repositoryNameFor,
  type RepositoryFile,
} from "../github/repository.js";
import { isStale, parseSpecReadJob, type AiJob, type RepositoryRead } from "../conversation/state.js";
import { parseDeployJob, storedReason } from "../deploy/deploy.js";
import { BUILD_ID_PATTERN, newQueueKey } from "../keys.js";
import type { WorkshopSettings } from "../workshop/settings.js";
import {
  ACCOUNT,
  BUILD_TASK_MAX_MS,
  BUILDS_CLUSTER_NAME,
  HANDED_OVER_GRACE_MS,
  LAUNCH_UNSTARTED_MS,
  QUEUE_SEEN_MS,
  QUEUE_WAIT_MAX_MS,
  REGION,
  SLOT_REPAIR_FORCE_AFTER,
} from "../settings.js";
import { errorName } from "../sign-in/code-request.js";
import type { BuildStatus } from "../types.js";

/** What the launcher reads of a build. */
export interface LaunchBuild {
  nickname: string;
  participantId: string;
  status: BuildStatus;
  /** Ticket 3.4: its place in the waiting line, once the launcher saw it queued. */
  queueKey?: string;
  /**
   * Ticket 3.7: a change build (`kind: "change"`, written by the AI worker with the build, ticket 3.6) edits the
   * repository's current `main`; anything else is a first build (the template and the spec).
   */
  kind?: "first" | "change";
  /** Change builds: the change's number (1 for a participant's first change) and the spec version it builds. */
  changeNumber?: number;
  specVersion?: number;
}

/** An approved spec version (ticket 3.7: with the "What changes" list a change version carries). */
export interface ApprovedSpec {
  text: string;
  whatChanges?: string[];
  /**
   * Ticket 3.9 try 2: set when the version was approved only by Rebuild from my repository (`rebuildApprovedAt`, which the
   * AI worker writes, never `approvedAt`, which only the conversation function writes): the request message it was made
   * for. The launcher then builds it only while its text equals the `repositorySpec` it stored on that request itself.
   */
  rebuildRequestId?: string;
}

/**
 * Ticket 3.7: what the launcher copies onto a change build for its runner (attributes only the launcher writes):
 * the spec version's text and its "What changes" list, read from that participant's `SPEC#<specVersion>`.
 */
export interface ChangeInput {
  spec: string;
  whatChanges: string[];
}

/** The slot counter (ticket 3.4): slots in use, and a number every claim, release and repair moves up. */
export interface SlotCount {
  /** Undefined when the counter (or its `running`) is missing or not a whole number: no claim passes then. */
  running: number | undefined;
  /** 0 when missing. */
  version: number;
  /** Try 2: consecutive refused repairs (`repairMisses`, written only by the launcher's check). */
  misses: number;
}

/** An item of the slots partition other than the counter: a holder (`buildId` set) or a malformed item (no `buildId`). */
export interface SlotItem {
  sk: string;
  buildId?: string;
}

/** What a claim did: the build is now `building` with a slot; it is no longer queued (a duplicate); or no slot is free. */
export type ClaimResult = "claimed" | "taken" | "no-slot";

/** One entry of the watch list. */
export interface LaunchEntry {
  buildId: string;
  /** ISO 8601: when the launcher claimed the build. */
  claimedAt: string;
  /** Set once the task started. */
  taskArn?: string;
}

export interface LaunchRecords {
  readBuild(buildId: string): Promise<LaunchBuild | undefined>;
  /** The participant's profile nickname, as stored. */
  readProfileNickname(participantId: string): Promise<string | undefined>;
  /** The participant's conversation: the build it started and the approved spec version. */
  readConversation(participantId: string): Promise<{ buildId?: string; approvedSpecVersion?: number }>;
  /** The spec version (text, and its "What changes" list when it has one), only when it exists and was approved. */
  readApprovedSpec(participantId: string, version: number): Promise<ApprovedSpec | undefined>;
  /**
   * Ticket 3.9: a Rebuild from my repository request (the participant's message at step building with REBUILD_REQUEST
   * and the `rebuild-from-repo` mark), whether it is still pending and whether a read is stored on it; undefined for any
   * other message (or none).
   */
  readRebuildRequest(participantId: string, messageId: string): Promise<RebuildRequestState | undefined>;
  /**
   * Ticket 3.9: stores what the read found on the request (`repositoryRead`, and `repositorySpec` for a found file), only
   * once (no read stored yet). False when refused.
   */
  storeRepositoryRead(participantId: string, messageId: string, read: RepositoryRead): Promise<boolean>;
  /**
   * Ticket 3.9 try 2: the text and repository name the launcher stored on a Rebuild from my repository request
   * (`repositorySpec`, `repositoryName`: attributes only the launcher writes), only for the route's marked request with a
   * `found` read; undefined otherwise.
   */
  readRebuildSpec(participantId: string, messageId: string): Promise<{ text: string; repository: string } | undefined>;
  /**
   * Ticket 3.7: stores a change build's input (`changeSpec`, `changeList`) on the build, only while it is `building`
   * under this launch without a task. False when refused.
   */
  setChangeInput(buildId: string, attemptId: string, input: ChangeInput, nowIso: string): Promise<boolean>;
  /**
   * The workshop settings (the `SETTINGS` item through settingsFromItem): builds at once (ticket 3.4; 15 when unset), the
   * global Stop and the last Resume's time (ticket 3.5).
   */
  readSettings(): Promise<WorkshopSettings>;
  /** Gives a queued build without a place its `queueKey`; false when it is no longer queued or already has one. */
  enqueue(buildId: string, queueKey: string): Promise<boolean>;
  /** Writes (or rewrites) the build's waiting entry, seen now. */
  touchQueueEntry(queueKey: string, buildId: string, nowIso: string): Promise<void>;
  /** The waiting entries before `queueKey` seen at or after `sinceIso` (the builds ahead). */
  countAhead(queueKey: string, sinceIso: string): Promise<number>;
  /** The slot counter (`running` undefined when it does not exist yet). */
  readSlots(): Promise<SlotCount>;
  /**
   * One transaction: the build from `queued` to `building` under a new launch (`attemptId`, which the task's runner
   * must name in every write; only while its nickname and participant are the ones read), its watch-list entry, and
   * (ticket 3.4) a slot: the counter goes up only while under `cap`, the build's holder is added and its waiting entry
   * (`queueKey`) removed. `taken` when the build is no longer `queued` (a duplicate message), `no-slot` when the cap was
   * reached, the counter is missing or negative, an item already sits at the build's holder key (or another claim or
   * release wrote the counter at the same moment).
   */
  claim(buildId: string, nickname: string, participantId: string, attemptId: string, nowIso: string, slot: { cap: number; queueKey: string }): Promise<ClaimResult>;
  /**
   * Every item of the slots partition but the counter: a well-formed holder (`type` build-slot, a valid `buildId`, at
   * `BUILD#<buildId>`) carries its `buildId`; any other item none.
   */
  listSlotHolders(): Promise<SlotItem[]>;
  /** Deletes a malformed item of the slots partition (never the counter). */
  removeSlotItem(sk: string): Promise<void>;
  /** Frees the build's slot (../build/slots.ts): false when it holds none or still runs. */
  releaseSlot(buildId: string): Promise<boolean>;
  /**
   * Sets the counter to `running` (and its refused repairs to 0), only while its version is still `seen`'s, or
   * unconditionally when `force` (creating it when missing).
   */
  repairSlots(seen: SlotCount, running: number, force: boolean): Promise<boolean>;
  /** Counts a refused repair (the counter's `repairMisses` up by one). */
  noteRepairRefused(): Promise<void>;
  /** Every waiting entry. */
  listQueueEntries(): Promise<{ queueKey: string; buildId: string }[]>;
  removeQueueEntry(queueKey: string): Promise<void>;
  /** Stores the started task on the watch-list entry and on the build. */
  recordTask(buildId: string, taskArn: string, nowIso: string): Promise<void>;
  /** Marks a claimed build that has no task failed (only while `building` without a task); removes its entry. */
  failUnstarted(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /**
   * Marks failed a build still `building` without a task under the launch that wrote this watch entry (`launchedAt`
   * equal to the entry's `claimedAt`): its launch recorded the task on the entry only, then stopped it.
   */
  failUnrecorded(buildId: string, claimedAt: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /** Marks failed a build still `building` with this task and no pushed commit. */
  failStopped(buildId: string, taskArn: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /**
   * Marks failed a build still `building` with this task and a pushed commit (handed over), whose deploy never started:
   * the task stopped and no deploy message moved it to `deploying` within HANDED_OVER_GRACE_MS.
   */
  failHandedOver(buildId: string, taskArn: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /**
   * Ticket 3.5 (global Stop): puts a build still `building` with this task and no pushed commit back to `queued` from the
   * beginning (place `queueKey`; its attempt, launch time, task and feed removed), then frees its slot (a failed release
   * is left to the check). False when the build was not in that state (nothing written).
   */
  requeueStopped(buildId: string, taskArn: string, queueKey: string, nowIso: string): Promise<boolean>;
  /** Marks failed a build still `queued`. */
  failQueued(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /** Marks failed a build of this app still waiting for the deploy of this pushed commit (`building` or `deploying`). */
  failDeploy(buildId: string, nickname: string, commit: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  listLaunches(): Promise<LaunchEntry[]>;
  /** Removes a watch-list entry, only while it still names this task (or none, for `undefined`). */
  removeLaunch(buildId: string, taskArn: string | undefined): Promise<void>;
}

/** Ticket 3.9: what the launcher reads of a Rebuild from my repository request. */
export interface RebuildRequestState {
  pending: boolean;
  /** A read is already stored on it. */
  read: boolean;
  /** Ticket 3.9 try 2: it is the conversation's message in flight (`pendingId`). */
  inFlight: boolean;
  /** Ticket 3.9 try 2: when it became pending (epoch seconds; the stale rule's input). */
  pendingSince?: number;
}

/** A task as the check sees it. */
export interface TaskState {
  stopped: boolean;
  /** When ECS created it. */
  createdAt?: Date;
  /** When ECS stopped it (unknown for a task ECS no longer knows, which stopped long ago). */
  stoppedAt?: Date;
}

/** What a task is started with: the container's overrides (decision "(2.9) Token hand-off"). */
export interface TaskStart {
  buildId: string;
  /** The build's one-repository token. */
  token: string;
  /**
   * The commit the runner builds from (or fails): what `prepareRepository` left on `main` for a first build, `main`'s
   * current commit for a change build (ticket 3.7).
   */
  baseCommit: string;
  /** The launch's attempt id, stored on the build by the claim. */
  attemptId: string;
}

export interface BuildTasks {
  /** Starts the builder for the build (`startedBy` the build id); the token goes in the container's override. */
  start(start: TaskStart, signal?: AbortSignal): Promise<{ taskArn: string } | { failure: string }>;
  /** The state of each task; a task ECS no longer knows counts as stopped. */
  describe(taskArns: readonly string[]): Promise<Map<string, TaskState>>;
  stop(taskArn: string): Promise<void>;
}

export interface DeadLetter {
  body: string | undefined;
  receiptHandle: string;
}

export interface DeadLetters {
  /** Up to 10 messages (no wait). */
  receive(): Promise<DeadLetter[]>;
  remove(receiptHandle: string): Promise<void>;
}

/**
 * AWS's own explanation of a refused ECS call (`ClientException`, `InvalidParameterException`, `AccessDeniedException`,
 * for example "ECS was unable to assume the role ..."), cut to 300 characters, so a refused RunTask can be diagnosed
 * from the logs (first live build after 2.9). ECS's messages name resources and settings, never override values, so the
 * build's token never reaches the log; other errors keep their name only.
 */
export function ecsRefusal(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { name, message, $metadata } = error as { name?: unknown; message?: unknown; $metadata?: unknown };
  if ($metadata === undefined || typeof message !== "string") return undefined;
  if (name !== "ClientException" && name !== "InvalidParameterException" && name !== "AccessDeniedException") return undefined;
  return message.slice(0, 300);
}

/** `paused` (ticket 3.5): the global Stop is on; the build waits, as `waiting`, without asking for a slot. */
export type LaunchOutcome = "started" | "invalid" | "duplicate" | "ignored" | "failed" | "waiting" | "paused";

/**
 * Ticket 3.9, a spec-read request: `read` (stored and handed back to the AI worker), `resent` (a read already stored:
 * only handed back again), `skipped` (not a pending rebuild request), `invalid` (not a spec-read body).
 */
export type SpecReadOutcome = "read" | "resent" | "skipped" | "invalid";

export interface LauncherLogEntry {
  event: "launcher" | "build-check" | "spec-read";
  outcome: LaunchOutcome | SpecReadOutcome | "checked" | "error";
  /** Spec read (ticket 3.9): what was found (`found`, `too-large`, ...), never the text. */
  read?: RepositoryRead["kind"];
  error?: string;
  /** Check: builds marked failed, tasks stopped, dead letters read. */
  failed?: number;
  stopped?: number;
  deadLetters?: number;
  /** Check (ticket 3.4): slots freed, malformed slot items removed, whether the counter was set (and forced), waiting entries removed. */
  freed?: number;
  strays?: number;
  repaired?: boolean;
  forced?: boolean;
  unqueued?: number;
  /** Check (ticket 3.5): running builds put back in the queue by the global Stop, and such builds launched again. */
  requeued?: number;
  relaunched?: number;
  durationMs: number;
}

export interface LauncherDeps {
  records: LaunchRecords;
  tasks: BuildTasks;
  /** Reads and parses the GitHub App's secret (only inside this process). */
  credentials: () => Promise<AppCredentials>;
  github: GitHubDeps;
  templateFiles: () => Promise<RepositoryFile[]>;
  now: () => Date;
  log: (entry: LauncherLogEntry) => void;
  /** A new attempt id for each claim (default a random UUID). */
  newAttemptId?: () => string;
  /** The launch's deadline (the handler aborts it LAUNCH_RESERVE_MS before the Lambda's timeout): RunTask gets it too. */
  signal?: AbortSignal;
}

export interface CheckDeps {
  records: LaunchRecords;
  tasks: BuildTasks;
  launchDeadLetters: DeadLetters;
  deployDeadLetters: DeadLetters;
  /**
   * Ticket 3.5: launches a build the global Stop put back in the queue (processLaunch of this body with the launcher's
   * deps), or answers undefined, launching nothing, when the check has too little time left for a launch.
   */
  relaunch: (body: string) => Promise<LaunchOutcome | undefined>;
  now: () => Date;
  log: (entry: LauncherLogEntry) => void;
}

/** Ticket 3.9: what reading a participant's SPEC.md needs (the launcher is the GitHub App key's only reader). */
export interface SpecReadDeps {
  records: Pick<LaunchRecords, "readRebuildRequest" | "storeRepositoryRead" | "readProfileNickname">;
  /** Reads and parses the GitHub App's secret (only inside this process). */
  credentials: () => Promise<AppCredentials>;
  github: GitHubDeps;
  /** The AI worker's queue: the job goes back there once the read is stored. */
  aiQueue: { send(job: AiJob): Promise<void> };
  now: () => Date;
  log: (entry: LauncherLogEntry) => void;
}

/**
 * Ticket 3.9, Rebuild from my repository: one spec-read message of the launch queue (body exactly
 * `{"readSpec": {"participantId", "messageId"}}`, sent only by the AI worker). Only for a pending rebuild request with no
 * read stored: reads the participant's own SPEC.md on `main` (their profile's nickname names the repository) with a
 * read-only one-repository token (readRepositorySpec: over 20 KB is never downloaded), stores what it found on the
 * request (a GitHub or key problem is stored as `github-error`, so the participant gets an answer), then hands the job
 * back to the AI worker. A request whose read is already stored is only handed back again (a lost send). A failed table
 * write or send is thrown (bare), so SQS delivers the message again; nothing is ever written to the repository.
 */
export async function processSpecRead(body: string | undefined, deps: SpecReadDeps): Promise<SpecReadOutcome> {
  const started = deps.now().getTime();
  const log = (outcome: SpecReadOutcome, extra: { read?: RepositoryRead["kind"]; error?: string } = {}): SpecReadOutcome => {
    deps.log({ event: "spec-read", outcome, ...extra, durationMs: Math.max(0, deps.now().getTime() - started) });
    return outcome;
  };
  const job = parseSpecReadJob(body);
  if (job === undefined) return log("invalid");
  const request = await deps.records.readRebuildRequest(job.participantId, job.messageId);
  // Only the conversation's own request in flight, not stale (the worker would skip it): nothing is asked of GitHub.
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  if (
    request === undefined ||
    !request.pending ||
    !request.inFlight ||
    request.pendingSince === undefined ||
    isStale({ status: "pending", pendingSince: request.pendingSince }, nowSeconds)
  ) {
    return log("skipped");
  }
  if (request.read) {
    await deps.aiQueue.send(job);
    return log("resent");
  }
  let read: RepositoryRead;
  let error: string | undefined;
  try {
    const nickname = await deps.records.readProfileNickname(job.participantId);
    if (nickname === undefined) throw Object.assign(new Error("no nickname"), { name: "NoNickname" });
    const found = await readRepositorySpec(await deps.credentials(), nickname, deps.github);
    // The name of the repository it was read from goes with the text: the worker checks it against the profile's.
    read = found.kind === "found" ? { ...found, repository: repositoryNameFor(nickname) } : found;
  } catch (problem) {
    read = { kind: "github-error" };
    error = errorName(problem);
  }
  if (await deps.records.storeRepositoryRead(job.participantId, job.messageId, read)) {
    await deps.aiQueue.send(job);
    return log("read", { read: read.kind, ...(error === undefined ? {} : { error }) });
  }
  return log("skipped", { read: read.kind });
}

export const SPEC_MISSING_REASON = "The approved spec could not be found, so the build did not start.";
/** Ticket 3.9 try 2: a version approved by Rebuild from my repository whose text is not what the launcher read. */
export const REBUILD_SPEC_UNCONFIRMED_REASON =
  "The spec could not be confirmed as the one read from your repository, so the build did not start. Press Rebuild from my repository again.";
export const START_FAILED_REASON = "The build could not be started: the build service had no room for it. Your facilitator can restart it.";
export const LAUNCH_SERVICE_REASON = "The build could not be started because of a problem on the workshop's side.";
export const STOPPED_REASON = "The build stopped before it was finished.";
export const UNSTARTED_REASON = "The build did not start in time.";
export const QUEUED_DEAD_REASON = "The build could not be started after several tries.";
/** Try 2: a build that waited in the line longer than QUEUE_WAIT_MAX_MS. */
export const QUEUE_TIMEOUT_REASON = "The build waited too long in the queue and did not start. Your facilitator can restart it.";
export const DEPLOY_DEAD_REASON = "The app could not be published because of a problem on the workshop's side.";

/** The build id of a launch message: exactly `{"buildId": "<id>"}`, else undefined. */
export function parseLaunchMessage(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const buildId = (value as { buildId?: unknown }).buildId;
  if (keys.length !== 1 || typeof buildId !== "string" || !BUILD_ID_PATTERN.test(buildId)) return undefined;
  return buildId;
}

/** A launch failure's reason for the build: GitHub's plain step messages, else a fixed text. */
function launchReason(error: unknown): string {
  if (error instanceof GitHubProblem) return storedReason(`GitHub: ${error.message}`);
  if (error instanceof LaunchFailure) return error.reason;
  return LAUNCH_SERVICE_REASON;
}

class LaunchFailure extends Error {
  constructor(readonly reason: string) {
    super("launch failed");
    this.name = "LaunchFailure";
  }
}

/**
 * Handles one launch message. Throws (a bare error, so SQS delivers it again) only before the claim, when a read
 * failed; after the claim every outcome is recorded on the build and the message is consumed.
 */
export async function processLaunch(body: string | undefined, deps: LauncherDeps): Promise<LaunchOutcome> {
  const started = deps.now().getTime();
  const log = (outcome: LaunchOutcome, error?: unknown): void => {
    const detail = ecsRefusal(error);
    deps.log({
      event: "launcher",
      outcome,
      ...(error === undefined ? {} : { error: errorName(error) }),
      ...(detail === undefined ? {} : { detail }),
      durationMs: Math.max(0, deps.now().getTime() - started),
    });
  };
  const buildId = parseLaunchMessage(body);
  if (buildId === undefined) {
    log("invalid");
    return "invalid";
  }

  let build: LaunchBuild | undefined;
  let attemptId: string;
  let checked: { ok: boolean; specVersion?: number };
  // Before and including the claim, a failed read or write is thrown: SQS delivers the message again, and the claim's
  // condition keeps a redelivery from acting twice.
  try {
    build = await deps.records.readBuild(buildId);
    if (build === undefined || build.status !== "queued") {
      log("duplicate");
      return "duplicate";
    }
    const [profileNickname, conversation] = await Promise.all([
      deps.records.readProfileNickname(build.participantId),
      deps.records.readConversation(build.participantId),
    ]);
    // Ticket 3.7: a change build builds the version stored on it, which must still be the conversation's approved one.
    const isChange = build.kind === "change";
    checked = {
      ok:
        profileNickname === build.nickname &&
        conversation.buildId === buildId &&
        (!isChange || (build.specVersion !== undefined && build.changeNumber !== undefined && build.specVersion === conversation.approvedSpecVersion)),
      ...(conversation.approvedSpecVersion === undefined ? {} : { specVersion: conversation.approvedSpecVersion }),
    };
    if (!checked.ok) {
      log("ignored");
      return "ignored";
    }
    // Ticket 3.4: the build's place in the waiting line, then a slot only when no earlier waiting build needs it.
    const settings = await deps.records.readSettings();
    const cap = settings.buildsAtOnce;
    let queueKey = build.queueKey;
    if (queueKey === undefined) {
      queueKey = newQueueKey(deps.now().toISOString(), buildId);
      // Refused: the build changed meanwhile; the next delivery reads it again.
      if (!(await deps.records.enqueue(buildId, queueKey))) {
        log("waiting");
        return "waiting";
      }
    }
    await deps.records.touchQueueEntry(queueKey, buildId, deps.now().toISOString());
    // Ticket 3.5: while the global Stop is on, the build keeps its place and waits; no slot, no task.
    if (settings.stopped) {
      log("paused");
      return "paused";
    }
    const since = new Date(deps.now().getTime() - QUEUE_SEEN_MS).toISOString();
    const [slots, ahead] = await Promise.all([deps.records.readSlots(), deps.records.countAhead(queueKey, since)]);
    // A missing or negative counter reads as full (the claim would refuse it too) until the check repairs it.
    if (slots.running === undefined || slots.running < 0 || slots.running + ahead >= cap) {
      log("waiting");
      return "waiting";
    }
    attemptId = (deps.newAttemptId ?? randomUUID)();
    const claimed = await deps.records.claim(buildId, build.nickname, build.participantId, attemptId, deps.now().toISOString(), { cap, queueKey });
    if (claimed !== "claimed") {
      const outcome = claimed === "taken" ? "duplicate" : "waiting";
      log(outcome);
      return outcome;
    }
  } catch (error) {
    log("failed", error);
    // No cause: only the error's name is ever printed.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("launch failed");
  }
  const { nickname, participantId } = build;

  let taskArn: string | undefined;
  try {
    const version = checked.specVersion;
    const spec = version === undefined ? undefined : await deps.records.readApprovedSpec(participantId, version);
    if (spec === undefined) throw new LaunchFailure(SPEC_MISSING_REASON);
    if (spec.rebuildRequestId !== undefined) {
      // Ticket 3.9 try 2: approved by Rebuild from my repository (the AI worker's rebuildApprovedAt), so built only as
      // the exact text the launcher itself read from this participant's own repository for that request.
      const read = await deps.records.readRebuildSpec(participantId, spec.rebuildRequestId);
      if (read === undefined || read.text !== spec.text || read.repository !== repositoryNameFor(nickname)) {
        throw new LaunchFailure(REBUILD_SPEC_UNCONFIRMED_REASON);
      }
    }
    const credentials = await deps.credentials();
    let baseCommit: string;
    if (build.kind === "change") {
      // Ticket 3.7: a change build edits the app as it is on `main` (never the template). The runner gets the version's
      // text and "What changes" list from the build, copied here from the stored version, and starts only from this commit.
      const whatChanges = spec.whatChanges ?? [];
      if (whatChanges.length === 0) throw new LaunchFailure(SPEC_MISSING_REASON);
      baseCommit = await readRepositoryMain(credentials, nickname, deps.github);
      if (!GIT_ID_PATTERN.test(baseCommit)) throw new LaunchFailure(LAUNCH_SERVICE_REASON);
      // Access review of 3.7: the input stored on the build (which the task beside the AI agent reads) holds no email
      // address, neither in the spec's text nor in the list (each line made one plain line first).
      const input = { spec: removeEmailAddresses(spec.text), whatChanges: whatChanges.map(plainLineWithoutEmails) };
      if (!(await deps.records.setChangeInput(buildId, attemptId, input, deps.now().toISOString()))) {
        throw new LaunchFailure(LAUNCH_SERVICE_REASON);
      }
    } else {
      baseCommit = (await prepareRepository({ credentials, nickname, spec: spec.text, templateFiles: await deps.templateFiles() }, deps.github)).commit;
    }
    const { token } = await builderToken(credentials, nickname, deps.github);
    // The base commit pins what the runner builds from (a push to main after this point fails the build), and the
    // deadline's signal keeps RunTask from outlasting the reserve the failure write needs.
    const result = await deps.tasks.start({ buildId, token, baseCommit, attemptId }, deps.signal);
    if ("failure" in result) throw new LaunchFailure(START_FAILED_REASON);
    taskArn = result.taskArn;
    await deps.records.recordTask(buildId, taskArn, deps.now().toISOString());
    log("started");
    return "started";
  } catch (error) {
    // A task already started but not recorded would run unwatched: stop it, then fail the build.
    if (taskArn !== undefined) await deps.tasks.stop(taskArn).catch(() => undefined);
    try {
      await deps.records.failUnstarted(buildId, [launchReason(error)], deps.now().toISOString());
    } catch (markError) {
      // The check fails it after LAUNCH_UNSTARTED_MS (its entry has no task).
      log("failed", markError);
      return "failed";
    }
    log("failed", error);
    return "failed";
  }
}

/** Reads a dead-letter queue until it is empty (at most `rounds` batches), handing each message to `handle`. */
async function drain(queue: DeadLetters, handle: (body: string | undefined) => Promise<void>, rounds = 5): Promise<number> {
  let count = 0;
  for (let round = 0; round < rounds; round += 1) {
    const messages = await queue.receive();
    if (messages.length === 0) break;
    for (const message of messages) {
      await handle(message.body);
      await queue.remove(message.receiptHandle);
      count += 1;
    }
  }
  return count;
}

/**
 * A task of the builds cluster in the workshop's own region and account (long ARN form, 32 hexadecimal digits). The watch
 * list is in the shared table, so the check asks ECS only about such ARNs: one malformed or forged entry (another cluster,
 * region or account) would otherwise make DescribeTasks fail for every build.
 */
const BUILD_TASK_ARN = new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task/${BUILDS_CLUSTER_NAME}/[0-9a-f]{32}$`);

/** The stuck-build check. Every write is conditional, so two checks at once (or a check racing a launch) are harmless. */
export async function runCheck(deps: CheckDeps): Promise<void> {
  const started = deps.now().getTime();
  const nowIso = (): string => deps.now().toISOString();
  let failed = 0;
  let stopped = 0;
  let deadLetters = 0;
  let freed = 0;
  let strays = 0;
  let repaired = false;
  let forced = false;
  let unqueued = 0;
  let requeued = 0;
  let relaunched = 0;
  try {
    const settings = await deps.records.readSettings();
    /**
     * Ticket 3.5: builds the global Stop put back in the queue (watch entry kept, build `queued`). Each keeps its place in
     * the waiting line seen (so builds queued after it wait for it), and is launched at the end of the check once Stop is
     * off.
     */
    const toRelaunch: { buildId: string; taskArn: string; queueKey: string }[] = [];
    const keepQueued = async (entry: LaunchEntry, taskArn: string, build: LaunchBuild): Promise<void> => {
      if (build.queueKey === undefined) {
        // Not placed by the Stop's write (no other writer leaves a `queued` build with a watch entry): just unwatch it.
        await deps.records.removeLaunch(entry.buildId, taskArn);
        return;
      }
      await deps.records.touchQueueEntry(build.queueKey, entry.buildId, nowIso());
      toRelaunch.push({ buildId: entry.buildId, taskArn, queueKey: build.queueKey });
    };
    const launches: LaunchEntry[] = [];
    for (const entry of await deps.records.listLaunches()) {
      if (entry.taskArn === undefined || BUILD_TASK_ARN.test(entry.taskArn)) launches.push(entry);
      else await deps.records.removeLaunch(entry.buildId, entry.taskArn);
    }
    const withTask = launches.filter((entry): entry is LaunchEntry & { taskArn: string } => entry.taskArn !== undefined);
    const states = withTask.length === 0 ? new Map<string, TaskState>() : await deps.tasks.describe(withTask.map((entry) => entry.taskArn));
    for (const entry of launches) {
      if (entry.taskArn === undefined) {
        // A claim whose task is not recorded yet: while Stop is on, the next check (once it has its task) stops it.
        if (started - Date.parse(entry.claimedAt) < LAUNCH_UNSTARTED_MS) continue;
        if (await deps.records.failUnstarted(entry.buildId, [UNSTARTED_REASON], nowIso())) failed += 1;
        else await deps.records.removeLaunch(entry.buildId, undefined);
        continue;
      }
      const state = states.get(entry.taskArn) ?? { stopped: true };
      if (state.stopped) {
        if (await deps.records.failStopped(entry.buildId, entry.taskArn, [STOPPED_REASON], nowIso())) {
          failed += 1;
          await deps.records.removeLaunch(entry.buildId, entry.taskArn);
          continue;
        }
        // Handed over (a pushed commit) and still `building`: the deploy message may not have started the deployer yet.
        // Watched until HANDED_OVER_GRACE_MS after the task stopped (longer than the deploy queue's deliveries), then
        // failed: no deploy will come, and `retry` recovers it. A task ECS forgot (no stop time) stopped long ago.
        // A launch that recorded its task on the entry but neither on the build nor as failed (two writes lost): the
        // launcher stopped that task, so the build fails (only while `building` without a task, under this launch: a
        // retry's new launch has another `launchedAt`).
        if (await deps.records.failUnrecorded(entry.buildId, entry.claimedAt, [LAUNCH_SERVICE_REASON], nowIso())) {
          failed += 1;
          await deps.records.removeLaunch(entry.buildId, entry.taskArn);
          continue;
        }
        const build = await deps.records.readBuild(entry.buildId);
        if (build?.status === "building") {
          const stoppedAt = state.stoppedAt?.getTime();
          if (stoppedAt !== undefined && started - stoppedAt < HANDED_OVER_GRACE_MS) continue;
          if (await deps.records.failHandedOver(entry.buildId, entry.taskArn, [DEPLOY_DEAD_REASON], nowIso())) failed += 1;
        }
        // Ticket 3.5: put back in the queue by the global Stop; launched by the check after Resume.
        if (build?.status === "queued") {
          await keepQueued(entry, entry.taskArn, build);
          continue;
        }
        await deps.records.removeLaunch(entry.buildId, entry.taskArn);
      } else if (settings.stopped) {
        // Ticket 3.5: the global Stop. Back to `queued` first (the task's own writes are refused from then on), then the
        // task is stopped; the check launches the build again after Resume. A build that handed its commit over finishes.
        const moved = await deps.records.requeueStopped(entry.buildId, entry.taskArn, newQueueKey(entry.claimedAt, entry.buildId), nowIso());
        const build = await deps.records.readBuild(entry.buildId);
        if (build?.status !== "queued") continue;
        await deps.tasks.stop(entry.taskArn);
        stopped += 1;
        await keepQueued(entry, entry.taskArn, build);
        if (moved) requeued += 1;
      } else if (state.createdAt !== undefined && started - state.createdAt.getTime() > BUILD_TASK_MAX_MS) {
        // Marked failed by the next check, once ECS reports it stopped.
        await deps.tasks.stop(entry.taskArn);
        stopped += 1;
      }
    }
    deadLetters += await drain(deps.launchDeadLetters, async (body) => {
      const buildId = parseLaunchMessage(body);
      if (buildId !== undefined && (await deps.records.failQueued(buildId, [QUEUED_DEAD_REASON], nowIso()))) failed += 1;
    });
    deadLetters += await drain(deps.deployDeadLetters, async (body) => {
      const job = parseDeployJob(body);
      if (job !== undefined && (await deps.records.failDeploy(job.buildId, job.nickname, job.commit, [DEPLOY_DEAD_REASON], nowIso()))) failed += 1;
    });
    // Ticket 3.4: slots. Delete malformed items (one at a build's holder key would block its claim forever), free the
    // slots of builds no longer running (failed by the builder, their writer's release failed, gone, or queued again),
    // then set the counter to the number of holders left: the builds `building` or `deploying`.
    for (const item of await deps.records.listSlotHolders()) {
      if (item.buildId === undefined) {
        await deps.records.removeSlotItem(item.sk);
        strays += 1;
        continue;
      }
      const build = await deps.records.readBuild(item.buildId);
      if (build?.status === "building" || build?.status === "deploying") continue;
      if (await deps.records.releaseSlot(item.buildId)) freed += 1;
    }
    // The repair is conditional on the counter's version, so a claim or release between the two reads makes it wait for
    // the next minute. It is forced (unconditional) when no race can explain the value (the counter is missing or
    // negative: no claim can pass then) or after SLOT_REPAIR_FORCE_AFTER refused repairs in a row: a writer that keeps
    // moving the version cannot keep a wrong counter. A forced write can miss a claim or release made in the same
    // instant; the next minute's repair corrects that.
    const seen = await deps.records.readSlots();
    const holders = (await deps.records.listSlotHolders()).filter((item) => item.buildId !== undefined).length;
    if (seen.running !== holders || seen.misses > 0) {
      forced = seen.running === undefined || seen.running < 0 || seen.misses >= SLOT_REPAIR_FORCE_AFTER;
      repaired = await deps.records.repairSlots(seen, holders, forced);
      if (!repaired) await deps.records.noteRepairRefused();
    }
    // The waiting line keeps only builds still waiting at that place (a retry gives a build a new place); a build waiting
    // there longer than QUEUE_WAIT_MAX_MS (its place's time) is failed, so a launch that keeps failing before its claim
    // ends in hours, not after the launch queue's 1,000 deliveries. Ticket 3.5: not while the global Stop is on, and the
    // wait counts from the last Resume when that is later than the place.
    const resumedAt = settings.resumedAt === undefined ? Number.NaN : Date.parse(settings.resumedAt);
    for (const entry of await deps.records.listQueueEntries()) {
      const build = await deps.records.readBuild(entry.buildId);
      if (build?.status === "queued" && build.queueKey === entry.queueKey) {
        if (settings.stopped) continue;
        const placedAt = Date.parse(entry.queueKey.slice(0, entry.queueKey.indexOf("#")));
        const waitingSince = Number.isFinite(resumedAt) && resumedAt > placedAt ? resumedAt : placedAt;
        if (!(started - waitingSince > QUEUE_WAIT_MAX_MS)) continue;
        if (await deps.records.failQueued(entry.buildId, [QUEUE_TIMEOUT_REASON], nowIso())) failed += 1;
      }
      await deps.records.removeQueueEntry(entry.queueKey);
      unqueued += 1;
    }
    // Ticket 3.5: after Resume, the builds the Stop put back in the queue start again, oldest place first, after the slots
    // above were freed. A launch that must wait (no slot, or Stop pressed again) leaves the later ones for the next minute,
    // as does too little time left; any other outcome means the build left `queued`, so its old watch entry goes (a new
    // claim's entry has no task yet and is kept by the condition).
    if (!settings.stopped) {
      for (const item of toRelaunch.sort((a, b) => (a.queueKey < b.queueKey ? -1 : a.queueKey > b.queueKey ? 1 : 0))) {
        const outcome = await deps.relaunch(JSON.stringify({ buildId: item.buildId }));
        if (outcome === undefined || outcome === "waiting" || outcome === "paused") break;
        if (outcome === "started") relaunched += 1;
        await deps.records.removeLaunch(item.buildId, item.taskArn);
      }
    }
  } catch (error) {
    deps.log({
      event: "build-check",
      outcome: "error",
      error: errorName(error),
      failed,
      stopped,
      deadLetters,
      freed,
      strays,
      repaired,
      forced,
      unqueued,
      requeued,
      relaunched,
      durationMs: Math.max(0, deps.now().getTime() - started),
    });
    // eslint-disable-next-line preserve-caught-error -- no cause, as above
    throw new Error("check failed");
  }
  deps.log({ event: "build-check", outcome: "checked", failed, stopped, deadLetters, freed, strays, repaired, forced, unqueued, requeued, relaunched, durationMs: Math.max(0, deps.now().getTime() - started) });
}
