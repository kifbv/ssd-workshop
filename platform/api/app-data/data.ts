// The data API for participants' apps (ticket 2.4): `GET`, `PUT` and `DELETE
// /api/apps/{nickname}/data/{key}`, JSON values that anyone with the app's address may read and write
// (the spec: apps have no sign-in). Apps run sandboxed (opaque origin), so every answer carries
// `Access-Control-Allow-Origin: *`, and `OPTIONS` answers the preflight a JSON `PUT` causes. The
// client is templates/basic/workshop-data.js; the contract is in docs/decisions.md ("(2.3) Data API
// contract for 2.4").
//
// Never reads the request's cookies (or a cookie header) and never sets one: the platform's session
// means nothing here. Never logs a nickname, a key or a value: only method, outcome, status and size.
import { isJsonContentType, UNSUPPORTED_MEDIA_TYPE_MESSAGE, type HttpRequest, type HttpResponse } from "../http.js";
import { checkNickname } from "../participant/participant.js";
import { errorName } from "../sign-in/code-request.js";

export const APP_DATA_PATH = "/api/apps/{nickname}/data/{key}";
export const APP_DATA_METHODS = ["GET", "PUT", "DELETE", "OPTIONS"] as const;
export type AppDataMethod = (typeof APP_DATA_METHODS)[number];
export const APP_DATA_ROUTES = APP_DATA_METHODS.map((method) => `${method} ${APP_DATA_PATH}`);

/** All of an app's values together: 10 MB (UTF-8 bytes of their canonical JSON; ticket 3.17, was 1 MB). */
export const MAX_APP_DATA_BYTES = 10 * 1024 * 1024;
/**
 * One value: 350 KB (UTF-8 bytes of its canonical JSON; ticket 3.17, was 100 KB). DynamoDB's item limit
 * is 400 KB, names and keys included: 350 KB plus VALUE_ITEM_OVERHEAD_BYTES leaves ~50 KB spare (store.test.ts).
 */
export const MAX_VALUE_BYTES = 350 * 1024;
/** Keys per app (ticket 3.17, was 100): the totals item then holds at most ~35.4 KB of `sizes` (usageItemBytes). */
export const MAX_KEYS = 500;
/** Lists and objects inside each other: deeper values would overflow the stack when written out. */
export const MAX_DEPTH = 100;
/** 1 to 64 letters, digits, dashes or underscores (ASCII). */
export const DATA_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * A write that lost a race with another write reads again and tries again, this many times in all,
 * after a short random pause (RETRY_PAUSE_MS): every write of one app updates the same totals item,
 * so writes at the same moment (a shared counter pressed by several visitors) cancel each other with
 * `TransactionConflict` on DynamoDB, and retrying at once would collide again.
 */
export const WRITE_ATTEMPTS = 4;
/** The pause before another try: a random whole number of milliseconds in this range. */
export const RETRY_PAUSE_MS = { min: 20, max: 80 } as const;
/**
 * What an app's writes may count per UTC day (its daily write budget, ticket 3.17: 50 MB, was 5 MB),
 * see writeCost: about 25,000 small writes, ample for a workshop app, while a loop replacing one 350 KB
 * value stops after 145. DynamoDB bills a transactional write 2 write units per KB of each item
 * (rounded up, the larger of the old and new item), which writeCost counts: 50 MB is 51,200 KB, so
 * ~0.1 M write units, ~$0.078 per app and day ($0.7625 per million in eu-central-1, on demand), at
 * worst; ~30 live apps: ~3.1 M write units, ~$2.34 a day, ~$70 a month if every app spent its whole
 * budget every day.
 */
