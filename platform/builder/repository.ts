/**
 * The builder's GitHub work (ticket 2.8), with the build's one-repository token (`builderToken`, ticket 2.6):
 *
 * - "clone": reads `main`'s commit (Git Data API) and downloads the public repository's tarball at that commit (the
 *   deployer's size-capped download and in-memory tar reader), so no git binary is needed;
 * - commits: pushes the agent's work as a few commits through the Git Data API (blobs, a full tree, a commit per
 *   group), each authored and committed by the builder's fixed identity with a fixed message, then moves `main`
 *   forward (never forced) to the last one. The last commit's id, from GitHub's answer, is the build's `pushedCommit`.
 *
 * The token goes only into the `authorization` header; nothing here logs it, a path or a file name.
 */
import { createHash } from "node:crypto";
import { expectStatus, githubCall, GitHubProblem, type GitHubDeps, type GitHubStep } from "../api/github/app.js";
import { commitRequest, GIT_ID_PATTERN, repositoryNameFor, withRetry, type RepositoryFile } from "../api/github/repository.js";
import { APPS_DEFAULT_BRANCH, APPS_GITHUB_OWNER } from "../api/settings.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function gitId(value: unknown, step: GitHubStep): string {
  if (typeof value !== "string" || !GIT_ID_PATTERN.test(value)) throw new GitHubProblem(`GitHub's answer to the step "${step}" holds no valid id.`);
  return value;
}

type Method = "GET" | "POST" | "PATCH";

function caller(deps: GitHubDeps, token: string, nickname: string) {
  const repo = `/repos/${APPS_GITHUB_OWNER}/${repositoryNameFor(nickname)}`;
  return (step: GitHubStep, method: Method, path: string, body?: unknown) => withRetry(deps, () => githubCall(deps, step, method, `${repo}${path}`, token, body));
}

/** The commit `main` points at (retried on GitHub's brief 404 or 409 right after the launcher prepared it). */
export async function readMain(deps: GitHubDeps, token: string, nickname: string): Promise<string> {
  const call = caller(deps, token, nickname);
  const answer = expectStatus(await call("get-branch", "GET", `/git/ref/heads/${APPS_DEFAULT_BRANCH}`), "get-branch", 200);
  return gitId(record(answer.object).sha, "get-branch");
}

/** One commit to make: a fixed message and the whole tree it holds. */
export interface PlannedCommit {
  message: string;
  files: readonly RepositoryFile[];
}

/** A commit as pushed: GitHub's id and its message. */
export interface PushedCommit {
  sha: string;
  message: string;
}

const contentKey = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Writes the commits one on top of the other, starting from `parent` (the `main` the build started from), then moves
 * `main` to the last one, fast-forward only: a `main` that moved meanwhile makes GitHub refuse (422) and the build
 * fails rather than losing someone's commit. Blobs are uploaded once per distinct content.
 */
export async function pushCommits(
  deps: GitHubDeps,
  token: string,
  nickname: string,
  parent: string,
  commits: readonly PlannedCommit[],
): Promise<PushedCommit[]> {
  if (commits.length === 0) throw new GitHubProblem("There is nothing to commit.");
  const call = caller(deps, token, nickname);
  const blobs = new Map<string, string>();
  const pushed: PushedCommit[] = [];
  let head = parent;
  for (const planned of commits) {
    const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    for (const file of [...planned.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const key = contentKey(file.bytes);
      let sha = blobs.get(key);
      if (sha === undefined) {
        const blob = expectStatus(await call("blob", "POST", "/git/blobs", { content: Buffer.from(file.bytes).toString("base64"), encoding: "base64" }), "blob", 201);
        sha = gitId(blob.sha, "blob");
        blobs.set(key, sha);
      }
      entries.push({ path: file.path, mode: "100644", type: "blob", sha });
    }
    // No base_tree: each commit's tree is exactly its files.
    const tree = gitId(expectStatus(await call("tree", "POST", "/git/trees", { tree: entries }), "tree", 201).sha, "tree");
    const commit = gitId(
      expectStatus(await call("commit", "POST", "/git/commits", commitRequest(planned.message, tree, [head], deps.now())), "commit", 201).sha,
      "commit",
    );
    pushed.push({ sha: commit, message: planned.message });
    head = commit;
  }
  expectStatus(await call("update-branch", "PATCH", `/git/refs/heads/${APPS_DEFAULT_BRANCH}`, { sha: head, force: false }), "update-branch", 200);
  return pushed;
}

/** Messages of the builder's commits (fixed text: nothing from the participant reaches a commit's metadata). */
export const PAGE_COMMIT_MESSAGE = "Build the app's page and its look (HTML, CSS and images)";
export const BEHAVIOUR_COMMIT_MESSAGE = "Add what the app does (JavaScript) and update its notes";
export const SINGLE_COMMIT_MESSAGE = "Build the app from the approved spec";

/** Files of the first commit: the page's structure and look (everything but scripts, data and notes). */
const isBehaviour = (path: string): boolean => /\.(js|json|md|txt)$/i.test(path);

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * The agent's work as commits on top of `base` (the files the build started from): first the page and its look
 * (`.html`, `.css`, images, fonts), then the behaviour and notes (`.js`, `.json`, `.md`, `.txt`), each commit holding
 * the whole app as it then stood; one commit when only one group changed; none when nothing changed. A file the
 * agent removed (it cannot) would leave with the last commit.
 */
export function planCommits(base: readonly RepositoryFile[], final: readonly RepositoryFile[]): PlannedCommit[] {
  const before = new Map(base.map((file) => [file.path, file.bytes]));
  const changed = final.filter((file) => !sameBytes(before.get(file.path), file.bytes));
  const removed = base.some((file) => !final.some((f) => f.path === file.path));
  if (changed.length === 0 && !removed) return [];
  const page = changed.filter((file) => !isBehaviour(file.path));
  const behaviour = changed.filter((file) => isBehaviour(file.path));
  if (page.length === 0 || (behaviour.length === 0 && !removed)) return [{ message: SINGLE_COMMIT_MESSAGE, files: final }];
  const pagePaths = new Set(page.map((file) => file.path));
  const first = [...base.filter((file) => !pagePaths.has(file.path)), ...page];
  return [
    { message: PAGE_COMMIT_MESSAGE, files: first },
    { message: BEHAVIOUR_COMMIT_MESSAGE, files: final },
  ];
}
