// The conversation routes (ticket 1.7): `POST /api/conversation/messages` stores a message and hands
// it to the AI worker through the queue, answering at once with its id; `GET
// /api/conversation/messages/{id}` returns the caller's own message and, once there, its reply.
// Ticket 1.8 adds `GET /api/conversation` (the conversation so far, for a page load) and
// `POST /api/conversation/step` (Write my spec: from step 1 to step 2). Ticket 1.9 adds
// `GET /api/conversation/spec` (the newest spec version, or `?version=n`) and
// `POST /api/conversation/spec/approve` (Approve spec), and Write my spec now also asks the AI worker
// for the first version. Every route starts with the
// one session check and reads or writes only the caller's own partition, so another participant's
// message id is simply not found.
import { MESSAGE_ID_PATTERN, newMessageId } from "../keys.js";
import {
  isJsonContentType,
  jsonResponse,
  readJsonObject,
  unsupportedMediaTypeResponse,
  type HttpRequest,
  type HttpResponse,
} from "../http.js";
import { FAILED_MESSAGE, NOT_FOUND_MESSAGE } from "../participant/participant.js";
import { requireSession, type ParticipantRecord, type SessionReader } from "../session/session.js";
import { errorName } from "../sign-in/code-request.js";
import type { ConversationState, MessageStatus, Step } from "../types.js";
import { MAX_SPEC_VERSION } from "../keys.js";
import { WRITE_SPEC_REQUEST } from "./spec.js";
import {
  FAILURE_REPLY,
  HISTORY_PAGE_LIMIT,
  isStale,
  type ConversationStore,
  type ListedItem,
  type MessageQueue,
  type StoredConversation,
} from "./state.js";

export const SEND_ROUTE = "POST /api/conversation/messages";
export const POLL_ROUTE = "GET /api/conversation/messages/{id}";
export const HISTORY_ROUTE = "GET /api/conversation";
export const STEP_ROUTE = "POST /api/conversation/step";
export const SPEC_ROUTE = "GET /api/conversation/spec";
export const APPROVE_ROUTE = "POST /api/conversation/spec/approve";
export const CONVERSATION_ROUTES = [SEND_ROUTE, POLL_ROUTE, HISTORY_ROUTE, STEP_ROUTE, SPEC_ROUTE, APPROVE_ROUTE] as const;

/** A message holds 1 to 2000 characters (Unicode code points) after trimming. */
export const MAX_MESSAGE_CHARS = 2000;
/** 2000 characters of up to 4 bytes, JSON escapes included, fit; anything larger is refused unread. */
export const MESSAGE_BODY_LIMITS = { maxBodyBytes: 16_384, maxRawBodyBytes: 24_576 } as const;

export const MESSAGES = {
  invalid: `Send a JSON body with a text of 1 to ${MAX_MESSAGE_CHARS} characters.`,
  busy: "Please wait for the answer to your last message.",
  waiting: "Your last message is waiting for your facilitator. You can write again once they have looked at it.",
  "no-nickname": "Please pick a nickname first.",
  "invalid-step": 'Send a JSON body with the step "spec".',
  "too-early": "Tell the AI about your idea and answer its questions first; then it can write your spec.",
  "wrong-step": "You are not at step 1 any more.",
  approved: "Your spec is approved, so it stays as it is for now. The build comes next.",
  "invalid-approve": "Send a JSON body with the version of the spec you approve.",
  "no-spec": "There is no spec to approve yet.",
  stale: "There is a newer version of your spec. Please have a look at it, then approve it.",
} as const;

export type ConversationRoute = "send" | "poll" | "history" | "step" | "spec" | "approve" | "unknown";
export type ConversationOutcome =
  | "accepted"
  | "ok"
  | "unauthorized"
  | "not-found"
  | "invalid-request"
  | "unsupported-media-type"
  | "busy"
  | "waiting"
  | "no-nickname"
  | "too-early"
  | "wrong-step"
  | "approved"
  | "no-spec"
  | "stale"
  | "failed";

