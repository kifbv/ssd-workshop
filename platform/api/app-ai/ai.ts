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
// 4. neither the app's $1 nor all apps' $10 for the UTC day is spent (429), the file exists and is a photo (at most
//    3.75 MB, Bedrock's limit) or a recording of at most 5 minutes counted from its packets (400);
// 5. the most the call can cost is reserved against both budgets in one transaction (./budget.ts, ./store.ts), then the
//    call runs and the counters are corrected to what it cost (tokens x Haiku 4.5's price; Transcribe: the recording's
//    bound, which is at least what Transcribe bills);
// 6. the model's answer is checked against the request (./tasks.ts): unusable is 502 "The AI could not read this".
//
// `transcribe` is a batch job that can outlast API Gateway's 30 s: the first request starts it (job
// `ssd-workshop-app-ai-<nickname>-<id>`, results under the media bucket's `transcripts/` prefix) and waits up to
// TRANSCRIBE_WAIT_MS; while it runs the answer is 202 and the app asks again with the same recording (no new charge);
// once done, the text is read, then the result file and the job are deleted. Never logs a token, an email, the app's
// nickname, an address, a text or an answer: task, outcome, status, cost and the writer's nickname.
import { checkAppWrite, type AppTokenReader } from "../app-token/token.js";
import { CORS_HEADERS } from "../app-data/data.js";
import { decodedSecondsBound, inspectMedia, type RecordingKind } from "../app-media/formats.js";
import { mediaKey } from "../app-media/media.js";
import type { HttpRequest, HttpResponse } from "../http.js";
import { checkNickname } from "../participant/participant.js";
import { errorName } from "../sign-in/code-request.js";
import type { WorkshopSettings } from "../workshop/settings.js";
import { APP_AI_TEXTS, APP_SIGN_IN_TEXTS } from "../workshop/texts.js";
import { BEDROCK_MAX_IMAGE_BYTES, MAX_TRANSCRIBE_SECONDS, modelCost, modelReservation, spentBudget, transcribeCost, utcDay, type AiSpend } from "./budget.js";
import { checkAnswer, jsonFromText, MAX_REQUEST_BYTES, MAX_TEXT_CHARACTERS, modelTask, oneLine, parseAppAiRequest, type AnswerTool, type AppAiRequest, type AppAiTask } from "./tasks.js";

export const APP_AI_PATH = "/api/apps/{nickname}/ai";
export const APP_AI_METHODS = ["POST", "OPTIONS"] as const;
export type AppAiMethod = (typeof APP_AI_METHODS)[number];
export const APP_AI_ROUTES = APP_AI_METHODS.map((method) => `${method} ${APP_AI_PATH}`);

/** A lost race on the budget counters is tried again this many times in all (as the media API's uploads). */
export const RESERVE_ATTEMPTS = 4;
/** `transcribe` waits this long for its job within one request, asking every TRANSCRIBE_POLL_MS, before answering 202. */
export const TRANSCRIBE_WAIT_MS = 15_000;
export const TRANSCRIBE_POLL_MS = 2_000;
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

/** What the AI tasks need from the table. */
export interface AppAiStore {
  /** True once the deployer has marked the app live. */
  isLive(nickname: string): Promise<boolean>;
  getSettings(): Promise<WorkshopSettings>;
  /** The app's counter and the all-apps counter (consistent reads). */
  getSpend(nickname: string): Promise<AiSpend>;
  /**
   * In one transaction, adds `costUsd` to the app's counter and the all-apps counter: a counter read as today's only
   * while it still counts today and is under its budget, one read as an earlier day's (or absent) set to `today` and
   * the cost only while it still counts an earlier day. `conflict`: a condition failed (a budget filled, or a day
   * turned): read again.
   */
  reserve(nickname: string, spend: AiSpend, today: string, costUsd: number): Promise<"reserved" | "conflict">;
  /** Adds `deltaUsd` (negative to give back) to both counters, only while they still count `today`. */
  settle(nickname: string, today: string, deltaUsd: number): Promise<void>;
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
  /** Deletes the result file, then the job. */
  cleanUp(jobName: string, outputKey: string): Promise<void>;
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
  | "workshop-budget"
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
async function settleQuietly(deps: AppAiDeps, nickname: string, today: string, delta: number, seen: Seen): Promise<void> {
  if (delta === 0) return;
  try {
    await deps.store.settle(nickname, today, delta);
    seen.costUsd += delta;
  } catch (error) {
    deps.log({ event: "app-ai", method: "POST", outcome: "failed", status: 0, error: `settle:${errorName(error)}` });
  }
}

/**
 * Reserves `cost` against both budgets: a spent budget is 429 (with its message), a lost race is read again; undefined
 * once reserved.
 */
async function reserve(deps: AppAiDeps, nickname: string, cost: number, seen: Seen): Promise<{ today: string } | { answer: Answer }> {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.pause();
    const today = utcDay(deps.now());
    const spend = await deps.store.getSpend(nickname);
    const spent = spentBudget(spend, today);
    if (spent === "app-budget") return { answer: refuse(429, "app-budget", APP_AI_TEXTS.appBudget) };
    if (spent === "workshop-budget") return { answer: refuse(429, "workshop-budget", APP_AI_TEXTS.workshopBudget) };
    if ((await deps.store.reserve(nickname, spend, today, cost)) === "reserved") {
      seen.costUsd += cost;
      return { today };
    }
  }
  return { answer: refuse(409, "conflict", APP_AI_TEXTS.conflict) };
}

