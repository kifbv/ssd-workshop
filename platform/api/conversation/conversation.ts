// The conversation routes (ticket 1.7): `POST /api/conversation/messages` stores a message and hands
// it to the AI worker through the queue, answering at once with its id; `GET
// /api/conversation/messages/{id}` returns the caller's own message and, once there, its reply.
// Ticket 1.8 adds `GET /api/conversation` (the conversation so far, for a page load) and
// `POST /api/conversation/step` (Write my spec: from step 1 to step 2). Ticket 1.9 adds
// `GET /api/conversation/spec` (the newest spec version, or `?version=n`) and
// `POST /api/conversation/spec/approve` (Approve spec), and Write my spec now also asks the AI worker
// for the first version. Ticket 2.7: Approve spec also stores the readiness request for the AI worker (see
// ./readiness.ts), and `GET /api/build` returns the caller's own build. Ticket 3.3: `GET /api/conversation` also
// answers `budgetLeft`, the caller's AI budget left in dollars (the AI worker enforces the budget). Ticket 3.5: while the
// admin's global Stop is on, the three reads the page repeats (`GET /api/conversation`, the message poll and
// `GET /api/build`) also answer `paused: true`, and `GET /api/status` answers only that (every signed-in screen asks it
// every 30 s), so every participant page shows the paused banner. Ticket 3.6: at step 4 (step `building` with the app live)
// a sent message is a change request; `POST /api/conversation/change/build` (Build this change) and
// `POST /api/conversation/change/discard` (Not this one) act on the proposed version, and once the app is live the reads
// ask the AI worker (once) for three suggested changes. Ticket 3.9: `POST /api/conversation/change/rebuild` (Rebuild from my
// repository) asks for a change build from the caller's own SPEC.md on GitHub. Ticket 3.15:
// `POST /api/conversation/change/edit` (Rebuild with my edits) asks for one from the spec the caller edited on the page,
// through the same pipeline. Ticket 3.26: `GET /api/build` also answers the caller's own `editUrl` (the app's edit link,
// made when the build is first seen live) and `POST /api/build/edit-link` (New edit link) replaces it. Every route starts with the
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
import { FAILED_MESSAGE, NICKNAME_PATTERN, NOT_FOUND_MESSAGE } from "../participant/participant.js";
import { appAddress, appRepositoryUrl, QUEUE_SEEN_MS } from "../settings.js";
import { requireSession, signInRequiredResponse, type ParticipantRecord, type SessionReader } from "../session/session.js";
import { editUrl, ensureEditLink, renewEditLink, type EditLink, type EditLinkStore } from "../app-token/token.js";
import { errorName } from "../sign-in/code-request.js";
import type { ConversationState, MessageStatus, Step } from "../types.js";
import { budgetOf } from "../workshop/budget.js";
import { APP_EDIT_LINK_TEXTS, changesUsedText, PHASE_3_TEXTS } from "../workshop/texts.js";
import type { BudgetFacts } from "../workshop/budget.js";
import { CHANGE_BUILD_REQUEST, CHANGE_FAILURE_REPLY } from "./change.js";
import { MAX_SPEC_VERSION } from "../keys.js";
import { READINESS_FAILURE_REPLY, READINESS_REQUEST } from "./readiness.js";
import { WRITE_SPEC_REQUEST } from "./spec.js";
import { EDIT_REQUEST, REBUILD_REQUEST } from "../workshop/texts.js";
import { cleanRepositorySpec } from "../github/repository.js";
import { MAX_SPEC_CHARS } from "./spec.js";
import {
  FAILURE_REPLY,
  HISTORY_PAGE_LIMIT,
  isStale,
  type ConversationStore,
  type ListedItem,
  type MessageQueue,
  type StoredBuild,
  type StoredConversation,
  type SuggestionsQueue,
} from "./state.js";

