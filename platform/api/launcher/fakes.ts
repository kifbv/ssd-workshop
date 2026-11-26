// In-memory stand-ins for the launcher's outside world (ticket 2.9), for its tests and `npm run builds`' tests (not
// bundled): one table holding builds, profiles, conversations, specs, nickname claims and the watch list, following
// DynamoLaunchRecords' and DynamoBuildsStore's conditions; the builder's tasks; a dead-letter queue. Ticket 3.4: the
// build slots (counter and holders) and the waiting line, with the same conditions as the real transactions.
import { BUILDS_SUBNET_IDS } from "../settings.js";
import type { BuildStatus } from "../types.js";
import type { WorkshopSettings } from "../workshop/settings.js";
import type { RepositoryRead } from "../conversation/state.js";
import type {
  ApprovedSpec,
  BuildTasks,
  ChangeInput,
  ClusterTaskList,
  ClaimResult,
  DeadLetter,
  DeadLetters,
  LaunchBuild,
  LaunchEntry,
  LaunchRecords,
  RebuildRequestState,
  RebuildSpecRead,
  RetryBuildState,
  RetryRequest,
  SlotCount,
  SlotItem,
  TaskStart,
  TaskState,
} from "./launcher.js";

export interface FakeBuild {
  nickname: string;
  participantId: string;
  status: BuildStatus;
  createdAt?: string;
  updatedAt?: string;
  launchedAt?: string;
  attemptId?: string;
  taskArn?: string;
  pushedCommit?: string;
  deployedCommit?: string;
  failureReasons?: string[];
  finishedAt?: string;
  feed?: unknown[];
  queueKey?: string;
  /** Ticket 3.6/3.7: a change build, its number and version, and the input the launcher copied for its runner. */
  kind?: "first" | "change";
  changeNumber?: number;
  specVersion?: number;
  changeSpec?: string;
  changeList?: string[];
}

export class FakeBuildTable implements LaunchRecords {
  readonly builds = new Map<string, FakeBuild>();
  /** Profile nickname by participant id. */
  readonly profiles = new Map<string, string>();
  readonly conversations = new Map<string, { buildId?: string; approvedSpecVersion?: number }>();
  /** `<participant id>#<version>` -> spec. */
  /** `rebuildRequestId` (ticket 3.9 try 2): approved only by Rebuild from my repository, for that request. */
  readonly specs = new Map<string, { text: string; approved: boolean; whatChanges?: string[]; rebuildRequestId?: string }>();
  /** Lower-cased nickname -> participant id (the `NICK#` claims). */
  readonly nicknames = new Map<string, string>();
  readonly launches = new Map<string, LaunchEntry>();
  /** Calls that throw once, by method name (a passing table error). */
  readonly failOnce = new Set<string>();
  /** Ticket 3.4: `buildsAtOnce` as the SETTINGS item gives it. */
  buildsAtOnce = 15;
  /** Ticket 3.5: the global Stop, and the last Resume's time, as the SETTINGS item gives them. */
  stopped = false;
  resumedAt: string | undefined;
  /**
   * The slot counter (`COUNT`; `running` undefined: missing, as before the first check) and the holders (build ids).
   * Starts as the first check leaves it (0 running).
   */
  readonly slots: SlotCount = { running: 0, version: 1, misses: 0 };
  readonly holders = new Map<string, string>();
  /** Malformed items of the slots partition, by sort key (`BUILD#<id>` blocks that build's claim). */
  readonly strays = new Set<string>();
  /** Try 2: when set, every conditional repair is refused, as when another writer keeps moving the version. */
  versionKeepsMoving = false;
  /** The waiting line: queueKey -> entry. */
  readonly queue = new Map<string, { buildId: string; lastSeenAt: string }>();

  private maybeFail(method: string): void {
    if (this.failOnce.delete(method)) throw Object.assign(new Error("table is down"), { name: "InternalServerError" });
  }