/** The only things ever logged: route, outcome and an error name (no text, id, token or reply). */
export interface ConversationLogEntry {
  event: "conversation";
  route: ConversationRoute;
  outcome: ConversationOutcome;
  error?: string;
}

export interface ConversationDeps {
  sessions: SessionReader;
  store: ConversationStore;
  queue: MessageQueue;
  now: () => Date;
  randomBytes: (size: number) => Buffer;
  log: (entry: ConversationLogEntry) => void;
}

/** The text of a send request, trimmed, or undefined when it breaks the rules. */
export function readMessageText(request: HttpRequest): string | undefined {
  const text = readJsonObject(request, MESSAGE_BODY_LIMITS)?.["text"];
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > MAX_MESSAGE_CHARS) return undefined;
  return trimmed;
}

interface Result {
  outcome: ConversationOutcome;
  response: HttpResponse;
  error?: string;
}

const refused = (reason: keyof typeof MESSAGES, status: number): Result => {
  const invalid = reason === "invalid" || reason === "invalid-step" || reason === "invalid-approve";
  return {
    outcome: invalid ? "invalid-request" : reason,
    response: jsonResponse(status, { message: MESSAGES[reason], ...(invalid ? {} : { reason }) }),
  };
};

async function send(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const text = readMessageText(request);
  if (text === undefined) return refused("invalid", 400);
  if (participant.nickname === undefined || participant.step === "nickname") return refused("no-nickname", 409);
  // Ticket 1.9: once the spec is approved, nothing changes it until phase 2's build flow takes over.
  if (participant.step === "approved") return refused("approved", 409);
  const created = await createAndQueue(participant.id, participant.step, text, deps);
  if (created.result !== "created") return refused(created.result, 409);
  return { outcome: "accepted", response: jsonResponse(202, { id: created.id }) };
}

/** Stores a pending message and hands it to the AI worker; a queue failure ends it as failed at once. */
async function createAndQueue(
  participantId: string,
  step: Step,
  text: string,
  deps: ConversationDeps,
): Promise<{ result: "created"; id: string } | { result: "busy" | "waiting" | "approved" }> {
  const now = deps.now();
  const id = newMessageId(now, deps.randomBytes);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const created = await deps.store.createMessage(participantId, { id, step, text, createdAt: now.toISOString(), nowSeconds });
  if (created !== "created") return { result: created };
  try {
    await deps.queue.send({ participantId, messageId: id });
  } catch (error) {
    // Nothing will answer it: end it as failed at once, so the participant can send again.
    await deps.store.finish(participantId, id, { kind: "failed", reply: FAILURE_REPLY }, "pending", now.toISOString());
    throw error;
  }
  return { result: "created", id };
}

async function poll(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  const id = request.pathParameters?.["id"];
  const notFound: Result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  // Read only in the caller's own partition: another participant's id is simply not there.
  if (typeof id !== "string" || !MESSAGE_ID_PATTERN.test(id)) return notFound;
  const message = await deps.store.getMessage(participant.id, id);
  if (message === undefined) return notFound;
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  let status: MessageStatus = message.status;
  let reply: string | undefined;
  if (isStale(message, nowSeconds)) {
    status = "failed";
    reply = FAILURE_REPLY;
  } else if (status === "done" || status === "declined" || status === "failed") {
    reply = (await deps.store.getReplyText(participant.id, id)) ?? (status === "failed" ? FAILURE_REPLY : undefined);
  }
  return { outcome: "ok", response: jsonResponse(200, { id, status, ...(reply === undefined ? {} : { reply }) }) };
}

/** One message of the conversation as the page shows it (ticket 1.8). */
export interface HistoryMessage {
  /** A participant message's id, or `<message id>-r` for a reply. */
  id: string;
  author: "participant" | "assistant";
  text: string;
  /** Participant messages only (a stale pending one shows as failed). */
  status?: MessageStatus;
  /** Replies only, and only when true: the AI offered to write the spec. */
  offersSpec?: true;
  /** The step the message belongs to (a reply: its message's step; ticket 1.9). */
  step?: Step;
  /** Replies only: the spec version this answer saved (ticket 1.9). */
  specVersion?: number;
}

