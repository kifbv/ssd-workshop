/**
 * The deployer (ticket 2.5): publishes one build of an app at `/apps/<nickname>/`. For one message
 * `{ buildId, nickname, commit }` from the deploy queue it:
 *
 * 1. marks the build `deploying`: only a build that exists, belongs to the message's app (same nickname), whose
 *    builder pushed the message's commit (`pushedCommit`, ticket 2.8) and waits for its deploy (`queued`, `building`, or `deploying` on a redelivery); any other message is dropped;
 * 2. downloads the app's public repository's own `main` from GitHub (`refs/heads/main`, tar.gz, size-capped, redirects
 *    refused) and unpacks it in memory (./tar.ts). Ticket 2.8 try 3: GitHub serves a fork's commit through the
 *    parent's address by commit id, so the deployer never downloads by commit id. It goes on only when the archive's
 *    own commit (its first entry, GitHub's pax global header) is the message's commit: another commit (main moved on,
 *    or a stale copy right after the push) is a passing problem, retried and then failed; no commit named fails at once;
 * 3. keeps those bytes: what is checked and published below is exactly them (no second download);
 * 4. runs the deploy check (../build/check.ts). When it fails, nothing is uploaded or removed, the live
 *    marker is left alone and the build is marked `failed` with the check's reasons;
 * 5. otherwise puts every file under `apps/<lower-cased nickname>/` (pages last), removes the keys the
 *    new version no longer has, invalidates `/apps/<nickname>/*` on CloudFront, writes the app's live
 *    marker (keeping the first `liveAt`) and marks the build `live` with the commit.
 *
 * Ticket 3.25: the app's `workshop-data.js` (the data client and the workshop's sign-in to save) is always the
 * platform's current one, bundled with the deployer, whatever the repository holds (none, an older copy, a changed one,
 * a folder or a link of that name): it replaces the repository's before the check (`withPlatformDataClient`). A second
 * message kind, `{ "refresh": "<nickname>" }` (sent by Franck's `npm run apps -- refresh`, question 10), puts only that
 * file into an app already published (its `index.html` is there) and invalidates it: apps built before 3.25 then save
 * with the workshop's sign-in without a new build.
 *
 * SQS delivers at least once and every step can run again: the same commit gives the same files. A
 * passing problem (GitHub or AWS) throws, so SQS delivers the message again; on the last delivery the
 * build is marked failed instead. Every phase runs within the Lambda's remaining time less DEPLOY_RESERVE_MS, so
 * the last delivery still has time to mark the build failed ("The deploy took too long."); a phase cut off is aborted
 * (its AbortSignal), and the build's last writes are conditional on it still being `deploying`, so a late write can
 * never change a finished build. Logs hold counts only: never a nickname, commit, file name, reason or error message.
 */
import { checkApp, type AppFile, type Problem } from "../build/check.js";
import { BUILD_ID_PATTERN } from "../keys.js";
import { NICKNAME_PATTERN } from "../participant/participant.js";
import { APPS_KEY_PREFIX, DEPLOY_MAX_RECEIVES, appMainArchiveUrl } from "../settings.js";
import { errorName } from "../sign-in/code-request.js";
import { ArchiveProblem, readTarGzArchive } from "./tar.js";

export interface DeployJob {
  buildId: string;
  /** As the participant typed it (equal to the build's `nickname`); keys and paths use it lower-cased. */
  nickname: string;
  /**
   * The full commit id: 40 lower-case hex digits. Must come from the platform's own push result (tickets 2.7,
   * 2.8), never from participant input: the deployer publishes whatever commit the message names.
   */
  commit: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** The platform's data client: every published app holds the platform's current copy at its top (ticket 3.25). */
export const DATA_CLIENT_PATH = "workshop-data.js";

/**
 * The app's files with the repository's `workshop-data.js` (of any kind, a folder with what it holds included) replaced by
 * the platform's `dataClient`.
 */
export function withPlatformDataClient(files: readonly AppFile[], dataClient: Uint8Array): AppFile[] {
  const theirs = (path: string): boolean => path === DATA_CLIENT_PATH || path.startsWith(`${DATA_CLIENT_PATH}/`);
  return [...files.filter((file) => !theirs(file.path)), { path: DATA_CLIENT_PATH, kind: "file", bytes: dataClient }];
}

/** Ticket 3.25: `{ "refresh": "<nickname>" }`, exactly, or undefined. */
export function parseRefreshJob(body: string | undefined): { nickname: string } | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).join(",") !== "refresh") return undefined;
  const nickname = fields["refresh"];
  return typeof nickname === "string" && NICKNAME_PATTERN.test(nickname) ? { nickname } : undefined;
}

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

