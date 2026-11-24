// In-memory stand-ins for `npm run builds` (ticket 2.9), over the launcher's fake table, so a test can retry a build
// and hand the launch message to the real launcher.
import type { FakeBuildTable, FakeTasks } from "../../api/launcher/fakes.js";
import type { BuildStatus } from "../../api/types.js";
import type { BuildSummary, BuildsStore, LaunchQueue, RetryBuild, TaskWatch } from "./command.js";

export class FakeBuildsStore implements BuildsStore {
  constructor(private readonly table: FakeBuildTable) {}

  async listBuilds(): Promise<BuildSummary[]> {
    return [...this.table.builds].map(([buildId, build]) => ({
      buildId,
      nickname: build.nickname,
      status: build.status,
      ...(build.createdAt === undefined ? {} : { createdAt: build.createdAt }),
    }));
  }

  async findParticipantId(nickname: string): Promise<string | undefined> {
    return this.table.nicknames.get(nickname.toLowerCase());
  }

  async readConversationBuildId(participantId: string): Promise<string | undefined> {
    return this.table.conversations.get(participantId)?.buildId;
  }

  async readBuild(buildId: string): Promise<RetryBuild | undefined> {
    const build = this.table.builds.get(buildId);
    return build && { nickname: build.nickname, participantId: build.participantId, status: build.status, ...(build.taskArn === undefined ? {} : { taskArn: build.taskArn }) };
  }

  async requeue(buildId: string, from: BuildStatus, nowIso: string): Promise<boolean> {
    const build = this.table.builds.get(buildId);
    if (!build || build.status !== from) return false;
    // The same attributes the real store removes (REQUEUE_REMOVED).
    delete build.failureReasons;
    delete build.finishedAt;
    delete build.pushedCommit;
    delete build.deployedCommit;
    delete build.taskArn;
    delete build.launchedAt;
    delete build.attemptId;
    delete build.feed;
    build.status = "queued";
    build.updatedAt = nowIso;
    return true;
  }
}

export class FakeLaunchQueue implements LaunchQueue {
  readonly sent: { body: string; participantId: string; deduplicationId: string }[] = [];
  failures = 0;

  async send(buildId: string, participantId: string, deduplicationId: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw Object.assign(new Error("queue is down"), { name: "ServiceUnavailable" });
    }
    this.sent.push({ body: JSON.stringify({ buildId }), participantId, deduplicationId });
  }
}

export class FakeTaskWatch implements TaskWatch {
  constructor(private readonly tasks: FakeTasks) {}

  async isStopped(taskArn: string): Promise<boolean> {
    return (await this.tasks.describe([taskArn])).get(taskArn)?.stopped ?? true;
  }

  async runningTasks(buildId: string): Promise<number> {
    return this.tasks.running(buildId).length;
  }
}
