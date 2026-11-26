// The facilitator routes (ticket 3.10): the dashboard's data and actions, for facilitators and the admin. Every
// facilitator sees and acts on every participant (spec delta "Dashboard scope", 2026-11-25); the role comes from the
// allow-list through the one session check (ticket 3.1), never from the profile, and a participant gets the same 404 as
// an unknown route before anything is read.
//
// Participants are named by their nickname in every action route (`/api/facilitator/participants/{nickname}/...`): it is
// unique (its `NICK#` claim, any letter case), it is what the dashboard already shows, and it is neither the participant
// id nor an email address. No answer holds a participant id or an email address: texts a participant typed (a flagged
// message, the conversation log) are shown with email-shaped text removed.
//
// - `GET  /api/facilitator/participants[?group=<group>]`: one row per participant (role `participant` on the profile).
// - `GET  /api/facilitator/participants/{nickname}/conversation`: the participant's conversation log.
// - `POST .../retry`: a failed build, or one `building` for over STUCK_BUILD_MS, is asked to run again. Only the
//   launcher may stop a build task or start one (access boundary), so this stores a Retry request the launcher's minute
//   check acts on, and moves the conversation's `updatedAt`. A retry never counts a change.
// - `POST .../pause` and `.../resume`: the profile's `paused` (the AI worker and the launcher hold a paused participant's
//   next message and build; the participant's page says "Your facilitator paused your session.").
// - `POST .../budget`: adds BUDGET_STEP_USD ($2) to the profile's `extraBudget`; the amount is the server's, never read
//   from the request.
// - `POST .../flag/approve` and `.../flag/reject`: the waiting flagged message, decided exactly as `npm run flags` does
//   (platform/api/flags/flags.ts).
import { removeEmailAddresses } from "../github/repository.js";
import { decideFlag, type FlagDecisionStore } from "../flags/flags.js";
import type { ConversationStore, ListedItem, MessageQueue } from "../conversation/state.js";
import { isJsonContentType, jsonResponse, unsupportedMediaTypeResponse, type HttpRequest, type HttpResponse } from "../http.js";
import { FAILED_MESSAGE, NICKNAME_PATTERN, notFoundResponse } from "../participant/participant.js";
import { requireSession, type SessionReader } from "../session/session.js";
import { BUDGET_STEP_USD, STUCK_BUILD_MS } from "../settings.js";
import { errorName } from "../sign-in/code-request.js";
import type { BuildStatus, Role } from "../types.js";
import { budgetFor, toCents, type WorkshopSettings } from "../workshop/settings.js";

const BASE = "/api/facilitator/participants";
export const LIST_ROUTE = `GET ${BASE}`;
export const CONVERSATION_ROUTE = `GET ${BASE}/{nickname}/conversation`;
export const RETRY_ROUTE = `POST ${BASE}/{nickname}/retry`;
export const PAUSE_ROUTE = `POST ${BASE}/{nickname}/pause`;
export const RESUME_ROUTE = `POST ${BASE}/{nickname}/resume`;
export const BUDGET_ROUTE = `POST ${BASE}/{nickname}/budget`;
export const APPROVE_ROUTE = `POST ${BASE}/{nickname}/flag/approve`;
export const REJECT_ROUTE = `POST ${BASE}/{nickname}/flag/reject`;

export type FacilitatorRoute = "list" | "conversation" | "retry" | "pause" | "resume" | "budget" | "approve" | "reject" | "unknown";

const ROUTES: Record<string, FacilitatorRoute> = {
  [LIST_ROUTE]: "list",
  [CONVERSATION_ROUTE]: "conversation",
  [RETRY_ROUTE]: "retry",
  [PAUSE_ROUTE]: "pause",
  [RESUME_ROUTE]: "resume",
  [BUDGET_ROUTE]: "budget",
  [APPROVE_ROUTE]: "approve",
  [REJECT_ROUTE]: "reject",
};
export const FACILITATOR_ROUTES = Object.keys(ROUTES);

/** How many messages and replies the conversation log shows (the newest, oldest first). */
export const CONVERSATION_LOG_LIMIT = 100;

