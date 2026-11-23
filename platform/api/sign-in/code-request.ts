// `POST /api/sign-in/code` (ticket 1.4): the rules, with the table and SES behind small interfaces
// so every rule is unit tested with in-memory fakes. The wiring to AWS is in ./store.ts, ./mailer.ts
// and ../handlers/sign-in-code.ts.
//
// Personal data: the email address and the code never reach a log line, an error message or the
// response. The response is the same, byte for byte, whether the address is listed or not, is over
// its hourly limit, or the table or SES failed, so it never tells who is on the list.
import { scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { isValidEmail } from "../email.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { normalizeEmail } from "../keys.js";
import type { CodeItem } from "../types.js";
import { buildCodeEmail, type CodeEmail } from "./code-email.js";

/** A code is valid for 10 minutes. */
export const CODE_TTL_SECONDS = 600;
/** At most 5 codes per email in any 60-minute window (sliding). */
export const RATE_WINDOW_SECONDS = 3600;
export const MAX_CODES_PER_WINDOW = 5;
/** Larger bodies are refused before parsing (an email request is a few dozen bytes). */
export const MAX_BODY_BYTES = 2048;
/** RFC 5321: 64 characters of local part, `@`, 255 of domain. */
export const MAX_EMAIL_LENGTH = 320;

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

export const NEUTRAL_MESSAGE =
  "If this address is on the workshop list, a sign-in code is on its way. It can take a minute; check your Junk folder too.";
export const BAD_REQUEST_MESSAGE = "Send a JSON body with one email address.";

/** The one answer to every well-formed request (a fresh copy each time, so no caller can change it). */
export function neutralResponse(): HttpResponse {
  return { statusCode: 202, headers: { ...JSON_HEADERS }, body: JSON.stringify({ message: NEUTRAL_MESSAGE }) };
}

/** A malformed request: generic, never echoes the input. */
export function badRequestResponse(): HttpResponse {
  return { statusCode: 400, headers: { ...JSON_HEADERS }, body: JSON.stringify({ message: BAD_REQUEST_MESSAGE }) };
}

/** `{"email": "..."}`, possibly base64; returns the normalized address, or undefined when malformed. */
export function parseCodeRequest(request: HttpRequest): string | undefined {
  if (typeof request.body !== "string") return undefined;
  const raw = request.isBase64Encoded === true ? Buffer.from(request.body, "base64").toString("utf8") : request.body;
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const email = (parsed as Record<string, unknown>)["email"];
  if (typeof email !== "string") return undefined;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > MAX_EMAIL_LENGTH || !isValidEmail(trimmed)) return undefined;
  return normalizeEmail(trimmed);
}

/** The sends still inside the window at `nowSeconds`, oldest first. */
export function recentSends(sentAt: readonly number[], nowSeconds: number): number[] {
  return sentAt.filter((t) => t > nowSeconds - RATE_WINDOW_SECONDS && t <= nowSeconds).sort((a, b) => a - b);
}

/** A 6-digit code, zero-padded, from a uniform source such as `crypto.randomInt`. */
export function generateCode(randomInt: (min: number, max: number) => number): string {
  const n = randomInt(0, 1_000_000);
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) throw new Error("random source out of range");
  return String(n).padStart(6, "0");
}

// scrypt with Node's default cost (N=2^14, r=8, p=1): tens of milliseconds per try, so guessing
// a code from a leaked hash costs hours of CPU against a 10-minute lifetime. Not a substitute for
// a secret pepper (none is available without a new paid service; see docs/decisions.md).
const SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function scrypt(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(code, salt, KEY_LENGTH, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** `scrypt$<salt hex>$<hash hex>`: the code itself is never stored. */
export async function hashCode(code: string, salt: Buffer): Promise<string> {
  if (salt.length < SALT_LENGTH) throw new Error("salt too short");
  const key = await scrypt(code, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** True when `code` matches a `hashCode` result (constant-time compare; for ticket 1.5). */
export async function verifyCode(code: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex, ...rest] = stored.split("$");
  if (scheme !== "scrypt" || saltHex === undefined || hashHex === undefined || rest.length > 0) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length < SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
  return timingSafeEqual(await scrypt(code, salt), expected);
}

export interface CodeRequests {
  /** Epoch seconds of the sends on record. */
  sentAt: number[];
  version: number;
}

/** What the code request needs from the table. Only allow-listed emails are ever written. */
export interface SignInStore {
  isAllowListed(email: string): Promise<boolean>;
  getCodeRequests(email: string): Promise<CodeRequests | undefined>;
  /**
   * Writes the sends of the window if the item is still at `expectedVersion` (undefined: it must
   * not exist yet). False when another request wrote first.
   */
  putCodeRequests(
    email: string,
    sentAt: number[],
    expiresAt: number,
    expectedVersion: number | undefined,
  ): Promise<boolean>;
  /** Replaces the email's code. */
  putCode(email: string, code: Omit<CodeItem, "pk" | "sk" | "type">): Promise<void>;
}

export interface CodeMailer {
  send(to: string, email: CodeEmail): Promise<void>;
}

export type Outcome = "sent" | "not-listed" | "rate-limited" | "conflict" | "invalid-request" | "failed";
export type Step = "allow-list" | "rate-limit" | "code" | "email";

/** The only things ever logged: no address, no code, no request body. */
export interface LogEntry {
  event: "sign-in-code";
  outcome: Outcome;
  step?: Step;
  /** An error's `name` only (its message can hold the address). */
  error?: string;
}

export interface CodeRequestDeps {
  store: SignInStore;
  mailer: CodeMailer;
  now: () => Date;
  randomInt: (min: number, max: number) => number;
  randomBytes: (size: number) => Buffer;
  log: (entry: LogEntry) => void;
}

/** An error's name if it looks like an identifier, else "Error": the name is all that is logged. */
export function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
}

export async function requestCode(request: HttpRequest, deps: CodeRequestDeps): Promise<HttpResponse> {
  const email = parseCodeRequest(request);
  if (email === undefined) {
    deps.log({ event: "sign-in-code", outcome: "invalid-request" });
    return badRequestResponse();
  }

  let step: Step = "allow-list";
  try {
    if (!(await deps.store.isAllowListed(email))) {
      deps.log({ event: "sign-in-code", outcome: "not-listed" });
      return neutralResponse();
    }

    step = "rate-limit";
    const now = deps.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const previous = await deps.store.getCodeRequests(email);
    const recent = recentSends(previous?.sentAt ?? [], nowSeconds);
    if (recent.length >= MAX_CODES_PER_WINDOW) {
      deps.log({ event: "sign-in-code", outcome: "rate-limited" });
      return neutralResponse();
    }
    // Counted before the send: a send that then fails still uses one of the five.
    const written = await deps.store.putCodeRequests(
      email,
      [...recent, nowSeconds],
      nowSeconds + RATE_WINDOW_SECONDS,
      previous?.version,
    );
    if (!written) {
      deps.log({ event: "sign-in-code", outcome: "conflict" });
      return neutralResponse();
    }

    step = "code";
    const code = generateCode(deps.randomInt);
    await deps.store.putCode(email, {
      codeHash: await hashCode(code, deps.randomBytes(SALT_LENGTH)),
      expiresAt: nowSeconds + CODE_TTL_SECONDS,
      attempts: 0,
      createdAt: now.toISOString(),
    });

    step = "email";
    await deps.mailer.send(email, buildCodeEmail(code));
    deps.log({ event: "sign-in-code", outcome: "sent" });
  } catch (error) {
    deps.log({ event: "sign-in-code", outcome: "failed", step, error: errorName(error) });
  }
  return neutralResponse();
}
