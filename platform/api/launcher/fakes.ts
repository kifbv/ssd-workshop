// In-memory stand-ins for the launcher's outside world (ticket 2.9), for its tests and `npm run builds`' tests (not
// bundled): one table holding builds, profiles, conversations, specs, nickname claims and the watch list, following
// DynamoLaunchRecords' and DynamoBuildsStore's conditions; the builder's tasks; a dead-letter queue.
import type { BuildStatus } from "../types.js";
import type { BuildTasks, DeadLetter, DeadLetters, LaunchBuild, LaunchEntry, LaunchRecords, TaskState } from "./launcher.js";

export interface FakeBuild {
  nickname: string;
  participantId: string;
  status: BuildStatus;
  createdAt?: string;
  updatedAt?: string;
  launchedAt?: string;
  taskArn?: string;
  pushedCommit?: string;
  deployedCommit?: string;
  failureReasons?: string[];
  finishedAt?: string;
  feed?: unknown[];
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
    return build && { nickname: build.nickname, participantId: build.participantId, status: build.status };
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

  async claim(buildId: string, nickname: string, participantId: string, nowIso: string): Promise<boolean> {
    this.maybeFail("claim");
    const build = this.builds.get(buildId);
    if (!build || build.status !== "queued" || build.nickname !== nickname || build.participantId !== participantId) return false;
    build.status = "building";
    build.launchedAt = nowIso;
    build.updatedAt = nowIso;
    delete build.taskArn;
    this.launches.set(buildId, { buildId, claimedAt: nowIso });
    return true;
  }

  async recordTask(buildId: string, taskArn: string, nowIso: string): Promise<void> {
    this.maybeFail("recordTask");
    const entry = this.launches.get(buildId);
    if (!entry || entry.taskArn !== undefined) throw Object.assign(new Error("launch entry gone"), { name: "LaunchEntryGone" });
    entry.taskArn = taskArn;
    const build = this.builds.get(buildId);
    if (build) {
      build.taskArn = taskArn;
      build.updatedAt = nowIso;
    }
  }

  private fail(build: FakeBuild, reasons: readonly string[], nowIso: string): void {
    build.status = "failed";
    build.failureReasons = [...reasons];
    build.finishedAt = nowIso;
    build.updatedAt = nowIso;
  }

  async failUnstarted(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    this.maybeFail("failUnstarted");
    const build = this.builds.get(buildId);
    const ok = build !== undefined && build.status === "building" && build.taskArn === undefined;
    if (ok) this.fail(build, reasons, nowIso);
    await this.removeLaunch(buildId, undefined);
    return ok;
  }

  async failStopped(buildId: string, taskArn: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    const build = this.builds.get(buildId);
    if (!build || build.status !== "building" || build.taskArn !== taskArn || build.pushedCommit !== undefined) return false;
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
  readonly started: { buildId: string; token: string; taskArn: string }[] = [];
  readonly states = new Map<string, TaskState>();
  readonly stopCalls: string[] = [];
  /** When set, RunTask answers with this failure and no task. */
  failure: string | undefined;
  /** When set, `start` throws (an AWS error). */
  startError: Error | undefined;
  private count = 0;

  constructor(private readonly now: () => Date) {}

  async start(buildId: string, token: string): Promise<{ taskArn: string } | { failure: string }> {
    if (this.startError) throw this.startError;
    if (this.failure !== undefined) return { failure: this.failure };
    this.count += 1;
    const taskArn = `arn:aws:ecs:eu-central-1:360206963848:task/ssd-workshop-builds/${String(this.count).padStart(32, "0")}`;
    this.started.push({ buildId, token, taskArn });
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
    const state = this.states.get(taskArn);
    if (state) state.stopped = true;
  }

  /** The task exits (as ECS reports it once the container stopped). */
  exit(taskArn: string): void {
    const state = this.states.get(taskArn);
    if (state) state.stopped = true;
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
