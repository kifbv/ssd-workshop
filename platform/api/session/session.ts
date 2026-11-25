// Sessions (ticket 1.5): the cookie, its token, and the one session check every protected route
// calls. The token lives only in the browser's HttpOnly cookie; the table keeps its SHA-256 hash.
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
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

const STEPS: readonly Step[] = ["nickname", "clarify", "spec", "approved", "building"];
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

/**
 * The `Set-Cookie` value that ends a session (ticket 3.1): same name and attributes, empty, expired
 * at once, so the browser drops it.
 */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * The link from a session to its allow-list entry (ticket 3.1). The entry's key holds the email
 * address and nothing else points from a participant to it, so the session item keeps the address
 * sealed (AES-256-GCM) under a key derived from the session token, which only the browser's cookie
 * holds (the table keeps the token's SHA-256). The table alone cannot open it; the session check opens
 * it with the caller's cookie, re-reads the entry and forgets the address. Never logged.
 */
const SEAL_INFO = "ssd-workshop session allow-list link v1";
const SEAL_IV_BYTES = 12;
const SEAL_TAG_BYTES = 16;

function sealKey(token: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), Buffer.alloc(0), SEAL_INFO, 32));
}

/** The sealed address for a new session: base64url of IV, ciphertext and tag. */
export function sealAllowRef(token: string, email: string, randomBytes: (size: number) => Buffer): string {
  const iv = randomBytes(SEAL_IV_BYTES);
  if (iv.length !== SEAL_IV_BYTES) throw new Error("random source gave the wrong length");
  const cipher = createCipheriv("aes-256-gcm", sealKey(token), iv);
  const sealed = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
}

/** The address sealed for this token, or undefined when the value is missing, malformed or another token's. */
export function openAllowRef(token: string, allowRef: string | undefined): string | undefined {
  if (allowRef === undefined) return undefined;
  const raw = Buffer.from(allowRef, "base64url");
  if (raw.length <= SEAL_IV_BYTES + SEAL_TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(token), raw.subarray(0, SEAL_IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - SEAL_TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(SEAL_IV_BYTES, raw.length - SEAL_TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
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
  /** The allow-list entry's address, sealed under the token (`sealAllowRef`); missing on sessions from before ticket 3.1. */
  allowRef?: string;
}

/** What the session check reads from an allow-list entry (never the address). */
export interface SessionAllowEntry {
  role: Role;
  group: string;
  participantId?: string;
}

/** What the session check needs from the table. */
export interface SessionReader {
  getSession(tokenHash: string): Promise<StoredSession | undefined>;
  /** The allow-list entry of this address (consistent read), or undefined when it is gone or malformed. */
  getAllowEntry(email: string): Promise<SessionAllowEntry | undefined>;
  getParticipant(participantId: string): Promise<ParticipantRecord | undefined>;
  /** Deletes the session item (no error when it is already gone). */
  deleteSession(tokenHash: string): Promise<void>;
}

export interface SessionDeps {
  sessions: SessionReader;
  now: () => Date;
}

/**
 * Why a call was refused: `no-session` (no cookie, a malformed, unknown or expired token, or no
 * profile) or `removed` (the person's allow-list entry is gone or no longer theirs: the session was deleted).
 */
export type SessionRefusal = "no-session" | "removed";

export type SessionCheck =
  | { ok: true; participant: ParticipantRecord; role: Role; tokenHash: string }
  | { ok: false; response: HttpResponse; reason: SessionRefusal };

export function signInRequiredResponse(): HttpResponse {
  return jsonResponse(401, { message: SIGN_IN_REQUIRED_MESSAGE });
}

/**
 * The one session check of every protected route: the caller's own participant record, with role
 * and group as the allow-list has them now (ticket 3.1), or a 401 for no cookie, a malformed or unknown
 * (forged) token, an expired session (DynamoDB's TTL deletes late, so the clock decides) or a session
 * whose participant is gone (that session is deleted too). A session whose allow-list entry is gone, or no longer linked to its
 * participant (or that has no sealed link, from before ticket 3.1), is deleted and answered 401: a
 * removed person is signed out at their next call. Table errors are thrown to the caller (a failure
 * is not a reason to sign someone out). The address is never logged or returned.
 */
export async function requireSession(request: HttpRequest, deps: SessionDeps): Promise<SessionCheck> {
  const refused = (reason: SessionRefusal): SessionCheck => ({ ok: false, response: signInRequiredResponse(), reason });
  const token = readSessionToken(request);
  if (token === undefined) return refused("no-session");
  const tokenHash = hashToken(token);
  const session = await deps.sessions.getSession(tokenHash);
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  if (session === undefined || !(session.expiresAt > nowSeconds)) return refused("no-session");
  const email = openAllowRef(token, session.allowRef);
  const [entry, participant] = await Promise.all([
    email === undefined ? Promise.resolve(undefined) : deps.sessions.getAllowEntry(email),
    deps.sessions.getParticipant(session.participantId),
  ]);
  if (entry === undefined || entry.participantId !== session.participantId) {
    await deps.sessions.deleteSession(tokenHash);
    return refused("removed");
  }
  if (participant === undefined) {
    // No profile behind a valid entry: nothing can use this session, so it is not left behind (try 2).
    await deps.sessions.deleteSession(tokenHash);
    return refused("no-session");
  }
  const current = { ...participant, role: entry.role, group: entry.group };
  return { ok: true, participant: current, role: entry.role, tokenHash };
}
