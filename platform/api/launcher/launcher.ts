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
 * 3. Reads the approved spec, prepares the repository (ticket 2.6, the template bundled with the function), mints the
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
 * it is under the cap (two launchers can never pass it), adds the build's slot holder and removes its waiting entry.
 * Every write that ends a build frees its slot (../build/slots.ts).
 *
 * Check (every minute, EventBridge Scheduler through the queue `ssd-workshop-builds-check`): a watched build whose task
 * has stopped (or is gone) while the build is still `building` without a pushed commit is marked failed; one still
 * `building` with a pushed commit (handed over, but no deploy started) is marked failed HANDED_OVER_GRACE_MS after its
 * task stopped; a claim that
 * never got a task within LAUNCH_UNSTARTED_MS is marked failed; a task running past BUILD_TASK_MAX_MS is stopped; the
 * launch queue's dead-letter messages fail their `queued` builds, and the deploy queue's fail their builds still
 * waiting for that deploy (decision "(2.5) Deploy message", "(2.7) For 2.9"). Ticket 3.4: it then frees the slots of
 * builds that ended (a writer's release that failed), sets the slot counter to the number of holders left (only if no
 * claim or release moved it meanwhile), and removes waiting entries of builds no longer waiting there.
 *
 * Logs: one JSON line per launch or check, with an outcome, counts and an error name; never a token, nickname, build id,
 * repository name or error message.
 */
import { randomUUID } from "node:crypto";
import { GitHubProblem, type AppCredentials, type GitHubDeps } from "../github/app.js";
import { builderToken, prepareRepository, type RepositoryFile } from "../github/repository.js";
import { parseDeployJob, storedReason } from "../deploy/deploy.js";
import { BUILD_ID_PATTERN, newQueueKey } from "../keys.js";
import { ACCOUNT, BUILD_TASK_MAX_MS, BUILDS_CLUSTER_NAME, HANDED_OVER_GRACE_MS, LAUNCH_UNSTARTED_MS, QUEUE_SEEN_MS, REGION } from "../settings.js";
import { errorName } from "../sign-in/code-request.js";
import type { BuildStatus } from "../types.js";

/** What the launcher reads of a build. */
export interface LaunchBuild {
  nickname: string;
  participantId: string;
  status: BuildStatus;
  /** Ticket 3.4: its place in the waiting line, once the launcher saw it queued. */
  queueKey?: string;
}