export const DAILY_WRITE_BUDGET_BYTES = 50 * 1024 * 1024;
/** DynamoDB's write unit: what a write counts towards the budget is a whole number of these per item. */
export const MIN_WRITE_COST_BYTES = 1024;
/** A value item's bytes beyond its value (attribute names, keys, type, size, time): an upper bound. */
export const VALUE_ITEM_OVERHEAD_BYTES = 256;
/** The totals item's bytes beyond its `sizes` entries (attribute names, keys, totals, day): an upper bound. */
export const USAGE_ITEM_BASE_BYTES = 256;
/** One `sizes` entry beyond its key's length (a number of at most 6 digits and the map's overhead): an upper bound. */
export const USAGE_ENTRY_BYTES = 8;
/** Base64 grows a body by 4/3: a raw body longer than this (477,868 bytes, ~467 KB) cannot decode to 350 KB or less. */
const MAX_RAW_BASE64_BYTES = Math.ceil(MAX_VALUE_BYTES / 3) * 4;

/** On every answer: any origin may read it (apps run in an opaque origin). Never with credentials. */
export const CORS_HEADERS = { "access-control-allow-origin": "*" } as const;
/** The preflight's answer: what workshop-data.js sends, cached by the browser for 10 minutes. */
export const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  "access-control-allow-methods": "GET, PUT, DELETE",
  "access-control-allow-headers": "content-type, accept",
  "access-control-max-age": "600",
  "cache-control": "no-store",
} as const;
const JSON_ANSWER_HEADERS = { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS } as const;
const EMPTY_ANSWER_HEADERS = { "cache-control": "no-store", ...CORS_HEADERS } as const;

/** The plain reasons apps show their visitors (workshop-data.js shows `message`). */
export const APP_DATA_MESSAGES = {
  notFound: "Not found.",
  badKey: "A key has 1 to 64 letters, digits, dashes or underscores.",
  badJson: "Send the value as JSON.",
  tooDeep: "This value is nested too deeply: lists and objects can go at most 100 levels deep.",
  valueTooBig: "This value is too big: a value can hold at most 350 KB.",
  appFull: "This app has no room left: an app can store at most 10 MB.",
  tooManyKeys: "This app already has 500 keys, the most it can keep. Remove one to add another.",
  conflict: "This value was being changed by someone else at the same moment. Please try again.",
  writeBudget: "This app has saved a lot of data today. Saving starts again tomorrow.",
  failed: "The data service had a problem. Please try again in a moment.",
} as const;

export interface AppUsage {
  /** Sum of the values' bytes. */
  bytes: number;
  keys: number;
  /** Each stored value's bytes, by key (the totals item's `sizes` map). */
  sizes: ReadonlyMap<string, number>;
  /** False until the app's first write creates the totals item. */
  created: boolean;
  /** The UTC day (YYYY-MM-DD) `writtenBytes` counts, undefined before the app's first write. */
  writeDay: string | undefined;
  /** What the app's writes on `writeDay` counted towards the daily write budget. */
  writtenBytes: number;
}

/**
 * What a write counts towards the daily budget. `sameDay`: the totals read showed writes of `today`
 * already, so the store adds `cost` to them (only while still today's and within the budget);
 * otherwise the store starts today's count at `cost` (only while no write of today got in first).
 */
export interface WriteCharge {
  /** UTC day, YYYY-MM-DD. */
  today: string;
  cost: number;
  sameDay: boolean;
}

/** `conflict`: the totals item changed since it was read (another write, or a limit reached since). */
export type PutResult = "saved" | "conflict";
export type DeleteResult = "deleted" | "conflict";

/** What the data API needs from the table. Nicknames are matched lower-cased. */
export interface AppDataStore {
  /** True once the deployer (ticket 2.5) has marked the app live. */
  isLive(nickname: string): Promise<boolean>;
  /** The stored canonical JSON text, or undefined (an eventually consistent read: GET only). */
  getValue(nickname: string, key: string): Promise<string | undefined>;
  /** The totals item: all a write reads (a write never reads the value item, which bills by its size). */
  getUsage(nickname: string): Promise<AppUsage>;
  /**
   * In one all-or-nothing step: stores the value and moves the totals by the change, only while the
   * key's size in the totals item is still `previousBytes` (undefined: none stored), the totals item
   * exists as read (`created`), the totals stay within 10 MB and 500 keys, and the day's writes stay
   * within the budget (`charge`).
   */
  putValue(nickname: string, key: string, json: string, bytes: number, previousBytes: number | undefined, created: boolean, nowIso: string, charge: WriteCharge): Promise<PutResult>;
  /** Like putValue: removes the value and takes it off the totals, only while its size is still `previousBytes`. */
  deleteValue(nickname: string, key: string, previousBytes: number, nowIso: string, charge: WriteCharge): Promise<DeleteResult>;
}

