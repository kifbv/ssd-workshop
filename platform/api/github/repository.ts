/**
 * The participant's repository (ticket 2.6): `ssd-<lower-cased nickname>` in the apps organization, public, whose
 * history starts with one commit holding the template and the approved spec (`SPEC.md`). A rebuild (after
 * `conversation reset`) reuses the repository and adds a commit on top of `main` holding the template and the new
 * spec. Also mints the builder's token: that one repository, contents write, at most one hour.
 *
 * Every commit is authored and committed by BUILDER_COMMIT_NAME <BUILDER_COMMIT_EMAIL> with a fixed message: no
 * participant's email address or text ever goes into a commit's metadata (the spec only goes into SPEC.md).
 */
import { createHash } from "node:crypto";
import { NICKNAME_PATTERN } from "../participant/participant.js";
import {
  APPS_DEFAULT_BRANCH,
  APPS_GITHUB_OWNER,
  BUILDER_COMMIT_EMAIL,
  BUILDER_COMMIT_NAME,
  appRepositoryName,
} from "../settings.js";
import {
  appJwt,
  expectStatus,
  findInstallation,
  githubCall,
  GitHubProblem,
  mintInstallationToken,
  type AppCredentials,
  type GitHubAnswer,
  type GitHubDeps,
  type GitHubStep,
  type InstallationToken,
} from "./app.js";

/** A file of the repository's tree: its path (`/` between folders) and its bytes. */
export interface RepositoryFile {
  path: string;
  bytes: Uint8Array;
}

export const SPEC_FILE = "SPEC.md";
/** Message of the history's first commit (a new repository). */
export const FIRST_COMMIT_MESSAGE = "Start from the workshop template and the approved spec";
/** Message of a rebuild's starting commit (the repository existed). */
export const REBUILD_COMMIT_MESSAGE = "Start again from the workshop template and the newly approved spec";
/**
 * Message of the one-file commit that opens an empty repository (GitHub's Git Data API refuses an empty one). When
 * it opened an empty repository it is replaced at once by the parentless first commit; when it landed on top of
 * history (GitHub's brief 404), it stays below the rebuild commit (decision "(2.6) Opening commit checked").
 */
export const BOOTSTRAP_MESSAGE = "Open the repository for the workshop";
export const BOOTSTRAP_FILE = "README.md";
export const BOOTSTRAP_TEXT = "This repository is being prepared by the SSD Workshop.\n";
export const REPOSITORY_DESCRIPTION = "An app made at the SSD Workshop";

/** Author and committer of every commit: the builder's fixed identity. */
export const COMMIT_IDENTITY = { name: BUILDER_COMMIT_NAME, email: BUILDER_COMMIT_EMAIL } as const;

/** The repository name for a nickname, after checking it against the 1.5 rules (also a valid GitHub name). */
export function repositoryNameFor(nickname: string): string {
  if (!NICKNAME_PATTERN.test(nickname)) throw new GitHubProblem("The nickname does not follow the workshop's rules.");
  return appRepositoryName(nickname);
}