  /** A participant with a queued build of their approved spec, as ticket 2.7 leaves it. */
  addQueuedBuild(input: { buildId: string; participantId: string; nickname: string; spec?: string }): void {
    this.profiles.set(input.participantId, input.nickname);
    this.nicknames.set(input.nickname.toLowerCase(), input.participantId);
    this.conversations.set(input.participantId, { buildId: input.buildId, approvedSpecVersion: 2 });
    this.specs.set(`${input.participantId}#2`, { text: input.spec ?? "# Run log\n\nA small app.", approved: true });
    this.builds.set(input.buildId, { nickname: input.nickname, participantId: input.participantId, status: "queued", createdAt: "2026-11-24T09:00:00.000Z" });
  }

  /**
   * Ticket 3.7: a participant whose app is live (`liveBuildId`, deployed from the repository's main) with a queued change
   * build of their approved version 3 (as 3.6's ready transaction leaves it).
   */
  addQueuedChangeBuild(input: { buildId: string; participantId: string; nickname: string; spec?: string; whatChanges?: string[]; changeNumber?: number }): void {
    this.profiles.set(input.participantId, input.nickname);
    this.nicknames.set(input.nickname.toLowerCase(), input.participantId);
    this.conversations.set(input.participantId, { buildId: input.buildId, approvedSpecVersion: 3 });
    this.specs.set(`${input.participantId}#3`, {
      text: input.spec ?? "# Run log\n\nA small app with a weekly chart.",
      approved: true,
      ...(input.whatChanges === undefined ? { whatChanges: ["Adds a weekly chart to the home screen"] } : { whatChanges: input.whatChanges }),
    });
    this.builds.set(input.buildId, {
      nickname: input.nickname,
      participantId: input.participantId,
      status: "queued",
      createdAt: "2026-11-24T11:00:00.000Z",
      kind: "change",
      changeNumber: input.changeNumber ?? 1,
      specVersion: 3,
    });
  }

  async readBuild(buildId: string): Promise<LaunchBuild | undefined> {
    this.maybeFail("readBuild");
    const build = this.builds.get(buildId);
    return (
      build && {
        nickname: build.nickname,
        participantId: build.participantId,
        status: build.status,
        ...(build.queueKey === undefined ? {} : { queueKey: build.queueKey }),
        ...(build.kind === "change" ? { kind: "change" as const } : {}),
        ...(build.changeNumber === undefined ? {} : { changeNumber: build.changeNumber }),
        ...(build.specVersion === undefined ? {} : { specVersion: build.specVersion }),
      }
    );
  }

