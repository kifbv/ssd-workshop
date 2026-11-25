// In-memory stand-ins for the launcher's outside world (ticket 2.9), for its tests and `npm run builds`' tests (not
// bundled): one table holding builds, profiles, conversations, specs, nickname claims and the watch list, following
// DynamoLaunchRecords' and DynamoBuildsStore's conditions; the builder's tasks; a dead-letter queue. Ticket 3.4: the
// build slots (counter and holders) and the waiting line, with the same conditions as the real transactions.
import type { BuildStatus } from "../types.js";
import type { BuildTasks, ClaimResult, DeadLetter, DeadLetters, LaunchBuild, LaunchEntry, LaunchRecords, SlotCount, TaskStart, TaskState } from "./launcher.js";

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
}

export class FakeBuildTable implements LaunchRecords {
  readonly builds = new Map<string, FakeBuild>();
  /** Profile nickname by participant id. */
  readonly profiles = new Map<string, string>();
  readonly conversations = new Map<string, { buildId?: string; approvedSpecVersion?: number }>();
  /** `<participant id>#<version>` -> spec. */
  readonly specs = new Map<string, { text: string; approved: boolean }>();
  /** Lower-cased nickname -> participant id (the `NICK#` claims). */
  readonly nicknames = new Map<string, string>();
  readonly launches = new Map<string, LaunchEntry>();
  /** Calls that throw once, by method name (a passing table error). */
  readonly failOnce = new Set<string>();
  /** Ticket 3.4: `buildsAtOnce` as the SETTINGS item gives it. */
  buildsAtOnce = 15;
  /** The slot counter (`COUNT`) and the holders (build ids). */
  readonly slots: SlotCount = { running: 0, version: 0 };
  readonly holders = new Map<string, string>();
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

  async readBuild(buildId: string): Promise<LaunchBuild | undefined> {
    this.maybeFail("readBuild");
    const build = this.builds.get(buildId);
    return build && { nickname: build.nickname, participantId: build.participantId, status: build.status, ...(build.queueKey === undefined ? {} : { queueKey: build.queueKey }) };
  }

  async readBuildsAtOnce(): Promise<number> {
    return this.buildsAtOnce;
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

  async listSlotHolders(): Promise<string[]> {
    return [...this.holders.keys()];
  }

  /** As releaseSlotItems: only for a build that ended (or is gone) and holds a slot. */
  async releaseSlot(buildId: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if ((build !== undefined && (build.status === "building" || build.status === "deploying")) || !this.holders.has(buildId)) return false;
    this.holders.delete(buildId);
    this.slots.running -= 1;
    this.slots.version += 1;
    return true;
  }

  async repairSlots(seen: SlotCount, running: number): Promise<boolean> {
    if (this.slots.version !== seen.version) return false;
    this.slots.running = running;
    this.slots.version += 1;
    return true;
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

  async readConversation(participantId: string): Promise<{ buildId?: string; approvedSpecVersion?: number }> {
    return { ...this.conversations.get(participantId) };
  }

  async readApprovedSpec(participantId: string, version: number): Promise<string | undefined> {
    const spec = this.specs.get(`${participantId}#${String(version)}`);
    return spec?.approved ? spec.text : undefined;
  }

  async claim(buildId: string, nickname: string, participantId: string, attemptId: string, nowIso: string, slot: { cap: number; queueKey: string }): Promise<ClaimResult> {
    this.maybeFail("claim");
    const build = this.builds.get(buildId);
    if (!build || build.status !== "queued" || build.nickname !== nickname || build.participantId !== participantId) return "taken";
    if (this.slots.running >= slot.cap || this.holders.has(buildId)) return "no-slot";
    this.slots.running += 1;
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
    if (buildId !== undefined && this.holders.delete(buildId)) {
      this.slots.running -= 1;
      this.slots.version += 1;
    }
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
}

/** The builder's tasks: started tasks run until a test stops them. */
export class FakeTasks implements BuildTasks {
  readonly started: (TaskStart & { taskArn: string; startedBy: string; signal?: AbortSignal })[] = [];
  readonly states = new Map<string, TaskState>();
  readonly stopCalls: string[] = [];
  /** When set, RunTask answers with this failure and no task. */
  failure: string | undefined;
  /** When set, `start` throws (an AWS error). */
  startError: Error | undefined;
  private count = 0;

  constructor(private readonly now: () => Date) {}

  async start(start: TaskStart, signal?: AbortSignal): Promise<{ taskArn: string } | { failure: string }> {
    if (this.startError) throw this.startError;
    if (this.failure !== undefined) return { failure: this.failure };
    this.count += 1;
    const taskArn = `arn:aws:ecs:eu-central-1:360206963848:task/ssd-workshop-builds/${String(this.count).padStart(32, "0")}`;
    // startedBy is the build id, as runTaskRequest sets it.
    this.started.push({ ...start, taskArn, startedBy: start.buildId, ...(signal === undefined ? {} : { signal }) });
    this.states.set(taskArn, { stopped: false, createdAt: this.now() });
    return { taskArn };
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

  async stop(taskArn: string): Promise<void> {
    this.stopCalls.push(taskArn);
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