export interface History {
  step: Step;
  state: ConversationState;
  messages: HistoryMessage[];
  /** The message in flight (pending or flagged), which the page polls; absent when none. */
  pendingId?: string;
  /** The newest spec version, and the approved one (ticket 1.9). */
  latestSpecVersion?: number;
  approvedSpecVersion?: number;
}

/**
 * The conversation as the page shows it: the listed items, oldest first, a stale pending message
 * shown as failed, and the neutral failure reply after a failed message that has none. `pendingId`
 * only while that message is really pending (not stale) or flagged.
 */
export function shapeHistory(step: Step, items: readonly ListedItem[], conversation: StoredConversation | undefined, nowSeconds: number): History {
  const messages: HistoryMessage[] = [];
  const replied = new Set(items.flatMap((i) => (i.author === "assistant" ? [i.replyTo] : [])));
  const stepOf = new Map(items.flatMap((i) => (i.author === "participant" ? [[i.id, i.step] as const] : [])));
  let pendingId: string | undefined;
  for (const item of items) {
    if (item.author === "assistant") {
      const replyStep = stepOf.get(item.replyTo);
      messages.push({
        id: `${item.replyTo}-r`,
        author: "assistant",
        text: item.text,
        ...(replyStep === undefined ? {} : { step: replyStep }),
        ...(item.offersSpec ? { offersSpec: true as const } : {}),
        ...(item.specVersion === undefined ? {} : { specVersion: item.specVersion }),
      });
      continue;
    }
    const status: MessageStatus = isStale(item, nowSeconds) ? "failed" : item.status;
    messages.push({ id: item.id, author: "participant", text: item.text, step: item.step, status });
    if (status === "failed" && !replied.has(item.id)) messages.push({ id: `${item.id}-r`, author: "assistant", text: FAILURE_REPLY, step: item.step });
    if ((status === "pending" || status === "flagged") && item.id === conversation?.pendingId) pendingId = item.id;
  }
  return {
    step,
    state: conversation?.state ?? "open",
    messages,
    ...(pendingId === undefined ? {} : { pendingId }),
    ...(conversation?.latestSpecVersion === undefined ? {} : { latestSpecVersion: conversation.latestSpecVersion }),
    ...(conversation?.approvedSpecVersion === undefined ? {} : { approvedSpecVersion: conversation.approvedSpecVersion }),
  };
}

/** True when at least one participant message was answered (the spec needs something to go on). */
export function hasAnsweredExchange(items: readonly ListedItem[]): boolean {
  return items.some((i) => i.author === "participant" && i.status === "done");
}

async function history(participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  const [items, conversation] = await Promise.all([
    deps.store.listItems(participant.id, HISTORY_PAGE_LIMIT),
    deps.store.getConversation(participant.id),
  ]);
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  return { outcome: "ok", response: jsonResponse(200, { ...shapeHistory(participant.step, items, conversation, nowSeconds) }) };
}

/**
 * Write my spec: from step 1 (clarify) to step 2 (spec), once an exchange was answered and nothing is
 * in flight; then (ticket 1.9) the request for the first spec version goes to the AI worker. Pressed
 * again at step 2 while there is no spec and nothing in flight (the first try failed), it asks again.
 */
async function moveStep(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  if (readJsonObject(request)?.["step"] !== "spec") return refused("invalid-step", 400);
  if (participant.nickname === undefined || participant.step === "nickname") return refused("no-nickname", 409);
  if (participant.step !== "clarify" && participant.step !== "spec") return refused("wrong-step", 409);
  if (participant.step === "clarify") {
    if (!hasAnsweredExchange(await deps.store.listItems(participant.id, HISTORY_PAGE_LIMIT))) return refused("too-early", 409);
    const now = deps.now();
    const result = await deps.store.moveToSpec(participant.id, Math.floor(now.getTime() / 1000), now.toISOString());
    if (result !== "moved") return refused(result, 409);
  }
  // Pressed twice (or in two tabs), or a spec already there: nothing more to ask for.
  const conversation = await deps.store.getConversation(participant.id);
  const created = conversation?.latestSpecVersion === undefined ? await createAndQueue(participant.id, "spec", WRITE_SPEC_REQUEST, deps) : undefined;
  return { outcome: "ok", response: jsonResponse(200, { step: "spec", ...(created?.result === "created" ? { id: created.id } : {}) }) };
}

