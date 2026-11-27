// The AI tasks for apps (ticket 3.21): `POST /api/apps/{nickname}/ai` (and its `OPTIONS` preflight). An app asks for
// one of four fixed tasks (./tasks.ts), never a free prompt; the photo tasks and `sort-text` run on Claude Haiku 4.5
// (EU profile), `transcribe` on Amazon Transcribe (question 8). Order of the checks, so that nothing paid happens
// before every refusal that can come first:
//
// 1. the app is live (404) and the caller holds an app write token for it (401, ticket 3.24: AI tasks need the workshop's
//    sign-in, like saving);
// 2. the admin's switch "Apps may use AI" is on and the global Stop is off (503 "AI is switched off for apps right now");
// 3. the request is one of the tasks with only its fields, within the limits, and a photo or recording address is under
//    `/app-media/<this nickname>/` (400);
// 4. neither the app's $1, nor the writer's $1 across all apps (try 2), nor all apps' $10 for the UTC day is spent (429),
//    the file exists and is a photo (at most 3.75 MB, Bedrock's limit) or a recording of at most 5 minutes counted from
//    its packets (400);
// 5. the most the call can cost is reserved against the three budgets in one transaction (./budget.ts, ./store.ts), then
//    the call runs and the counters are corrected to what it cost (tokens x Haiku 4.5's price; Transcribe: the
//    recording's bound, which is at least what Transcribe bills);
// 6. the model's answer is checked against the request (./tasks.ts): unusable is 502 "The AI could not read this".
//
// `transcribe` is a batch job that can outlast API Gateway's 30 s: the request that starts it (job
// `ssd-workshop-app-ai-<nickname>-<id>`, results under the media bucket's `transcripts/` prefix) polls it while the
// deadline below leaves room; while it runs the answer is 202 and the app asks again with the same recording. A request
// that finds the job running (a join) answers 202 at once, without waiting and without a charge (try 2). Once done, the
// text is read, then the job and the result file are deleted. Never logs a token, an email, the app's nickname, an
// address, a text or an answer: task, outcome, status, cost and the writer's nickname.
//
// Time (try 2): every call this function makes is bounded (TABLE_CALL_LIMIT_MS, S3_CALL_LIMIT_MS,
// TRANSCRIBE_CALL_LIMIT_MS, the model's timeoutMs), and every paid step starts only when it and everything after it fit
// before REQUEST_DEADLINE_MS (26 s from the request's start), under the function's 28 s timeout and API Gateway's 30 s:
// a model call is cut off at the deadline less one settlement (5.5 s), and starts only with MIN_MODEL_CALL_MS left; a
// Transcribe job starts only with its start call, one status call and a refund left; no wait between polls begins after
// TRANSCRIBE_LAST_POLL_MS (10 s), so the last status call starts by 12 s and ends by 15 s, leaving the reading and
// clean-up (4 s + 3 s + 4 s). The free steps before them (about seven table
// calls, an S3 read, up to RESERVE_ATTEMPTS reservations) are not cut short: only if every one of them took its full
// limit could the function's timeout come first, and then nothing was billed and at most a reservation stays counted
// (never less than the cost).
import { checkAppWrite, type AppTokenReader } from "../app-token/token.js";
import { CORS_HEADERS } from "../app-data/data.js";
import { decodedSecondsBound, inspectMedia, type RecordingKind } from "../app-media/formats.js";
import { mediaKey } from "../app-media/media.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { checkNickname } from "../participant/participant.js";
import { errorName } from "../sign-in/code-request.js";
import type { WorkshopSettings } from "../workshop/settings.js";
import { APP_AI_TEXTS, APP_SIGN_IN_TEXTS } from "../workshop/texts.js";
import { BEDROCK_MAX_IMAGE_BYTES, MAX_TRANSCRIBE_SECONDS, modelCost, modelReservation, spentBudget, transcribeCost, utcDay, type AiSpend, type SpentBudget } from "./budget.js";
import { checkAnswer, jsonFromText, MAX_REQUEST_BYTES, MAX_TEXT_CHARACTERS, modelTask, oneLine, parseAppAiRequest, type AnswerTool, type AppAiRequest, type AppAiTask } from "./tasks.js";