export const SEND_ROUTE = "POST /api/conversation/messages";
export const POLL_ROUTE = "GET /api/conversation/messages/{id}";
export const HISTORY_ROUTE = "GET /api/conversation";
export const STEP_ROUTE = "POST /api/conversation/step";
export const SPEC_ROUTE = "GET /api/conversation/spec";
export const APPROVE_ROUTE = "POST /api/conversation/spec/approve";
export const BUILD_ROUTE = "GET /api/build";
export const STATUS_ROUTE = "GET /api/status";
/** Ticket 3.6: Build this change and Not this one, on the caller's proposed spec version. */
export const CHANGE_BUILD_ROUTE = "POST /api/conversation/change/build";
export const CHANGE_DISCARD_ROUTE = "POST /api/conversation/change/discard";
/** Ticket 3.9: Rebuild from my repository (step 4): the caller's own SPEC.md on `main`, read by the platform. */
export const CHANGE_REBUILD_ROUTE = "POST /api/conversation/change/rebuild";
/** Ticket 3.15: Rebuild with my edits (step 4): the caller's own live spec, edited on the page. */
export const CHANGE_EDIT_ROUTE = "POST /api/conversation/change/edit";
/** Ticket 3.26, New edit link (step 4): a new edit secret for the caller's own app; the old one stops at once. */
export const EDIT_LINK_ROUTE = "POST /api/build/edit-link";
export const CONVERSATION_ROUTES = [
  SEND_ROUTE,
  POLL_ROUTE,
  HISTORY_ROUTE,
  STEP_ROUTE,
  SPEC_ROUTE,
  APPROVE_ROUTE,
  BUILD_ROUTE,
  STATUS_ROUTE,
  CHANGE_BUILD_ROUTE,
  CHANGE_DISCARD_ROUTE,
  CHANGE_REBUILD_ROUTE,
  CHANGE_EDIT_ROUTE,
  EDIT_LINK_ROUTE,
] as const;

/** Ticket 3.6: a page load asks for the suggested changes again only this long after the last ask (none stored yet). */
export const SUGGESTIONS_RETRY_MS = 10 * 60 * 1000;

/** A message holds 1 to 2000 characters (Unicode code points) after trimming. */
export const MAX_MESSAGE_CHARS = 2000;
/** 2000 characters of up to 4 bytes, JSON escapes included, fit; anything larger is refused unread. */
export const MESSAGE_BODY_LIMITS = { maxBodyBytes: 16_384, maxRawBodyBytes: 24_576 } as const;
/**
 * Ticket 3.15: an edited spec holds at most MAX_SPEC_CHARS (8,000) characters. 8,000 characters as JSON escapes (up to
 * 12 bytes each, a `\uXXXX` surrogate pair) fit in 96 KB; a larger body is answered as too long, unread.
 */
export const EDIT_BODY_LIMITS = { maxBodyBytes: 98_304, maxRawBodyBytes: 131_072 } as const;

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
  "invalid-change": "Send a JSON body with the version of the proposed change.",
  "invalid-rebuild": "Send a JSON body (it may be empty: {}).",
  "invalid-edit": "Send a JSON body with the version of your live spec and the edited text.",
  "edit-empty": PHASE_3_TEXTS.editEmpty,
  "too-long": PHASE_3_TEXTS.editTooLong,
  "build-running": PHASE_3_TEXTS.changeWhileBuilding,
  "not-live": PHASE_3_TEXTS.changeBeforeLive,
} as const;

export type ConversationRoute =
  | "send"
  | "poll"
  | "history"
  | "step"
  | "spec"
  | "approve"
  | "build"
  | "status"
  | "change-build"
  | "change-discard"
  | "change-rebuild"
  | "change-edit"
  | "edit-link"
  | "unknown";
export type ConversationOutcome =
  | "accepted"
  | "ok"
  | "unauthorized"
  | "removed"
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
  | "build-running"
  | "not-live"
  | "no-changes-left"
  | "discarded"
  | "too-long"
  /** Ticket 3.26: New edit link made a new secret. */
  | "renewed"
  | "failed";

/** The only things ever logged: route, outcome and an error name (no text, id, token, edit secret or its hash, or reply). */
export interface ConversationLogEntry {
  event: "conversation";
  route: ConversationRoute;
  outcome: ConversationOutcome;
  error?: string;
}

export interface ConversationDeps {
  sessions: SessionReader;
  store: ConversationStore;
  /** The AI worker's queue (ticket 3.6: also the suggestions job). */
  queue: MessageQueue & SuggestionsQueue;
  /** Ticket 3.26: the apps' edit links (the caller's own only). */
  editLinks: EditLinkStore;
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
  const invalid =
    reason === "invalid" ||
    reason === "invalid-step" ||
    reason === "invalid-approve" ||
    reason === "invalid-change" ||
    reason === "invalid-rebuild" ||
    reason === "invalid-edit" ||
    reason === "edit-empty";
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
  // Ticket 1.9: once the spec is approved, nothing changes it until the build is live.
  if (participant.step === "approved") return refused("approved", 409);
  if (participant.step === "building") {
    // Ticket 3.6: step 4, a change request: only while the app is live, nothing of theirs is building, and changes are left.
    const gate = await changeGate(participant.id, await deps.store.getConversation(participant.id), deps);
    if ("refusal" in gate) return gate.refusal;
    const created = await createAndQueue(participant.id, "building", text, deps, gate.buildId);
    if (created.result !== "created") return refused(created.result === "approved" ? "busy" : created.result, 409);
    return { outcome: "accepted", response: jsonResponse(202, { id: created.id }) };
  }
  const created = await createAndQueue(participant.id, participant.step, text, deps);
  if (created.result !== "created") return refused(created.result, 409);
  return { outcome: "accepted", response: jsonResponse(202, { id: created.id }) };
}

