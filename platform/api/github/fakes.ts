// An in-memory GitHub for the GitHub module's tests (ticket 2.6; not bundled: no handler imports it). It answers the
// REST calls the module makes the way GitHub documents them, checks the app's JWT against the test key and every
// installation token's rights, and keeps repositories with their blobs, trees, commits and `main`.
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { githubTar, gzip } from "../deploy/tar-fixtures.js";
import { APPS_GITHUB_OWNER } from "../settings.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** The test app's private key as GitHub hands it out (PKCS#1 PEM). */
export const TEST_PRIVATE_KEY_PEM = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
export const TEST_APP_ID = "424242";
/** The secret's text as Franck loads it. */
export const TEST_SECRET_TEXT = JSON.stringify({ appId: TEST_APP_ID, privateKey: TEST_PRIVATE_KEY_PEM });
export const TEST_INSTALLATION_ID = 9001;
/** Every installation token the fake mints starts with this, so a test can look for it anywhere. */
export const FAKE_TOKEN_PREFIX = "ghs_FAKEINSTALLATIONTOKEN";

export interface FakeCommit {
  sha: string;
  message: string;
  tree: string;
  parents: string[];
  author: unknown;
  committer: unknown;
}

export interface FakeRepository {
  name: string;
  private: boolean;
  defaultBranch: string;
  blobs: Map<string, Uint8Array>;
  /** Tree id -> path -> blob id. */
  trees: Map<string, Map<string, string>>;
  commits: Map<string, FakeCommit>;
  main: string | undefined;
  /** The create request's body. */
  createdWith: Record<string, unknown> | undefined;
}

interface Grant {
  permissions: Record<string, string>;
  repositories: string[] | undefined;
}

export interface FakeCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

/** Counted across fakes, so every token a test file sees is distinct. */
let minted = 0;

