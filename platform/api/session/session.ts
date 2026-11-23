// Sessions (ticket 1.5): the cookie, its token, and the one session check every protected route
// calls. The token lives only in the browser's HttpOnly cookie; the table keeps its SHA-256 hash.
import { createHash } from "node:crypto";
import { jsonResponse, type HttpRequest, type HttpResponse } from "../http.js";
import type { Role, Step } from "../types.js";

/**
 * `__Host-` makes the browser accept the cookie only with Secure, Path=/ and no Domain, so no
 * other host under rankly.games can set or overwrite it.
 */
export const SESSION_COOKIE = "__Host-ssd_session";
/** A session lasts 8 hours from sign-in (not extended by use). */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
/** 32 random bytes, base64url without padding: 43 characters. */
export const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const ROLES: readonly Role[] = ["participant", "facilitator", "admin"];
export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as string[]).includes(value);

const STEPS: readonly Step[] = ["nickname", "clarify", "spec", "approved"];
export const isStep = (value: unknown): value is Step => typeof value === "string" && (STEPS as string[]).includes(value);

export const SIGN_IN_REQUIRED_MESSAGE = "Please sign in.";

/** A new session token from a cryptographic source such as `crypto.randomBytes`. */
export function newSessionToken(randomBytes: (size: number) => Buffer): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) throw new Error("random source gave the wrong length");
  return bytes.toString("base64url");
}

/**
 * The stored form of a token: SHA-256, hex. A fast hash is right here (unlike the 6-digit code's
 * scrypt): the token holds 256 random bits, so a leaked hash cannot be reversed by guessing.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The `Set-Cookie` value that starts a session: HttpOnly, Secure, SameSite=Strict, 8 hours. */
export function sessionCookie(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("malformed session token");
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** The session token from the request's cookies, if one is there and well formed. */
export function readSessionToken(request: HttpRequest): string | undefined {
  const prefix = `${SESSION_COOKIE}=`;
  for (const cookie of request.cookies ?? []) {
    const trimmed = cookie.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const token = trimmed.slice(prefix.length);
    if (TOKEN_PATTERN.test(token)) return token;
  }
  return undefined;
}

/** A participant's own record, as the API returns it (no email: it is never stored here). */
export interface ParticipantRecord {
  id: string;
  /** Unset until chosen. */
  nickname?: string;
  role: Role;
  group: string;
  step: Step;
}

export interface StoredSession {
  participantId: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/** What the session check needs from the table. */
export interface SessionReader {
  getSession(tokenHash: string): Promise<StoredSession | undefined>;
  getParticipant(participantId: string): Promise<ParticipantRecord | undefined>;
}

export interface SessionDeps {
  sessions: SessionReader;
  now: () => Date;
}

export type SessionCheck =
  | { ok: true; participant: ParticipantRecord; role: Role }
  | { ok: false; response: HttpResponse };

export function signInRequiredResponse(): HttpResponse {
  return jsonResponse(401, { message: SIGN_IN_REQUIRED_MESSAGE });
}

/**
 * The one session check of every protected route: the caller's own participant record and role,
 * or a 401 for no cookie, a malformed or unknown (forged) token, an expired session (DynamoDB's
 * TTL deletes late, so the clock decides) or a session whose participant is gone. Table errors
 * are thrown to the caller (a failure is not a reason to sign someone out).
 */
export async function requireSession(request: HttpRequest, deps: SessionDeps): Promise<SessionCheck> {
  const token = readSessionToken(request);
  if (token === undefined) return { ok: false, response: signInRequiredResponse() };
  const session = await deps.sessions.getSession(hashToken(token));
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  if (session === undefined || !(session.expiresAt > nowSeconds)) return { ok: false, response: signInRequiredResponse() };
  const participant = await deps.sessions.getParticipant(session.participantId);
  if (participant === undefined) return { ok: false, response: signInRequiredResponse() };
  return { ok: true, participant, role: participant.role };
}
