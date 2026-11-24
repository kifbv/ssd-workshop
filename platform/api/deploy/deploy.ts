/**
 * The deployer (ticket 2.5): publishes one build of an app at `/apps/<nickname>/`. For one message
 * `{ buildId, nickname, commit }` from the deploy queue it:
 *
 * 1. marks the build `deploying` (only an existing build: a message for an unknown build is dropped);
 * 2. downloads the app's public repository at the commit from GitHub (tar.gz, size-capped) and unpacks
 *    it in memory (./tar.ts);
 * 3. runs the deploy check (../build/check.ts). When it fails, nothing is uploaded or removed, the live
 *    marker is left alone and the build is marked `failed` with the check's reasons;
 * 4. otherwise puts every file under `apps/<lower-cased nickname>/` (pages last), removes the keys the
 *    new version no longer has, invalidates `/apps/<nickname>/*` on CloudFront, writes the app's live
 *    marker (keeping the first `liveAt`) and marks the build `live` with the commit.
 *
 * SQS delivers at least once and every step can run again: the same commit gives the same files. A
 * passing problem (GitHub or AWS) throws, so SQS delivers the message again; on the last delivery the
 * build is marked failed instead. Logs hold counts only: never a nickname, commit, file name, reason or
 * error message.
 */
import { checkApp, type AppFile, type Problem } from "../build/check.js";
import { BUILD_ID_PATTERN } from "../keys.js";
import { NICKNAME_PATTERN } from "../participant/participant.js";
import { APPS_KEY_PREFIX, DEPLOY_MAX_RECEIVES, appArchiveUrl } from "../settings.js";
import { errorName } from "../sign-in/code-request.js";
import { ArchiveProblem, readTarGz } from "./tar.js";

export interface DeployJob {
  buildId: string;
  /** As the participant typed it; keys and paths use it lower-cased. */
  nickname: string;
  /** The full commit id: 40 lower-case hex digits. */
  commit: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** The message body, read strictly: exactly these three fields, each in its form, or undefined. */
export function parseDeployJob(body: string | undefined): DeployJob | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "buildId,commit,nickname") return undefined;
  const { buildId, nickname, commit } = fields;
  if (typeof buildId !== "string" || !BUILD_ID_PATTERN.test(buildId)) return undefined;
  if (typeof nickname !== "string" || !NICKNAME_PATTERN.test(nickname)) return undefined;
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) return undefined;
  return { buildId, nickname, commit };
}

/** The apps bucket, as the deployer uses it. */
export interface AppObjects {
  put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
  /** Every key under the prefix. */
  list(prefix: string): Promise<string[]>;
  remove(keys: readonly string[]): Promise<void>;
}

/** CloudFront, as the deployer uses it. */
export interface Cdn {
  invalidate(paths: readonly string[], reference: string): Promise<void>;
}

/** The table's build items and live markers, as the deployer uses them. Build updates return false when the build does not exist. */
export interface DeployRecords {
  startDeploy(buildId: string, nowIso: string): Promise<boolean>;
  markLive(buildId: string, commit: string, nowIso: string): Promise<boolean>;
  markFailed(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /** Writes the live marker, keeping `liveAt` when it exists. */
  markAppLive(nickname: string, nowIso: string): Promise<void>;
}

export type DeployOutcome = "live" | "failed" | "invalid" | "no-build" | "retry" | "gave-up";

/** The only things ever logged: counts, an outcome and an error name. */
export interface DeployLogEntry {
  event: "deployer";
  outcome: DeployOutcome;
  files?: number;
  bytes?: number;
  removed?: number;
  problems?: number;
  error?: string;
  durationMs: number;
}

export interface DeployDeps {
  /** Downloads the tarball at the address (GitHub). Throws DownloadProblem for what it can name. */
  download: (url: string) => Promise<Uint8Array>;
  objects: AppObjects;
  cdn: Cdn;
  records: DeployRecords;
  now: () => Date;
  log: (entry: DeployLogEntry) => void;
}

/**
 * A download that failed: `passing` problems (GitHub's answer, a timeout) are tried again; the others (over
 * the size limit) fail the build at once. `reason` is stored on the build when it fails.
 */
export class DownloadProblem extends Error {
  constructor(
    readonly reason: string,
    readonly passing: boolean,
  ) {
    super(reason);
    this.name = "DownloadProblem";
  }
}

/** Stored when a passing problem outlasts every delivery and has no reason of its own (an AWS error). */
export const SERVICE_PROBLEM_REASON = "The workshop could not publish the app because of a problem on its side. Please try again.";

/** What the Lambda runtime sees of a deploy to retry: no message or stack of the original error. */
export const DEPLOY_FAILED = "deploy failed";

/** The browser and CloudFront keep a file 60 s; each deploy also invalidates the app's paths. */
export const CACHE_CONTROL = "public, max-age=60";

/** Every type the deploy check allows (ALLOWED_EXTENSIONS), by lower-cased extension. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** The content type of a file the check passed, from its extension in any letter case. */
export function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const type = dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()];
  return type ?? "application/octet-stream";
}