export type AppDataOutcome =
  | "read"
  | "saved"
  | "deleted"
  | "preflight"
  | "not-found"
  | "bad-key"
  | "bad-json"
  | "too-deep"
  | "unsupported-media-type"
  | "value-too-big"
  | "app-full"
  | "too-many-keys"
  | "conflict"
  | "write-budget"
  | "failed";

/** The only things ever logged: no nickname, no key, no value, no header. */
export interface AppDataLogEntry {
  event: "app-data";
  method: AppDataMethod | "other";
  outcome: AppDataOutcome;
  status: number;
  /** The value's size (reads and writes that got that far). */
  bytes?: number;
  /** The error's name (failures only). */
  error?: string;
}

export interface AppDataDeps {
  store: AppDataStore;
  now: () => Date;
  log: (entry: AppDataLogEntry) => void;
  /** Waits before another try after a lost race (`pauseBeforeRetry` in the function; tests pass no wait). */
  pause: () => Promise<void>;
}

/** A random whole number of milliseconds within RETRY_PAUSE_MS. */
export function retryPauseMs(random: () => number): number {
  const { min, max } = RETRY_PAUSE_MS;
  return Math.min(max, min + Math.floor(random() * (max - min + 1)));
}

/** Waits RETRY_PAUSE_MS (random) before another try. */
export function pauseBeforeRetry(random: () => number = Math.random): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, retryPauseMs(random)));
}

/** UTC day of a time, YYYY-MM-DD: the daily write budget starts again at midnight UTC. */
const utcDay = (time: Date): string => time.toISOString().slice(0, 10);

/** `bytes` rounded up to whole write units (1 KB), at least one. */
const writeUnits = (bytes: number): number => Math.max(1, Math.ceil(bytes / MIN_WRITE_COST_BYTES)) * MIN_WRITE_COST_BYTES;

/**
 * An upper bound of the totals item's bytes while it holds `key` (each `sizes` entry is its key's
 * length plus USAGE_ENTRY_BYTES): an app with 500 keys of 64 characters has a totals item of ~35.4 KB,
 * which every one of its writes rewrites.
 */
export function usageItemBytes(sizes: ReadonlyMap<string, number>, key: string): number {
  let total = USAGE_ITEM_BASE_BYTES;
  for (const k of new Set([...sizes.keys(), key])) total += k.length + USAGE_ENTRY_BYTES;
  return total;
}

/**
 * What a write counts towards the daily budget: what DynamoDB bills it, in KB. Both items the
 * transaction writes count, each rounded up to whole KB and at the larger of its old and new size:
 * the value item (`max(bytes, previousBytes)` plus its overhead, at least 1 KB; a DELETE has no new
 * value, so its old one counts) and the totals item. So a small write counts 2 KB, a 350 KB one 352 KB,
 * and replacing 350 KB with 1 byte still counts the 350 KB it overwrites.
 */
export function writeCost(bytes: number | undefined, previousBytes: number | undefined, sizes: ReadonlyMap<string, number>, key: string): number {
  return writeUnits(Math.max(bytes ?? 0, previousBytes ?? 0) + VALUE_ITEM_OVERHEAD_BYTES) + writeUnits(usageItemBytes(sizes, key));
}

/**
 * What a write of `cost` counts towards today's budget, or undefined when it would pass the budget.
 * A stored day other than today (older, or later when another instance's clock is ahead) gives a
 * new-day charge; the store's condition accepts it only over an older day, so a later one is a lost race.
 */