export const APP_AI_PATH = "/api/apps/{nickname}/ai";
export const APP_AI_METHODS = ["POST", "OPTIONS"] as const;
export type AppAiMethod = (typeof APP_AI_METHODS)[number];
export const APP_AI_ROUTES = APP_AI_METHODS.map((method) => `${method} ${APP_AI_PATH}`);

/** A lost race on the budget counters is tried again this many times in all (as the media API's uploads). */
export const RESERVE_ATTEMPTS = 4;
/** Every paid step and what follows it ends this long after the request started (the function's timeout is 28 s). */
export const REQUEST_DEADLINE_MS = 26_000;
/** The longest one table call takes: 2 attempts of 1 s to connect and 1.5 s to answer (clientSettings), plus the SDK's backoff. */
export const TABLE_CALL_LIMIT_MS = 5_500;
/** The longest one S3 call takes, body included: one attempt, raced and aborted at this limit (./store.ts). */
export const S3_CALL_LIMIT_MS = 4_000;
/** The longest one Transcribe call takes: one attempt, raced and aborted at this limit (./store.ts). */
export const TRANSCRIBE_CALL_LIMIT_MS = 3_000;
/** One Bedrock attempt of at most 20 s (a Haiku call with a photo takes a few seconds); shorter when the deadline is nearer. */
export const MODEL_CALL_LIMIT_MS = 20_000;
/** A model call starts only with at least this long for it; else 503 and the reservation goes back. */
export const MIN_MODEL_CALL_MS = 8_000;
/** The request that started a Transcribe job asks about it every TRANSCRIBE_POLL_MS. */
export const TRANSCRIBE_POLL_MS = 2_000;
/** Reading a finished job's text, then deleting the job, then the result file. */
export const TRANSCRIBE_AFTER_DONE_MS = S3_CALL_LIMIT_MS + TRANSCRIBE_CALL_LIMIT_MS + S3_CALL_LIMIT_MS;
/**
 * No wait before a poll begins later than this after the request started (10 s): that wait (2 s) and its status call
 * (3 s) end by 15 s, and the reading and clean-up (11 s) still fit before the deadline.
 */
export const TRANSCRIBE_LAST_POLL_MS = REQUEST_DEADLINE_MS - TRANSCRIBE_POLL_MS - TRANSCRIBE_CALL_LIMIT_MS - TRANSCRIBE_AFTER_DONE_MS;
/** Where Amazon Transcribe writes its results in the media bucket (never served: CloudFront maps only `/app-media/*`). */
export const TRANSCRIPTS_PREFIX = "transcripts/";
/** The Transcribe job of a recording: `ssd-workshop-app-ai-<lower-cased nickname>-<id>` (letters, digits and dashes). */
export const transcriptionJobName = (nickname: string, mediaId: string): string => `ssd-workshop-app-ai-${nickname.toLowerCase()}-${mediaId}`;
/** Its result file: `transcripts/<lower-cased nickname>/<id>.json`. */
export const transcriptKey = (nickname: string, mediaId: string): string => `${TRANSCRIPTS_PREFIX}${nickname.toLowerCase()}/${mediaId}.json`;

/** The preflight's answer: what 3.22's helpers send (JSON, `Authorization`), cached by the browser for 10 minutes. */
export const AI_PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type, accept, authorization",
  "access-control-max-age": "600",
  "cache-control": "no-store",
} as const;
const JSON_ANSWER_HEADERS = { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS } as const;

/** Bedrock errors after which nothing was billed: the call's reservation is given back. */
export const UNBILLED_MODEL_ERRORS = ["ValidationException", "AccessDeniedException", "ThrottlingException", "ServiceQuotaExceededException", "ModelNotReadyException", "ResourceNotFoundException"];

