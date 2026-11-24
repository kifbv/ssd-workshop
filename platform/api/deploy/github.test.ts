import { describe, expect, it } from "vitest";
import { DownloadProblem } from "./deploy.js";
import { MAX_DOWNLOAD_BYTES, downloadArchive } from "./github.js";

const URL_ = "https://codeload.github.com/ssd-workshop-apps/ssd-ada/tar.gz/0123456789abcdef0123456789abcdef01234567";

function streamOf(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      onPull?.();
      const chunk = chunks[at];
      at += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

const problemOf = async (work: Promise<unknown>): Promise<DownloadProblem> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DownloadProblem) return error;
    throw error;
  }
  throw new Error("no problem raised");
};

describe("downloadArchive (ticket 2.5)", () => {
  it("fetches the address anonymously (no token, no cookie) with a time limit and returns the bytes", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const bytes = await downloadArchive(URL_, {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), { status: 200 });
      },
    });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[0]?.init?.redirect).toBe("follow");
  });

  it("stops when the deployer's signal is aborted (its phase's time is up), as a passing problem", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const work = downloadArchive(URL_, {
      signal: controller.signal,
      fetch: (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) => seen?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    });
    expect(seen?.aborted).toBe(false);
    controller.abort();
    const problem = await problemOf(work);
    expect(seen?.aborted).toBe(true);
    expect(problem.passing).toBe(true);
  });

  it("is a passing problem when GitHub answers with an error or cannot be reached", async () => {
    const answered = await problemOf(downloadArchive(URL_, { fetch: async () => new Response("nope", { status: 404 }) }));
    expect(answered.passing).toBe(true);
    expect(answered.reason).toBe("GitHub answered 404 to the download of the commit; check that the repository and the commit exist.");
    const unreachable = await problemOf(
      downloadArchive(URL_, {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(unreachable.passing).toBe(true);
    expect(unreachable.reason).toBe("GitHub could not be reached to download the commit.");
  });

  it("stops reading past the size limit, and fails the build at once (not a passing problem)", async () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(10 * 1024 * 1024);
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const problem = await problemOf(
      downloadArchive(URL_, { fetch: async () => new Response(streamOf(Array.from({ length: 50 }, () => chunk), () => (pulls += 1)), { status: 200 }) }),
    );
    expect(problem.passing).toBe(false);
    expect(problem.reason).toBe("The repository's download is over 10 MB, so nothing was published.");
    expect(pulls).toBeLessThan(15);
  });

  it("refuses at once an answer whose announced length is over the limit", async () => {
    // The body is 1 byte: only the announced length can fail it.
    const problem = await problemOf(
      downloadArchive(URL_, {
        fetch: async () =>
          new Response(streamOf([new Uint8Array(1)]), { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } }),
      }),
    );
    expect(problem.passing).toBe(false);
    expect(problem.reason).toMatch(/over 10 MB/);
  });

  it("gives up after the time limit", async () => {
    const problem = await problemOf(
      downloadArchive(URL_, {
        timeoutMs: 20,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
          }),
      }),
    );
    expect(problem.passing).toBe(true);
    expect(problem.reason).toBe("GitHub could not be reached to download the commit.");
  });
});
