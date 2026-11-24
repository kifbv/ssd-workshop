/**
 * Downloads an app's tarball from GitHub (ticket 2.5). The repositories are public, so the download is
 * anonymous (ticket 2.6 may add a token). The body is read as a stream and dropped past
 * MAX_DOWNLOAD_BYTES; the whole download has a time limit.
 *
 * Before the download, the deployer asks GitHub (anonymously, the repositories are public) whether the commit is on
 * the app repository's own `main` (`compareWithMain`, ticket 2.8 try 2): GitHub serves a commit of any fork in the
 * repository's network through the parent's archive address, so the commit id alone does not prove where it is.
 */
import { APPS_GITHUB_OWNER, GITHUB_API_URL, GITHUB_API_VERSION, GITHUB_USER_AGENT, appRepositoryName } from "../settings.js";
import { DOWNLOAD_TIMEOUT_MS, DownloadProblem } from "./deploy.js";

export { DOWNLOAD_TIMEOUT_MS };

const MB = 1024 * 1024;

/** At most this much is downloaded: an app holds at most 5 MB, and compressed text is smaller still. */
export const MAX_DOWNLOAD_BYTES = 10 * MB;

const TOO_BIG = `The repository's download is over ${MAX_DOWNLOAD_BYTES / MB} MB, so nothing was published.`;
const UNREACHABLE = "GitHub could not be reached to download the commit.";

export interface DownloadOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Stops the download when aborted (the deployer's phase deadline), like the time limit. */
  signal?: AbortSignal;
}

export async function downloadArchive(url: string, options: DownloadOptions = {}): Promise<Uint8Array> {
  const fetchFn = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  let response: Response;
  try {
    response = await fetchFn(url, { signal, redirect: "follow" });
  } catch {
    throw new DownloadProblem(UNREACHABLE, true);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new DownloadProblem(`GitHub answered ${response.status} to the download of the commit; check that the repository and the commit exist.`, true);
  }
  const announced = Number(response.headers.get("content-length") ?? "0");
  if (announced > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new DownloadProblem(TOO_BIG, false);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  try {
    for (;;) {
      const next = reader ? await reader.read() : { done: true as const, value: undefined };
      if (next.done) break;
      total += next.value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader?.cancel().catch(() => undefined);
        throw new DownloadProblem(TOO_BIG, false);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof DownloadProblem) throw error;
    throw new DownloadProblem(UNREACHABLE, true);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** GitHub's compare of the app's `main` with the commit (one commit per page: only the status is read). */
export const compareUrl = (nickname: string, commit: string): string =>
  `${GITHUB_API_URL}/repos/${APPS_GITHUB_OWNER}/${appRepositoryName(nickname)}/compare/main...${commit}?per_page=1`;

const COMPARE_FAILED = "GitHub could not tell whether the commit is on the app's main branch.";

/**
 * Where the commit stands against the app repository's `main`: GitHub's `status` (`identical`: main is the commit;
 * `behind`: main holds it; `ahead`, `diverged`: it is not on main), or `not-found` when GitHub answers 404 (no such
 * repository or commit in it). Any other answer, one without a status, or no answer is a passing DownloadProblem
 * (SQS delivers the message again). `commit` must already be 40 hex digits (parseDeployJob).
 */
export async function compareWithMain(nickname: string, commit: string, options: DownloadOptions = {}): Promise<string> {
  const fetchFn = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  let response: Response;
  try {
    response = await fetchFn(compareUrl(nickname, commit), {
      headers: { accept: "application/vnd.github+json", "user-agent": GITHUB_USER_AGENT, "x-github-api-version": GITHUB_API_VERSION },
      redirect: "error",
      signal,
    });
  } catch {
    throw new DownloadProblem(COMPARE_FAILED, true);
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return "not-found";
  }
  let body: unknown;
  try {
    body = response.status === 200 ? await response.json() : undefined;
  } catch {
    body = undefined;
  }
  if (response.status !== 200) await response.body?.cancel().catch(() => undefined);
  const status = body !== null && typeof body === "object" ? (body as { status?: unknown }).status : undefined;
  if (typeof status !== "string" || status === "") throw new DownloadProblem(COMPARE_FAILED, true);
  return status;
}