/**
 * Ticket 3.6: whether a change may be asked for (or built) now: the conversation's build is the caller's and live, or a
 * change build that failed (the app before it is still live); none of theirs is queued or running; and fewer changes
 * were built than the cap. Answers the build the change follows, or the refusal.
 */
async function changeGate(
  participantId: string,
  conversation: StoredConversation | undefined,
  deps: ConversationDeps,
): Promise<{ buildId: string; build: StoredBuild; facts: BudgetFacts } | { refusal: Result }> {
  const build = conversation?.buildId === undefined ? undefined : await deps.store.getBuild(conversation.buildId);
  if (build === undefined || build.participantId !== participantId) return { refusal: refused("not-live", 409) };
  if (build.status === "queued" || build.status === "building" || build.status === "deploying") return { refusal: refused("build-running", 409) };
  if (build.status === "failed" && build.kind !== "change") return { refusal: refused("not-live", 409) };
  const facts = await deps.store.getBudgetFacts(participantId);
  const cap = facts.settings.changeRequestsPerPerson;
  if (facts.limits.changeRequestsUsed >= cap) {
    return { refusal: { outcome: "no-changes-left", response: jsonResponse(409, { message: changesUsedText(cap), reason: "no-changes-left" }) } };
  }
  return { buildId: build.buildId, build, facts };
}

/** Stores a pending message and hands it to the AI worker; a queue failure ends it as failed at once. */
async function createAndQueue(
  participantId: string,
  step: Step,
  text: string,
  deps: ConversationDeps,
  afterBuild?: string,
  request?: { request: "rebuild-from-repo" } | { request: "edit-spec"; editedSpec: string },
): Promise<{ result: "created"; id: string } | { result: "busy" | "waiting" | "approved" }> {
  const now = deps.now();
  const id = newMessageId(now, deps.randomBytes);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const created = await deps.store.createMessage(
    participantId,
    { id, step, text, createdAt: now.toISOString(), nowSeconds, ...request },
    afterBuild,
  );
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
  const paused = await pausedFlag(participant.id, deps);
  return {
    outcome: "ok",
    response: jsonResponse(200, { id, status, ...(reply === undefined ? {} : { reply }), ...paused.flag }),
    ...(paused.error === undefined ? {} : { error: paused.error }),
  };
}

/**
 * Ticket 3.5: `{ paused: true }` while the global Stop is on, else nothing. A failed settings read answers
 * `{ pausedUnknown: true }` instead (the page keeps the line as it shows it; the answer is still 200) and is logged by
 * name only. Ticket 3.10: while a facilitator paused the caller, `{ paused: true, pausedBy: "facilitator" }` (the page
 * then says "Your facilitator paused your session.").
 */
async function pausedFlag(participantId: string, deps: ConversationDeps): Promise<{ flag: PausedFlag; error?: string }> {
  try {
    return { flag: pausedFlagOf(await deps.store.getPauseState(participantId)) };
  } catch (error) {
    return { flag: { pausedUnknown: true }, error: errorName(error) };
  }
}

/** What a participant's page is told about holds (ticket 3.5, 3.10). */
export type PausedFlag = { paused?: true; pausedBy?: "facilitator"; pausedUnknown?: true };

/** Ticket 3.10: a facilitator's Pause of the caller wins over the global Stop (it lasts until that facilitator's Resume). */
export function pausedFlagOf(state: { stopped: boolean; paused: boolean }): PausedFlag {
  if (state.paused) return { paused: true, pausedBy: "facilitator" };
  return state.stopped ? { paused: true } : {};
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
  /** Ticket 3.6: the proposed change's version, waiting for Build this change or Not this one. */
  proposedSpecVersion?: number;
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
    ...(conversation?.proposedSpecVersion === undefined ? {} : { proposedSpecVersion: conversation.proposedSpecVersion }),
  };
}

