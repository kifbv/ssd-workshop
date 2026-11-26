// The protected participant routes (ticket 1.5): `GET /api/me`, `POST /api/me/nickname` and
// `GET /api/participants/{id}`, `POST /api/sign-out` (ticket 3.1), and `POST /api/app-tokens` (ticket 3.24: an app
// write token for one live app, for the hand-off page /app-sign-in). Every one starts with the one
// session check (../session/session.ts) and works only on the caller's own record: facilitator views
// of others come in phase 3. Sign-out also revokes the caller's app write tokens (ticket 3.24).
import {
  isJsonContentType,
  jsonResponse,
  readJsonObject,
  unsupportedMediaTypeResponse,
  type HttpRequest,
  type HttpResponse,
} from "../http.js";
import { appTokenExpiry, hashAppToken, newAppToken, signOutWithAppTokens, type AppTokenWriter } from "../app-token/token.js";
import { clearedSessionCookie, requireSession, signInRequiredResponse, type ParticipantRecord, type SessionReader } from "../session/session.js";
import { errorName } from "../sign-in/code-request.js";
import { APP_SIGN_IN_TEXTS } from "../workshop/texts.js";

export const ME_ROUTE = "GET /api/me";
export const NICKNAME_ROUTE = "POST /api/me/nickname";
export const PARTICIPANT_ROUTE = "GET /api/participants/{id}";
export const SIGN_OUT_ROUTE = "POST /api/sign-out";
/** Ticket 3.24: `{"app": "<nickname>"}` -> `{token, app, nickname, expiresAt}` for a live app. */
export const APP_TOKEN_ROUTE = "POST /api/app-tokens";
export const PARTICIPANT_ROUTES = [ME_ROUTE, NICKNAME_ROUTE, PARTICIPANT_ROUTE, SIGN_OUT_ROUTE, APP_TOKEN_ROUTE] as const;
/** A token route whose list kept changing under it (two Continues at once) tries this many times before a 409. */
export const APP_TOKEN_ATTEMPTS = 3;

/** 3 to 20 letters, digits or dashes (ASCII). */
export const NICKNAME_PATTERN = /^[A-Za-z0-9-]{3,20}$/;

/**
 * Nicknames nobody may take, compared regardless of case: names of the site's own paths (so a
 * nickname can later be part of a participant app's address without hiding one) and names that
 * could pass for staff or the system. Names under 3 characters are kept for the record although
 * the rule already refuses them.
 */
export const RESERVED_NICKNAMES: readonly string[] = [
  "admin",
  "administrator",
  "api",
  "apps",
  "assets",
  "claude",
  "facilitator",
  "facilitators",
  "globe",
  "help",
  "intro",
  "login",
  "logout",
  "me",
  "null",
  "root",
  "sign-in",
  "sign-out",
  "signin",
  "static",
  "support",
  "system",
  "undefined",
  "workshop",
  "www",
  "x",
];

export type NicknameCheck = "ok" | "rules" | "reserved";

export function checkNickname(nickname: string): NicknameCheck {
  if (!NICKNAME_PATTERN.test(nickname)) return "rules";
  if (RESERVED_NICKNAMES.includes(nickname.toLowerCase())) return "reserved";
  return "ok";
}

export const NOT_FOUND_MESSAGE = "Not found.";
export const FAILED_MESSAGE = "Something went wrong. Please try again in a moment.";
export const SIGNED_OUT_MESSAGE = "You're signed out.";
export const BAD_NICKNAME_REQUEST_MESSAGE = "Send a JSON body with a nickname.";
export const NICKNAME_MESSAGES = {
  rules: "A nickname has 3 to 20 letters, digits or dashes.",
  reserved: "That nickname is reserved. Please pick another one.",
  taken: "That nickname is already taken. Please pick another one.",
  "already-set": "You already have a nickname, and it can't be changed.",
} as const;

export type ClaimResult = "saved" | "taken" | "already-set";

/** What the participant routes need from the table. */
export interface ParticipantStore extends SessionReader, AppTokenWriter {
  /** Ticket 3.24: true while the app's live marker (`APP#<lower-cased nickname>` / `LIVE`, its `liveAt`) is there. */
  isAppLive(nickname: string): Promise<boolean>;
  /**
   * In one transaction: claims the nickname (lower-cased key, only if unclaimed) and sets it on the
   * participant's profile, moving the step from `nickname` to `clarify` (only if no nickname yet).
   */
  claimNickname(participantId: string, nickname: string, nowIso: string): Promise<ClaimResult>;
}

