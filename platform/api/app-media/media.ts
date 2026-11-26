// The media API for participants' apps (ticket 3.18): `PUT` and `DELETE /api/apps/{nickname}/media/{id}` (and the
// `OPTIONS` preflight). A `PUT` takes a photo (JPEG) or a voice recording (WebM/Opus, Ogg/Opus, MP4 with AAC or Opus)
// as the request's body, at most 4 MB, checks the app is live, the token (3.24), the bytes' real format (./formats.ts,
// never the declared type), the app's room (500 MB, 2,000 files, photos and recordings together) and its daily upload
// budget (500 MB), removes a photo's metadata (the location), and stores the file in the media bucket under
// `app-media/<lower-cased nickname>/<id>`, served by CloudFront at the same path; it answers the file's address.
// `DELETE` removes one file of that app. The client is 3.19's workshop-data.js; the contract is in docs/decisions.md
// ("(3.18) ...").
//
// The id is the client's (a random 22-character base64url name, 132 bits), strictly checked, so a key can only ever be
// `app-media/<this app>/<one id>`: no other app's file, no path. A file is created once (an id already used answers 409).
//
// Race safety: the room and the day's budget are taken in one DynamoDB transaction BEFORE the file goes to S3 (the
// file's record, `uploading`, created only if absent, and the app's totals moved only while they stay within the limits),
// so parallel uploads can never pass them; a failed upload gives the room back. The record turns `stored` only while
// the app is still live (a ConditionCheck on the live marker), so a reset that deleted the marker makes a late upload
// delete its own file. Never logs a token, an email, the app's nickname or an id: method, outcome, status, size, kind
// and (after the token check) the writer's nickname, like the data API.
import type { HttpRequest, HttpResponse } from "../http.js";
import { checkAppWrite, type AppTokenReader } from "../app-token/token.js";
import { CORS_HEADERS, retryPauseMs } from "../app-data/data.js";
import { checkNickname } from "../participant/participant.js";
import { SITE_DOMAIN } from "../settings.js";
import { errorName } from "../sign-in/code-request.js";
import { APP_SIGN_IN_TEXTS } from "../workshop/texts.js";
import { detectMedia, MEDIA_CONTENT_TYPES, stripJpegMetadata, type MediaKind } from "./formats.js";

export const APP_MEDIA_PATH = "/api/apps/{nickname}/media/{id}";
export const APP_MEDIA_METHODS = ["PUT", "DELETE", "OPTIONS"] as const;
export type AppMediaMethod = (typeof APP_MEDIA_METHODS)[number];
export const APP_MEDIA_ROUTES = APP_MEDIA_METHODS.map((method) => `${method} ${APP_MEDIA_PATH}`);

const MB = 1024 * 1024;
/**
 * One photo or recording: 4 MB (4,194,304 bytes, after a photo's metadata is removed it can only be smaller). Sent as
 * the body, API Gateway hands it to Lambda base64 (4/3 larger) inside a 6 MB invoke: ~5.6 MB plus the event fits.
 */
export const MAX_MEDIA_FILE_BYTES = 4 * MB;
/** All of an app's photos and recordings together: 500 MB. */
export const MAX_APP_MEDIA_BYTES = 500 * MB;
/** Photos and recordings per app. */
export const MAX_APP_MEDIA_FILES = 2000;
/** What an app may upload per UTC day (its daily upload budget): 500 MB, counted at upload and never given back. */
export const DAILY_UPLOAD_BUDGET_BYTES = 500 * MB;
/**
 * The least an upload counts towards the daily budget (please veto): 256 KB, so an app can make at most 2,000 uploads a
 * day (the same as its file limit) whatever their size: each upload costs requests (S3, DynamoDB, Lambda, API Gateway),
 * and tiny files would otherwise allow ~2 million a day under the 500 MB budget.
 */