  async readSettings(): Promise<WorkshopSettings> {
    this.maybeFail("readSettings");
    return {
      aiBudgetUsd: 5,
      changeRequestsPerPerson: 5,
      buildsAtOnce: this.buildsAtOnce,
      stopped: this.stopped,
      ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }),
    };
  }

  async enqueue(buildId: string, queueKey: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "queued" || build.queueKey !== undefined) return false;
    build.queueKey = queueKey;
    return true;
  }

  async touchQueueEntry(queueKey: string, buildId: string, nowIso: string): Promise<void> {
    this.queue.set(queueKey, { buildId, lastSeenAt: nowIso });
  }

  async countAhead(queueKey: string, sinceIso: string): Promise<number> {
    return [...this.queue].filter(([key, entry]) => key < queueKey && entry.lastSeenAt >= sinceIso).length;
  }

  async readSlots(): Promise<SlotCount> {
    return { ...this.slots };
  }

  async listSlotHolders(): Promise<SlotItem[]> {
    return [...[...this.holders.keys()].map((buildId) => ({ sk: `BUILD#${buildId}`, buildId })), ...[...this.strays].map((sk) => ({ sk }))];
  }

  async removeSlotItem(sk: string): Promise<void> {
    this.strays.delete(sk);
  }

  /** As releaseSlotItems: only for a build that ended (or is gone) and holds a slot. */
  async releaseSlot(buildId: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if ((build !== undefined && (build.status === "building" || build.status === "deploying")) || !this.holders.has(buildId)) return false;
    this.holders.delete(buildId);
    this.countDown();
    return true;
  }

  /** A release's ADD on the counter (it creates a missing one at -1). */
  private countDown(): void {
    this.slots.running = (this.slots.running ?? 0) - 1;
    this.slots.version += 1;
  }

  async repairSlots(seen: SlotCount, running: number, force: boolean): Promise<boolean> {
    if (!force && (this.versionKeepsMoving || this.slots.version !== seen.version)) return false;
    this.slots.running = running;
    this.slots.misses = 0;
    this.slots.version += 1;
    return true;
  }

  async noteRepairRefused(): Promise<void> {
    this.slots.misses += 1;
  }

  async listQueueEntries(): Promise<{ queueKey: string; buildId: string }[]> {
    return [...this.queue].map(([queueKey, entry]) => ({ queueKey, buildId: entry.buildId }));
  }

  async removeQueueEntry(queueKey: string): Promise<void> {
    this.queue.delete(queueKey);
  }

  /** What the deployer does at the end (its terminal write, then the slot release). */
  async endBuild(buildId: string, status: "live" | "failed", nowIso: string): Promise<void> {
    const build = this.builds.get(buildId);
    if (!build) return;
    build.status = status;
    build.finishedAt = nowIso;
    await this.releaseSlot(buildId);
  }

  async readProfileNickname(participantId: string): Promise<string | undefined> {
    return this.profiles.get(participantId);
  }

  /**
   * Ticket 3.9: Rebuild from my repository requests, `<participant id>#<message id>` -> pending, the stored read, and
   * (try 2) whether it is the conversation's message in flight (default yes) and since when it is pending.
   */
  /** Ticket 3.15: Rebuild with my edits requests' `editedSpec`, by `<participant id>#<message id>`. */
  readonly editRequests = new Map<string, string>();
  readonly rebuildRequests = new Map<string, { pending: boolean; read?: RepositoryRead; inFlight?: boolean; pendingSince?: number }>();

  async readRebuildRequest(participantId: string, messageId: string): Promise<RebuildRequestState | undefined> {
    this.maybeFail("readRebuildRequest");
    const request = this.rebuildRequests.get(`${participantId}#${messageId}`);
    return (
      request && {
        pending: request.pending,
        read: request.read !== undefined,
        inFlight: request.inFlight ?? true,
        ...(request.pendingSince === undefined ? {} : { pendingSince: request.pendingSince }),
      }
    );
  }

  async readRebuildSpec(participantId: string, messageId: string): Promise<RebuildSpecRead | undefined> {
    // Ticket 3.15: an edit request holds the edited text itself.
    const edited = this.editRequests.get(`${participantId}#${messageId}`);
    if (edited !== undefined) return { source: "page", text: edited };
    const read = this.rebuildRequests.get(`${participantId}#${messageId}`)?.read;
    return read?.kind === "found" ? { source: "repository", text: read.text, repository: read.repository } : undefined;
  }

  async storeRepositoryRead(participantId: string, messageId: string, read: RepositoryRead): Promise<boolean> {
    this.maybeFail("storeRepositoryRead");
    const request = this.rebuildRequests.get(`${participantId}#${messageId}`);
    if (request === undefined || request.read !== undefined) return false;
    request.read = read;
    return true;
  }

  async readConversation(participantId: string): Promise<{ buildId?: string; approvedSpecVersion?: number }> {
    return { ...this.conversations.get(participantId) };
  }

  async readApprovedSpec(participantId: string, version: number): Promise<ApprovedSpec | undefined> {
    const spec = this.specs.get(`${participantId}#${String(version)}`);
    if (!spec?.approved) return undefined;
    return {
      text: spec.text,
      ...(spec.whatChanges === undefined || spec.whatChanges.length === 0 ? {} : { whatChanges: [...spec.whatChanges] }),
      ...(spec.rebuildRequestId === undefined ? {} : { rebuildRequestId: spec.rebuildRequestId }),
    };
  }

  /** As DynamoLaunchRecords.setChangeInput: only while `building` under this launch without a task. */
  async setChangeInput(buildId: string, attemptId: string, input: ChangeInput, nowIso: string): Promise<boolean> {
    this.maybeFail("setChangeInput");
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building" || build.attemptId !== attemptId || build.taskArn !== undefined) return false;
    build.changeSpec = input.spec;
    build.changeList = [...input.whatChanges];
    build.updatedAt = nowIso;
    return true;
  }

  async claim(buildId: string, nickname: string, participantId: string, attemptId: string, nowIso: string, slot: { cap: number; queueKey: string }): Promise<ClaimResult> {
    this.maybeFail("claim");
    const build = this.builds.get(buildId);
    if (!build || build.status !== "queued" || build.nickname !== nickname || build.participantId !== participantId) return "taken";
    const running = this.slots.running;
    if (running === undefined || running < 0 || running >= slot.cap || this.holders.has(buildId) || this.strays.has(`BUILD#${buildId}`)) return "no-slot";
    this.slots.running = running + 1;
    this.slots.version += 1;
    this.holders.set(buildId, nowIso);
    this.queue.delete(slot.queueKey);
    delete build.queueKey;
    build.status = "building";
    build.attemptId = attemptId;
    build.launchedAt = nowIso;
    build.updatedAt = nowIso;
    delete build.taskArn;
    this.launches.set(buildId, { buildId, claimedAt: nowIso });
    return "claimed";
  }

  async recordTask(buildId: string, taskArn: string, nowIso: string): Promise<void> {
    this.maybeFail("recordTask");
    const entry = this.launches.get(buildId);
    if (!entry || entry.taskArn !== undefined) throw Object.assign(new Error("launch entry gone"), { name: "LaunchEntryGone" });
    entry.taskArn = taskArn;
    // The build's write is a second call (DynamoLaunchRecords.recordTask): it can fail after the entry's.
    this.maybeFail("recordTaskBuild");
    const build = this.builds.get(buildId);
    if (build) {
      build.taskArn = taskArn;
      build.updatedAt = nowIso;
    }
  }

  /** A failure write, then the slot release (DynamoLaunchRecords' failAndRelease). */
  private fail(build: FakeBuild, reasons: readonly string[], nowIso: string): void {
    build.status = "failed";
    build.failureReasons = [...reasons];
    build.finishedAt = nowIso;
    build.updatedAt = nowIso;
    const buildId = [...this.builds].find(([, b]) => b === build)?.[0];
    if (buildId !== undefined && this.holders.delete(buildId)) this.countDown();
  }

  async failUnstarted(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    this.maybeFail("failUnstarted");
    const build = this.builds.get(buildId);
    const ok = build !== undefined && build.status === "building" && build.taskArn === undefined;
    if (ok) this.fail(build, reasons, nowIso);
    await this.removeLaunch(buildId, undefined);
    return ok;
  }

  async failUnrecorded(buildId: string, claimedAt: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building" || build.taskArn !== undefined || build.launchedAt !== claimedAt) return false;
    this.fail(build, reasons, nowIso);
    return true;
  }

  async failStopped(buildId: string, taskArn: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building" || build.taskArn !== taskArn || build.pushedCommit !== undefined) return false;
    this.fail(build, reasons, nowIso);
    return true;
  }

  async failHandedOver(buildId: string, taskArn: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building" || build.taskArn !== taskArn || build.pushedCommit === undefined) return false;
    this.fail(build, reasons, nowIso);
    return true;
  }

  /** As DynamoLaunchRecords.requeueStopped: back to queued from the beginning, then the slot release. */
  async requeueStopped(buildId: string, taskArn: string, queueKey: string, nowIso: string): Promise<boolean> {
    this.maybeFail("requeueStopped");
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building" || build.taskArn !== taskArn || build.pushedCommit !== undefined) return false;
    build.status = "queued";
    build.queueKey = queueKey;
    build.updatedAt = nowIso;
    delete build.attemptId;
    delete build.launchedAt;
    delete build.taskArn;
    delete build.feed;
    await this.releaseSlot(buildId);
    return true;
  }

  async failQueued(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "queued") return false;
    this.fail(build, reasons, nowIso);
    return true;
  }

  async failDeploy(buildId: string, nickname: string, commit: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || (build.status !== "building" && build.status !== "deploying") || build.nickname !== nickname || build.pushedCommit !== commit) return false;
    this.fail(build, reasons, nowIso);
    return true;
  }

  async listLaunches(): Promise<LaunchEntry[]> {
    this.maybeFail("listLaunches");
    return [...this.launches.values()].map((entry) => ({ ...entry }));
  }

  async removeLaunch(buildId: string, taskArn: string | undefined): Promise<void> {
    const entry = this.launches.get(buildId);
    if (entry !== undefined && entry.taskArn === taskArn) this.launches.delete(buildId);
  }

  /** Ticket 3.10: participants a facilitator paused. */
  readonly paused = new Set<string>();
  /** Ticket 3.10: the facilitators' Retry requests, build id -> requestedAt. */
  readonly retryRequests = new Map<string, string>();

  async readPaused(participantId: string): Promise<boolean> {
    return this.paused.has(participantId);
  }

  async listRetryRequests(): Promise<RetryRequest[]> {
    return [...this.retryRequests].map(([buildId, requestedAt]) => ({ buildId, requestedAt }));
  }

  async removeRetryRequest(buildId: string): Promise<void> {
    this.retryRequests.delete(buildId);
  }

  async readRetryBuild(buildId: string): Promise<RetryBuildState | undefined> {
    const build = this.builds.get(buildId);
    return (
      build && {
        status: build.status,
        ...(build.taskArn === undefined ? {} : { taskArn: build.taskArn }),
        ...(build.launchedAt === undefined ? {} : { launchedAt: build.launchedAt }),
        handedOver: build.pushedCommit !== undefined,
      }
    );
  }

  /** As DynamoLaunchRecords.requeueFailed: only while `failed`; back to queued from the beginning at a new place. */
  async requeueFailed(buildId: string, queueKey: string, nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "failed") return false;
    const { failureReasons, finishedAt, pushedCommit, taskArn, launchedAt, attemptId, feed, ...kept } = build;
    void [failureReasons, finishedAt, pushedCommit, taskArn, launchedAt, attemptId, feed];
    this.builds.set(buildId, { ...kept, status: "queued", queueKey, updatedAt: nowIso });
    return true;
  }
}