/** A budget already spent (429) before any file is read; undefined when both have room. */
async function budgetSpent(deps: AppAiDeps, nickname: string): Promise<Answer | undefined> {
  const spent = spentBudget(await deps.store.getSpend(nickname), utcDay(deps.now()));
  if (spent === "app-budget") return refuse(429, "app-budget", APP_AI_TEXTS.appBudget);
  if (spent === "workshop-budget") return refuse(429, "workshop-budget", APP_AI_TEXTS.workshopBudget);
  return undefined;
}

async function runModelTask(request: Exclude<AppAiRequest, { task: "transcribe" }>, nickname: string, deps: AppAiDeps, seen: Seen): Promise<Answer> {
  const spent = await budgetSpent(deps, nickname);
  if (spent !== undefined) return spent;
  let photo: Buffer | undefined;
  if (request.task !== "sort-text") {
    const bytes = await deps.media.read(mediaKey(nickname, request.mediaId));
    if (bytes === undefined) return refuse(400, "media-not-found", APP_AI_TEXTS.mediaNotFound);
    const found = inspectMedia(bytes);
    if (found?.kind !== "jpeg") return refuse(400, "wrong-media", APP_AI_TEXTS.notAPhoto);
    if (found.photo.length > BEDROCK_MAX_IMAGE_BYTES) return refuse(400, "photo-too-big", APP_AI_TEXTS.photoTooBig);
    photo = found.photo;
  }
  const reservation = modelReservation(request);
  const reserved = await reserve(deps, nickname, reservation, seen);
  if ("answer" in reserved) return reserved.answer;
  const task = modelTask(request);
  let reply: ModelAnswer;
  try {
    reply = await deps.model.answer({ system: task.system, text: task.text, tool: task.tool, ...(photo === undefined ? {} : { photo }) });
  } catch (error) {
    // Refused before it ran (nothing billed): the reservation goes back. Cut off or failed later: it stays counted.
    if (UNBILLED_MODEL_ERRORS.includes(errorName(error))) await settleQuietly(deps, nickname, reserved.today, -reservation, seen);
    throw error;
  }
  // Corrected to what it cost; a cost above the reservation (it cannot be, by the bounds) is added all the same.
  await settleQuietly(deps, nickname, reserved.today, modelCost(reply.inputTokens, reply.outputTokens) - reservation, seen);
  const answer = checkAnswer(request, reply.input ?? jsonFromText(reply.text));
  if (answer === undefined) return refuse(502, "unreadable", APP_AI_TEXTS.unreadable);
  return { outcome: "answered", response: json(200, answer) };
}