/** A spec version from a query string: a whole number from 1 to MAX_SPEC_VERSION, written plainly. */
export function parseVersion(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,3}$/.test(value)) return undefined;
  const version = Number(value);
  return version <= MAX_SPEC_VERSION ? version : undefined;
}

/** The caller's newest spec version, or the one `?version=n` names; any other is simply not found. */
async function spec(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  const notFound: Result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  const asked = request.queryStringParameters?.["version"];
  let found;
  if (asked === undefined) {
    found = await deps.store.getLatestSpec(participant.id);
  } else {
    const version = parseVersion(asked);
    if (version === undefined) return notFound;
    found = await deps.store.getSpec(participant.id, version);
  }
  if (found === undefined) return notFound;
  return { outcome: "ok", response: jsonResponse(200, { version: found.version, text: found.text, createdAt: found.createdAt, approved: found.approved }) };
}

/** Approve spec (ticket 1.9): the version the participant saw, only while it is the newest. */
async function approve(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const version = readJsonObject(request)?.["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > MAX_SPEC_VERSION) return refused("invalid-approve", 400);
  if (participant.nickname === undefined || participant.step === "nickname") return refused("no-nickname", 409);
  const approved: Result = { outcome: "ok", response: jsonResponse(200, { step: "approved", version }) };
  if (participant.step === "clarify") return refused("no-spec", 409);
  if (participant.step === "approved") {
    // Pressed twice (or in two tabs): the same version again is fine.
    const conversation = await deps.store.getConversation(participant.id);
    return conversation?.approvedSpecVersion === version ? approved : refused("approved", 409);
  }
  const now = deps.now();
  const result = await deps.store.approveSpec(participant.id, version, Math.floor(now.getTime() / 1000), now.toISOString());
  if (result === "approved") return approved;
  // The step moved meanwhile (another tab approved): answer as for a press at step approved.
  if (result === "wrong-step") return refused("approved", 409);
  return refused(result, 409);
}

function routeOf(request: HttpRequest): ConversationRoute {
  if (request.routeKey === SEND_ROUTE) return "send";
  if (request.routeKey === POLL_ROUTE) return "poll";
  if (request.routeKey === HISTORY_ROUTE) return "history";
  if (request.routeKey === STEP_ROUTE) return "step";
  if (request.routeKey === SPEC_ROUTE) return "spec";
  if (request.routeKey === APPROVE_ROUTE) return "approve";
  return "unknown";
}

/** Routes one request; table or queue failures give a 500 with a generic message (logged by error name only). */
export async function handleConversationRequest(request: HttpRequest, deps: ConversationDeps): Promise<HttpResponse> {
  const route = routeOf(request);
  let result: Result;
  try {
    const session = await requireSession(request, { sessions: deps.sessions, now: deps.now });
    if (!session.ok) result = { outcome: "unauthorized", response: session.response };
    else if (route === "send") result = await send(request, session.participant, deps);
    else if (route === "poll") result = await poll(request, session.participant, deps);
    else if (route === "history") result = await history(session.participant, deps);
    else if (route === "step") result = await moveStep(request, session.participant, deps);
    else if (route === "spec") result = await spec(request, session.participant, deps);
    else if (route === "approve") result = await approve(request, session.participant, deps);
    else result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  } catch (error) {
    result = { outcome: "failed", response: jsonResponse(500, { message: FAILED_MESSAGE }), error: errorName(error) };
  }
  deps.log({ event: "conversation", route, outcome: result.outcome, ...(result.error === undefined ? {} : { error: result.error }) });
  return result.response;
}