/**
 * The builder's tasks: started tasks run until a test stops them. Ticket 3.14: every task of the builds cluster with its
 * subnets (the launcher's in the build subnets, others added by a test), as ListTasks and DescribeTasks report them.
 */
export class FakeTasks implements BuildTasks {
  readonly started: (TaskStart & { taskArn: string; startedBy: string; signal?: AbortSignal })[] = [];
  readonly states = new Map<string, TaskState>();
  readonly stopCalls: string[] = [];
  /** Ticket 3.14: the reason each stop gave (undefined: the launcher's default). */
  readonly stopReasons = new Map<string, string | undefined>();
  /** Ticket 3.14: each task's subnets (from its network interface). */
  readonly subnets = new Map<string, string[]>();
  /** Ticket 3.14: when set, listing the cluster's tasks throws (AccessDenied before the boundary allows ListTasks). */
  listError: Error | undefined;
  /** When set, RunTask answers with this failure and no task. */
  failure: string | undefined;
  /** When set, `start` throws (an AWS error). */
  startError: Error | undefined;
  private count = 0;

  constructor(private readonly now: () => Date) {}

  private nextArn(): string {
    this.count += 1;
    return `arn:aws:ecs:eu-central-1:360206963848:task/ssd-workshop-builds/${String(this.count).padStart(32, "0")}`;
  }

