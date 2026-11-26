/**
 * The platform's GitHub App (ticket 2.6): reads its credentials from the secret's text, signs the app's own
 * token (a JWT, RS256, with node:crypto), finds the app's installation on the apps organization and mints
 * installation tokens. Plain `fetch` against the REST API, no dependency; `fetch` and the clock are injected so
 * the tests mock GitHub.
 *
 * Never logged or put in an error: the secret's text, the private key, the JWT, any installation token, a
 * repository name (it holds the nickname) or a GitHub answer's body. Logs are one JSON line per call: the step,
 * GitHub's status and the duration.
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { APPS_GITHUB_OWNER, GITHUB_API_URL, GITHUB_API_VERSION, GITHUB_USER_AGENT } from "../settings.js";

/** The secret's content once parsed: the app's id and its private key (never printed). */
export interface AppCredentials {
  appId: string;
  privateKey: KeyObject;
}

/** Each GitHub call the platform makes, named for the logs. */
export type GitHubStep =
  | "app"
  | "installation"
  | "installation-token"
  | "create-repository"
  | "get-repository"
  | "delete-repository"
  | "get-branch"
  | "get-commit"
  | "get-tree"
  | "bootstrap"
  | "blob"
  | "tree"
  | "commit"
  | "update-branch"
  /** Ticket 3.9: the blob of `SPEC.md` (Rebuild from my repository). */
  | "get-blob";

export interface GitHubLogEntry {
  event: "github";
  step: GitHubStep;
  /** GitHub's status, or `unreachable` when no answer came (time limit, network). */
  status: number | "unreachable";
  /** Error name when unreachable. */
  error?: string;
  durationMs: number;
}

export interface GitHubDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  log: (entry: GitHubLogEntry) => void;
  /** Time limit of each call (default GITHUB_CALL_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Stops every call when aborted (a caller's deadline). */
  signal?: AbortSignal;
  /** Waits between tries of a step GitHub briefly refuses (default: a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** Each call to GitHub gets at most this long. */
export const GITHUB_CALL_TIMEOUT_MS = 10_000;

/**
 * A GitHub problem with a plain reason that is safe to log and show to Franck or a facilitator: it names the
 * step and GitHub's status, never a token, a key, a nickname or GitHub's answer.
 */
export class GitHubProblem extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubProblem";
  }
}

export const SECRET_NOT_LOADED =
  'The GitHub secret is not loaded yet: it must hold {"appId": "<id>", "privateKey": "<PEM text>"} (see infra/README.md).';
export const SECRET_KEY_UNREADABLE =
  "The GitHub secret's private key cannot be read: load the app's .pem file exactly as GitHub gave it (see infra/README.md).";

/**
 * Reads the secret's text. Anything that is not the expected JSON (CDK's random placeholder, a key alone, an
 * empty value) fails with SECRET_NOT_LOADED, and a key that is not a PEM private key with SECRET_KEY_UNREADABLE;
 * neither message echoes any part of the value (JSON.parse's own message quotes the text, so it is dropped).
 */
export function parseGitHubSecret(text: string | undefined): AppCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    throw new GitHubProblem(SECRET_NOT_LOADED);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new GitHubProblem(SECRET_NOT_LOADED);
  const { appId, privateKey } = parsed as { appId?: unknown; privateKey?: unknown };
  const id = typeof appId === "number" && Number.isSafeInteger(appId) ? String(appId) : appId;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,19}$/.test(id) || typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
    throw new GitHubProblem(SECRET_NOT_LOADED);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new GitHubProblem(SECRET_KEY_UNREADABLE);
  }
  if (key.asymmetricKeyType !== "rsa") throw new GitHubProblem(SECRET_KEY_UNREADABLE);
  return { appId: id, privateKey: key };
}

const base64Url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/**
 * The app's own token (GitHub: "Generating a JSON Web Token for a GitHub App"): RS256, issued 60 s in the past
 * (clock drift), valid 9 minutes (GitHub allows at most 10), `iss` the app id. It can only list and manage the
 * app's installations and mint installation tokens.
 */