function chargeFor(usage: AppUsage, cost: number, now: Date): WriteCharge | undefined {
  const today = utcDay(now);
  const sameDay = usage.writeDay === today;
  const written = sameDay ? usage.writtenBytes : 0;
  return written + cost > DAILY_WRITE_BUDGET_BYTES ? undefined : { today, cost, sameDay };
}

interface Answer {
  outcome: AppDataOutcome;
  response: HttpResponse;
  bytes?: number;
}

function json(statusCode: number, body: string): HttpResponse {
  return { statusCode, headers: { ...JSON_ANSWER_HEADERS }, body };
}

function refuse(statusCode: number, outcome: AppDataOutcome, message: string): Answer {
  return { outcome, response: json(statusCode, JSON.stringify({ message })) };
}

const empty = (): HttpResponse => ({ statusCode: 204, headers: { ...EMPTY_ANSWER_HEADERS } });
const notFound = (): Answer => refuse(404, "not-found", APP_DATA_MESSAGES.notFound);
const LIMIT_ANSWERS = {
  "value-too-big": () => refuse(413, "value-too-big", APP_DATA_MESSAGES.valueTooBig),
  "app-full": () => refuse(413, "app-full", APP_DATA_MESSAGES.appFull),
  "too-many-keys": () => refuse(413, "too-many-keys", APP_DATA_MESSAGES.tooManyKeys),
} as const;
const overBudget = (): Answer => refuse(429, "write-budget", APP_DATA_MESSAGES.writeBudget);

function methodOf(request: HttpRequest): AppDataMethod | "other" {
  const index = APP_DATA_ROUTES.indexOf(request.routeKey ?? "");
  return APP_DATA_METHODS[index] ?? "other";
}

/**
 * How deep lists and objects go in valid JSON text, counting brackets outside strings; stops early
 * past `limit`. Linear, and never recursive (a recursive walk would overflow on deep values).
 */
export function nestingDepth(text: string, limit: number): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") {
      depth += 1;
      if (depth > deepest) deepest = depth;
      if (deepest > limit) return deepest;
    } else if (c === "]" || c === "}") depth -= 1;
  }
  return deepest;
}

type ReadValue = { ok: true; json: string; bytes: number } | { ok: false; answer: Answer };

/** The body as canonical JSON text within 350 KB, refusing too large bodies before parsing them. */
function readValue(request: HttpRequest): ReadValue {
  const body = request.body;
  if (typeof body !== "string" || body === "") return { ok: false, answer: refuse(400, "bad-json", APP_DATA_MESSAGES.badJson) };
  const base64 = request.isBase64Encoded === true;
  if (Buffer.byteLength(body, "utf8") > (base64 ? MAX_RAW_BASE64_BYTES : MAX_VALUE_BYTES)) {
    return { ok: false, answer: LIMIT_ANSWERS["value-too-big"]() };
  }
  const raw = base64 ? Buffer.from(body, "base64").toString("utf8") : body;
  if (Buffer.byteLength(raw, "utf8") > MAX_VALUE_BYTES) return { ok: false, answer: LIMIT_ANSWERS["value-too-big"]() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, answer: refuse(400, "bad-json", APP_DATA_MESSAGES.badJson) };
  }
  if (nestingDepth(raw, MAX_DEPTH) > MAX_DEPTH) return { ok: false, answer: refuse(400, "too-deep", APP_DATA_MESSAGES.tooDeep) };
  const canonical = JSON.stringify(parsed);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > MAX_VALUE_BYTES) return { ok: false, answer: LIMIT_ANSWERS["value-too-big"]() };
  return { ok: true, json: canonical, bytes };
}