export type ParticipantRoute = "me" | "nickname" | "participant" | "sign-out" | "app-token" | "unknown";
export type ParticipantOutcome =
  | "ok"
  | "signed-out"
  /** Ticket 3.24 try 3: signed out, but the revocation after the session's delete failed every try. */
  | "signed-out-revoke-failed"
  | "unauthorized"
  /** Refused because the person's allow-list entry is gone: their session was deleted (ticket 3.1). */
  | "removed"
  | "not-found"
  | "rules"
  | "reserved"
  | "taken"
  | "already-set"
  | "invalid-request"
  | "unsupported-media-type"
  /** Ticket 3.24, the token route: a token was made; or no live app; no nickname yet; too many tokens; lost races. */
  | "token"
  | "not-live"
  | "no-nickname"
  | "too-many"
  | "conflict"
  | "failed";

/** The only things ever logged: no nickname, no id, no token (session or app), no body. */
export interface ParticipantLogEntry {
  event: "participant";
  route: ParticipantRoute;
  outcome: ParticipantOutcome;
  error?: string;
}

export interface ParticipantDeps {
  store: ParticipantStore;
  now: () => Date;
  /** A cryptographic source such as `crypto.randomBytes` (ticket 3.24: app write tokens). */
  randomBytes: (size: number) => Buffer;
  log: (entry: ParticipantLogEntry) => void;
}

/** The record as the API returns it: id, nickname (null until chosen), role, group, step. */
export function recordBody(p: ParticipantRecord): Record<string, unknown> {
  return { id: p.id, nickname: p.nickname ?? null, role: p.role, group: p.group, step: p.step };
}

export function notFoundResponse(): HttpResponse {
  return jsonResponse(404, { message: NOT_FOUND_MESSAGE });
}

function routeOf(request: HttpRequest): ParticipantRoute {
  switch (request.routeKey) {
    case ME_ROUTE:
      return "me";
    case NICKNAME_ROUTE:
      return "nickname";
    case PARTICIPANT_ROUTE:
      return "participant";
    case SIGN_OUT_ROUTE:
      return "sign-out";
    case APP_TOKEN_ROUTE:
      return "app-token";
    default:
      return "unknown";
  }
}

async function setNickname(
  request: HttpRequest,
  participant: ParticipantRecord,
  deps: ParticipantDeps,
): Promise<{ outcome: ParticipantOutcome; response: HttpResponse }> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const nickname = readJsonObject(request)?.["nickname"];
  if (typeof nickname !== "string") {
    return { outcome: "invalid-request", response: jsonResponse(400, { message: BAD_NICKNAME_REQUEST_MESSAGE }) };
  }
  if (participant.nickname !== undefined) {
    return { outcome: "already-set", response: jsonResponse(409, { message: NICKNAME_MESSAGES["already-set"], reason: "already-set" }) };
  }
  const trimmed = nickname.trim();
  const check = checkNickname(trimmed);
  if (check !== "ok") return { outcome: check, response: jsonResponse(400, { message: NICKNAME_MESSAGES[check], reason: check }) };
  const result = await deps.store.claimNickname(participant.id, trimmed, deps.now().toISOString());
  if (result !== "saved") return { outcome: result, response: jsonResponse(409, { message: NICKNAME_MESSAGES[result], reason: result }) };
  return { outcome: "ok", response: jsonResponse(200, recordBody({ ...participant, nickname: trimmed, step: "clarify" })) };
}

type Routed = { outcome: ParticipantOutcome; response: HttpResponse };

/**
 * Ticket 3.24: a new app write token for the live app named in the body, for the caller. Any signed-in participant
 * with a nickname may get one for any live app (decision "Who may save"). The token (random, stored only as its
 * SHA-256) is answered once and never logged; it ends after 12 hours, never after the caller's session.
 */
