// App write tokens (ticket 3.24): saving in a participant's app needs the workshop's own sign-in. The platform's
// session cookie never reaches an app (SameSite=Strict, and apps run sandboxed in an opaque origin), so the hand-off
// page `/app-sign-in` asks a session-protected route for a token for one app and passes it to the app in the address's
// fragment (`/apps/<nickname>/#wt=<token>`); the app sends it on every write as `Authorization: Bearer <token>`.
//
// A token is 32 random bytes (base64url, 43 characters), scoped to one app and one participant, recording the writer's
// nickname. The table keeps only its SHA-256 (`APPTOKEN#<hash>` / `TOKEN`), with the app, the nickname and `expiresAt`
// (also the table's TTL): 12 hours after it was made, but never after the session it came from. Each participant's
// tokens are listed (hash -> expiry) in one item, `TOKENS#<participant id>` / `TOKENS`, so sign-out and
// `npm run participant -- reset` can delete them all (revocation); at most MAX_APP_TOKENS live ones at a time.
//
// This module is the one write check every app route uses: the data API (3.24), and the media uploads (3.18) and
// AI tasks (3.21) to come. Never log a token or its hash.
import type { HttpRequest } from "../http.js";
import { hashToken, newSessionToken } from "../session/session.js";

/** A token lasts 12 hours (a workshop day), never longer than its session (see appTokenExpiry). */
export const APP_TOKEN_TTL_SECONDS = 12 * 60 * 60;
/** Live tokens one participant may hold at once (each Continue on /app-sign-in makes one; sign-out clears them). */
export const MAX_APP_TOKENS = 50;
/** 32 random bytes, base64url without padding. */
export const APP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What the table keeps of a token (under its hash): the app (lower-cased nickname), the writer's nickname, the expiry. */
export interface StoredAppToken {
  /** The app it was made for: its lower-cased nickname. */
  app: string;
  /** The nickname of the participant it was made for (the writer), as they chose it. */
  nickname: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/** What the write check needs from the table. */
export interface AppTokenReader {
  /** The token stored under this hash (consistent read), or undefined. */
  getAppToken(tokenHash: string): Promise<StoredAppToken | undefined>;
}

/**
 * `too-many`: MAX_APP_TOKENS live tokens already; `conflict`: the participant's list changed while being written (try
 * again); `no-session`: the session the request came with is gone (signed out meanwhile), so no token was made.
 */
export type CreateTokenResult = "saved" | "too-many" | "conflict" | "no-session";

/** What the token route, sign-out and the reset need from the table. */
export interface AppTokenWriter {
  /**
   * Stores a new token (by hash) and adds it to the participant's list, only while they hold fewer than MAX_APP_TOKENS
   * live ones, the list is unchanged since it was read (its `version`), and the session (by its token's hash) still
   * exists, all in one transaction.
   */
  createAppToken(participantId: string, sessionTokenHash: string, tokenHash: string, token: StoredAppToken, nowSeconds: number): Promise<CreateTokenResult>;
  /** Deletes every token of the participant, then empties their list (bumping its `version`); returns how many were listed. */
  revokeAppTokens(participantId: string): Promise<number>;
}

/** What a sign-out needs: the tokens' revocation and the session's delete. */
export interface SignOutStore extends AppTokenWriter {
  deleteSession(tokenHash: string): Promise<void>;
}

/** The revocation after the session's delete is tried this many times in all before the sign-out gives up on it. */
export const LAST_REVOKE_ATTEMPTS = 3;

/** `last-revoke-failed`: signed out, but every try of the last revocation failed (a racing token may live on). */
export type SignOutResult = "done" | "last-revoke-failed";

/**
 * Sign-out (ticket 3.24 try 2): the participant's tokens, then the session, then the tokens once more.
 * The first pass comes before the session's delete, so a failure there (thrown) leaves the person signed in to try again.
 * A token whose request passed the session check can still be committed between that pass and the session's delete;
 * once the session is gone none can be (the create transaction checks the session item), and every committed token is
 * in the list (its `version` condition), so the last pass deletes whatever the first one missed. Try 3: the session is
 * already gone when the last pass runs, so a failure there cannot be retried by the person: it is tried
 * LAST_REVOKE_ATTEMPTS times, and if all fail the sign-out still completes (`last-revoke-failed`, for the log; the
 * residual risk is in docs/decisions.md "(3.24) No token survives a sign-out").
 */
export async function signOutWithAppTokens(store: SignOutStore, participantId: string, sessionTokenHash: string): Promise<SignOutResult> {
  await store.revokeAppTokens(participantId);
  await store.deleteSession(sessionTokenHash);
  for (let attempt = 0; attempt < LAST_REVOKE_ATTEMPTS; attempt += 1) {
    try {
      await store.revokeAppTokens(participantId);
      return "done";
    } catch {
      // Tried again; the error itself is never logged (only the outcome, by the caller).
    }
  }
  return "last-revoke-failed";
}

/** A new token from a cryptographic source such as `crypto.randomBytes` (same form as a session token). */
export function newAppToken(randomBytes: (size: number) => Buffer): string {
  return newSessionToken(randomBytes);
}

/** The stored form: SHA-256, hex (256 random bits: a leaked hash cannot be reversed by guessing). */
export function hashAppToken(token: string): string {
  return hashToken(token);
}

/** When a token made now from a session ending at `sessionExpiresAt` ends: 12 hours, but never after the session. */
export function appTokenExpiry(nowSeconds: number, sessionExpiresAt: number): number {
  return Math.min(nowSeconds + APP_TOKEN_TTL_SECONDS, sessionExpiresAt);
}

/** The token from `Authorization: Bearer <token>` (scheme in any case), if well formed. Never reads a cookie. */
export function readBearerToken(request: HttpRequest): string | undefined {
  const header = request.headers?.["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header.trim());
  return match?.[1];
}

/** Why a write was refused (logged as an outcome; never the token). */
export type AppWriteRefusal = "no-token" | "unknown" | "expired" | "other-app";
export type AppWriteCheck = { ok: true; writer: string } | { ok: false; reason: AppWriteRefusal };

/**
 * The one write check of every app route: the request carries a token that exists, has not expired, and was made for
 * this app (`app` compared lower-cased). Gives the writer's nickname. A sign-out or a reset deletes the token, so it is
 * then unknown. Table errors are thrown to the caller.
 */
export async function checkAppWrite(request: HttpRequest, app: string, tokens: AppTokenReader, now: Date): Promise<AppWriteCheck> {
  const token = readBearerToken(request);
  if (token === undefined) return { ok: false, reason: "no-token" };
  const stored = await tokens.getAppToken(hashAppToken(token));
  if (stored === undefined) return { ok: false, reason: "unknown" };
  // DynamoDB's TTL deletes late: the clock decides.
  if (!(stored.expiresAt > Math.floor(now.getTime() / 1000))) return { ok: false, reason: "expired" };
  if (stored.app !== app.toLowerCase()) return { ok: false, reason: "other-app" };
  return { ok: true, writer: stored.nickname };
}