const sha1 = (data: string | Uint8Array): string => createHash("sha1").update(data).digest("hex");
/** Git's id of a blob (`blob <size>\0<bytes>`), as GitHub reports it in trees. */
export const gitBlobSha = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export class FakeGitHub {
  readonly repositories = new Map<string, FakeRepository>();
  readonly calls: FakeCall[] = [];
  /** Every bearer the module sent (JWTs and tokens), for the "never logged" checks. */
  readonly bearers = new Set<string>();
  readonly grants = new Map<string, Grant>();
  /** Lifetime of minted tokens (GitHub: one hour). */
  tokenLifetimeMs = 60 * 60 * 1000;
  /** When set, the token answer reports these instead of what was asked (a misbehaving GitHub). */
  overrideTokenAnswer: Record<string, unknown> | undefined;
  /** Organization the installation reports. */
  installationAccount = APPS_GITHUB_OWNER;
  /** Default branch of repositories created from now on (the organization's setting). */
  defaultBranch = "main";

  constructor(private readonly now: () => Date) {}

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization") ?? undefined;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const method = init.method ?? "GET";
    this.calls.push({ method, path: parsed.pathname, authorization, body });
    if (authorization?.startsWith("Bearer ")) this.bearers.add(authorization.slice("Bearer ".length));
    if (parsed.origin === "https://codeload.github.com") return this.tarball(parsed.pathname);
    if (parsed.origin !== "https://api.github.com") return json(404, { message: "Not Found" });
    if (headers.get("x-github-api-version") !== "2022-11-28" || !headers.get("user-agent")) return json(400, { message: "Bad headers" });
    return this.route(method, parsed.pathname, authorization ?? "", body ?? {});
  };

  /**
   * GitHub's anonymous tarball download (`codeload.github.com/<owner>/<name>/tar.gz/<commit>`) of a public repository:
   * a gzip'd tar of the commit's files under one top folder, as the deployer and the builder (ticket 2.8) read it.
   */
  private tarball(path: string): Response {
    const match = /^\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(path);
    const repo = match && match[1] === APPS_GITHUB_OWNER ? this.repositories.get(match[2] ?? "") : undefined;
    const commit = repo?.commits.get(match?.[3] ?? "");
    if (!repo || repo.private || !commit) return json(404, { message: "Not Found" });
    const tree = repo.trees.get(commit.tree) ?? new Map<string, string>();
    const files = Object.fromEntries([...tree].map(([file, blob]) => [file, repo.blobs.get(blob) ?? new Uint8Array()]));
    return new Response(gzip(githubTar(files)), { status: 200, headers: { "content-type": "application/x-gzip" } });
  }

  /** The files at a commit, as text. */
  filesAt(name: string, commitSha: string): Record<string, string> {
    const repo = this.repo(name);
    const commit = repo.commits.get(commitSha);
    if (!commit) throw new Error("no such commit");
    const tree = repo.trees.get(commit.tree) ?? new Map<string, string>();
    return Object.fromEntries([...tree].map(([path, blob]) => [path, new TextDecoder().decode(repo.blobs.get(blob))]));
  }

  /** The commits from `main` back to the first one (first parents). */
  history(name: string): FakeCommit[] {
    const repo = this.repo(name);
    const out: FakeCommit[] = [];
    let at = repo.main;
    while (at !== undefined) {
      const commit = repo.commits.get(at);
      if (!commit) break;
      out.push(commit);
      at = commit.parents[0];
    }
    return out;
  }

  repo(name: string): FakeRepository {
    const repo = this.repositories.get(name);
    if (!repo) throw new Error("no such repository");
    return repo;
  }

  /** A repository that exists already (a rebuild), empty when `empty`. */
  addRepository(name: string, options: { private?: boolean; defaultBranch?: string } = {}): FakeRepository {
    const repo: FakeRepository = {
      name,
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? "main",
      blobs: new Map(),
      trees: new Map(),
      commits: new Map(),
      main: undefined,
      createdWith: undefined,
    };
    this.repositories.set(name, repo);
    return repo;
  }

  /**
   * A commit already on `main` (a repository some earlier run or a person left): the given files, message and
   * parents, by the builder's identity. Returns its id.
   */
  seedCommit(name: string, files: Record<string, string>, message: string, parents: string[] = []): string {
    const repo = this.repo(name);
    const tree = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) {
      const bytes = new TextEncoder().encode(content);
      const blob = gitBlobSha(bytes);
      repo.blobs.set(blob, bytes);
      tree.set(path, blob);
    }
    const treeSha = sha1(`seed ${JSON.stringify([...tree])}`);
    repo.trees.set(treeSha, tree);
    const commit = this.addCommit(repo, { message, tree: treeSha, parents, author: undefined, committer: undefined });
    repo.main = commit;
    return commit;
  }

  private jwtValid(authorization: string): boolean {
    const jwt = authorization.replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) return false;
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    if (!verify.verify(keys.publicKey, Buffer.from(signature, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iat: number; exp: number; iss: string };
    const nowS = this.now().getTime() / 1000;
    return claims.iss === TEST_APP_ID && claims.iat <= nowS && claims.exp > nowS && claims.exp - claims.iat <= 600;
  }

  private grantOf(authorization: string): Grant | undefined {
    return this.grants.get(authorization.replace(/^Bearer /, ""));
  }

  private canUse(authorization: string, repo: string | undefined, permission: string): boolean {
    const grant = this.grantOf(authorization);
    if (!grant || grant.permissions[permission] !== "write") return false;
    return repo === undefined || grant.repositories === undefined || grant.repositories.includes(repo);
  }

  private repoJson(repo: FakeRepository): Record<string, unknown> {
    return {
      name: repo.name,
      full_name: `${APPS_GITHUB_OWNER}/${repo.name}`,
      owner: { login: APPS_GITHUB_OWNER, type: "Organization" },
      private: repo.private,
      visibility: repo.private ? "private" : "public",
      default_branch: repo.defaultBranch,
    };
  }

  private route(method: string, path: string, auth: string, body: Record<string, unknown>): Response {
    const org = APPS_GITHUB_OWNER;
    if (method === "GET" && path === "/app") {
      if (!this.jwtValid(auth)) return json(401, { message: "Bad credentials" });
      return json(200, { slug: "ssd-workshop-gh-app", name: "SSD Workshop GH App", owner: { login: org } });
    }
    if (method === "GET" && path === `/orgs/${org}/installation`) {
      if (!this.jwtValid(auth)) return json(401, { message: "Bad credentials" });
      return json(200, {
        id: TEST_INSTALLATION_ID,
        account: { login: this.installationAccount, type: "Organization" },
        repository_selection: "all",
        permissions: { administration: "write", contents: "write", metadata: "read" },
      });
    }
    if (method === "POST" && path === `/app/installations/${TEST_INSTALLATION_ID}/access_tokens`) {
      if (!this.jwtValid(auth)) return json(401, { message: "Bad credentials" });
      minted += 1;
      const token = `${FAKE_TOKEN_PREFIX}${String(minted).padStart(4, "0")}xyz`;
      const repositories = body.repositories as string[] | undefined;
      const permissions = { ...(body.permissions as Record<string, string>), metadata: "read" };
      this.grants.set(token, { permissions, repositories });
      return json(201, {
        token,
        expires_at: new Date(this.now().getTime() + this.tokenLifetimeMs).toISOString(),
        permissions,
        repository_selection: repositories ? "selected" : "all",
        ...(repositories && { repositories: repositories.map((name) => ({ name, full_name: `${org}/${name}` })) }),
        ...this.overrideTokenAnswer,
      });
    }
    if (method === "POST" && path === `/orgs/${org}/repos`) {
      if (!this.canUse(auth, undefined, "administration")) return json(401, { message: "Resource not accessible by integration" });
      const name = String(body.name);
      if (this.repositories.has(name)) {
        return json(422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
      }
      const repo = this.addRepository(name, { private: body.private === true || body.visibility === "private", defaultBranch: this.defaultBranch });
      repo.createdWith = body;
      return json(201, this.repoJson(repo));
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!match || match[1] !== org) return json(404, { message: "Not Found" });
    const name = match[2] ?? "";
    const rest = match[3] ?? "";
    const repo = this.repositories.get(name);
    if (rest === "" && method === "GET") {
      if (!this.canUse(auth, undefined, "administration")) return json(401, { message: "Bad credentials" });
      return repo ? json(200, this.repoJson(repo)) : json(404, { message: "Not Found" });
    }
    if (!repo || !this.canUse(auth, name, "contents")) return json(404, { message: "Not Found" });
    if (method === "PUT" && rest.startsWith("/contents/")) {
      // As GitHub does: the file is added to the default branch's tree, in a commit on top of it when it exists;
      // a file that is already there needs its blob id (`sha`), else 422.
      const file = rest.slice("/contents/".length);
      const base = repo.main === undefined ? undefined : repo.commits.get(repo.main);
      const entries = new Map(base === undefined ? [] : (repo.trees.get(base.tree) ?? []));
      if (entries.has(file) && body.sha === undefined) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      const bytes = Buffer.from(String(body.content), "base64");
      const blob = gitBlobSha(bytes);
      repo.blobs.set(blob, bytes);
      entries.set(file, blob);
      const tree = sha1(`tree ${JSON.stringify([...entries].sort())}`);
      repo.trees.set(tree, entries);
      const parents = repo.main ? [repo.main] : [];
      const commit = this.addCommit(repo, { message: String(body.message), tree, parents, author: body.author, committer: body.committer });
      repo.main = commit;
      return json(201, {
        content: { path: file, sha: blob },
        commit: { sha: commit, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })) },
      });
    }
    if (repo.main === undefined) return json(409, { message: "Git Repository is empty." });
    if (method === "GET" && rest === "/git/ref/heads/main") return json(200, { ref: "refs/heads/main", object: { sha: repo.main, type: "commit" } });
    if (method === "GET" && rest.startsWith("/git/commits/")) {
      const commit = repo.commits.get(rest.slice("/git/commits/".length));
      return commit
        ? json(200, { sha: commit.sha, message: commit.message, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) })
        : json(404, {});
    }
    if (method === "GET" && rest.startsWith("/git/trees/")) {
      const sha = rest.slice("/git/trees/".length);
      const tree = repo.trees.get(sha);
      if (!tree) return json(404, { message: "Not Found" });
      return json(200, { sha, truncated: false, tree: [...tree].map(([path, blob]) => ({ path, mode: "100644", type: "blob", sha: blob })) });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const bytes = body.encoding === "base64" ? Buffer.from(String(body.content), "base64") : Buffer.from(String(body.content));
      const blob = gitBlobSha(bytes);
      repo.blobs.set(blob, bytes);
      return json(201, { sha: blob });
    }
    if (method === "POST" && rest === "/git/trees") {
      if (body.base_tree !== undefined) return json(400, { message: "base_tree not expected in these tests" });
      const entries = body.tree as { path: string; mode: string; type: string; sha: string }[];
      if (entries.some((e) => e.mode !== "100644" || e.type !== "blob" || !repo.blobs.has(e.sha))) return json(422, { message: "bad tree" });
      const tree = sha1(JSON.stringify(entries));
      repo.trees.set(tree, new Map(entries.map((e) => [e.path, e.sha])));
      return json(201, { sha: tree });
    }
    if (method === "POST" && rest === "/git/commits") {
      if (!repo.trees.has(String(body.tree))) return json(422, { message: "no tree" });
      const parents = body.parents as string[];
      if (parents.some((p) => !repo.commits.has(p))) return json(422, { message: "no parent" });
      const sha = this.addCommit(repo, { message: String(body.message), tree: String(body.tree), parents, author: body.author, committer: body.committer });
      return json(201, { sha });
    }
    if (method === "PATCH" && rest === "/git/refs/heads/main") {
      const sha = String(body.sha);
      const commit = repo.commits.get(sha);
      if (!commit) return json(422, { message: "Object does not exist" });
      // As GitHub does: without force, the new commit must have the current `main` among its ancestors.
      if (body.force !== true && !this.descendsFrom(repo, sha, repo.main)) return json(422, { message: "Update is not a fast forward" });
      repo.main = sha;
      return json(200, { ref: "refs/heads/main", object: { sha } });
    }
    return json(404, { message: "Not Found" });
  }

  private descendsFrom(repo: FakeRepository, sha: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const queue = [...(repo.commits.get(sha)?.parents ?? [])];
    while (queue.length > 0) {
      const at = queue.shift() ?? "";
      if (at === ancestor) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(repo.commits.get(at)?.parents ?? []));
    }
    return false;
  }

  private addCommit(repo: FakeRepository, commit: Omit<FakeCommit, "sha">): string {
    const sha = sha1(`${JSON.stringify(commit)} ${repo.commits.size}`);
    repo.commits.set(sha, { sha, ...commit });
    return sha;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