async function createAppToken(request: HttpRequest, participant: ParticipantRecord, sessionTokenHash: string, sessionExpiresAt: number, deps: ParticipantDeps): Promise<Routed> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const app = readJsonObject(request)?.["app"];
  // A name outside the nickname rules (or a reserved one) can never be an app: the same answer as a missing one, no read.
  if (typeof app !== "string" || checkNickname(app) !== "ok" || !(await deps.store.isAppLive(app))) {
    return { outcome: "not-live", response: jsonResponse(404, { message: APP_SIGN_IN_TEXTS.notLive, reason: "not-live" }) };
  }
  if (participant.nickname === undefined) {
    return { outcome: "no-nickname", response: jsonResponse(409, { message: APP_SIGN_IN_TEXTS.noNickname, reason: "no-nickname" }) };
  }
  const now = deps.now();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const stored = { app: app.toLowerCase(), nickname: participant.nickname, expiresAt: appTokenExpiry(nowSeconds, sessionExpiresAt) };
  for (let attempt = 0; attempt < APP_TOKEN_ATTEMPTS; attempt += 1) {
    const token = newAppToken(deps.randomBytes);
    const result = await deps.store.createAppToken(participant.id, sessionTokenHash, hashAppToken(token), stored, nowSeconds);
    // Signed out since the session check (the transaction found no session): no token, the same 401 as no session.
    if (result === "no-session") return { outcome: "unauthorized", response: signInRequiredResponse() };
    if (result === "too-many") return { outcome: "too-many", response: jsonResponse(429, { message: APP_SIGN_IN_TEXTS.tooMany, reason: "too-many" }) };
    if (result === "saved") {
      return { outcome: "token", response: jsonResponse(200, { token, app: stored.app, nickname: stored.nickname, expiresAt: stored.expiresAt }) };
    }
  }
  return { outcome: "conflict", response: jsonResponse(409, { message: APP_SIGN_IN_TEXTS.conflict, reason: "conflict" }) };
}

/** The answer to `POST /api/sign-out` also clears the cookie, whatever it is (the browser drops it). */
function withClearedCookie(response: HttpResponse): HttpResponse {
  return { ...response, cookies: [clearedSessionCookie()] };
}

async function route(
  request: HttpRequest,
  deps: ParticipantDeps,
  which: ParticipantRoute,
): Promise<{ outcome: ParticipantOutcome; response: HttpResponse }> {
  const session = await requireSession(request, { sessions: deps.store, now: deps.now });
  if (!session.ok) {
    const outcome = session.reason === "removed" ? "removed" : "unauthorized";
    return { outcome, response: which === "sign-out" ? withClearedCookie(session.response) : session.response };
  }
  const { participant } = session;
  switch (which) {
    case "sign-out": {
      if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
      // Ticket 3.24: the caller's app write tokens first (all of them, from every session), so a failure leaves them
      // signed in to try again rather than signed out with tokens still working; a second pass after the session's
      // delete ends any token made in between (signOutWithAppTokens).
      // Try 3: a failure of that last pass (after its retries) still answers the sign-out as done (the session is gone,
      // nothing for the person to retry) and is logged by its outcome name only.
      const signedOut = await signOutWithAppTokens(deps.store, participant.id, session.tokenHash);
      return { outcome: signedOut === "done" ? "signed-out" : "signed-out-revoke-failed", response: withClearedCookie(jsonResponse(200, { message: SIGNED_OUT_MESSAGE })) };
    }
    case "me":
      return { outcome: "ok", response: jsonResponse(200, recordBody(participant)) };
    case "participant":
      // Only the caller's own id: any other id, existing or not, gets the same 404 (no read).
      if (request.pathParameters?.["id"] !== participant.id) return { outcome: "not-found", response: notFoundResponse() };
      return { outcome: "ok", response: jsonResponse(200, recordBody(participant)) };
    case "nickname":
      return setNickname(request, participant, deps);
    case "app-token":
      return createAppToken(request, participant, session.tokenHash, session.expiresAt, deps);
    default:
      return { outcome: "not-found", response: notFoundResponse() };
  }
}

/** Routes one request; table failures give a 500 with a generic message (logged by error name only). */
export async function handleParticipantRequest(request: HttpRequest, deps: ParticipantDeps): Promise<HttpResponse> {
  const which = routeOf(request);
  try {
    const { outcome, response } = await route(request, deps, which);
    deps.log({ event: "participant", route: which, outcome });
    return response;
  } catch (error) {
    deps.log({ event: "participant", route: which, outcome: "failed", error: errorName(error) });
    return jsonResponse(500, { message: FAILED_MESSAGE });
  }
}
