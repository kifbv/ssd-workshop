// The protected participant routes (ticket 1.5): `GET /api/me`, `POST /api/me/nickname` and
// `GET /api/participants/{id}`. Every one starts with the one session check (../session/session.ts)
// and works only on the caller's own record: facilitator views of others come in phase 3.
import {
  isJsonContentType,
  jsonResponse,
  readJsonObject,
  unsupportedMediaTypeResponse,
  type HttpRequest,
  type HttpResponse,
} from "../http.js";
import { requireSession, type ParticipantRecord, type SessionReader } from "../session/session.js";
import { errorName } from "../sign-in/code-request.js";

export const ME_ROUTE = "GET /api/me";
export const NICKNAME_ROUTE = "POST /api/me/nickname";
export const PARTICIPANT_ROUTE = "GET /api/participants/{id}";
export const PARTICIPANT_ROUTES = [ME_ROUTE, NICKNAME_ROUTE, PARTICIPANT_ROUTE] as const;

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
export const BAD_NICKNAME_REQUEST_MESSAGE = "Send a JSON body with a nickname.";
export const NICKNAME_MESSAGES = {
  rules: "A nickname has 3 to 20 letters, digits or dashes.",
  reserved: "That nickname is reserved. Please pick another one.",
  taken: "That nickname is already taken. Please pick another one.",
  "already-set": "You already have a nickname, and it can't be changed.",
} as const;

export type ClaimResult = "saved" | "taken" | "already-set";

/** What the participant routes need from the table. */
export interface ParticipantStore extends SessionReader {
  /**
   * In one transaction: claims the nickname (lower-cased key, only if unclaimed) and sets it on the
   * participant's profile, moving the step from `nickname` to `clarify` (only if no nickname yet).
   */
  claimNickname(participantId: string, nickname: string, nowIso: string): Promise<ClaimResult>;
}

export type ParticipantRoute = "me" | "nickname" | "participant" | "unknown";
export type ParticipantOutcome =
  | "ok"
  | "unauthorized"
  | "not-found"
  | "rules"
  | "reserved"
  | "taken"
  | "already-set"
  | "invalid-request"
  | "unsupported-media-type"
  | "failed";

/** The only things ever logged: no nickname, no id, no token, no body. */
export interface ParticipantLogEntry {
  event: "participant";
  route: ParticipantRoute;
  outcome: ParticipantOutcome;
  error?: string;
}

export interface ParticipantDeps {
  store: ParticipantStore;
  now: () => Date;
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

async function route(request: HttpRequest, deps: ParticipantDeps, which: ParticipantRoute) {
  const session = await requireSession(request, { sessions: deps.store, now: deps.now });
  if (!session.ok) return { outcome: "unauthorized" as const, response: session.response };
  const { participant } = session;
  switch (which) {
    case "me":
      return { outcome: "ok" as const, response: jsonResponse(200, recordBody(participant)) };
    case "participant":
      // Only the caller's own id: any other id, existing or not, gets the same 404 (no read).
      if (request.pathParameters?.["id"] !== participant.id) return { outcome: "not-found" as const, response: notFoundResponse() };
      return { outcome: "ok" as const, response: jsonResponse(200, recordBody(participant)) };
    case "nickname":
      return setNickname(request, participant, deps);
    default:
      return { outcome: "not-found" as const, response: notFoundResponse() };
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