async function putValue(request: HttpRequest, nickname: string, key: string, deps: AppDataDeps): Promise<Answer> {
  if (!isJsonContentType(request)) return refuse(415, "unsupported-media-type", UNSUPPORTED_MEDIA_TYPE_MESSAGE);
  const value = readValue(request);
  if (!value.ok) return value.answer;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.pause();
    // One read, of the small totals item, before anything else; the limits and the budget come from it.
    const usage = await deps.store.getUsage(nickname);
    const previous = usage.sizes.get(key);
    const keys = usage.keys + (previous === undefined ? 1 : 0);
    const bytes = usage.bytes - (previous ?? 0) + value.bytes;
    // Precise reasons from what was read; the store's conditions hold the limits against races.
    if (keys > MAX_KEYS) return { ...LIMIT_ANSWERS["too-many-keys"](), bytes: value.bytes };
    if (bytes > MAX_APP_DATA_BYTES) return { ...LIMIT_ANSWERS["app-full"](), bytes: value.bytes };
    const now = deps.now();
    const charge = chargeFor(usage, writeCost(value.bytes, previous, usage.sizes, key), now);
    if (charge === undefined) return { ...overBudget(), bytes: value.bytes };
    const result = await deps.store.putValue(nickname, key, value.json, value.bytes, previous, usage.created, now.toISOString(), charge);
    if (result === "saved") return { outcome: "saved", response: empty(), bytes: value.bytes };
    // Someone wrote in between (or a limit was reached since): read again (a real limit is then reported).
  }
  return { ...refuse(409, "conflict", APP_DATA_MESSAGES.conflict), bytes: value.bytes };
}

async function deleteValue(nickname: string, key: string, deps: AppDataDeps): Promise<Answer> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.pause();
    const usage = await deps.store.getUsage(nickname);
    const previous = usage.sizes.get(key);
    // Nothing to remove: no write, nothing counted.
    if (previous === undefined) return { outcome: "deleted", response: empty() };
    const now = deps.now();
    const charge = chargeFor(usage, writeCost(undefined, previous, usage.sizes, key), now);
    if (charge === undefined) return overBudget();
    if ((await deps.store.deleteValue(nickname, key, previous, now.toISOString(), charge)) === "deleted") {
      return { outcome: "deleted", response: empty() };
    }
  }
  return refuse(409, "conflict", APP_DATA_MESSAGES.conflict);
}

async function route(request: HttpRequest, method: AppDataMethod | "other", deps: AppDataDeps): Promise<Answer> {
  if (method === "other") return notFound();
  // The preflight carries no data and reads nothing: the same answer for every address.
  if (method === "OPTIONS") return { outcome: "preflight", response: { statusCode: 204, headers: { ...PREFLIGHT_HEADERS } } };
  const nickname = request.pathParameters?.["nickname"];
  const key = request.pathParameters?.["key"];
  // A nickname outside the 1.5 rules (or a reserved one) can never be an app: 404 without a read.
  if (typeof nickname !== "string" || checkNickname(nickname) !== "ok") return notFound();
  if (!(await deps.store.isLive(nickname))) return notFound();
  if (typeof key !== "string" || !DATA_KEY_PATTERN.test(key)) return refuse(400, "bad-key", APP_DATA_MESSAGES.badKey);
  switch (method) {
    case "GET": {
      const stored = await deps.store.getValue(nickname, key);
      // A missing key is `null`, never 404 (404 means the app is not live).
      const body = stored ?? "null";
      return { outcome: "read", response: json(200, body), bytes: Buffer.byteLength(body, "utf8") };
    }
    case "PUT":
      return putValue(request, nickname, key, deps);
    case "DELETE":
      return deleteValue(nickname, key, deps);
  }
}

/** Answers one request; table failures give a 500 with a plain message (logged by error name only). */
export async function handleAppDataRequest(request: HttpRequest, deps: AppDataDeps): Promise<HttpResponse> {
  const method = methodOf(request);
  try {
    const { outcome, response, bytes } = await route(request, method, deps);
    deps.log({ event: "app-data", method, outcome, status: response.statusCode, ...(bytes === undefined ? {} : { bytes }) });
    return response;
  } catch (error) {
    deps.log({ event: "app-data", method, outcome: "failed", status: 500, error: errorName(error) });
    return json(500, JSON.stringify({ message: APP_DATA_MESSAGES.failed }));
  }
}
