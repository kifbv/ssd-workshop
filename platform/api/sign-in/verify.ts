// `POST /api/sign-in/verify` (ticket 1.5): checks a sign-in code and starts a session. The rules
// live here, with the table behind a small interface so every rule is unit tested with in-memory
// fakes; the wiring to AWS is in ./verify-store.ts and ../handlers/sign-in-verify.ts.
//
// Every refusal (an address not on the list, no live code, an expired code, a wrong code, a burned
// code, a lost race, a failure or work still running at the deadline) gets the same 401, sent at
// the same fixed time as a success (ANSWER_AFTER_MS after the start), so neither the answer nor its
// timing tells who is on the list. Personal data: the address, the code and the session token
// never reach a log line, an error message or the answer body.
import {
  isJsonContentType,
  jsonResponse,
  readJsonObject,
  unsupportedMediaTypeResponse,
  type HttpRequest,
  type HttpResponse,
} from "../http.js";
import { newParticipantId } from "../keys.js";
import { hashToken, newSessionToken, sessionCookie, SESSION_TTL_SECONDS } from "../session/session.js";
import type { Role, Step } from "../types.js";
import { ANSWER_AFTER_MS, errorName, liveCodes, parseEmailField, verifyAnyCode, type StoredCodes } from "./code-request.js";

/** Wrong tries shared by all of an address's live codes; at the fifth the codes are burned. */
export const MAX_ATTEMPTS = 5;
/** Tries at deleting a matched codes item when another request wrote it in between. */
const CODE_WRITE_TRIES = 3;
const CODE_PATTERN = /^[0-9]{6}$/;

export const WRONG_CODE_MESSAGE = "That code is not right or has expired. Ask for a new one.";
export const BAD_VERIFY_MESSAGE = "Send a JSON body with your email address and the 6-digit code.";

/** The one answer to every refusal (a fresh copy each time). */
export function refusedResponse(): HttpResponse {
  return jsonResponse(401, { message: WRONG_CODE_MESSAGE });
}

export function badVerifyResponse(): HttpResponse {
  return jsonResponse(400, { message: BAD_VERIFY_MESSAGE });
}

/** `{"email", "code"}`, possibly base64; undefined when malformed (syntax only, never the list). */
export function parseVerifyRequest(request: HttpRequest): { email: string; code: string } | undefined {
  const body = readJsonObject(request);
  const email = parseEmailField(body?.["email"]);
  const code = body?.["code"];
  if (email === undefined || typeof code !== "string") return undefined;
  const trimmed = code.trim();
  return CODE_PATTERN.test(trimmed) ? { email, code: trimmed } : undefined;
}

/** What the code check reads from an allow-list entry (only entries with an `email` count). */
export interface AllowEntry {
  group: string;
  role: Role;
  participantId?: string;
}

/** What the code check needs from the table. */
export interface VerifyStore {
  /** The entry, if the address is listed (an entry without `email` or with an unknown role is not). */
  getAllowEntry(email: string): Promise<AllowEntry | undefined>;
  getCode(email: string): Promise<StoredCodes | undefined>;
  /**
   * Counts one wrong try atomically (whatever other requests did in between) and bumps the version;
   * returns the new `attempts` and `version`, or undefined when the codes item no longer exists.
   */
  addWrongTry(email: string): Promise<{ attempts: number; version: number } | undefined>;
  /** Deletes the codes item if it is still at `expectedVersion`; false otherwise. */
  deleteCode(email: string, expectedVersion: number): Promise<boolean>;
  /** Links the entry to a participant if it still exists and has none yet; false otherwise. */
  linkParticipant(email: string, participantId: string): Promise<boolean>;
  /**
   * Creates the participant's profile (step `nickname`) or refreshes role and group of an existing
   * one; returns the participant's step.
   */
  upsertProfile(participantId: string, role: Role, group: string, nowIso: string): Promise<Step>;
  putSession(tokenHash: string, participantId: string, createdAtIso: string, expiresAt: number): Promise<void>;
}

export type VerifyOutcome =
  | "signed-in"
  | "not-listed"
  | "no-code"
  | "wrong-code"
  | "burned"
  | "conflict"
  | "invalid-request"
  | "unsupported-media-type"
  | "failed";
export type VerifyStep = "allow-list" | "code" | "participant" | "session";

/** The only things ever logged: no address, no code, no token, no body. */
export interface VerifyLogEntry {
  event: "sign-in-verify";
  outcome: VerifyOutcome;
  step?: VerifyStep;
  /** An error's `name` only. */
  error?: string;
}

export interface VerifyDeps {
  store: VerifyStore;
  now: () => Date;
  randomBytes: (size: number) => Buffer;
  randomUUID: () => string;
  log: (entry: VerifyLogEntry) => void;
  /** Resolves after `ms` milliseconds (tests pass fake timers). */
  sleep: (ms: number) => Promise<void>;
}

type CodeCheck = "match" | "no-code" | "wrong-code" | "burned" | "conflict";