/** True when at least one participant message was answered (the spec needs something to go on). */
export function hasAnsweredExchange(items: readonly ListedItem[]): boolean {
  return items.some((i) => i.author === "participant" && i.status === "done");
}

async function history(participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  // A failed budget read does not break the history: `budgetLeft` is left out (the page shows nothing) and the
  // error is logged by name only.
  let budgetError: string | undefined;
  const [items, conversation, budget] = await Promise.all([
    deps.store.listItems(participant.id, HISTORY_PAGE_LIMIT),
    deps.store.getConversation(participant.id),
    deps.store.getBudgetFacts(participant.id).catch((error: unknown) => {
      budgetError = errorName(error);
      return undefined;
    }),
  ]);
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  // Ticket 3.3: the caller's own budget left, in dollars (whole cents, never below 0); never their spend or anyone else's.
  const shaped = shapeHistory(participant.step, items, conversation, nowSeconds);
  // Ticket 3.5: the global Stop, from the same settings read as the budget.
  // A failed read answers `pausedUnknown: true`, so the page keeps the paused line as it shows it.
  // Ticket 3.6: at step 4, the changes used and the cap (the page shows "Changes left: 3 of 5") and the suggested changes;
  // once the app is live and none are stored, the AI worker is asked for them (at most every SUGGESTIONS_RETRY_MS).
  let step4: { changeRequestsUsed?: number; changeRequestsPerPerson?: number; suggestions?: string[] } = {};
  let suggestionsError: string | undefined;
  if (participant.step === "building") {
    step4 = {
      ...(budget === undefined ? {} : { changeRequestsUsed: budget.limits.changeRequestsUsed, changeRequestsPerPerson: budget.settings.changeRequestsPerPerson }),
      ...(conversation?.suggestions === undefined ? {} : { suggestions: conversation.suggestions }),
    };
    suggestionsError = await askForSuggestionsWhenLive(participant.id, conversation, undefined, deps);
  }
  const body =
    budget === undefined
      ? { ...shaped, ...step4, pausedUnknown: true }
      : { ...shaped, ...step4, budgetLeft: budgetOf(budget).leftUsd, ...pausedFlagOf({ stopped: budget.settings.stopped, paused: budget.limits.paused }) };
  const error = budgetError ?? suggestionsError;
  return { outcome: "ok", response: jsonResponse(200, body), ...(error === undefined ? {} : { error }) };
}

/**
 * Ticket 3.6: once the caller's app is live and no suggestions are stored, asks the AI worker for them, at most once per
 * SUGGESTIONS_RETRY_MS (a conditional write of the time asked, then the job). Never fails the read it is part of: an
 * error is answered by name, for the log.
 */
async function askForSuggestionsWhenLive(
  participantId: string,
  conversation: StoredConversation | undefined,
  knownBuild: StoredBuild | undefined,
  deps: ConversationDeps,
): Promise<string | undefined> {
  if (conversation?.buildId === undefined || conversation.suggestions !== undefined) return undefined;
  try {
    const now = deps.now();
    const askedBefore = new Date(now.getTime() - SUGGESTIONS_RETRY_MS).toISOString();
    if (conversation.suggestionsRequestedAt !== undefined && !(conversation.suggestionsRequestedAt < askedBefore)) return undefined;
    const build = knownBuild ?? (await deps.store.getBuild(conversation.buildId));
    if (build?.status !== "live" || build.participantId !== participantId) return undefined;
    if (!(await deps.store.markSuggestionsRequested(participantId, now.toISOString(), askedBefore))) return undefined;
    await deps.queue.sendSuggestions(participantId);
    return undefined;
  } catch (error) {
    return errorName(error);
  }
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
  // Ticket 2.7: a version whose readiness check failed was approved once (`approvedAt` stays) but is no longer
  // the approved one: it shows as approved only while the conversation still holds that approval.
  const approved = found.approved && (await deps.store.getConversation(participant.id))?.approvedSpecVersion === found.version;
  return {
    outcome: "ok",
    response: jsonResponse(200, {
      version: found.version,
      text: found.text,
      createdAt: found.createdAt,
      approved,
      // Ticket 3.6: a proposed change's version carries its "What changes" list.
      ...(found.whatChanges === undefined ? {} : { whatChanges: found.whatChanges }),
    }),
  };
}