  async start(start: TaskStart, signal?: AbortSignal): Promise<{ taskArn: string } | { failure: string }> {
    if (this.startError) throw this.startError;
    if (this.failure !== undefined) return { failure: this.failure };
    const taskArn = this.nextArn();
    // startedBy is the build id, as runTaskRequest sets it; Fargate places it in one of the two build subnets.
    this.started.push({ ...start, taskArn, startedBy: start.buildId, ...(signal === undefined ? {} : { signal }) });
    this.states.set(taskArn, { stopped: false, createdAt: this.now() });
    this.subnets.set(taskArn, [BUILDS_SUBNET_IDS[this.count % 2] ?? BUILDS_SUBNET_IDS[0]]);
    return { taskArn };
  }

  /** Ticket 3.14: a task someone else started in the builds cluster (RunTask by hand), in these subnets. */
  addTask(subnetIds: string[]): string {
    const taskArn = this.nextArn();
    this.states.set(taskArn, { stopped: false, createdAt: this.now() });
    this.subnets.set(taskArn, [...subnetIds]);
    return taskArn;
  }

  /** Ticket 3.14: a running task's network interface is in these subnets instead. */
  moveTo(taskArn: string, subnetIds: string[]): void {
    this.subnets.set(taskArn, [...subnetIds]);
  }