/**
 * Checks `code` against the address's live codes. A match deletes the codes item (no code can be
 * used again), conditional on the version read; on a conflict it reads again (3 times). A wrong
 * try is always counted, with one atomic add to the shared `attempts` (never lost to a race, so a
 * burst of parallel guesses gets at most 4 refusals before the burn); the add that reaches 5 burns
 * the whole item. A wrong try on an item that vanished meanwhile is simply refused.
 */
async function checkCode(store: VerifyStore, email: string, code: string, nowSeconds: number): Promise<CodeCheck> {
  for (let i = 0; i < CODE_WRITE_TRIES; i++) {
    const stored = await store.getCode(email);
    const live = liveCodes(stored?.codes ?? [], nowSeconds);
    if (stored === undefined || live.length === 0) return "no-code";
    if (stored.attempts >= MAX_ATTEMPTS) {
      // Burned by an earlier wrong try whose delete lost a race; refuse and burn.
      await store.deleteCode(email, stored.version);
      return "burned";
    }
    if (await verifyAnyCode(code, live, nowSeconds)) {
      if (await store.deleteCode(email, stored.version)) return "match";
      continue;
    }
    const counted = await store.addWrongTry(email);
    if (counted === undefined) return "no-code";
    if (counted.attempts >= MAX_ATTEMPTS) {
      // If a later write wins the delete race, the item keeps attempts >= 5 and every read burns it.
      await store.deleteCode(email, counted.version);
      return "burned";
    }
    return "wrong-code";
  }
  return "conflict";
}

/** The participant linked to the entry, linking a new one on the first sign-in. */
async function participantFor(deps: VerifyDeps, email: string, entry: AllowEntry): Promise<string | undefined> {
  if (entry.participantId !== undefined) return entry.participantId;
  const id = newParticipantId(deps.randomUUID);
  if (await deps.store.linkParticipant(email, id)) return id;
  // Another sign-in of the same person linked one first (or the entry is gone).
  return (await deps.store.getAllowEntry(email))?.participantId;
}

interface Progress {
  step: VerifyStep;
  timedOut: boolean;
}

type Signed = { next: Step; cookie: string };

/** The work behind a well-formed request. Never throws; logs its one outcome unless timed out. */
async function signIn(email: string, code: string, deps: VerifyDeps, progress: Progress): Promise<Signed | undefined> {
  const log = (entry: VerifyLogEntry): void => {
    if (!progress.timedOut) deps.log(entry);
  };
  try {
    const entry = await deps.store.getAllowEntry(email);
    if (entry === undefined) {
      log({ event: "sign-in-verify", outcome: "not-listed" });
      return undefined;
    }

    progress.step = "code";
    const now = deps.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const check = await checkCode(deps.store, email, code, nowSeconds);
    if (check !== "match") {
      log({ event: "sign-in-verify", outcome: check });
      return undefined;
    }

    progress.step = "participant";
    const participantId = await participantFor(deps, email, entry);
    if (participantId === undefined) {
      log({ event: "sign-in-verify", outcome: "conflict", step: progress.step });
      return undefined;
    }
    // Role and group follow the allow-list at every sign-in.
    const step = await deps.store.upsertProfile(participantId, entry.role, entry.group, now.toISOString());

    progress.step = "session";
    const token = newSessionToken(deps.randomBytes);
    await deps.store.putSession(hashToken(token), participantId, now.toISOString(), nowSeconds + SESSION_TTL_SECONDS);
    log({ event: "sign-in-verify", outcome: "signed-in" });
    return { next: step, cookie: sessionCookie(token) };
  } catch (error) {
    log({ event: "sign-in-verify", outcome: "failed", step: progress.step, error: errorName(error) });
    return undefined;
  }
}

/**
 * A request without the JSON content type gets its 415, and a malformed one its 400, at once (both
 * depend only on the request's syntax). Every other request is answered exactly ANSWER_AFTER_MS
 * after the start: 200 `{"next": <step>}` with the session cookie, or the one 401.
 */
export async function verifySignIn(request: HttpRequest, deps: VerifyDeps): Promise<HttpResponse> {
  const deadline = deps.sleep(ANSWER_AFTER_MS);
  if (!isJsonContentType(request)) {
    deps.log({ event: "sign-in-verify", outcome: "unsupported-media-type" });
    return unsupportedMediaTypeResponse();
  }
  const parsed = parseVerifyRequest(request);
  if (parsed === undefined) {
    deps.log({ event: "sign-in-verify", outcome: "invalid-request" });
    return badVerifyResponse();
  }

  const progress: Progress = { step: "allow-list", timedOut: false };
  const result = await Promise.race([
    signIn(parsed.email, parsed.code, deps, progress).then((signed) => ({ signed })),
    deadline.then(() => undefined),
  ]);
  if (result === undefined) {
    progress.timedOut = true;
    deps.log({ event: "sign-in-verify", outcome: "failed", step: progress.step, error: "Timeout" });
  }
  await deadline;
  const signed = result?.signed;
  if (signed === undefined) return refusedResponse();
  return { ...jsonResponse(200, { next: signed.next }), cookies: [signed.cookie] };
}
