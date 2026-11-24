/**
 * Downloads an app's tarball from GitHub (ticket 2.5). The repositories are public, so the download is
 * anonymous (ticket 2.6 may add a token). The body is read as a stream and dropped past
 * MAX_DOWNLOAD_BYTES; the whole download has a time limit.
 */
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