export const FACILITATOR_TEXTS = {
  noBuild: "This participant has no build yet.",
  notRetryable: "Only a failed build, or one building for over 15 minutes, can be retried.",
  retryRequested: "Retry requested: the build starts again within a minute.",
  noFlag: "No message is waiting for a decision.",
  decidedMeanwhile: "This message was decided meanwhile; nothing changed.",
  approved: "Approved: the message goes to the AI now; the answer appears on the participant's page.",
  approvedNotQueued: "Approved, but the message could not be handed to the AI. The participant sees it fail within 20 minutes and can send it again.",
  rejected: "Rejected: the participant got a polite decline and can write again.",
  paused: "Paused: the participant's next message and build wait until you press Resume.",
  resumed: "Resumed: the participant's messages and builds go ahead.",
  budgetAdded: `Added $${String(BUDGET_STEP_USD)} of AI budget.`,
} as const;

export type FacilitatorOutcome =
  | "ok"
  | "requested"
  | "paused"
  | "resumed"
  | "added"
  | "approved"
  | "approved-not-queued"
  | "rejected"
  | "refused"
  | "unauthorized"
  | "removed"
  | "not-found"
  | "unsupported-media-type"
  | "failed";

/** The only things ever logged: route and outcome (no nickname, id, text or value). */
export interface FacilitatorLogEntry {
  event: "facilitator";
  route: FacilitatorRoute;
  outcome: FacilitatorOutcome;
  error?: string;
}

/** A profile as the dashboard reads it (the index by type; never an email address). */
export interface RosterProfile {
  participantId: string;
  nickname?: string;
  role?: string;
  group?: string;
  step?: string;
  stepSince?: string;
  createdAt?: string;
  paused: boolean;
  extraBudget: number;
  changeRequestsUsed: number;
}

export interface RosterBuild {
  participantId: string;
  status: BuildStatus;
  launchedAt?: string;
  kind?: "first" | "change";
  changeNumber?: number;
}

/** Everything the list needs, read in a few queries (no scan). */
export interface Roster {
  profiles: RosterProfile[];
  conversations: Map<string, { buildId?: string; state?: string; pendingId?: string }>;
  /** Spend in dollars by participant id. */
  spend: Map<string, number>;
  builds: Map<string, RosterBuild>;
  /** Builds with a Retry request the launcher has not acted on yet. */
  retries: Set<string>;
}

/** A build as Retry checks it. */
export interface RetryBuild {
  participantId: string;
  status: BuildStatus;
  launchedAt?: string;
}

export interface FacilitatorStore extends FlagDecisionStore, Pick<ConversationStore, "listItems"> {
  roster(): Promise<Roster>;
  /** The participant id holding the nickname (its claim, any letter case). */
  findParticipantId(nickname: string): Promise<string | undefined>;
  /** The profile's `role` (written from the allow-list by the sign-in and the allow-list command), or undefined. */
  getProfileRole(participantId: string): Promise<string | undefined>;
  getSettings(): Promise<WorkshopSettings>;
  getRetryBuild(buildId: string): Promise<RetryBuild | undefined>;
  /** Sets the profile's `paused`; false when there is no profile. */
  setPaused(participantId: string, paused: boolean): Promise<boolean>;
  /** Adds `dollars` to the profile's `extraBudget` (one atomic ADD); the new extra budget, or undefined without a profile. */
  addBudget(participantId: string, dollars: number): Promise<number | undefined>;
  /** Stores a Retry request for the build and moves the conversation's `updatedAt`. */
  requestRetry(buildId: string, participantId: string, nowIso: string): Promise<void>;
}

export interface FacilitatorDeps {
  sessions: SessionReader;
  store: FacilitatorStore;
  /** The AI worker's queue (an approved flag goes there). */
  queue: () => MessageQueue;
  now: () => Date;
  log: (entry: FacilitatorLogEntry) => void;
}

/** One dashboard row: no participant id, no email address. */
export interface ParticipantRow {
  /** Also the handle of every action route; null before the participant chose one (no action applies then). */
  nickname: string | null;
  group: string | null;
  step: string | null;
  /** When the current step started (ISO 8601): `stepSince`, else the profile's creation. */
  stepSince: string | null;
  minutesInStep: number | null;
  build: {
    status: BuildStatus;
    kind: "first" | "change";
    changeNumber?: number;
    /** `building` for over 15 minutes. */
    stuck: boolean;
    minutesBuilding?: number;
    /** A Retry was pressed and the launcher has not acted on it yet. */
    retryRequested: boolean;
  } | null;
  spentUsd: number;
  budgetUsd: number;
  extraBudgetUsd: number;
  changeRequestsUsed: number;
  changeRequestsPerPerson: number;
  paused: boolean;
  /** The open flag (at most one per participant): the message's text and the guardrail's reason. */
  flags: { text: string; reason: string }[];
}

const minutesSince = (iso: string | undefined, now: number): number | null => {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : null;
};

