/**
 * The participant's repository (ticket 2.6): `ssd-<lower-cased nickname>` in the apps organization, public, whose
 * history starts with one commit holding the template and the approved spec (`SPEC.md`). A rebuild (after
 * `conversation reset`) reuses the repository and adds a commit on top of `main` holding the template and the new
 * spec. Also mints the builder's token: that one repository, contents write, at most one hour.
 *
 * Every commit is authored and committed by BUILDER_COMMIT_NAME <BUILDER_COMMIT_EMAIL> with a fixed message: no
 * participant's email address or text ever goes into a commit's metadata (the spec only goes into SPEC.md).
 */
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
  type GitHubDeps,
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
 * Message of the one-file commit that opens an empty repository (GitHub's Git Data API refuses an empty one). It
 * is replaced at once by the parentless first commit, so it never shows in the history.
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

/**
 * A token for exactly one repository with contents write: GitHub's answer must say `selected`, list only that
 * repository and grant only `contents: write` (plus `metadata: read`, which GitHub adds to every token).
 */
async function repositoryToken(deps: GitHubDeps, jwt: string, installationId: number, name: string): Promise<InstallationToken> {
  const token = await mintInstallationToken(deps, jwt, installationId, { repositories: [name], permissions: { ...CONTENTS_PERMISSIONS } });
  const fullName = `${APPS_GITHUB_OWNER}/${name}`.toLowerCase();
  const repositories = token.repositories ?? [];
  const permissions = Object.entries(token.permissions);
  const permissionsOk =
    token.permissions.contents === "write" &&
    permissions.every(([key, value]) => (key === "contents" && value === "write") || (key === "metadata" && value === "read"));
  if (
    token.repositorySelection !== "selected" ||
    repositories.length !== 1 ||
    repositories[0]?.toLowerCase() !== fullName ||
    !permissionsOk
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
 * as new.
 */
export async function prepareRepository(
  input: { credentials: AppCredentials; nickname: string; spec: string; templateFiles: readonly RepositoryFile[] },
  deps: GitHubDeps,
): Promise<PreparedRepository> {
  const name = repositoryNameFor(input.nickname);
  const files = withSpec(input.templateFiles, input.spec);
  const jwt = appJwt(input.credentials, deps.now());
  const installation = await findInstallation(deps, jwt);
  const admin = await mintInstallationToken(deps, jwt, installation.id, { permissions: { ...ADMIN_PERMISSIONS } });
  const { created, facts } = await createOrFindRepository(deps, admin.token, name);
  if (facts.defaultBranch !== APPS_DEFAULT_BRANCH) {
    throw new GitHubProblem(`The app's repository's default branch is not ${APPS_DEFAULT_BRANCH}; set the organization's default branch to ${APPS_DEFAULT_BRANCH}.`);
  }
  const { token } = await repositoryToken(deps, jwt, installation.id, name);
  const repo = `/repos/${APPS_GITHUB_OWNER}/${name}`;
  const call = (step: Parameters<typeof githubCall>[1], method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown) =>
    githubCall(deps, step, method, `${repo}${path}`, token, body);

  // Where `main` stands: 409 (empty) or 404 (no main yet) means the repository must be opened first.
  let head: string | undefined;
  const branch = await call("get-branch", "GET", `/git/ref/heads/${APPS_DEFAULT_BRANCH}`);
  if (branch.status === 200) {
    head = text(record(branch.json.object).sha);
    if (head === undefined) throw new GitHubProblem('GitHub\'s answer to the step "get-branch" holds no commit.');
  } else if (branch.status !== 404 && branch.status !== 409) {
    expectStatus(branch, "get-branch", 200);
  }

  let fresh = head === undefined;
  if (head === undefined) {
    expectStatus(
      await call("bootstrap", "PUT", `/contents/${BOOTSTRAP_FILE}`, {
        message: BOOTSTRAP_MESSAGE,
        content: Buffer.from(BOOTSTRAP_TEXT).toString("base64"),
        author: { ...COMMIT_IDENTITY },
        committer: { ...COMMIT_IDENTITY },
      }),
      "bootstrap",
      201,
    );
  } else {
    const commit = expectStatus(await call("get-commit", "GET", `/git/commits/${head}`), "get-commit", 200);
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    if (text(commit.message)?.trim() === BOOTSTRAP_MESSAGE && parents.length === 0) fresh = true;
  }

  const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const file of files) {
    const blob = expectStatus(
      await call("blob", "POST", "/git/blobs", { content: Buffer.from(file.bytes).toString("base64"), encoding: "base64" }),
      "blob",
      201,
    );
    const sha = text(blob.sha);
    if (sha === undefined) throw new GitHubProblem('GitHub\'s answer to the step "blob" holds no id.');
    entries.push({ path: file.path, mode: "100644", type: "blob", sha });
  }
  // No base_tree: the tree is exactly the template and the spec.
  const tree = text(expectStatus(await call("tree", "POST", "/git/trees", { tree: entries }), "tree", 201).sha);
  if (tree === undefined) throw new GitHubProblem('GitHub\'s answer to the step "tree" holds no id.');
  const parents = fresh || head === undefined ? [] : [head];
  const message = parents.length === 0 ? FIRST_COMMIT_MESSAGE : REBUILD_COMMIT_MESSAGE;
  const commit = text(expectStatus(await call("commit", "POST", "/git/commits", commitRequest(message, tree, parents, deps.now())), "commit", 201).sha);
  if (commit === undefined) throw new GitHubProblem('GitHub\'s answer to the step "commit" holds no id.');
  // A first commit replaces the opening one (force); a rebuild's commit moves `main` forward only.
  expectStatus(await call("update-branch", "PATCH", `/git/refs/heads/${APPS_DEFAULT_BRANCH}`, { sha: commit, force: parents.length === 0 }), "update-branch", 200);
  return { repository: `${APPS_GITHUB_OWNER}/${name}`, created, commit };
}