/**
 * Approve spec (ticket 1.9): the version the participant saw, only while it is the newest. Ticket 2.7: the
 * approval stores the readiness request as the message in flight and hands it to the AI worker. Pressed again at
 * step approved for the same version, it answers as approved, and asks for the check again only when nothing is
 * in flight (an approval from before 2.7, a check that never finished).
 */
async function approve(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const version = readJsonObject(request)?.["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > MAX_SPEC_VERSION) return refused("invalid-approve", 400);
  if (participant.nickname === undefined || participant.step === "nickname") return refused("no-nickname", 409);
  if (participant.step === "clarify") return refused("no-spec", 409);
  const now = deps.now();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const readiness = { id: newMessageId(now, deps.randomBytes), step: "approved" as const, text: READINESS_REQUEST, createdAt: now.toISOString(), nowSeconds };
  const approved = (id?: string): Result => ({ outcome: "ok", response: jsonResponse(200, { step: "approved", version, ...(id === undefined ? {} : { id }) }) });
  if (participant.step === "approved" || participant.step === "building") {
    // Pressed twice (or in two tabs): the same version again is fine.
    const conversation = await deps.store.getConversation(participant.id);
    if (conversation?.approvedSpecVersion !== version) return refused("approved", 409);
    if (participant.step === "building") return approved();
    const asked = await deps.store.requestReadiness(participant.id, version, readiness);
    if (asked !== "created") return approved();
    await queueReadiness(participant.id, readiness.id, version, deps);
    return approved(readiness.id);
  }
  const result = await deps.store.approveSpec(participant.id, version, nowSeconds, now.toISOString(), readiness);
  // The step moved meanwhile (another tab approved this version at the same moment): answer as for a second press.
  if (result === "wrong-step") return (await deps.store.getConversation(participant.id))?.approvedSpecVersion === version ? approved() : refused("approved", 409);
  if (result !== "approved") return refused(result, 409);
  await queueReadiness(participant.id, readiness.id, version, deps);
  return approved(readiness.id);
}

/** Hands the readiness request to the AI worker; a queue failure sends the participant back to step 2 at once (approve again). */
async function queueReadiness(participantId: string, messageId: string, version: number, deps: ConversationDeps): Promise<void> {
  try {
    await deps.queue.send({ participantId, messageId });
  } catch (error) {
    await deps.store.finishReadiness(participantId, messageId, { kind: "failed", reply: READINESS_FAILURE_REPLY, version }, deps.now().toISOString());
    throw error;
  }
}

/**
 * The caller's own build (ticket 2.7; the step 3 page polls it from ticket 2.10): its id, status, feed, repository
 * and app address and, when it failed, the reasons; while queued, the number of builds ahead of it (ticket 3.4). Found through the caller's own conversation, and only a build that names the caller:
 * anyone else's build (or none yet) is simply not found.
 */
async function build(participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  const notFound: Result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  const conversation = await deps.store.getConversation(participant.id);
  const buildId = conversation?.buildId;
  if (buildId === undefined) return notFound;
  const found = await deps.store.getBuild(buildId);
  if (found === undefined || found.participantId !== participant.id) return notFound;
  // Ticket 3.6: the app is live: ask for the suggested changes (once).
  const suggestionsError = found.status === "live" ? await askForSuggestionsWhenLive(participant.id, conversation, found, deps) : undefined;
  // Ticket 2.10: the feed so far and the links the page shows (commits under the repository, the app's address).
  // Never the participant id: the answer holds only the build's own facts.
  const nickname = found.nickname !== undefined && NICKNAME_PATTERN.test(found.nickname) ? found.nickname : undefined;
  // Ticket 3.4: a queued build the launcher has placed in the waiting line answers how many builds wait ahead of it (a
  // count only, never whose). A failed count leaves `ahead` out (the page says the build is in the queue) and is logged
  // by name only.
  let ahead: number | undefined;
  let aheadError: string | undefined;
  if (found.status === "queued" && found.queueKey !== undefined) {
    const since = new Date(deps.now().getTime() - QUEUE_SEEN_MS).toISOString();
    ahead = await deps.store.countQueuedAhead(found.queueKey, since).catch((error: unknown) => {
      aheadError = errorName(error);
      return undefined;
    });
  }
  // Ticket 3.26: the app's edit link, only ever in the caller's own answer (the build names the caller). Made when the
  // build is first seen live; while a change build runs, the existing one is shown. A failure leaves `editUrl` out (the
  // page keeps the plain address) and is logged by name only, never the secret or its hash.
  let link: EditLink | undefined;
  let linkError: string | undefined;
  if (nickname !== undefined) {
    try {
      link = found.status === "live" ? await ensureEditLink(deps.editLinks, participant.id, nickname, deps.randomBytes, deps.now()) : await ownLink(deps.editLinks, nickname);
    } catch (error) {
      linkError = errorName(error);
    }
  }
  const paused = await pausedFlag(participant.id, deps);
  const error = aheadError ?? linkError ?? paused.error ?? suggestionsError;
  return {
    outcome: "ok",
    response: jsonResponse(200, {
      buildId: found.buildId,
      status: found.status,
      feed: found.feed ?? [],
      ...(nickname === undefined ? {} : { repositoryUrl: appRepositoryUrl(nickname), appUrl: appAddress(nickname) }),
      ...(nickname === undefined || link === undefined ? {} : { editUrl: editUrl(nickname, link.secret) }),
      ...(found.status === "failed" && found.failureReasons !== undefined ? { failureReasons: found.failureReasons } : {}),
      ...(ahead === undefined ? {} : { ahead }),
      // Ticket 3.6: a change build says so, with its number.
      ...(found.kind === "change" ? { kind: "change", ...(found.changeNumber === undefined ? {} : { changeNumber: found.changeNumber }) } : {}),
      ...paused.flag,
    }),
    ...(error === undefined ? {} : { error }),
  };
}

/** Ticket 3.26: the app's stored edit link when it is this builder's (nicknames are unique), else undefined. */
async function ownLink(store: EditLinkStore, nickname: string): Promise<EditLink | undefined> {
  const link = await store.getEditLink(nickname);
  return link !== undefined && link.nickname.toLowerCase() === nickname.toLowerCase() ? link : undefined;
}

/**
 * Ticket 3.26, New edit link: a new secret for the caller's own app (the app named by the session's nickname: nothing in
 * the body names one), only once the app has an edit link (it went live and was not reset; 404 otherwise). The old
 * secret's lookup item goes in the same transaction, so it answers 401 at once. The body must be JSON (415 otherwise,
 * so a plain form on another site cannot press it); its content is ignored. Answers the new `editUrl`.
 */
async function newEditLink(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  if (readJsonObject(request) === undefined) return refused("invalid-rebuild", 400);
  const notLive: Result = { outcome: "not-live", response: jsonResponse(404, { message: APP_EDIT_LINK_TEXTS.notLive, reason: "not-live" }) };
  if (participant.nickname === undefined || !NICKNAME_PATTERN.test(participant.nickname)) return notLive;
  const renewed = await renewEditLink(deps.editLinks, participant.id, participant.nickname, deps.randomBytes, deps.now());
  if (!renewed.ok) return renewed.reason === "removed" ? { outcome: "removed", response: signInRequiredResponse() } : notLive;
  return { outcome: "renewed", response: jsonResponse(200, { editUrl: editUrl(participant.nickname, renewed.link.secret) }) };
}

/** Ticket 3.6: the version a change route names (a whole number from 1), or undefined. */
function readChangeVersion(request: HttpRequest): number | undefined {
  const version = readJsonObject(request)?.["version"];
  return typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= MAX_SPEC_VERSION ? version : undefined;
}

/**
 * Ticket 3.6, Build this change: for the caller's own proposed version only (any other version, or none proposed: 404),
 * while the app is live, nothing of theirs is building and changes are left; stores the request for the AI worker (which
 * runs the readiness check and queues the change build) as the message in flight, and answers its id for polling.
 */
async function buildChange(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const version = readChangeVersion(request);
  if (version === undefined) return refused("invalid-change", 400);
  const notFound: Result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  if (participant.step !== "building") return notFound;
  const conversation = await deps.store.getConversation(participant.id);
  if (conversation?.proposedSpecVersion !== version) return notFound;
  const gate = await changeGate(participant.id, conversation, deps);
  if ("refusal" in gate) return gate.refusal;
  const now = deps.now();
  const message = {
    id: newMessageId(now, deps.randomBytes),
    step: "building" as const,
    text: CHANGE_BUILD_REQUEST,
    createdAt: now.toISOString(),
    nowSeconds: Math.floor(now.getTime() / 1000),
    request: "change-build" as const,
  };
  const result = await deps.store.requestChangeBuild(participant.id, version, gate.buildId, message);
  if (result === "stale") return notFound;
  if (result !== "created") return refused(result, 409);
  try {
    await deps.queue.send({ participantId: participant.id, messageId: message.id });
  } catch (error) {
    // Nothing will answer it: end it at once (the proposal stays), so the participant can press again.
    await deps.store.finishChangeBuild(
      participant.id,
      message.id,
      { kind: "failed", reply: CHANGE_FAILURE_REPLY, version, previousBuildId: gate.buildId },
      now.toISOString(),
    );
    throw error;
  }
  return { outcome: "accepted", response: jsonResponse(202, { id: message.id, version }) };
}

/** Ticket 3.6, Not this one: puts the caller's own proposed version aside (any other version: 404); nothing counts. */
async function discardChange(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const version = readChangeVersion(request);
  if (version === undefined) return refused("invalid-change", 400);
  const notFound: Result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  if (participant.step !== "building") return notFound;
  const now = deps.now();
  const result = await deps.store.discardChange(participant.id, version, Math.floor(now.getTime() / 1000), now.toISOString());
  if (result === "stale") return notFound;
  if (result !== "discarded") return refused(result, 409);
  return { outcome: "discarded", response: jsonResponse(200, { version, discarded: true }) };
}

/**
 * Ticket 3.9, Rebuild from my repository: at step 4 only (any other step: 404, like a change route's), while the app is
 * live, nothing of the caller's is building and changes are left (the change gate's 409s); stores REBUILD_REQUEST marked
 * `rebuild-from-repo` (an attribute only this route writes) as the message in flight and hands it to the AI worker, which
 * has the launcher read the caller's own SPEC.md, checks it and queues the change build. Answers its id for polling. The
 * body must be JSON (415 otherwise, so a plain form cannot press it from another site); its content is ignored.
 */
async function rebuildFromRepository(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  if (readJsonObject(request) === undefined) return refused("invalid-rebuild", 400);
  if (participant.step !== "building" || participant.nickname === undefined) return { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  const gate = await changeGate(participant.id, await deps.store.getConversation(participant.id), deps);
  if ("refusal" in gate) return gate.refusal;
  const created = await createAndQueue(participant.id, "building", REBUILD_REQUEST, deps, gate.buildId, { request: "rebuild-from-repo" });
  if (created.result !== "created") return refused(created.result === "approved" ? "busy" : created.result, 409);
  return { outcome: "accepted", response: jsonResponse(202, { id: created.id }) };
}

/**
 * Ticket 3.15, Rebuild with my edits: body `{ "version": n, "text": "..." }`, where `version` is the caller's live spec
 * version the editor opened (any other: 404, so a stale editor never rebuilds over a newer live spec) and `text` the
 * edited spec, at most MAX_SPEC_CHARS characters (counted in code points; longer: 400 "too-long", nothing stored, no AI
 * call). Only the caller's own conversation is read or written (the session's participant; nothing in the body names
 * one). At step 4 only (any other step: 404), behind the change gate's 409s. The text is cleaned as a repository's
 * SPEC.md is (cleanRepositorySpec: line endings, control and format characters, email addresses, trailing spaces) and
 * stored beside EDIT_REQUEST marked `edit-spec` (`editedSpec`, an attribute only this route writes); the AI worker then
 * runs Rebuild from my repository's pipeline on it (same spec, shape, guardrail, readiness, the counted change build).
 * The text is never logged. Answers the request's id for polling.
 */
async function editSpec(request: HttpRequest, participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const body = readJsonObject(request, EDIT_BODY_LIMITS);
  if (body === undefined) return isOversized(request) ? refused("too-long", 400) : refused("invalid-edit", 400);
  const version = body["version"];
  const text = body["text"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > MAX_SPEC_VERSION || typeof text !== "string") {
    return refused("invalid-edit", 400);
  }
  // Before anything is read or stored, and before any AI call.
  if (Array.from(text).length > MAX_SPEC_CHARS) return refused("too-long", 400);
  const notFound: Result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  if (participant.step !== "building" || participant.nickname === undefined) return notFound;
  const conversation = await deps.store.getConversation(participant.id);
  if (conversation?.approvedSpecVersion !== version) return notFound;
  const editedSpec = cleanRepositorySpec(text);
  if (editedSpec.trim() === "") return refused("edit-empty", 400);
  const gate = await changeGate(participant.id, conversation, deps);
  if ("refusal" in gate) return gate.refusal;
  const created = await createAndQueue(participant.id, "building", EDIT_REQUEST, deps, gate.buildId, { request: "edit-spec", editedSpec });
  if (created.result !== "created") return refused(created.result === "approved" ? "busy" : created.result, 409);
  return { outcome: "accepted", response: jsonResponse(202, { id: created.id }) };
}

/** Ticket 3.15: the body is over EDIT_BODY_LIMITS (so its text cannot be 8,000 characters or fewer, as the page sends it). */
function isOversized(request: HttpRequest): boolean {
  if (typeof request.body !== "string") return false;
  if (Buffer.byteLength(request.body, "utf8") > EDIT_BODY_LIMITS.maxRawBodyBytes) return true;
  const raw = request.isBase64Encoded === true ? Buffer.from(request.body, "base64").toString("utf8") : request.body;
  return Buffer.byteLength(raw, "utf8") > EDIT_BODY_LIMITS.maxBodyBytes;
}

/**
 * Ticket 3.5: `GET /api/status`, the workshop's state for any signed-in person (`{ paused: true }` while the global
 * Stop is on, else `{}`): one small `SETTINGS` read, which every signed-in screen repeats every 30 s so an idle page
 * shows and clears the paused banner. A failed read is a 500 (the page keeps what it showed), not a false "running".
 * Ticket 3.10: also the caller's own Pause (`{ paused: true, pausedBy: "facilitator" }`), from their profile.
 */
async function workshopStatus(participant: ParticipantRecord, deps: ConversationDeps): Promise<Result> {
  return { outcome: "ok", response: jsonResponse(200, pausedFlagOf(await deps.store.getPauseState(participant.id))) };
}

function routeOf(request: HttpRequest): ConversationRoute {
  if (request.routeKey === SEND_ROUTE) return "send";
  if (request.routeKey === POLL_ROUTE) return "poll";
  if (request.routeKey === HISTORY_ROUTE) return "history";
  if (request.routeKey === STEP_ROUTE) return "step";
  if (request.routeKey === SPEC_ROUTE) return "spec";
  if (request.routeKey === APPROVE_ROUTE) return "approve";
  if (request.routeKey === BUILD_ROUTE) return "build";
  if (request.routeKey === STATUS_ROUTE) return "status";
  if (request.routeKey === CHANGE_BUILD_ROUTE) return "change-build";
  if (request.routeKey === CHANGE_DISCARD_ROUTE) return "change-discard";
  if (request.routeKey === CHANGE_REBUILD_ROUTE) return "change-rebuild";
  if (request.routeKey === CHANGE_EDIT_ROUTE) return "change-edit";
  if (request.routeKey === EDIT_LINK_ROUTE) return "edit-link";
  return "unknown";
}

/** Routes one request; table or queue failures give a 500 with a generic message (logged by error name only). */
export async function handleConversationRequest(request: HttpRequest, deps: ConversationDeps): Promise<HttpResponse> {
  const route = routeOf(request);
  let result: Result;
  try {
    const session = await requireSession(request, { sessions: deps.sessions, now: deps.now });
    // A person taken off the allow-list is told apart in the logs (ticket 3.1), as on the participant routes.
    if (!session.ok) result = { outcome: session.reason === "removed" ? "removed" : "unauthorized", response: session.response };
    else if (route === "send") result = await send(request, session.participant, deps);
    else if (route === "poll") result = await poll(request, session.participant, deps);
    else if (route === "history") result = await history(session.participant, deps);
    else if (route === "step") result = await moveStep(request, session.participant, deps);
    else if (route === "spec") result = await spec(request, session.participant, deps);
    else if (route === "approve") result = await approve(request, session.participant, deps);
    else if (route === "build") result = await build(session.participant, deps);
    else if (route === "status") result = await workshopStatus(session.participant, deps);
    else if (route === "change-build") result = await buildChange(request, session.participant, deps);
    else if (route === "change-discard") result = await discardChange(request, session.participant, deps);
    else if (route === "change-rebuild") result = await rebuildFromRepository(request, session.participant, deps);
    else if (route === "change-edit") result = await editSpec(request, session.participant, deps);
    else if (route === "edit-link") result = await newEditLink(request, session.participant, deps);
    else result = { outcome: "not-found", response: jsonResponse(404, { message: NOT_FOUND_MESSAGE }) };
  } catch (error) {
    result = { outcome: "failed", response: jsonResponse(500, { message: FAILED_MESSAGE }), error: errorName(error) };
  }
  deps.log({ event: "conversation", route, outcome: result.outcome, ...(result.error === undefined ? {} : { error: result.error }) });
  return result.response;
}