export const MIN_UPLOAD_CHARGE_BYTES = 256 * 1024;
/**
 * An upload whose record is still `uploading` this long after it began has died (the function's timeout is far shorter):
 * a `DELETE` may then remove it. Before that, a `DELETE` answers 409 (the upload may still finish).
 */
export const UPLOAD_STALE_SECONDS = 120;
/** The client's random id: 22 base64url characters (16 random bytes, 128 bits, padded out to 132). */
export const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Where a file lives in the media bucket; CloudFront serves the same path at the workshop's address. */
export const MEDIA_KEY_PREFIX = "app-media/";
/** Base64 grows a body by 4/3: a raw body longer than this cannot decode to 4 MB or less. */
const MAX_RAW_BASE64_BYTES = Math.ceil(MAX_MEDIA_FILE_BYTES / 3) * 4;
/** Like the data API: every upload of one app updates the same totals item, so a lost race is tried again. */
export const UPLOAD_ATTEMPTS = 4;

/**
 * Stored with every file and served as is (S3 metadata; CloudFront's caching policy follows it). Browsers keep a file a
 * year (an id is never reused, so a file never changes); CloudFront at most a day (`s-maxage`), so a deleted file
 * leaves the edge caches within a day without an invalidation per delete (please veto).
 */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, s-maxage=86400, immutable";

/** The media bucket's key of a file: `app-media/<lower-cased nickname>/<id>`. */
export const mediaKey = (nickname: string, id: string): string => `${MEDIA_KEY_PREFIX}${nickname.toLowerCase()}/${id}`;
/** The file's public address: `https://workshop.rankly.games/app-media/<lower-cased nickname>/<id>`. */
export const mediaAddress = (nickname: string, id: string): string => `https://${SITE_DOMAIN}/${mediaKey(nickname, id)}`;

/** The preflight's answer: what workshop-data.js sends (its type, `Authorization`), cached by the browser for 10 minutes. */
export const MEDIA_PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  "access-control-allow-methods": "PUT, DELETE",
  "access-control-allow-headers": "content-type, accept, authorization",
  "access-control-max-age": "600",
  "cache-control": "no-store",
} as const;
const JSON_ANSWER_HEADERS = { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS } as const;

/** The plain reasons apps show their visitors (workshop-data.js shows `message`). */
export const APP_MEDIA_MESSAGES = {
  notFound: "Not found.",
  signInToSave: APP_SIGN_IN_TEXTS.signInToSave,
  badId: "A photo or recording id has 22 letters, digits, dashes or underscores.",
  noBody: "Send the photo or recording as the request's body.",
  fileTooBig: "This file is too big: a photo or recording can be at most 4 MB.",
  unsupported: "Send a photo as a JPEG, or a voice recording as WebM, Ogg or MP4 audio.",
  appFull: "This app has no room left for photos and recordings: an app can keep at most 500 MB.",
  tooManyFiles: "This app already keeps 2,000 photos and recordings, the most it can keep. Delete one to add another.",
  uploadBudget: "This app has uploaded a lot today. Uploading starts again tomorrow.",
  idTaken: "A photo or recording with this id already exists. Use a new id.",
  uploading: "This photo or recording is still being uploaded. Please try again in a moment.",
  conflict: "This app's photos and recordings were being changed by someone else at the same moment. Please try again.",
  failed: "The media service had a problem. Please try again in a moment.",
} as const;

/** The app's media totals (`MEDIA_USAGE`): all a `PUT` reads before taking room. */
export interface MediaUsage {
  bytes: number;
  files: number;
  /** The UTC day (YYYY-MM-DD) `uploadedBytes` counts, undefined before the app's first upload. */
  uploadDay: string | undefined;
  uploadedBytes: number;
  /** False until the app's first upload creates the totals item. */
  created: boolean;
}

/** One file's record (`MEDIA#<id>`). */
export interface MediaRecord {
  bytes: number;
  status: "uploading" | "stored";
  /** When the upload began (ISO). */
  createdAt: string;
}

