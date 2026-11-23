// The conversation routes (ticket 1.7): `POST /api/conversation/messages` stores a message and hands
// it to the AI worker through the queue, answering at once with its id; `GET
// /api/conversation/messages/{id}` returns the caller's own message and, once there, its reply.
// Both start with the one session check and read or write only the caller's own partition, so
// another participant's message id is simply not found.
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
import type { MessageStatus } from "../types.js";
import { FAILURE_REPLY, isStale, type ConversationStore, type MessageQueue } from "./state.js";

export const SEND_ROUTE = "POST /api/conversation/messages";
export const POLL_ROUTE = "GET /api/conversation/messages/{id}";
export const CONVERSATION_ROUTES = [SEND_ROUTE, POLL_ROUTE] as const;

/** A message holds 1 to 2000 characters (Unicode code points) after trimming. */
export const MAX_MESSAGE_CHARS = 2000;
/** 2000 characters of up to 4 bytes, JSON escapes included, fit; anything larger is refused unread. */
export const MESSAGE_BODY_LIMITS = { maxBodyBytes: 16_384, maxRawBodyBytes: 24_576 } as const;

export const MESSAGES = {
  invalid: `Send a JSON body with a text of 1 to ${MAX_MESSAGE_CHARS} characters.`,
  busy: "Please wait for the answer to your last message.",
  waiting: "Your last message is waiting for your facilitator. You can write again once they have looked at it.",
  "no-nickname": "Please pick a nickname first.",
} as const;

export type ConversationRoute = "send" | "poll" | "unknown";
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

const refused = (reason: keyof typeof MESSAGES, status: number): Result => ({
  outcome: reason === "invalid" ? "invalid-request" : reason,
  response: jsonResponse(status, { message: MESSAGES[reason], ...(reason === "invalid" ? {} : { reason }) }),
});

async function send(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const text = readMessageText(request);
  if (text === undefined) return refused("invalid", 400);
  if (participant.nickname === undefined || participant.step === "nickname") return refused("no-nickname", 409);
  const now = deps.now();
  const id = newMessageId(now, deps.randomBytes);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const created = await deps.store.createMessage(participant.id, {
    id,
    step: participant.step,
    text,
    createdAt: now.toISOString(),
    nowSeconds,
  });
  if (created !== "created") return refused(created, 409);
  try {
    await deps.queue.send({ participantId: participant.id, messageId: id });
  } catch (error) {
    // Nothing will answer it: end it as failed at once, so the participant can send again.
    await deps.store.finish(participant.id, id, { kind: "failed", reply: FAILURE_REPLY }, "pending", now.toISOString());
    throw error;
  }
  return { outcome: "accepted", response: jsonResponse(202, { id }) };
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

function routeOf(request: HttpRequest): ConversationRoute {
  if (request.routeKey === SEND_ROUTE) return "send";
  if (request.routeKey === POLL_ROUTE) return "poll";
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
    else result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  } catch (error) {
    result = { outcome: "failed", response: jsonResponse(500, { message: FAILED_MESSAGE }), error: errorName(error) };
  }
  deps.log({ event: "conversation", route, outcome: result.outcome, ...(result.error === undefined ? {} : { error: result.error }) });
  return result.response;
}