export function appJwt(credentials: AppCredentials, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: credentials.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64Url(signer.sign(credentials.privateKey))}`;
}

export interface GitHubAnswer {
  status: number;
  /** The answer's JSON (an empty object when it has none). Never logged. */
  json: Record<string, unknown>;
}

/** One authenticated REST call. Logs the step, status and duration only. */
export async function githubCall(
  deps: GitHubDeps,
  step: GitHubStep,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  bearer: string,
  body?: unknown,
): Promise<GitHubAnswer> {
  const started = deps.now().getTime();
  const durationMs = (): number => Math.max(0, deps.now().getTime() - started);
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? GITHUB_CALL_TIMEOUT_MS);
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([timeout, deps.signal]);
  let response: Response;
  try {
    response = await deps.fetch(`${GITHUB_API_URL}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${bearer}`,
        "user-agent": GITHUB_USER_AGENT,
        "x-github-api-version": GITHUB_API_VERSION,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    deps.log({ event: "github", step, status: "unreachable", error: error instanceof Error ? error.name : "Error", durationMs: durationMs() });
    throw new GitHubProblem(`GitHub could not be reached (${step}).`);
  }
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    // No JSON body (204, an error page): an empty answer.
  }
  deps.log({ event: "github", step, status: response.status, durationMs: durationMs() });
  return { status: response.status, json };
}

/** Fails with a plain reason unless GitHub answered one of `expected`. */
export function expectStatus(answer: GitHubAnswer, step: GitHubStep, ...expected: number[]): Record<string, unknown> {
  if (!expected.includes(answer.status)) throw new GitHubProblem(`GitHub answered ${answer.status} to the step "${step}".`, answer.status);
  return answer.json;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export type Permissions = Record<string, string>;

const permissionsOf = (value: unknown): Permissions =>
  Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

/** The app itself (GET /app with the JWT), for the smoke check. */
export interface AppInfo {
  slug: string;
  name: string;
  owner: string;
}

export async function getApp(deps: GitHubDeps, jwt: string): Promise<AppInfo> {
  const json = expectStatus(await githubCall(deps, "app", "GET", "/app", jwt), "app", 200);
  return { slug: text(json.slug) ?? "?", name: text(json.name) ?? "?", owner: text(record(json.owner).login) ?? "?" };
}

/** The app's installation on the apps organization. */
export interface Installation {
  id: number;
  account: string;
  accountType: string;
  /** `all` or `selected`. */
  repositorySelection: string;
  permissions: Permissions;
}

/**
 * GET /orgs/<org>/installation with the JWT. Only an installation on APPS_GITHUB_OWNER itself is accepted, so the
 * platform never acts on another account the app might be installed on.
 */
export async function findInstallation(deps: GitHubDeps, jwt: string): Promise<Installation> {
  const answer = await githubCall(deps, "installation", "GET", `/orgs/${APPS_GITHUB_OWNER}/installation`, jwt);
  if (answer.status === 404) throw new GitHubProblem(`The GitHub App is not installed on the organization ${APPS_GITHUB_OWNER}.`, 404);
  const json = expectStatus(answer, "installation", 200);
  const account = record(json.account);
  const id = json.id;
  const login = text(account.login);
  if (typeof id !== "number" || !Number.isSafeInteger(id) || login?.toLowerCase() !== APPS_GITHUB_OWNER.toLowerCase()) {
    throw new GitHubProblem(`GitHub's answer does not name an installation on ${APPS_GITHUB_OWNER}.`);
  }
  return {
    id,
    account: login,
    accountType: text(account.type) ?? "?",
    repositorySelection: text(json.repository_selection) ?? "?",
    permissions: permissionsOf(json.permissions),
  };
}

/** An installation token as GitHub answered it (the token itself is never logged). */
export interface InstallationToken {
  token: string;
  /** ISO time GitHub gives (`expires_at`). */
  expiresAt: string;
  permissions: Permissions;
  repositorySelection: string;
  /** `owner/name` of each repository the token reaches, when it was limited to some. */
  repositories: string[] | undefined;
}

/** Longest an installation token may live: GitHub gives one hour; a minute more is allowed for clock drift. */
export const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
export const TOKEN_CLOCK_SKEW_MS = 60 * 1000;

/**
 * POST /app/installations/<id>/access_tokens with the JWT, asking for exactly `permissions` and, when given,
 * only `repositories` (names without the owner). Refuses an answer without a token or whose expiry is past or
 * more than an hour (plus TOKEN_CLOCK_SKEW_MS) away.
 */
export async function mintInstallationToken(
  deps: GitHubDeps,
  jwt: string,
  installationId: number,
  request: { permissions: Permissions; repositories?: string[] },
): Promise<InstallationToken> {
  const json = expectStatus(
    await githubCall(deps, "installation-token", "POST", `/app/installations/${installationId}/access_tokens`, jwt, {
      ...(request.repositories !== undefined && { repositories: request.repositories }),
      permissions: request.permissions,
    }),
    "installation-token",
    201,
  );
  const token = text(json.token);
  const expiresAt = text(json.expires_at);
  if (token === undefined || token === "" || expiresAt === undefined) throw new GitHubProblem("GitHub's answer holds no installation token.");
  const expires = Date.parse(expiresAt);
  const now = deps.now().getTime();
  if (!Number.isFinite(expires) || expires <= now || expires > now + MAX_TOKEN_LIFETIME_MS + TOKEN_CLOCK_SKEW_MS) {
    throw new GitHubProblem("GitHub's installation token does not expire within an hour, so it was not used.");
  }
  const repositories = Array.isArray(json.repositories)
    ? json.repositories.map((repository) => text(record(repository).full_name) ?? "?")
    : undefined;
  return { token, expiresAt, permissions: permissionsOf(json.permissions), repositorySelection: text(json.repository_selection) ?? "?", repositories };
}