/** A participant's text for a facilitator: email-shaped text removed (an address typed into a message is not shown). */
export const shownText = (text: string): string => removeEmailAddresses(text);

async function listRows(deps: FacilitatorDeps, group: string | undefined): Promise<{ rows: ParticipantRow[]; settings: WorkshopSettings }> {
  const [roster, settings] = await Promise.all([deps.store.roster(), deps.store.getSettings()]);
  const now = deps.now().getTime();
  const profiles = roster.profiles.filter((p) => p.role === "participant" && (group === undefined || p.group === group));
  const rows = await Promise.all(
    profiles.map(async (p): Promise<ParticipantRow> => {
      const conversation = roster.conversations.get(p.participantId);
      const buildId = conversation?.buildId;
      const stored = buildId === undefined ? undefined : roster.builds.get(buildId);
      const build = stored !== undefined && stored.participantId === p.participantId ? stored : undefined;
      const building = build?.status === "building" ? minutesSince(build.launchedAt, now) : null;
      let flags: ParticipantRow["flags"] = [];
      if (conversation?.state === "waiting" && conversation.pendingId !== undefined) {
        const message = await deps.store.getMessage(p.participantId, conversation.pendingId);
        if (message?.status === "flagged") flags = [{ text: shownText(message.text), reason: shownText(message.verdictReason ?? "") }];
      }
      const since = p.stepSince ?? p.createdAt;
      return {
        nickname: p.nickname ?? null,
        group: p.group ?? null,
        step: p.step ?? null,
        stepSince: since ?? null,
        minutesInStep: minutesSince(since, now),
        build:
          build === undefined || buildId === undefined
            ? null
            : {
                status: build.status,
                kind: build.kind === "change" ? "change" : "first",
                ...(build.kind === "change" && build.changeNumber !== undefined ? { changeNumber: build.changeNumber } : {}),
                stuck: isStuck(build, now),
                ...(building === null ? {} : { minutesBuilding: building }),
                retryRequested: roster.retries.has(buildId),
              },
        spentUsd: toCents(roster.spend.get(p.participantId) ?? 0),
        budgetUsd: budgetFor(settings, p),
        extraBudgetUsd: toCents(p.extraBudget),
        changeRequestsUsed: p.changeRequestsUsed,
        changeRequestsPerPerson: settings.changeRequestsPerPerson,
        paused: p.paused,
        flags,
      };
    }),
  );
  // Rows by group, then nickname (any letter case); participants without a nickname yet last in their group.
  const key = (row: ParticipantRow): string => `${row.group ?? "~"}\u0000${row.nickname === null ? "~" : row.nickname.toLowerCase()}`;
  return { rows: rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)), settings };
}

/** `building` for over STUCK_BUILD_MS (the launcher's check uses the same rule before it acts on a Retry). */
export function isStuck(build: { status: BuildStatus; launchedAt?: string }, now: number): boolean {
  if (build.status !== "building" || build.launchedAt === undefined) return false;
  const at = Date.parse(build.launchedAt);
  return Number.isFinite(at) && now - at > STUCK_BUILD_MS;
}

/** One log line per message: who said it and what, never an id or a model's internals. */
function logLine(item: ListedItem): Record<string, unknown> {
  if (item.author === "participant") return { author: "participant", step: item.step, status: item.status, text: shownText(item.text) };
  return { author: "assistant", text: shownText(item.text) };
}

type Result = { outcome: FacilitatorOutcome; response: HttpResponse; error?: string };

const refused = (message: string, status = 409): Result => ({ outcome: "refused", response: jsonResponse(status, { message }) });