/** What an upload counts towards today's budget; `sameDay` as in the data API's WriteCharge. */
export interface UploadCharge {
  today: string;
  cost: number;
  sameDay: boolean;
}

export interface NewMedia {
  bytes: number;
  contentType: string;
  /** The writer's nickname (from the token). */
  uploadedBy: string;
}

/** `taken`: a record with this id exists; `conflict`: the totals changed since they were read (read again). */
export type ReserveResult = "reserved" | "taken" | "conflict";

/** What the media API needs from the table. Nicknames are matched lower-cased. */
export interface AppMediaStore {
  /** True once the deployer has marked the app live (`liveAt` on `APP#<nickname>`). */
  isLive(nickname: string): Promise<boolean>;
  getUsage(nickname: string): Promise<MediaUsage>;
  getRecord(nickname: string, id: string): Promise<MediaRecord | undefined>;
  /**
   * In one transaction: creates the file's record (`uploading`) only if absent, and moves the totals by one file and
   * its bytes and the day's uploads by `charge`, only while they stay within 500 MB, 2,000 files and the budget (and the
   * totals item exists as read, `created`).
   */
  reserve(nickname: string, id: string, file: NewMedia, nowIso: string, created: boolean, charge: UploadCharge): Promise<ReserveResult>;
  /** Marks the record `stored`, only while it is still `uploading` and the app still live; false otherwise. */
  finish(nickname: string, id: string): Promise<boolean>;
  /** Gives a failed upload's room back: deletes its record (only while `uploading`) and takes it off the totals (not the day's uploads). */
  release(nickname: string, id: string, bytes: number, nowIso: string): Promise<void>;
  /** Deletes the record and takes it off the totals, only while it is as read; `conflict` when it changed. */
  remove(nickname: string, id: string, record: MediaRecord, nowIso: string): Promise<"deleted" | "conflict">;
}

/** The media bucket. */
export interface MediaBucket {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type AppMediaOutcome =
  | "stored"
  | "deleted"
  | "preflight"
  | "not-found"
  | "unauthorized"
  | "bad-id"
  | "no-body"
  | "file-too-big"
  | "unsupported-media-type"
  | "app-full"
  | "too-many-files"
  | "upload-budget"
  | "id-taken"
  | "uploading"
  | "conflict"
  | "failed";

/** The only things ever logged: no app nickname, no id, no token or its hash, no email; the writer after the token check. */
export interface AppMediaLogEntry {
  event: "app-media";
  method: AppMediaMethod | "other";
  outcome: AppMediaOutcome;
  status: number;
  writer?: string;
  /** The file's size as stored (a photo's after its metadata went), on uploads that got that far. */
  bytes?: number;
  kind?: MediaKind;
  error?: string;
}

export interface AppMediaDeps {
  store: AppMediaStore;
  bucket: MediaBucket;
  tokens: AppTokenReader;
  now: () => Date;
  log: (entry: AppMediaLogEntry) => void;
  /** Waits before another try after a lost race (tests pass no wait). */
  pause: () => Promise<void>;
}

/** Waits a random 20 to 80 ms (the data API's RETRY_PAUSE_MS) before another try. */
export function pauseBeforeUploadRetry(random: () => number = Math.random): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, retryPauseMs(random)));
}

const utcDay = (time: Date): string => time.toISOString().slice(0, 10);

/** What an upload of `bytes` counts towards the day's budget (at least MIN_UPLOAD_CHARGE_BYTES), or undefined when it would pass it. */
export function uploadCharge(usage: MediaUsage, bytes: number, now: Date): UploadCharge | undefined {
  const today = utcDay(now);
  const sameDay = usage.uploadDay === today;
  const cost = Math.max(bytes, MIN_UPLOAD_CHARGE_BYTES);
  return (sameDay ? usage.uploadedBytes : 0) + cost > DAILY_UPLOAD_BUDGET_BYTES ? undefined : { today, cost, sameDay };
}