/**
 * The apps bucket, as the deployer uses it. `signal` is aborted when the phase's time is up: the call must stop
 * (the AWS SDK's `abortSignal`), so nothing it does lands after the deploy gave up.
 */
export interface AppObjects {
  put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string, signal?: AbortSignal): Promise<void>;
  /** Every key under the prefix. */
  list(prefix: string, signal?: AbortSignal): Promise<string[]>;
  remove(keys: readonly string[], signal?: AbortSignal): Promise<void>;
}

/** CloudFront, as the deployer uses it (`signal` as for AppObjects). */
export interface Cdn {
  invalidate(paths: readonly string[], reference: string, signal?: AbortSignal): Promise<void>;
}

/**
 * The table's build items and live markers, as the deployer uses them. Build updates return false when their
 * condition fails (the build is missing, or not in the state the update needs).
 */
export interface DeployRecords {
  /**
   * Marks the build `deploying` only when it exists, its nickname equals `nickname` exactly, its `pushedCommit` (what
   * the builder pushed, ticket 2.8) equals `commit`, and it is queued, building or deploying.
   */
  startDeploy(buildId: string, nickname: string, commit: string, nowIso: string): Promise<boolean>;
  /** Only while the build is `deploying`: a late write never changes a finished (live or failed) build. */
  markLive(buildId: string, commit: string, nowIso: string, signal?: AbortSignal): Promise<boolean>;
  /** Only while the build is `deploying`, as markLive. */
  markFailed(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean>;
  /** Writes the live marker, keeping `liveAt` when it exists. */
  markAppLive(nickname: string, nowIso: string, signal?: AbortSignal): Promise<void>;
}

/**
 * `no-build`: no deployable build for the message (missing, another app's, or already live or failed).
 * `dead-letter`: the last delivery could not even mark the build failed; the message goes to the dead-letter queue.
 * Ticket 3.25, a refresh: `refreshed` (the platform's workshop-data.js put and invalidated), `not-published` (the app has
 * no index.html under its prefix: nothing to refresh), or `retry`/`dead-letter` on a failure.
 */
export type DeployOutcome = "live" | "failed" | "invalid" | "no-build" | "retry" | "gave-up" | "dead-letter" | "refreshed" | "not-published";

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
  /**
   * Downloads the tarball at the address (GitHub) within `timeoutMs`, stopping when `signal` is aborted, with redirects
   * refused (`downloadForDeployer` in ./github.ts). Throws DownloadProblem for what it can name.
   */
  download: (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<Uint8Array>;
  objects: AppObjects;
  cdn: Cdn;
  records: DeployRecords;
  now: () => Date;
  log: (entry: DeployLogEntry) => void;
  /** Ticket 3.25: the platform's current templates/basic/workshop-data.js (bundled next to the deployer's code). */
  dataClient: Uint8Array;
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

/**
 * Stored on the last delivery when main's archive names another commit than the message (main moved on, or codeload
 * still served the copy from before the push).
 */
export const MAIN_MOVED_REASON = "The app's main branch on GitHub is not at the commit the builder pushed, so nothing was published.";

/** Stored at once when main's archive does not name its commit (no pax global header first, or a malformed one). */
export const NO_COMMIT_REASON = "GitHub's download of the app's main branch does not name its commit, so nothing was published.";

/** Stored when a passing problem outlasts every delivery and has no reason of its own (an AWS error). */
export const SERVICE_PROBLEM_REASON = "The workshop could not publish the app because of a problem on its side. Please try again.";

/** The whole download, answer and body, must end within this time (less when the Lambda has less left). */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Stored when the Lambda's time ran out before the deploy finished (last delivery). */
export const TIME_UP_REASON = "The deploy took too long.";

/**
 * No phase (download, a batch of puts, the clean-up, the invalidation, a table write) starts with less than this
 * much of the Lambda's time left, and each one is cut off this long before the end: room to mark the build failed.
 */
export const DEPLOY_RESERVE_MS = 15_000;

/** The deploy ran out of time (see DEPLOY_RESERVE_MS). */
export class DeployTimeUp extends Error {
  constructor() {
    super("time up");
    this.name = "DeployTimeUp";
  }
}

/** setTimeout's longest delay; a longer (or infinite) one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * `work`, or DeployTimeUp after `ms`. The work gets a signal of its own, aborted when the time is up, and passes it
 * to every call it makes (S3, CloudFront, DynamoDB, the download), so a cut-off call stops instead of landing later.
 */
async function within<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  if (!(ms < MAX_TIMER_MS)) return work(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeployTimeUp());
      controller.abort(new DeployTimeUp());
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeUp]);
  } catch (error) {
    // A failed step also stops the calls it started alongside (a batch's other puts), so none lands later.
    if (!controller.signal.aborted) controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * Control, format (bidirectional overrides, zero-width), private-use, unassigned and lone surrogate characters, and
 * line or paragraph separators. Reasons quote file names and lines from the participant's repository (anyone's
 * text): each such character is stored as `?`, so a page shows exactly what is there.
 */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** A reason as stored: at most MAX_REASON_CHARS, non-printable characters as `?` (after the cut, which may split a pair). */