  /** Ticket 3.14 try 2: when true, the list says the page bound left some tasks out. */
  listTruncated = false;

  async listClusterTasks(): Promise<ClusterTaskList> {
    if (this.listError) throw this.listError;
    const tasks = [...this.states]
      .filter(([, state]) => !state.stopped)
      .map(([taskArn, state]) => ({
        taskArn,
        subnetIds: [...(this.subnets.get(taskArn) ?? [])],
        ...(state.createdAt === undefined ? {} : { createdAt: state.createdAt }),
      }));
    return { tasks, truncated: this.listTruncated };
  }

  async describe(taskArns: readonly string[]): Promise<Map<string, TaskState>> {
    const out = new Map<string, TaskState>();
    // A task ECS no longer knows is left out, as ECS reports it MISSING (DescribeTasks' failures).
    for (const arn of taskArns) {
      const state = this.states.get(arn);
      out.set(arn, state === undefined ? { stopped: true } : { ...state });
    }
    return out;
  }

  async stop(taskArn: string, reason?: string): Promise<void> {
    this.stopCalls.push(taskArn);
    this.stopReasons.set(taskArn, reason);
    this.exit(taskArn);
  }

  /** The task exits (as ECS reports it once the container stopped). */
  exit(taskArn: string): void {
    const state = this.states.get(taskArn);
    if (state) {
      state.stopped = true;
      state.stoppedAt = this.now();
    }
  }

  /** Running tasks started for the build (ListTasks with `startedBy`, desired status RUNNING). */
  running(buildId: string): string[] {
    return this.started.filter((task) => task.startedBy === buildId && this.states.get(task.taskArn)?.stopped === false).map((task) => task.taskArn);
  }
}

export class FakeDeadLetters implements DeadLetters {
  readonly messages: DeadLetter[] = [];
  private count = 0;

  add(body: string): void {
    this.count += 1;
    this.messages.push({ body, receiptHandle: `handle-${String(this.count)}` });
  }

  async receive(): Promise<DeadLetter[]> {
    return this.messages.slice(0, 10).map((message) => ({ ...message }));
  }

  async remove(receiptHandle: string): Promise<void> {
    const index = this.messages.findIndex((message) => message.receiptHandle === receiptHandle);
    if (index >= 0) this.messages.splice(index, 1);
  }
}