interface Answer {
  outcome: AppMediaOutcome;
  response: HttpResponse;
  bytes?: number;
  kind?: MediaKind;
}

const json = (statusCode: number, body: Record<string, unknown>): HttpResponse => ({ statusCode, headers: { ...JSON_ANSWER_HEADERS }, body: JSON.stringify(body) });
const refuse = (statusCode: number, outcome: AppMediaOutcome, message: string): Answer => ({ outcome, response: json(statusCode, { message }) });
const notFound = (): Answer => refuse(404, "not-found", APP_MEDIA_MESSAGES.notFound);

function methodOf(request: HttpRequest): AppMediaMethod | "other" {
  return APP_MEDIA_METHODS[APP_MEDIA_ROUTES.indexOf(request.routeKey ?? "")] ?? "other";
}

type ReadBody = { ok: true; bytes: Buffer } | { ok: false; answer: Answer };

/** The body's bytes (base64 from API Gateway for binary types), refusing a too large one before decoding it. */
function readBody(request: HttpRequest): ReadBody {
  const body = request.body;
  if (typeof body !== "string" || body === "") return { ok: false, answer: refuse(400, "no-body", APP_MEDIA_MESSAGES.noBody) };
  const base64 = request.isBase64Encoded === true;
  const tooBig = (): ReadBody => ({ ok: false, answer: refuse(413, "file-too-big", APP_MEDIA_MESSAGES.fileTooBig) });
  if (body.length > (base64 ? MAX_RAW_BASE64_BYTES : MAX_MEDIA_FILE_BYTES)) return tooBig();
  const bytes = base64 ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
  if (bytes.length > MAX_MEDIA_FILE_BYTES) return tooBig();
  return { ok: true, bytes };
}

/** Best effort: a failure here is left for a later `DELETE` or a reset (logged by the caller's outcome only). */
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    // Nothing to add: the record or the file stays, which a DELETE of the id or `npm run participant -- reset` removes.
  }
}

async function putMedia(request: HttpRequest, nickname: string, id: string, writer: string, deps: AppMediaDeps): Promise<Answer> {
  const body = readBody(request);
  if (!body.ok) return body.answer;
  const kind = detectMedia(body.bytes);
  if (kind === undefined) return refuse(415, "unsupported-media-type", APP_MEDIA_MESSAGES.unsupported);
  // detectMedia accepted the JPEG, so stripping it succeeds.
  const file = kind === "jpeg" ? (stripJpegMetadata(body.bytes) as Buffer) : body.bytes;
  const contentType = MEDIA_CONTENT_TYPES[kind];
  const sized = { bytes: file.length, kind };
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.pause();
    const usage = await deps.store.getUsage(nickname);
    // Precise reasons from what was read; the transaction's conditions hold the limits against races.
    if (usage.files + 1 > MAX_APP_MEDIA_FILES) return { ...refuse(413, "too-many-files", APP_MEDIA_MESSAGES.tooManyFiles), ...sized };
    if (usage.bytes + file.length > MAX_APP_MEDIA_BYTES) return { ...refuse(413, "app-full", APP_MEDIA_MESSAGES.appFull), ...sized };
    const now = deps.now();
    const charge = uploadCharge(usage, file.length, now);
    if (charge === undefined) return { ...refuse(429, "upload-budget", APP_MEDIA_MESSAGES.uploadBudget), ...sized };
    const reserved = await deps.store.reserve(nickname, id, { bytes: file.length, contentType, uploadedBy: writer }, now.toISOString(), usage.created, charge);
    if (reserved === "taken") return { ...refuse(409, "id-taken", APP_MEDIA_MESSAGES.idTaken), ...sized };
    if (reserved === "conflict") continue;
    const key = mediaKey(nickname, id);
    try {
      await deps.bucket.put(key, file, contentType);
    } catch (error) {
      await quietly(() => deps.store.release(nickname, id, file.length, deps.now().toISOString()));
      throw error;
    }
    if (!(await deps.store.finish(nickname, id))) {
      // The app stopped being live (a reset) or the record went meanwhile: the file must not stay.
      await quietly(() => deps.bucket.delete(key));
      await quietly(() => deps.store.release(nickname, id, file.length, deps.now().toISOString()));
      return { ...notFound(), ...sized };
    }
    return { outcome: "stored", response: json(201, { address: mediaAddress(nickname, id), contentType, bytes: file.length }), ...sized };
  }
  return { ...refuse(409, "conflict", APP_MEDIA_MESSAGES.conflict), ...sized };
}