export function storedReason(text: string): string {
  const cut = text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS - 1)}…`;
  return cut.replace(NON_PRINTABLE, "?");
}

function reasonText(problem: Problem): string {
  const where = problem.file === undefined ? "" : problem.line === undefined ? `${problem.file}: ` : `${problem.file}, line ${problem.line}: `;
  return storedReason(`${where}${problem.reason}`);
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

/**
 * Runs one phase within the time left (throws DeployTimeUp when too little is left to start it), giving it the
 * time left and a signal aborted when that time is up.
 */
type Bounded = <T>(work: (ms: number, signal: AbortSignal) => Promise<T>) => Promise<T>;

async function putAll(files: readonly AppFile[], prefix: string, objects: AppObjects, bounded: Bounded): Promise<void> {
  // Pages last: a new page only ever names files that are already there.
  const putOne = (file: AppFile, signal: AbortSignal) => objects.put(`${prefix}${file.path}`, file.bytes, contentTypeOf(file.path), CACHE_CONTROL, signal);
  const others = files.filter((f) => !isPage(f.path));
  const pages = files.filter((f) => isPage(f.path));
  for (const group of [others, pages]) {
    for (let at = 0; at < group.length; at += PUT_CONCURRENCY) {
      await bounded((_, signal) => Promise.all(group.slice(at, at + PUT_CONCURRENCY).map((file) => putOne(file, signal))));
    }
  }
}

/**
 * Handles one deploy message, delivered for the `receiveCount`-th time. Resolves when the message is
 * done with (published, failed, dropped); throws a bare error when SQS should deliver it again.
 * `deadlineMs` (epoch ms, on the `deps.now` clock) is when the Lambda stops: now plus its remaining time.
 */
export async function processDeploy(
  body: string | undefined,
  receiveCount: number,
  deps: DeployDeps,
  deadlineMs: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  const started = deps.now().getTime();
  const bounded: Bounded = (work) => {
    const left = deadlineMs - deps.now().getTime() - DEPLOY_RESERVE_MS;
    if (!(left > 0)) return Promise.reject(new DeployTimeUp());
    return within((signal) => work(left, signal), left);
  };
  const log = (entry: Omit<DeployLogEntry, "event" | "durationMs">): void =>
    deps.log({ event: "deployer", ...entry, durationMs: Math.max(0, deps.now().getTime() - started) });
  const nowIso = (): string => deps.now().toISOString();

  const job = parseDeployJob(body);
  if (job === undefined) {
    const refresh = parseRefreshJob(body);
    if (refresh !== undefined) return refreshDataClient(refresh.nickname, receiveCount, deps, bounded, log);
    log({ outcome: "invalid" });
    return;
  }

  const nickname = job.nickname.toLowerCase();
  const prefix = `${APPS_KEY_PREFIX}${nickname}/`;
  // Set once the build is known to be this app's and deployable: only then may a failure be recorded on it.
  let claimed = false;
  try {
    // Not bounded: a short table call (the client's own timeouts), and nothing may be recorded before it.
    if (!(await deps.records.startDeploy(job.buildId, job.nickname, job.commit, nowIso()))) {
      log({ outcome: "no-build" });
      return;
    }
    claimed = true;

    let files: AppFile[];
    try {
      // The download's own time limit ends a second after the phase's, so a cut-off reads as the deploy's time running out.
      const archive = await bounded((ms, signal) => deps.download(appMainArchiveUrl(job.nickname), Math.min(DOWNLOAD_TIMEOUT_MS, ms + 1000), signal));
      const unpacked = readTarGzArchive(archive);
      if (unpacked.commit === undefined) throw new DownloadProblem(NO_COMMIT_REASON, false);
      // Another commit: main moved on, or codeload served its copy from before the push. Retried, never published.
      if (unpacked.commit !== job.commit) throw new DownloadProblem(MAIN_MOVED_REASON, true);
      // Ticket 3.25: the platform's data client, whatever the repository holds; the check then sees what is published.
      files = withPlatformDataClient(unpacked.files, deps.dataClient);
    } catch (error) {
      const reason = error instanceof ArchiveProblem || (error instanceof DownloadProblem && !error.passing) ? error.reason : undefined;
      if (reason === undefined) throw error;
      const marked = await deps.records.markFailed(job.buildId, [storedReason(reason)], nowIso());
      log({ outcome: marked ? "failed" : "no-build", problems: 1 });
      return;
    }

    const result = checkApp(files);
    const published = files.filter((file) => file.kind === "file");
    if (!result.ok) {
      const marked = await deps.records.markFailed(job.buildId, storedReasons(result.problems), nowIso());
      log({ outcome: marked ? "failed" : "no-build", files: published.length, bytes: result.totalBytes, problems: result.problems.length });
      return;
    }

    await putAll(published, prefix, deps.objects, bounded);
    const keep = new Set(published.map((file) => `${prefix}${file.path}`));
    const stale = (await bounded((_, signal) => deps.objects.list(prefix, signal))).filter((key) => key.startsWith(prefix) && !keep.has(key));
    if (stale.length > 0) await bounded((_, signal) => deps.objects.remove(stale, signal));
    await bounded((_, signal) => deps.cdn.invalidate([`/${prefix}*`], `${job.buildId}-${deps.now().getTime()}`, signal));
    // The marker before the build: when the build's write then fails, the build stays `deploying`, so a redelivery
    // does it all again (and the last one marks it failed) while the marker truly says the app's files are served.
    // The other order could leave a live build with no marker, which no redelivery repairs (the build is no longer
    // deploying) and which keeps the app's data API answering 404.
    await bounded((_, signal) => deps.records.markAppLive(job.nickname, nowIso(), signal));
    const marked = await bounded((_, signal) => deps.records.markLive(job.buildId, job.commit, nowIso(), signal));
    // Not marked: the build stopped being `deploying` meanwhile (another writer finished it); it is left as it is.
    log({ outcome: marked ? "live" : "no-build", files: published.length, bytes: result.totalBytes, removed: stale.length });
  } catch (error) {
    const name = errorName(error);
    if (receiveCount < DEPLOY_MAX_RECEIVES) {
      log({ outcome: "retry", error: name });
      // Deliberately no cause: the Lambda runtime would log its message (keys, nicknames).
      // eslint-disable-next-line preserve-caught-error
      throw new Error(DEPLOY_FAILED);
    }
    if (!claimed) {
      // The build was never checked: leave it alone; the message goes to the dead-letter queue.
      log({ outcome: "dead-letter", error: name });
      // eslint-disable-next-line preserve-caught-error -- no cause, as above
      throw new Error(DEPLOY_FAILED);
    }
    const reason = error instanceof DeployTimeUp ? TIME_UP_REASON : error instanceof DownloadProblem ? storedReason(error.reason) : SERVICE_PROBLEM_REASON;
    // A failure here goes no further than its name either (the message then reaches the dead-letter queue).
    // true: recorded; false: the build was finished meanwhile (nothing written); undefined: the write failed.
    const recorded = await deps.records.markFailed(job.buildId, [reason], nowIso()).then(
      (marked) => marked,
      () => undefined,
    );
    log({ outcome: recorded === undefined ? "dead-letter" : recorded ? "gave-up" : "no-build", error: name });
    // eslint-disable-next-line preserve-caught-error -- no cause, as above
    if (recorded === undefined) throw new Error(DEPLOY_FAILED);
  }
}

/**
 * Ticket 3.25 (question 10): puts the platform's workshop-data.js into an app already published and invalidates it on
 * CloudFront; nothing else of the app changes, and no record is written. An app is published when its `index.html` is
 * under its prefix (the deployer puts it last). A failure throws, so SQS delivers the message again; after the last
 * delivery it goes to the dead-letter queue (`npm run apps -- refresh` can simply run again).
 */
async function refreshDataClient(
  nickname: string,
  receiveCount: number,
  deps: DeployDeps,
  bounded: Bounded,
  log: (entry: Omit<DeployLogEntry, "event" | "durationMs">) => void,
): Promise<void> {
  const prefix = `${APPS_KEY_PREFIX}${nickname.toLowerCase()}/`;
  try {
    const keys = await bounded((_, signal) => deps.objects.list(prefix, signal));
    if (!keys.includes(`${prefix}index.html`)) {
      log({ outcome: "not-published" });
      return;
    }
    await bounded((_, signal) => deps.objects.put(`${prefix}${DATA_CLIENT_PATH}`, deps.dataClient, contentTypeOf(DATA_CLIENT_PATH), CACHE_CONTROL, signal));
    await bounded((_, signal) => deps.cdn.invalidate([`/${prefix}${DATA_CLIENT_PATH}`], `refresh-${nickname.toLowerCase()}-${deps.now().getTime()}`, signal));
    log({ outcome: "refreshed", files: 1, bytes: deps.dataClient.byteLength });
  } catch (error) {
    log({ outcome: receiveCount < DEPLOY_MAX_RECEIVES ? "retry" : "dead-letter", error: errorName(error) });
    // Deliberately no cause, as for a deploy: the runtime would log its message.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(DEPLOY_FAILED);
  }
}