async function act(which: FacilitatorRoute, request: HttpRequest, deps: FacilitatorDeps, callerId: string): Promise<Result> {
  const nickname = request.pathParameters?.["nickname"];
  // An unknown nickname, or one that cannot be one, is the plain 404 (nothing else is read).
  if (typeof nickname !== "string" || !NICKNAME_PATTERN.test(nickname)) return { outcome: "not-found", response: notFoundResponse() };
  const participantId = await deps.store.findParticipantId(nickname);
  // Actions and the log reach participants only: never the caller, a facilitator or the admin (their profile's role, a
  // copy of the allow-list's), nor a removed person. Each is the same plain 404 as an unknown nickname.
  if (participantId === undefined || participantId === callerId) return { outcome: "not-found", response: notFoundResponse() };
  if ((await deps.store.getProfileRole(participantId)) !== "participant") return { outcome: "not-found", response: notFoundResponse() };
  if (which === "conversation") {
    const items = await deps.store.listItems(participantId, CONVERSATION_LOG_LIMIT);
    return { outcome: "ok", response: jsonResponse(200, { nickname, messages: items.map(logLine) }) };
  }
  // Every action is a write: a JSON content type, as for every other write of the API (a plain form post cannot send
  // one). The body is never read: no route takes a value from it (Add budget's amount is the server's).
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  if (which === "pause" || which === "resume") {
    if (!(await deps.store.setPaused(participantId, which === "pause"))) return { outcome: "not-found", response: notFoundResponse() };
    return { outcome: which === "pause" ? "paused" : "resumed", response: jsonResponse(200, { message: FACILITATOR_TEXTS[which === "pause" ? "paused" : "resumed"], paused: which === "pause" }) };
  }
  if (which === "budget") {
    const extra = await deps.store.addBudget(participantId, BUDGET_STEP_USD);
    if (extra === undefined) return { outcome: "not-found", response: notFoundResponse() };
    const settings = await deps.store.getSettings();
    return {
      outcome: "added",
      response: jsonResponse(200, { message: FACILITATOR_TEXTS.budgetAdded, extraBudgetUsd: toCents(extra), budgetUsd: budgetFor(settings, { extraBudget: extra }) }),
    };
  }
  if (which === "retry") {
    const buildId = (await deps.store.getConversation(participantId))?.buildId;
    const build = buildId === undefined ? undefined : await deps.store.getRetryBuild(buildId);
    if (buildId === undefined || build === undefined || build.participantId !== participantId) return refused(FACILITATOR_TEXTS.noBuild);
    if (build.status !== "failed" && !isStuck(build, deps.now().getTime())) return refused(FACILITATOR_TEXTS.notRetryable);
    await deps.store.requestRetry(buildId, participantId, deps.now().toISOString());
    return { outcome: "requested", response: jsonResponse(202, { message: FACILITATOR_TEXTS.retryRequested }) };
  }
  // Approve or Reject, exactly as `npm run flags -- approve|reject <nickname>`.
  const decision = await decideFlag(participantId, which === "approve" ? "approve" : "reject", deps);
  switch (decision.outcome) {
    case "nothing-waiting":
      return refused(FACILITATOR_TEXTS.noFlag);
    case "decided-meanwhile":
      return refused(FACILITATOR_TEXTS.decidedMeanwhile);
    case "rejected":
      return { outcome: "rejected", response: jsonResponse(200, { message: FACILITATOR_TEXTS.rejected }) };
    case "approved":
      return { outcome: "approved", response: jsonResponse(200, { message: FACILITATOR_TEXTS.approved }) };
    case "approved-not-queued":
      return { outcome: "approved-not-queued", response: jsonResponse(500, { message: FACILITATOR_TEXTS.approvedNotQueued }), error: errorName(decision.error) };
  }
}

const ALLOWED: readonly Role[] = ["facilitator", "admin"];

async function route(request: HttpRequest, deps: FacilitatorDeps, which: FacilitatorRoute): Promise<Result> {
  const session = await requireSession(request, { sessions: deps.sessions, now: deps.now });
  if (!session.ok) return { outcome: session.reason === "removed" ? "removed" : "unauthorized", response: session.response };
  // Participants see the same 404 as for an unknown route; nothing is read or written.
  if (!ALLOWED.includes(session.role) || which === "unknown") return { outcome: "not-found", response: notFoundResponse() };
  if (which === "list") {
    const raw = request.queryStringParameters?.["group"];
    const group = raw === undefined || raw.trim() === "" ? undefined : raw.trim();
    const { rows: participants, settings } = await listRows(deps, group);
    return {
      outcome: "ok",
      // The viewer's own role and group (from the allow-list), so the page can start its filter on that group.
      response: jsonResponse(200, { viewer: { role: session.role, group: session.participant.group }, stopped: settings.stopped, participants }),
    };
  }
  return act(which, request, deps, session.participant.id);
}

/** Routes one request; table failures give a 500 with a generic message (logged by error name only). */
export async function handleFacilitatorRequest(request: HttpRequest, deps: FacilitatorDeps): Promise<HttpResponse> {
  const which = ROUTES[request.routeKey ?? ""] ?? "unknown";
  try {
    const { outcome, response, error } = await route(request, deps, which);
    deps.log({ event: "facilitator", route: which, outcome, ...(error === undefined ? {} : { error }) });
    return response;
  } catch (error) {
    deps.log({ event: "facilitator", route: which, outcome: "failed", error: errorName(error) });
    return jsonResponse(500, { message: FAILED_MESSAGE });
  }
}