/**
 * Transcribe errors on StartTranscriptionJob that prove no job was created (a refused request: invalid, over a quota or
 * rate, not allowed): the reservation goes back at once (try 3). Any other error (our time limit, an aborted or broken
 * connection, a 5xx) may arrive after Transcribe created the job, so the request asks once whether the job exists and
 * gives the reservation back only when it is missing. `ConflictException` is not an error here: the start answers
 * `exists` (another request created the job and carries its charge).
 */
export const UNSTARTED_TRANSCRIBE_ERRORS = ["BadRequestException", "LimitExceededException", "AccessDeniedException"];

/** What the AI tasks need from the table. */
export interface AppAiStore {
  /** True once the deployer has marked the app live. */
  isLive(nickname: string): Promise<boolean>;
  getSettings(): Promise<WorkshopSettings>;
  /** The app's counter, the writer's counter and the all-apps counter (consistent reads). */
  getSpend(nickname: string, writer: string): Promise<AiSpend>;
  /**
   * In one transaction, adds `costUsd` to the app's, the writer's and the all-apps counter: a counter read as today's only
   * while it still counts today and is under its budget, one read as an earlier day's (or absent) set to `today` and
   * the cost only while it still counts an earlier day. `conflict`: a condition failed (a budget filled, or a day
   * turned): read again.
   */
  reserve(nickname: string, writer: string, spend: AiSpend, today: string, costUsd: number): Promise<"reserved" | "conflict">;
  /** Adds `deltaUsd` (negative to give back) to the three counters, each only while it still counts `today`. */
  settle(nickname: string, writer: string, today: string, deltaUsd: number): Promise<void>;
}

/** The media bucket, read only. */
export interface MediaReader {
  /** The file's bytes, or undefined when there is no such file (at most the media API's 4 MB). */
  read(key: string): Promise<Buffer | undefined>;
}

export interface ModelCall {
  system: string;
  text: string;
  /** A JPEG to look at, before the text. */
  photo?: Buffer;
  tool: AnswerTool;
  /** The call is cut off (TimeoutError) after this long. */
  timeoutMs: number;
}

