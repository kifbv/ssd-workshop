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

/** `too-many`: MAX_APP_TOKENS live tokens already; `conflict`: the participant's list changed while being written (try again). */
export type CreateTokenResult = "saved" | "too-many" | "conflict";

/** What the token route, sign-out and the reset need from the table. */
export interface AppTokenWriter {
  /** Stores a new token (by hash) and adds it to the participant's list, only while they hold fewer than MAX_APP_TOKENS live ones. */
  createAppToken(participantId: string, tokenHash: string, token: StoredAppToken, nowSeconds: number): Promise<CreateTokenResult>;
  /** Deletes every token of the participant, then their list; returns how many tokens were listed. */
  revokeAppTokens(participantId: string): Promise<number>;
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