/** The slot counter (ticket 3.4): slots in use, and a number every claim, release and repair moves up. */
export interface SlotCount {
  running: number;
  version: number;
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
  /** The text of the spec version, only when that version exists and was approved. */
  readApprovedSpec(participantId: string, version: number): Promise<string | undefined>;
  /** Ticket 3.4: builds at once (the `SETTINGS` item through settingsFromItem: 15 when unset). */
  readBuildsAtOnce(): Promise<number>;
  /** Gives a queued build without a place its `queueKey`; false when it is no longer queued or already has one. */
  enqueue(buildId: string, queueKey: string): Promise<boolean>;
  /** Writes (or rewrites) the build's waiting entry, seen now. */
  touchQueueEntry(queueKey: string, buildId: string, nowIso: string): Promise<void>;
  /** The waiting entries before `queueKey` seen at or after `sinceIso` (the builds ahead). */
  countAhead(queueKey: string, sinceIso: string): Promise<number>;
  /** The slot counter (0 and 0 when it does not exist yet). */
  readSlots(): Promise<SlotCount>;
  /**
   * One transaction: the build from `queued` to `building` under a new launch (`attemptId`, which the task's runner
   * must name in every write; only while its nickname and participant are the ones read), its watch-list entry, and
   * (ticket 3.4) a slot: the counter goes up only while under `cap`, the build's holder is added and its waiting entry
   * (`queueKey`) removed. `taken` when the build is no longer `queued` (a duplicate message), `no-slot` when the cap was
   * reached (or another claim or release wrote the counter at the same moment).
   */
  claim(buildId: string, nickname: string, participantId: string, attemptId: string, nowIso: string, slot: { cap: number; queueKey: string }): Promise<ClaimResult>;
  /** The builds holding a slot. */
  listSlotHolders(): Promise<string[]>;
  /** Frees the build's slot (../build/slots.ts): false when it holds none or still runs. */
  releaseSlot(buildId: string): Promise<boolean>;
  /** Sets the counter to `running`, only while its version is still `seen`'s. */
  repairSlots(seen: SlotCount, running: number): Promise<boolean>;
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
  /** Marks failed a build still `queued`. */
  failQueued(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /** Marks failed a build of this app still waiting for the deploy of this pushed commit (`building` or `deploying`). */
  failDeploy(buildId: string, nickname: string, commit: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  listLaunches(): Promise<LaunchEntry[]>;
  /** Removes a watch-list entry, only while it still names this task (or none, for `undefined`). */
  removeLaunch(buildId: string, taskArn: string | undefined): Promise<void>;
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
  /** The commit `prepareRepository` left on `main`: the runner builds from it or fails. */
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

export type LaunchOutcome = "started" | "invalid" | "duplicate" | "ignored" | "failed" | "waiting";

export interface LauncherLogEntry {
  event: "launcher" | "build-check";
  outcome: LaunchOutcome | "checked" | "error";
  error?: string;
  /** Check: builds marked failed, tasks stopped, dead letters read. */
  failed?: number;
  stopped?: number;
  deadLetters?: number;
  /** Check (ticket 3.4): slots freed, whether the counter was set, waiting entries removed. */
  freed?: number;
  repaired?: boolean;
  unqueued?: number;
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
  now: () => Date;
  log: (entry: LauncherLogEntry) => void;
}

export const SPEC_MISSING_REASON = "The approved spec could not be found, so the build did not start.";
export const START_FAILED_REASON = "The build could not be started: the build service had no room for it. Your facilitator can restart it.";
export const LAUNCH_SERVICE_REASON = "The build could not be started because of a problem on the workshop's side.";
export const STOPPED_REASON = "The build stopped before it was finished.";
export const UNSTARTED_REASON = "The build did not start in time.";
export const QUEUED_DEAD_REASON = "The build could not be started after several tries.";
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
    checked = {
      ok: profileNickname === build.nickname && conversation.buildId === buildId,
      ...(conversation.approvedSpecVersion === undefined ? {} : { specVersion: conversation.approvedSpecVersion }),
    };
    if (!checked.ok) {
      log("ignored");
      return "ignored";
    }
    // Ticket 3.4: the build's place in the waiting line, then a slot only when no earlier waiting build needs it.
    const cap = await deps.records.readBuildsAtOnce();
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
    const since = new Date(deps.now().getTime() - QUEUE_SEEN_MS).toISOString();
    const [slots, ahead] = await Promise.all([deps.records.readSlots(), deps.records.countAhead(queueKey, since)]);
    if (Math.max(0, slots.running) + ahead >= cap) {
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
    const credentials = await deps.credentials();
    const prepared = await prepareRepository({ credentials, nickname, spec, templateFiles: await deps.templateFiles() }, deps.github);
    const { token } = await builderToken(credentials, nickname, deps.github);
    // The prepared commit pins what the runner builds from (a push to main after this point fails the build), and the
    // deadline's signal keeps RunTask from outlasting the reserve the failure write needs.
    const result = await deps.tasks.start({ buildId, token, baseCommit: prepared.commit, attemptId }, deps.signal);
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
  let repaired = false;
  let unqueued = 0;
  try {
    const launches: LaunchEntry[] = [];
    for (const entry of await deps.records.listLaunches()) {
      if (entry.taskArn === undefined || BUILD_TASK_ARN.test(entry.taskArn)) launches.push(entry);
      else await deps.records.removeLaunch(entry.buildId, entry.taskArn);
    }
    const withTask = launches.filter((entry): entry is LaunchEntry & { taskArn: string } => entry.taskArn !== undefined);
    const states = withTask.length === 0 ? new Map<string, TaskState>() : await deps.tasks.describe(withTask.map((entry) => entry.taskArn));
    for (const entry of launches) {
      if (entry.taskArn === undefined) {
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
        await deps.records.removeLaunch(entry.buildId, entry.taskArn);
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
    // Ticket 3.4: slots. Free the slots of builds that ended (their writer's release failed, or the build is gone), then
    // set the counter to the number of holders left: the builds `building` or `deploying`. The repair is conditional on
    // the counter's version, so a claim or release between the two reads makes it wait for the next minute.
    for (const buildId of await deps.records.listSlotHolders()) {
      const build = await deps.records.readBuild(buildId);
      if (build?.status === "building" || build?.status === "deploying") continue;
      if (await deps.records.releaseSlot(buildId)) freed += 1;
    }
    const seen = await deps.records.readSlots();
    const holders = (await deps.records.listSlotHolders()).length;
    if (seen.running !== holders) repaired = await deps.records.repairSlots(seen, holders);
    // The waiting line keeps only builds still waiting at that place (a retry gives a build a new place).
    for (const entry of await deps.records.listQueueEntries()) {
      const build = await deps.records.readBuild(entry.buildId);
      if (build?.status === "queued" && build.queueKey === entry.queueKey) continue;
      await deps.records.removeQueueEntry(entry.queueKey);
      unqueued += 1;
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
      repaired,
      unqueued,
      durationMs: Math.max(0, deps.now().getTime() - started),
    });
    // eslint-disable-next-line preserve-caught-error -- no cause, as above
    throw new Error("check failed");
  }
  deps.log({ event: "build-check", outcome: "checked", failed, stopped, deadLetters, freed, repaired, unqueued, durationMs: Math.max(0, deps.now().getTime() - started) });
}