export interface ModelAnswer {
  /** The tool call's input, when the model called the tool. */
  input: unknown;
  /** Any text the model wrote. */
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Claude Haiku 4.5 on Bedrock (./store.ts), or a fake in tests. Throws on any failure. */
export interface AppAiModel {
  answer(call: ModelCall): Promise<ModelAnswer>;
}

export type TranscriptionStatus = { state: "missing" } | { state: "working" } | { state: "failed" } | { state: "done"; language: string | undefined };

/** Amazon Transcribe and its result files (./store.ts), or a fake in tests. */
export interface Transcriber {
  status(jobName: string): Promise<TranscriptionStatus>;
  /** Starts a batch job on the stored file, language detected; `exists` when a job of that name is already there. */
  start(job: { name: string; mediaKey: string; format: RecordingKind; outputKey: string }): Promise<"started" | "exists">;
  /** The transcript's text from the result file, or undefined when it is not there. */
  transcript(outputKey: string): Promise<string | undefined>;
  /**
   * Deletes the job, then the result file (in that order: a request that finds the file gone then finds the job gone
   * too). `gone` when the job was no longer there (another request cleaned up first).
   */
  cleanUp(jobName: string, outputKey: string): Promise<"deleted" | "gone">;
}

export type AppAiOutcome =
  | "answered"
  | "transcribed"
  | "working"
  | "preflight"
  | "not-found"
  | "unauthorized"
  | "switched-off"
  | "bad-request"
  | "media-not-in-app"
  | "media-not-found"
  | "wrong-media"
  | "photo-too-big"
  | "recording-too-long"
  | "app-budget"
  | "writer-budget"
  | "workshop-budget"
  | "out-of-time"
  | "unreadable"
  | "transcribe-failed"
  | "conflict"
  | "failed";

/** The only things ever logged. */
export interface AppAiLogEntry {
  event: "app-ai";
  method: AppAiMethod | "other";
  outcome: AppAiOutcome;
  status: number;
  task?: AppAiTask;
  writer?: string;
  /** What this request added to the budgets, in dollars (after the correction). */
  costUsd?: number;
  error?: string;
}

export interface AppAiDeps {
  store: AppAiStore;
  tokens: AppTokenReader;
  media: MediaReader;
  model: AppAiModel;
  transcriber: Transcriber;
  now: () => Date;
  log: (entry: AppAiLogEntry) => void;
  /** Waits before another try after a lost race (tests pass no wait). */
  pause: () => Promise<void>;
  /** Waits between two looks at a Transcribe job (tests move a fake clock). */
  sleep: (ms: number) => Promise<void>;
}

interface Answer {
  outcome: AppAiOutcome;
  response: HttpResponse;
}

const json = (statusCode: number, body: Record<string, unknown>): HttpResponse => ({ statusCode, headers: { ...JSON_ANSWER_HEADERS }, body: JSON.stringify(body) });
const refuse = (statusCode: number, outcome: AppAiOutcome, message: string): Answer => ({ outcome, response: json(statusCode, { message }) });

/** What the request has seen, for its log line. */
interface Seen {
  task?: AppAiTask;
  writer?: string;
  costUsd: number;
}

/** Who asks: the app, the signed-in writer (the token's nickname), and when the request started (for the deadline). */
interface Caller {
  nickname: string;
  writer: string;
  startedAt: number;
}

const timeLeft = (deps: AppAiDeps, caller: Caller): number => caller.startedAt + REQUEST_DEADLINE_MS - deps.now().getTime();
const elapsed = (deps: AppAiDeps, caller: Caller): number => deps.now().getTime() - caller.startedAt;
const outOfTime = (): Answer => refuse(503, "out-of-time", APP_AI_TEXTS.outOfTime);
const working = (): Answer => ({ outcome: "working", response: json(202, { status: "working", message: APP_AI_TEXTS.working }) });

/** A spent budget's 429. */
function spentAnswer(spent: SpentBudget): Answer {
  if (spent === "app-budget") return refuse(429, "app-budget", APP_AI_TEXTS.appBudget);
  if (spent === "writer-budget") return refuse(429, "writer-budget", APP_AI_TEXTS.writerBudget);
  return refuse(429, "workshop-budget", APP_AI_TEXTS.workshopBudget);
}

function methodOf(request: HttpRequest): AppAiMethod | "other" {
  return APP_AI_METHODS[APP_AI_ROUTES.indexOf(request.routeKey ?? "")] ?? "other";
}

/** The body as JSON (base64 or not), refusing a large one before decoding; undefined when it is not JSON. */
function readBody(request: HttpRequest): unknown {
  const body = request.body;
  if (typeof body !== "string" || body.length > (MAX_REQUEST_BYTES * 4) / 3 + 4) return undefined;
  const text = request.isBase64Encoded === true ? Buffer.from(body, "base64").toString("utf8") : body;
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Best effort: a failed correction leaves the reservation counted (never less than the cost), logged by name. */
async function settleQuietly(deps: AppAiDeps, caller: Caller, today: string, delta: number, seen: Seen): Promise<void> {
  if (delta === 0) return;
  try {
    await deps.store.settle(caller.nickname, caller.writer, today, delta);
    seen.costUsd += delta;
  } catch (error) {
    deps.log({ event: "app-ai", method: "POST", outcome: "failed", status: 0, error: `settle:${errorName(error)}` });
  }
}

/** Reserves `cost` against the three budgets: a spent budget is 429 (with its message), a lost race is read again. */
async function reserve(deps: AppAiDeps, caller: Caller, cost: number, seen: Seen): Promise<{ today: string } | { answer: Answer }> {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.pause();
    const today = utcDay(deps.now());
    const spend = await deps.store.getSpend(caller.nickname, caller.writer);
    const spent = spentBudget(spend, today);
    if (spent !== undefined) return { answer: spentAnswer(spent) };
    if ((await deps.store.reserve(caller.nickname, caller.writer, spend, today, cost)) === "reserved") {
      seen.costUsd += cost;
      return { today };
    }
  }
  return { answer: refuse(409, "conflict", APP_AI_TEXTS.conflict) };
}

/** A budget already spent (429) before any file is read; undefined when all three have room. */
async function budgetSpent(deps: AppAiDeps, caller: Caller): Promise<Answer | undefined> {
  const spent = spentBudget(await deps.store.getSpend(caller.nickname, caller.writer), utcDay(deps.now()));
  return spent === undefined ? undefined : spentAnswer(spent);
}

/** Gives a reservation back when a paid step will not start (out of time), if the settlement itself still fits. */
async function giveBack(deps: AppAiDeps, caller: Caller, today: string, cost: number, seen: Seen): Promise<Answer> {
  if (timeLeft(deps, caller) >= TABLE_CALL_LIMIT_MS) await settleQuietly(deps, caller, today, -cost, seen);
  return outOfTime();
}

async function runModelTask(request: Exclude<AppAiRequest, { task: "transcribe" }>, caller: Caller, deps: AppAiDeps, seen: Seen): Promise<Answer> {
  const spent = await budgetSpent(deps, caller);
  if (spent !== undefined) return spent;
  let photo: Buffer | undefined;
  if (request.task !== "sort-text") {
    const bytes = await deps.media.read(mediaKey(caller.nickname, request.mediaId));
    if (bytes === undefined) return refuse(400, "media-not-found", APP_AI_TEXTS.mediaNotFound);
    const found = inspectMedia(bytes);
    if (found?.kind !== "jpeg") return refuse(400, "wrong-media", APP_AI_TEXTS.notAPhoto);
    if (found.photo.length > BEDROCK_MAX_IMAGE_BYTES) return refuse(400, "photo-too-big", APP_AI_TEXTS.photoTooBig);
    photo = found.photo;
  }
  const reservation = modelReservation(request);
  const reserved = await reserve(deps, caller, reservation, seen);
  if ("answer" in reserved) return reserved.answer;
  // The call ends one settlement before the deadline, so the correction after it still fits.
  const timeoutMs = Math.min(MODEL_CALL_LIMIT_MS, timeLeft(deps, caller) - TABLE_CALL_LIMIT_MS);
  if (timeoutMs < MIN_MODEL_CALL_MS) return giveBack(deps, caller, reserved.today, reservation, seen);
  const task = modelTask(request);
  let reply: ModelAnswer;
  try {
    reply = await deps.model.answer({ system: task.system, text: task.text, tool: task.tool, timeoutMs, ...(photo === undefined ? {} : { photo }) });
  } catch (error) {
    // Refused before it ran (nothing billed): the reservation goes back. Cut off or failed later: it stays counted.
    if (UNBILLED_MODEL_ERRORS.includes(errorName(error))) await settleQuietly(deps, caller, reserved.today, -reservation, seen);
    throw error;
  }
  // Corrected to what it cost; a cost above the reservation (it cannot be, by the bounds) is added all the same.
  await settleQuietly(deps, caller, reserved.today, modelCost(reply.inputTokens, reply.outputTokens) - reservation, seen);
  const answer = checkAnswer(request, reply.input ?? jsonFromText(reply.text));
  if (answer === undefined) return refuse(502, "unreadable", APP_AI_TEXTS.unreadable);
  return { outcome: "answered", response: json(200, answer) };
}

/**
 * After a failed start: `missing` when the error proves nothing started or the job is not there, `exists` when it is,
 * `unknown` when the status call fails too (try 3).
 */
async function statusAfterFailedStart(deps: AppAiDeps, name: string, error: unknown): Promise<"missing" | "exists" | "unknown"> {
  if (UNSTARTED_TRANSCRIBE_ERRORS.includes(errorName(error))) return "missing";
  try {
    return (await deps.transcriber.status(name)).state === "missing" ? "missing" : "exists";
  } catch {
    return "unknown";
  }
}

async function runTranscribe(mediaId: string, caller: Caller, deps: AppAiDeps, seen: Seen): Promise<Answer> {
  const name = transcriptionJobName(caller.nickname, mediaId);
  const outputKey = transcriptKey(caller.nickname, mediaId);
  let status = await deps.transcriber.status(name);
  // A job already running: another request started it and carries its charge. Answered at once (try 2), so asking
  // again costs a short request, never a wait.
  if (status.state === "working") return working();
  if (status.state === "missing") {
    const spent = await budgetSpent(deps, caller);
    if (spent !== undefined) return spent;
    const key = mediaKey(caller.nickname, mediaId);
    const bytes = await deps.media.read(key);
    if (bytes === undefined) return refuse(400, "media-not-found", APP_AI_TEXTS.mediaNotFound);
    const found = inspectMedia(bytes);
    if (found === undefined || found.kind === "jpeg") return refuse(400, "wrong-media", APP_AI_TEXTS.notARecording);
    // Counted from every packet, not the timestamps a crafted file can shorten (ticket 3.21): Transcribe bills what it decodes.
    const seconds = decodedSecondsBound(bytes, found.kind);
    if (seconds === undefined) return refuse(400, "wrong-media", APP_AI_TEXTS.notARecording);
    if (seconds > MAX_TRANSCRIBE_SECONDS) return refuse(400, "recording-too-long", APP_AI_TEXTS.recordingTooLong);
    const cost = transcribeCost(seconds);
    const reserved = await reserve(deps, caller, cost, seen);
    if ("answer" in reserved) return reserved.answer;
    // The start, one status call should it fail without proof, and a refund must fit before the deadline (try 3).
    if (timeLeft(deps, caller) < 2 * TRANSCRIBE_CALL_LIMIT_MS + TABLE_CALL_LIMIT_MS) return giveBack(deps, caller, reserved.today, cost, seen);
    let started: "started" | "exists";
    try {
      started = await deps.transcriber.start({ name, mediaKey: key, format: found.kind, outputKey });
    } catch (error) {
      const after = await statusAfterFailedStart(deps, name, error);
      // Refused (nothing started) or no job there: nothing is billed, the reservation goes back.
      if (after === "missing") await settleQuietly(deps, caller, reserved.today, -cost, seen);
      // The job exists although the answer was lost: it runs and is paid for, the app asks again and joins it.
      if (after === "exists") {
        deps.log({ event: "app-ai", method: "POST", outcome: "failed", status: 0, error: `start:${errorName(error)}` });
        return working();
      }
      // Missing, or unknown (the status call failed too: the charge stays, never under the cost).
      throw error;
    }
    // Another request started the same job a moment ago: it carries the charge, and this one does not wait.
    if (started === "exists") {
      await settleQuietly(deps, caller, reserved.today, -cost, seen);
      return working();
    }
    // Only the request that started the job polls it: a wait begins only by TRANSCRIBE_LAST_POLL_MS, so the poll and the reading still fit.
    status = { state: "working" };
    while (status.state === "working" && elapsed(deps, caller) <= TRANSCRIBE_LAST_POLL_MS) {
      await deps.sleep(TRANSCRIBE_POLL_MS);
      status = await deps.transcriber.status(name);
    }
  }
  if (status.state === "working") return working();
  // Gone after it existed: another request read the text and cleaned up a moment ago. Asking again starts over.
  if (status.state === "missing") return working();
  if (timeLeft(deps, caller) < TRANSCRIBE_AFTER_DONE_MS) return working();
  if (status.state === "failed") {
    await deps.transcriber.cleanUp(name, outputKey);
    return refuse(502, "transcribe-failed", APP_AI_TEXTS.transcribeFailed);
  }
  const text = await deps.transcriber.transcript(outputKey);
  const cleaned = await deps.transcriber.cleanUp(name, outputKey);
  if (text === undefined) {
    // The file is gone and so was the job: another request read the text first (try 2), not a failure; asking again starts over.
    if (cleaned === "gone") return working();
    return refuse(502, "transcribe-failed", APP_AI_TEXTS.transcribeFailed);
  }
  // At most what sort-text reads, so the text can be sorted into topics next.
  return { outcome: "transcribed", response: json(200, { text: oneLine(text, MAX_TEXT_CHARACTERS), language: status.language ?? null }) };
}

async function route(request: HttpRequest, method: AppAiMethod | "other", deps: AppAiDeps, seen: Seen, startedAt: number): Promise<Answer> {
  if (method === "other") return refuse(404, "not-found", "Not found.");
  if (method === "OPTIONS") return { outcome: "preflight", response: { statusCode: 204, headers: { ...AI_PREFLIGHT_HEADERS } } };
  const nickname = request.pathParameters?.["nickname"];
  if (typeof nickname !== "string" || checkNickname(nickname) !== "ok" || !(await deps.store.isLive(nickname))) return refuse(404, "not-found", "Not found.");
  const write = await checkAppWrite(request, nickname, deps.tokens, deps.now());
  // The writer's nickname keys its own day counter: one that is not a nickname (it cannot be, by 3.24) is refused.
  if (!write.ok || checkNickname(write.writer) === "rules") return refuse(401, "unauthorized", APP_SIGN_IN_TEXTS.signInToSave);
  seen.writer = write.writer;
  const caller: Caller = { nickname, writer: write.writer, startedAt };
  const settings = await deps.store.getSettings();
  if (!settings.appAiEnabled || settings.stopped) return refuse(503, "switched-off", APP_AI_TEXTS.switchedOff);
  const parsed = parseAppAiRequest(readBody(request), nickname);
  if (!parsed.ok) {
    if (parsed.reason === "photo-not-in-app") return refuse(400, "media-not-in-app", APP_AI_TEXTS.photoNotInApp);
    if (parsed.reason === "recording-not-in-app") return refuse(400, "media-not-in-app", APP_AI_TEXTS.recordingNotInApp);
    return refuse(400, "bad-request", APP_AI_TEXTS.badRequest);
  }
  seen.task = parsed.request.task;
  if (parsed.request.task === "transcribe") return runTranscribe(parsed.request.mediaId, caller, deps, seen);
  return runModelTask(parsed.request, caller, deps, seen);
}

/** Answers one request; any failure gives a 500 with a plain message (logged by error name only). */
export async function handleAppAiRequest(request: HttpRequest, deps: AppAiDeps): Promise<HttpResponse> {
  const method = methodOf(request);
  const startedAt = deps.now().getTime();
  const seen: Seen = { costUsd: 0 };
  const extra = (): Partial<AppAiLogEntry> => ({
    ...(seen.task === undefined ? {} : { task: seen.task }),
    ...(seen.writer === undefined ? {} : { writer: seen.writer }),
    ...(seen.costUsd === 0 ? {} : { costUsd: Math.round(seen.costUsd * 1e8) / 1e8 }),
  });
  try {
    const { outcome, response } = await route(request, method, deps, seen, startedAt);
    deps.log({ event: "app-ai", method, outcome, status: response.statusCode, ...extra() });
    return response;
  } catch (error) {
    deps.log({ event: "app-ai", method, outcome: "failed", status: 500, ...extra(), error: errorName(error) });
    return json(500, { message: APP_AI_TEXTS.failed });
  }
}