async function deleteMedia(nickname: string, id: string, deps: AppMediaDeps): Promise<Answer> {
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.pause();
    const record = await deps.store.getRecord(nickname, id);
    // Nothing to remove (never stored, or already deleted): done, nothing touched.
    if (record === undefined) return { outcome: "deleted", response: { statusCode: 204, headers: { "cache-control": "no-store", ...CORS_HEADERS } } };
    const now = deps.now();
    if (record.status === "uploading" && now.getTime() - Date.parse(record.createdAt) < UPLOAD_STALE_SECONDS * 1000) {
      return refuse(409, "uploading", APP_MEDIA_MESSAGES.uploading);
    }
    // The file first, then its record: a failure in between leaves the record, and the same DELETE again finishes.
    await deps.bucket.delete(mediaKey(nickname, id));
    if ((await deps.store.remove(nickname, id, record, now.toISOString())) === "deleted") {
      return { outcome: "deleted", response: { statusCode: 204, headers: { "cache-control": "no-store", ...CORS_HEADERS } }, bytes: record.bytes };
    }
  }
  return refuse(409, "conflict", APP_MEDIA_MESSAGES.conflict);
}

async function route(request: HttpRequest, method: AppMediaMethod | "other", deps: AppMediaDeps, seen: { writer?: string }): Promise<Answer> {
  if (method === "other") return notFound();
  // The preflight carries no data and reads nothing: the same answer for every address.
  if (method === "OPTIONS") return { outcome: "preflight", response: { statusCode: 204, headers: { ...MEDIA_PREFLIGHT_HEADERS } } };
  const nickname = request.pathParameters?.["nickname"];
  const id = request.pathParameters?.["id"];
  // Same order as the data API (3.24): nickname rules and the live marker (404, the bucket untouched), the id (400),
  // the token (401), then the body.
  if (typeof nickname !== "string" || checkNickname(nickname) !== "ok") return notFound();
  if (!(await deps.store.isLive(nickname))) return notFound();
  if (typeof id !== "string" || !MEDIA_ID_PATTERN.test(id)) return refuse(400, "bad-id", APP_MEDIA_MESSAGES.badId);
  const write = await checkAppWrite(request, nickname, deps.tokens, deps.now());
  if (!write.ok) return refuse(401, "unauthorized", APP_MEDIA_MESSAGES.signInToSave);
  seen.writer = write.writer;
  return method === "PUT" ? putMedia(request, nickname, id, write.writer, deps) : deleteMedia(nickname, id, deps);
}

/** Answers one request; table or bucket failures give a 500 with a plain message (logged by error name only). */
export async function handleAppMediaRequest(request: HttpRequest, deps: AppMediaDeps): Promise<HttpResponse> {
  const method = methodOf(request);
  const seen: { writer?: string } = {};
  const writer = () => (seen.writer === undefined ? {} : { writer: seen.writer });
  try {
    const { outcome, response, bytes, kind } = await route(request, method, deps, seen);
    deps.log({ event: "app-media", method, outcome, status: response.statusCode, ...writer(), ...(bytes === undefined ? {} : { bytes }), ...(kind === undefined ? {} : { kind }) });
    return response;
  } catch (error) {
    deps.log({ event: "app-media", method, outcome: "failed", status: 500, ...writer(), error: errorName(error) });
    return json(500, { message: APP_MEDIA_MESSAGES.failed });
  }
}
