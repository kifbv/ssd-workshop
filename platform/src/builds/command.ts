// `npm run builds -- list | retry <nickname>` (ticket 2.9): the facilitator's stand-in for phase 3's dashboard. Run
// from Franck's machine with his own AWS credentials (`AWS_PROFILE=franck`): Claude sessions may not send to the launch
// queue (access stack, `NoBuildQueueForSessions`). The flow lives here with its outside world passed in, so it is tested
// against in-memory fakes; ./main.ts wires in the real ones. It prints build ids, nicknames and statuses only: never an
// email address, a token or a failure's text.
import type { BuildStatus } from "../../api/types.js";

export const USAGE = `Usage: npm run builds -- list | retry <nickname>

  list               every build, newest first: when it was created, its status, the app's nickname and its id
  retry <nickname>   queue the participant's failed (or stuck queued) build again: the launcher starts a new task on
                     the same repository

Runs with your own AWS credentials (AWS_PROFILE=franck).`;

export type BuildsCommand = { command: "list" } | { command: "retry"; nickname: string };

/** Nicknames are 3 to 20 letters, digits or dashes (the API's rule); anything else is refused unread. */
const NICKNAME = /^[A-Za-z0-9-]{3,20}$/;

export function parseBuildsArgs(args: readonly string[]): BuildsCommand | { error: string } {
  const [command, ...rest] = args;
  if (command === undefined) return { error: "no command given" };
  if (command === "list") return rest.length === 0 ? { command } : { error: "list takes no arguments" };
  if (command !== "retry") return { error: "unknown command" };
  const [nickname, ...extra] = rest;
  if (nickname === undefined) return { error: "retry needs a nickname" };
  if (extra.length > 0) return { error: "retry takes one nickname" };
  if (!NICKNAME.test(nickname.trim())) return { error: "that is not a nickname (3 to 20 letters, digits or dashes)" };
  return { command, nickname: nickname.trim() };
}

export interface BuildSummary {
  buildId: string;
  nickname: string;
  status: BuildStatus;
  createdAt?: string;
}

export interface RetryBuild {
  nickname: string;
  participantId: string;
  status: BuildStatus;
  taskArn?: string;
}

export interface BuildsStore {
  listBuilds(): Promise<BuildSummary[]>;
  /** The participant holding the nickname (its `NICK#` claim, any letter case). */
  findParticipantId(nickname: string): Promise<string | undefined>;
  /** The build the participant's conversation started (ticket 2.7). */
  readConversationBuildId(participantId: string): Promise<string | undefined>;
  readBuild(buildId: string): Promise<RetryBuild | undefined>;
  /**
   * Back to `queued`, only while still `from`: removes the earlier run's task, pushed and deployed commits, feed,
   * failure reasons and times, so the launcher and the builder take it as new.
   */
  requeue(buildId: string, from: BuildStatus, nowIso: string): Promise<boolean>;
}

export interface LaunchQueue {
  /** `{"buildId"}` to the launch queue, in the participant's message group, with a deduplication id of its own. */
  send(buildId: string, participantId: string, deduplicationId: string): Promise<void>;
}

export interface TaskWatch {
  /** True when the task has stopped (or ECS no longer knows it). */
  isStopped(taskArn: string): Promise<boolean>;
  /**
   * How many tasks started for this build still run (ListTasks by `startedBy`, which the launcher sets to the build id):
   * also a task the build no longer names (a RunTask cut off before its answer, ticket 2.9 try 2).
   */
  runningTasks(buildId: string): Promise<number>;
}

export interface BuildsDeps {
  /** Called only once the arguments are accepted, so a usage error makes no AWS call. */
  connect: () => { store: BuildsStore; queue: LaunchQueue; tasks: TaskWatch };
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

const RETRYABLE: readonly BuildStatus[] = ["failed", "queued"];

async function retry(nickname: string, deps: BuildsDeps, world: ReturnType<BuildsDeps["connect"]>): Promise<number> {
  const { store, queue, tasks } = world;
  const participantId = await store.findParticipantId(nickname);
  if (participantId === undefined) {
    deps.err(`No participant has the nickname ${nickname}.`);
    return 1;
  }
  const buildId = await store.readConversationBuildId(participantId);
  const build = buildId === undefined ? undefined : await store.readBuild(buildId);
  if (buildId === undefined || build === undefined || build.participantId !== participantId) {
    deps.err(`${nickname} has no build yet. Nothing changed.`);
    return 1;
  }
  if (!RETRYABLE.includes(build.status)) {
    deps.err(`${nickname}'s build is ${build.status}; only a failed (or stuck queued) build can be retried. Nothing changed.`);
    return 1;
  }
  // Never two tasks for one build: the earlier one must have stopped, and no other task started for it may still run.
  if ((build.taskArn !== undefined && !(await tasks.isStopped(build.taskArn))) || (await tasks.runningTasks(buildId)) > 0) {
    deps.err(`${nickname}'s earlier build task is still running; try again in a minute. Nothing changed.`);
    return 1;
  }
  const now = deps.now();
  if (!(await store.requeue(buildId, build.status, now.toISOString()))) {
    deps.err(`${nickname}'s build changed meanwhile; look at it with "list" and try again. Nothing changed.`);
    return 1;
  }
  try {
    // Its own deduplication id: SQS would drop a second message with the build id within 5 minutes.
    await queue.send(buildId, participantId, `${buildId}-retry-${String(now.getTime())}`);
  } catch (error) {
    deps.err(`${nickname}'s build is queued again, but the launch message could not be sent (${error instanceof Error ? error.name : "Error"}); run retry again.`);
    return 1;
  }
  deps.out(`${nickname}'s build ${buildId} is queued again; the launcher starts a new task on the same repository within a minute.`);
  return 0;
}

export async function runBuilds(args: readonly string[], deps: BuildsDeps): Promise<number> {
  const parsed = parseBuildsArgs(args);
  if ("error" in parsed) {
    deps.err(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  try {
    const world = deps.connect();
    if (parsed.command === "retry") return await retry(parsed.nickname, deps, world);
    const builds = await world.store.listBuilds();
    if (builds.length === 0) {
      deps.out("No builds yet.");
      return 0;
    }
    const sorted = [...builds].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    for (const build of sorted) deps.out(`${build.createdAt ?? "-"}  ${build.status.padEnd(9)}  ${build.nickname}  ${build.buildId}`);
    return 0;
  } catch (error) {
    deps.err(`The command failed (${error instanceof Error ? error.name : "Error"}). Check your AWS credentials (AWS_PROFILE=franck).`);
    return 1;
  }
}