async function runTranscribe(mediaId: string, nickname: string, deps: AppAiDeps, seen: Seen): Promise<Answer> {
  const name = transcriptionJobName(nickname, mediaId);
  const outputKey = transcriptKey(nickname, mediaId);
  let status = await deps.transcriber.status(name);
  if (status.state === "missing") {
    const spent = await budgetSpent(deps, nickname);
    if (spent !== undefined) return spent;
    const key = mediaKey(nickname, mediaId);
    const bytes = await deps.media.read(key);
    if (bytes === undefined) return refuse(400, "media-not-found", APP_AI_TEXTS.mediaNotFound);
    const found = inspectMedia(bytes);
    if (found === undefined || found.kind === "jpeg") return refuse(400, "wrong-media", APP_AI_TEXTS.notARecording);
    // Counted from every packet, not the timestamps a crafted file can shorten (ticket 3.21): Transcribe bills what it decodes.
    const seconds = decodedSecondsBound(bytes, found.kind);
    if (seconds === undefined) return refuse(400, "wrong-media", APP_AI_TEXTS.notARecording);
    if (seconds > MAX_TRANSCRIBE_SECONDS) return refuse(400, "recording-too-long", APP_AI_TEXTS.recordingTooLong);
    const cost = transcribeCost(seconds);
    const reserved = await reserve(deps, nickname, cost, seen);
    if ("answer" in reserved) return reserved.answer;
    let started: "started" | "exists";
    try {
      started = await deps.transcriber.start({ name, mediaKey: key, format: found.kind, outputKey });
    } catch (error) {
      // A refused start bills nothing (a job that never ran).
      await settleQuietly(deps, nickname, reserved.today, -cost, seen);
      throw error;
    }
    // Another request started the same job a moment ago: it carries the charge.
    if (started === "exists") await settleQuietly(deps, nickname, reserved.today, -cost, seen);
    status = { state: "working" };
  }
  const deadline = deps.now().getTime() + TRANSCRIBE_WAIT_MS;
  while (status.state === "working" && deps.now().getTime() < deadline) {
    await deps.sleep(TRANSCRIBE_POLL_MS);
    status = await deps.transcriber.status(name);
  }
  if (status.state === "working") return { outcome: "working", response: json(202, { status: "working", message: APP_AI_TEXTS.working }) };
  if (status.state === "missing") return refuse(502, "transcribe-failed", APP_AI_TEXTS.transcribeFailed);
  if (status.state === "failed") {
    await deps.transcriber.cleanUp(name, outputKey);
    return refuse(502, "transcribe-failed", APP_AI_TEXTS.transcribeFailed);
  }
  const text = await deps.transcriber.transcript(outputKey);
  await deps.transcriber.cleanUp(name, outputKey);
  if (text === undefined) return refuse(502, "transcribe-failed", APP_AI_TEXTS.transcribeFailed);
  // At most what sort-text reads, so the text can be sorted into topics next.
  return { outcome: "transcribed", response: json(200, { text: oneLine(text, MAX_TEXT_CHARACTERS), language: status.language ?? null }) };
}

async function route(request: HttpRequest, method: AppAiMethod | "other", deps: AppAiDeps, seen: Seen): Promise<Answer> {
  if (method === "other") return refuse(404, "not-found", "Not found.");
  if (method === "OPTIONS") return { outcome: "preflight", response: { statusCode: 204, headers: { ...AI_PREFLIGHT_HEADERS } } };
  const nickname = request.pathParameters?.["nickname"];
  if (typeof nickname !== "string" || checkNickname(nickname) !== "ok" || !(await deps.store.isLive(nickname))) return refuse(404, "not-found", "Not found.");
  const write = await checkAppWrite(request, nickname, deps.tokens, deps.now());
  if (!write.ok) return refuse(401, "unauthorized", APP_SIGN_IN_TEXTS.signInToSave);
  seen.writer = write.writer;
  const settings = await deps.store.getSettings();
  if (!settings.appAiEnabled || settings.stopped) return refuse(503, "switched-off", APP_AI_TEXTS.switchedOff);
  const parsed = parseAppAiRequest(readBody(request), nickname);
  if (!parsed.ok) {
    if (parsed.reason === "photo-not-in-app") return refuse(400, "media-not-in-app", APP_AI_TEXTS.photoNotInApp);
    if (parsed.reason === "recording-not-in-app") return refuse(400, "media-not-in-app", APP_AI_TEXTS.recordingNotInApp);
    return refuse(400, "bad-request", APP_AI_TEXTS.badRequest);
  }
  seen.task = parsed.request.task;
  if (parsed.request.task === "transcribe") return runTranscribe(parsed.request.mediaId, nickname, deps, seen);
  return runModelTask(parsed.request, nickname, deps, seen);
}

/** Answers one request; any failure gives a 500 with a plain message (logged by error name only). */
export async function handleAppAiRequest(request: HttpRequest, deps: AppAiDeps): Promise<HttpResponse> {
  const method = methodOf(request);
  const seen: Seen = { costUsd: 0 };
  const extra = (): Partial<AppAiLogEntry> => ({
    ...(seen.task === undefined ? {} : { task: seen.task }),
    ...(seen.writer === undefined ? {} : { writer: seen.writer }),
    ...(seen.costUsd === 0 ? {} : { costUsd: Math.round(seen.costUsd * 1e8) / 1e8 }),
  });
  try {
    const { outcome, response } = await route(request, method, deps, seen);
    deps.log({ event: "app-ai", method, outcome, status: response.statusCode, ...extra() });
    return response;
  } catch (error) {
    deps.log({ event: "app-ai", method, outcome: "failed", status: 500, ...extra(), error: errorName(error) });
    return json(500, { message: APP_AI_TEXTS.failed });
  }
}