/** The template's files with SPEC.md replaced whole by the approved spec (decision "(2.3) Template app"). */
export function withSpec(templateFiles: readonly RepositoryFile[], spec: string): RepositoryFile[] {
  return [
    ...templateFiles.filter((file) => file.path !== SPEC_FILE),
    { path: SPEC_FILE, bytes: new TextEncoder().encode(spec) },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The body of a Git Data API commit: fixed identity and message, the given tree and parents. */
export function commitRequest(message: string, tree: string, parents: readonly string[], now: Date): Record<string, unknown> {
  const date = now.toISOString();
  return {
    message,
    tree,
    parents: [...parents],
    author: { ...COMMIT_IDENTITY, date },
    committer: { ...COMMIT_IDENTITY, date },
  };
}

/** Rights the platform asks for when it creates or looks up a repository (any repository of the organization). */
export const ADMIN_PERMISSIONS = { administration: "write" } as const;
/** Rights of a token limited to one repository: its files and history only. */
export const CONTENTS_PERMISSIONS = { contents: "write" } as const;

/** True when the token grants `right: write` and nothing else but `metadata: read` (GitHub adds it to every token). */
function grantsOnly(token: InstallationToken, right: string): boolean {
  return (
    token.permissions[right] === "write" &&
    Object.entries(token.permissions).every(([key, value]) => (key === right && value === "write") || (key === "metadata" && value === "read"))
  );
}

/**
 * The organization-wide token that creates or finds the repository: GitHub's answer must grant only
 * `administration: write` (plus `metadata: read`). It reaches every repository of the organization, so it stays in
 * the process that asked for it (from 2.9, the launcher) and is never handed on.
 */
async function adminToken(deps: GitHubDeps, jwt: string, installationId: number): Promise<InstallationToken> {
  const token = await mintInstallationToken(deps, jwt, installationId, { permissions: { ...ADMIN_PERMISSIONS } });
  if (!grantsOnly(token, "administration")) {
    throw new GitHubProblem("GitHub's token grants more than administration write (or not that), so it was not used.");
  }
  return token;
}

/**
 * A token for exactly one repository with contents write: GitHub's answer must say `selected`, list only that
 * repository and grant only `contents: write` (plus `metadata: read`, which GitHub adds to every token).
 */
async function repositoryToken(deps: GitHubDeps, jwt: string, installationId: number, name: string): Promise<InstallationToken> {
  const token = await mintInstallationToken(deps, jwt, installationId, { repositories: [name], permissions: { ...CONTENTS_PERMISSIONS } });
  const fullName = `${APPS_GITHUB_OWNER}/${name}`.toLowerCase();
  const repositories = token.repositories ?? [];
  if (
    token.repositorySelection !== "selected" ||
    repositories.length !== 1 ||
    repositories[0]?.toLowerCase() !== fullName ||
    !grantsOnly(token, "contents")
  ) {
    throw new GitHubProblem("GitHub's token reaches more than the one repository with contents write, so it was not used.");
  }
  return token;
}

/** The builder's token (ticket 2.8 uses it to push): one repository, contents write, expiring within an hour. */
export interface BuilderToken {
  token: string;
  expiresAt: string;
  /** `owner/name`. */
  repository: string;
}

export async function builderToken(credentials: AppCredentials, nickname: string, deps: GitHubDeps): Promise<BuilderToken> {
  const name = repositoryNameFor(nickname);
  const jwt = appJwt(credentials, deps.now());
  const installation = await findInstallation(deps, jwt);
  const token = await repositoryToken(deps, jwt, installation.id, name);
  return { token: token.token, expiresAt: token.expiresAt, repository: `${APPS_GITHUB_OWNER}/${name}` };
}

export interface PreparedRepository {
  /** `owner/name`. */
  repository: string;
  /** True when this call created the repository. */
  created: boolean;
  /** The commit `main` now points at: the template and the approved spec. */
  commit: string;
}

interface RepositoryFacts {
  defaultBranch: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A Git object id as GitHub gives it: 40 lower-case hex digits (SHA-1). Anything else never goes into a path. */
export const GIT_ID_PATTERN = /^[0-9a-f]{40}$/;

/** The id at `value`, checked against GIT_ID_PATTERN; fails plainly naming the step otherwise. */
function gitId(value: unknown, step: GitHubStep): string {
  const id = text(value);
  if (id === undefined || !GIT_ID_PATTERN.test(id)) throw new GitHubProblem(`GitHub's answer to the step "${step}" holds no valid id.`);
  return id;
}

/** Git's id of a blob holding `bytes` (`blob <size>\0<bytes>`), as a tree lists it. */
function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
const BOOTSTRAP_BLOB_ID = gitBlobId(new TextEncoder().encode(BOOTSTRAP_TEXT));

/**
 * Waits before each further try of a step GitHub answered 404 or 409 (right after a repository is created or
 * opened, GitHub briefly answers so while it settles): at most RETRY_WAITS_MS.length + 1 tries in all.
 */
export const RETRY_WAITS_MS = [1000, 2000] as const;
const RETRIED_STATUSES = new Set([404, 409]);
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls GitHub, trying again after a 404 or 409 (never after any other status: an authorization refusal or a 422
 * is final) until the waits run out or the caller's signal aborts; then returns the last answer for the caller to
 * check.
 */
async function withRetry(deps: GitHubDeps, call: () => Promise<GitHubAnswer>): Promise<GitHubAnswer> {
  const aborted = (): boolean => deps.signal?.aborted === true;
  let answer = await call();
  for (const wait of RETRY_WAITS_MS) {
    if (!RETRIED_STATUSES.has(answer.status) || aborted()) return answer;
    await (deps.sleep ?? realSleep)(wait);
    if (aborted()) return answer;
    answer = await call();
  }
  return answer;
}

/** Checks GitHub's description of the repository: in the organization, the expected name, public. */
function checkRepository(json: Record<string, unknown>, name: string): RepositoryFacts {
  const owner = text(record(json.owner).login);
  if (owner?.toLowerCase() !== APPS_GITHUB_OWNER.toLowerCase() || text(json.name)?.toLowerCase() !== name) {
    throw new GitHubProblem(`GitHub's answer names another repository than the app's in ${APPS_GITHUB_OWNER}.`);
  }
  if (json.private !== false) {
    throw new GitHubProblem("The app's repository is not public; make it public in GitHub or delete it, then try again.");
  }
  return { defaultBranch: text(json.default_branch) ?? APPS_DEFAULT_BRANCH };
}

/** Creates the public repository, or finds it when it already exists (GitHub answers 422 to a taken name). */
async function createOrFindRepository(deps: GitHubDeps, adminToken: string, name: string): Promise<{ created: boolean; facts: RepositoryFacts }> {
  const created = await githubCall(deps, "create-repository", "POST", `/orgs/${APPS_GITHUB_OWNER}/repos`, adminToken, {
    name,
    description: REPOSITORY_DESCRIPTION,
    visibility: "public",
    private: false,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    auto_init: false,
  });
  if (created.status === 201) return { created: true, facts: checkRepository(created.json, name) };
  if (created.status !== 422) expectStatus(created, "create-repository", 201);
  // 422: most often "name already exists on this account" (a rebuild). Any other refusal shows as a 404 here.
  const found = await githubCall(deps, "get-repository", "GET", `/repos/${APPS_GITHUB_OWNER}/${name}`, adminToken);
  if (found.status === 404) throw new GitHubProblem('GitHub refused to create the repository (422) and it does not exist.', 422);
  return { created: false, facts: checkRepository(expectStatus(found, "get-repository", 200), name) };
}

/**
 * Makes the repository hold the template and the approved spec on `main`:
 *
 * - new or empty repository: one Contents API commit opens it (GitHub's Git Data API answers 409 "Git Repository
 *   is empty" otherwise), then a parentless commit holding exactly the template and SPEC.md replaces it, so the
 *   history's first commit is that one;
 * - existing repository (a rebuild): a commit on top of `main` whose tree is the template and the new SPEC.md (a
 *   rebuild starts from the template, decision "(2.6) Rebuild").
 *
 * A repository whose `main` still points at the opening commit alone (an earlier try stopped half-way) is treated
 * as new. Only a commit known to have no parent (the opening commit as GitHub answered it, or that leftover) is
 * ever replaced by force; anything else gets the new commit on top, so no earlier history leaves `main`.
 */
export async function prepareRepository(
  input: { credentials: AppCredentials; nickname: string; spec: string; templateFiles: readonly RepositoryFile[] },
  deps: GitHubDeps,
): Promise<PreparedRepository> {
  const name = repositoryNameFor(input.nickname);
  const files = withSpec(input.templateFiles, input.spec);
  const jwt = appJwt(input.credentials, deps.now());
  const installation = await findInstallation(deps, jwt);
  const admin = await adminToken(deps, jwt, installation.id);
  const { created, facts } = await createOrFindRepository(deps, admin.token, name);
  if (facts.defaultBranch !== APPS_DEFAULT_BRANCH) {
    throw new GitHubProblem(`The app's repository's default branch is not ${APPS_DEFAULT_BRANCH}; set the organization's default branch to ${APPS_DEFAULT_BRANCH}.`);
  }
  const { token } = await repositoryToken(deps, jwt, installation.id, name);
  const repo = `/repos/${APPS_GITHUB_OWNER}/${name}`;
  const once = (step: GitHubStep, method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown) =>
    githubCall(deps, step, method, `${repo}${path}`, token, body);
  // Every step after `get-branch` is tried again on GitHub's brief 404 or 409 (decision "(2.6) Retry").
  const call = (step: GitHubStep, method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown) =>
    withRetry(deps, () => once(step, method, path, body));

  // Where `main` stands: 409 (empty) or 404 (no main yet) means the repository must be opened first. Not retried:
  // its 404 or 409 is the expected answer for an empty repository (but may also be GitHub's brief 404, see below).
  const branch = await once("get-branch", "GET", `/git/ref/heads/${APPS_DEFAULT_BRANCH}`);
  if (branch.status !== 200 && branch.status !== 404 && branch.status !== 409) expectStatus(branch, "get-branch", 200);
  let head = branch.status === 200 ? gitId(record(branch.json.object).sha, "get-branch") : undefined;
  // The parents of the commit written below: none for a first commit (forced over the opening one), else `head`.
  let parents: string[];
  if (head === undefined) {
    const opened = await call("bootstrap", "PUT", `/contents/${BOOTSTRAP_FILE}`, {
      message: BOOTSTRAP_MESSAGE,
      content: Buffer.from(BOOTSTRAP_TEXT).toString("base64"),
      author: { ...COMMIT_IDENTITY },
      committer: { ...COMMIT_IDENTITY },
    });
    if (opened.status === 422) {
      // README.md is there already (GitHub asks for its blob id): the repository is not empty and get-branch's 404 was
      // GitHub's brief one. Read `main` again, this time with retries (decision "(2.6) Opening refused").
      const again = expectStatus(await call("get-branch", "GET", `/git/ref/heads/${APPS_DEFAULT_BRANCH}`), "get-branch", 200);
      head = gitId(record(again.object).sha, "get-branch");
      parents = (await isLoneOpeningCommit(head, call)) ? [] : [head];
    } else {
      // GitHub puts the opening commit on top of `main` when `main` exists: only a parentless one opened an empty
      // repository and may be replaced; otherwise it is the head of a rebuild (decision "(2.6) Opening commit checked").
      const commit = record(expectStatus(opened, "bootstrap", 201).commit);
      const opening = gitId(commit.sha, "bootstrap");
      if (!Array.isArray(commit.parents)) throw new GitHubProblem('GitHub\'s answer to the step "bootstrap" holds no list of parents.');
      parents = commit.parents.length === 0 ? [] : [opening];
    }
  } else {
    parents = (await isLoneOpeningCommit(head, call)) ? [] : [head];
  }

  const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const file of files) {
    const blob = expectStatus(
      await call("blob", "POST", "/git/blobs", { content: Buffer.from(file.bytes).toString("base64"), encoding: "base64" }),
      "blob",
      201,
    );
    const sha = gitId(blob.sha, "blob");
    entries.push({ path: file.path, mode: "100644", type: "blob", sha });
  }
  // No base_tree: the tree is exactly the template and the spec.
  const tree = gitId(expectStatus(await call("tree", "POST", "/git/trees", { tree: entries }), "tree", 201).sha, "tree");
  const message = parents.length === 0 ? FIRST_COMMIT_MESSAGE : REBUILD_COMMIT_MESSAGE;
  const commit = gitId(
    expectStatus(await call("commit", "POST", "/git/commits", commitRequest(message, tree, parents, deps.now())), "commit", 201).sha,
    "commit",
  );
  // A first commit replaces the opening one (force); a rebuild's commit moves `main` forward only.
  expectStatus(await call("update-branch", "PATCH", `/git/refs/heads/${APPS_DEFAULT_BRANCH}`, { sha: commit, force: parents.length === 0 }), "update-branch", 200);
  return { repository: `${APPS_GITHUB_OWNER}/${name}`, created, commit };
}

/**
 * True only for the platform's own opening commit left alone on `main` (an earlier try stopped half-way): no
 * parent, the opening message, and a tree of exactly BOOTSTRAP_FILE holding BOOTSTRAP_TEXT. Anything else with
 * that message (other files, other text) is kept as history: the new commit goes on top of it, never forced
 * (decision "(2.6) Leftover opening commit").
 */
async function isLoneOpeningCommit(
  head: string,
  call: (step: GitHubStep, method: "GET", path: string) => Promise<GitHubAnswer>,
): Promise<boolean> {
  const commit = expectStatus(await call("get-commit", "GET", `/git/commits/${head}`), "get-commit", 200);
  // Fail safe: an answer without a parents list is not taken for a parentless commit.
  if (text(commit.message)?.trim() !== BOOTSTRAP_MESSAGE || !Array.isArray(commit.parents) || commit.parents.length !== 0) return false;
  const treeId = gitId(record(commit.tree).sha, "get-commit");
  const tree = expectStatus(await call("get-tree", "GET", `/git/trees/${treeId}`), "get-tree", 200);
  const entries = Array.isArray(tree.tree) ? tree.tree.map(record) : [];
  const [only] = entries;
  return (
    tree.truncated !== true &&
    entries.length === 1 &&
    only !== undefined &&
    only.path === BOOTSTRAP_FILE &&
    only.type === "blob" &&
    only.mode === "100644" &&
    only.sha === BOOTSTRAP_BLOB_ID
  );
}