/** One stored reason at most this long, and all of them together at most MAX_REASONS_CHARS (the build item stays small). */
export const MAX_REASON_CHARS = 500;
export const MAX_REASONS_CHARS = 16_000;

function reasonText(problem: Problem): string {
  const where = problem.file === undefined ? "" : problem.line === undefined ? `${problem.file}: ` : `${problem.file}, line ${problem.line}: `;
  const text = `${where}${problem.reason}`;
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS - 1)}…`;
}

/** The check's problems as the build's reasons, within the length caps; what does not fit is counted in a last line. */
export function storedReasons(problems: readonly Problem[]): string[] {
  const reasons: string[] = [];
  let total = 0;
  for (const [index, problem] of problems.entries()) {
    const text = reasonText(problem);
    // Room is kept for the closing line.
    if (total + text.length > MAX_REASONS_CHARS - 40) {
      const left = problems.length - index;
      reasons.push(`…and ${left} more ${left === 1 ? "problem" : "problems"}.`);
      break;
    }
    reasons.push(text);
    total += text.length;
  }
  return reasons;
}

const isPage = (path: string): boolean => path.toLowerCase().endsWith(".html");

/** At most this many puts at once. */
const PUT_CONCURRENCY = 8;

async function putAll(files: readonly AppFile[], prefix: string, objects: AppObjects): Promise<void> {
  // Pages last: a new page only ever names files that are already there.
  const putOne = (file: AppFile) => objects.put(`${prefix}${file.path}`, file.bytes, contentTypeOf(file.path), CACHE_CONTROL);
  const others = files.filter((f) => !isPage(f.path));
  const pages = files.filter((f) => isPage(f.path));
  for (const group of [others, pages]) {
    for (let at = 0; at < group.length; at += PUT_CONCURRENCY) {
      await Promise.all(group.slice(at, at + PUT_CONCURRENCY).map(putOne));
    }
  }
}

/**
 * Handles one deploy message, delivered for the `receiveCount`-th time. Resolves when the message is
 * done with (published, failed, dropped); throws a bare error when SQS should deliver it again.
 */
export async function processDeploy(body: string | undefined, receiveCount: number, deps: DeployDeps): Promise<void> {
  const started = deps.now().getTime();
  const log = (entry: Omit<DeployLogEntry, "event" | "durationMs">): void =>
    deps.log({ event: "deployer", ...entry, durationMs: Math.max(0, deps.now().getTime() - started) });
  const nowIso = (): string => deps.now().toISOString();

  const job = parseDeployJob(body);
  if (job === undefined) {
    log({ outcome: "invalid" });
    return;
  }

  const nickname = job.nickname.toLowerCase();
  const prefix = `${APPS_KEY_PREFIX}${nickname}/`;
  try {
    if (!(await deps.records.startDeploy(job.buildId, nowIso()))) {
      log({ outcome: "no-build" });
      return;
    }

    let files: AppFile[];
    try {
      files = readTarGz(await deps.download(appArchiveUrl(job.nickname, job.commit)));
    } catch (error) {
      const reason = error instanceof ArchiveProblem || (error instanceof DownloadProblem && !error.passing) ? error.reason : undefined;
      if (reason === undefined) throw error;
      await deps.records.markFailed(job.buildId, [reason], nowIso());
      log({ outcome: "failed", problems: 1 });
      return;
    }

    const result = checkApp(files);
    const published = files.filter((file) => file.kind === "file");
    if (!result.ok) {
      await deps.records.markFailed(job.buildId, storedReasons(result.problems), nowIso());
      log({ outcome: "failed", files: published.length, bytes: result.totalBytes, problems: result.problems.length });
      return;
    }

    await putAll(published, prefix, deps.objects);
    const keep = new Set(published.map((file) => `${prefix}${file.path}`));
    const stale = (await deps.objects.list(prefix)).filter((key) => key.startsWith(prefix) && !keep.has(key));
    if (stale.length > 0) await deps.objects.remove(stale);
    await deps.cdn.invalidate([`/${prefix}*`], `${job.buildId}-${deps.now().getTime()}`);
    await deps.records.markAppLive(job.nickname, nowIso());
    await deps.records.markLive(job.buildId, job.commit, nowIso());
    log({ outcome: "live", files: published.length, bytes: result.totalBytes, removed: stale.length });
  } catch (error) {
    const name = errorName(error);
    if (receiveCount < DEPLOY_MAX_RECEIVES) {
      log({ outcome: "retry", error: name });
      // Deliberately no cause: the Lambda runtime would log its message (keys, nicknames).
      // eslint-disable-next-line preserve-caught-error
      throw new Error(DEPLOY_FAILED);
    }
    const reason = error instanceof DownloadProblem ? error.reason : SERVICE_PROBLEM_REASON;
    // A failure here goes no further than its name either (the message then reaches the dead-letter queue).
    const recorded = await deps.records.markFailed(job.buildId, [reason], nowIso()).then(
      () => true,
      () => false,
    );
    log({ outcome: recorded ? "gave-up" : "retry", error: name });
    // eslint-disable-next-line preserve-caught-error -- no cause, as above
    if (!recorded) throw new Error(DEPLOY_FAILED);
  }
}
