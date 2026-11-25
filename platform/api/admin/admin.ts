// The admin routes (ticket 3.2): `GET /api/admin/settings` and `PUT /api/admin/settings` read and change the
// workshop's caps. Only the admin may use them: the role comes from the allow-list through the one session check
// (ticket 3.1), never from the profile, and anyone else gets the same 404 as an unknown route.
import {
  isJsonContentType,
  jsonResponse,
  readJsonObject,
  unsupportedMediaTypeResponse,
  type HttpRequest,
  type HttpResponse,
} from "../http.js";
import { FAILED_MESSAGE, notFoundResponse } from "../participant/participant.js";
import { requireSession, type SessionReader } from "../session/session.js";
import { errorName } from "../sign-in/code-request.js";
import { CAP_RANGES, parseCaps, type WorkshopSettings } from "../workshop/settings.js";
import type { SettingsStore } from "../workshop/store.js";

export const SETTINGS_GET_ROUTE = "GET /api/admin/settings";
export const SETTINGS_PUT_ROUTE = "PUT /api/admin/settings";
export const ADMIN_ROUTES = [SETTINGS_GET_ROUTE, SETTINGS_PUT_ROUTE] as const;

/** The 400 answer, naming the allowed ranges (never echoing what was sent). */
export const BAD_SETTINGS_MESSAGE =
  `Send aiBudgetUsd (${CAP_RANGES.aiBudgetUsd.min} to ${CAP_RANGES.aiBudgetUsd.max} dollars), ` +
  `changeRequestsPerPerson (${CAP_RANGES.changeRequestsPerPerson.min} to ${CAP_RANGES.changeRequestsPerPerson.max}) and ` +
  `buildsAtOnce (${CAP_RANGES.buildsAtOnce.min} to ${CAP_RANGES.buildsAtOnce.max}), as numbers.`;

export type AdminRoute = "settings-get" | "settings-put" | "unknown";
export type AdminOutcome = "ok" | "saved" | "unauthorized" | "removed" | "not-found" | "invalid-request" | "unsupported-media-type" | "failed";

/** The only things ever logged: route and outcome (no id, no values, no body). */
export interface AdminLogEntry {
  event: "admin";
  route: AdminRoute;
  outcome: AdminOutcome;
  error?: string;
}

export interface AdminDeps {
  sessions: SessionReader;
  settings: SettingsStore;
  now: () => Date;
  log: (entry: AdminLogEntry) => void;
}

/** The settings as the API returns them. */
export function settingsBody(settings: WorkshopSettings): Record<string, unknown> {
  return {
    aiBudgetUsd: settings.aiBudgetUsd,
    changeRequestsPerPerson: settings.changeRequestsPerPerson,
    buildsAtOnce: settings.buildsAtOnce,
    stopped: settings.stopped,
  };
}

function routeOf(request: HttpRequest): AdminRoute {
  if (request.routeKey === SETTINGS_GET_ROUTE) return "settings-get";
  if (request.routeKey === SETTINGS_PUT_ROUTE) return "settings-put";
  return "unknown";
}

async function route(request: HttpRequest, deps: AdminDeps, which: AdminRoute): Promise<{ outcome: AdminOutcome; response: HttpResponse }> {
  const session = await requireSession(request, { sessions: deps.sessions, now: deps.now });
  if (!session.ok) return { outcome: session.reason === "removed" ? "removed" : "unauthorized", response: session.response };
  // Participants and facilitators see the same 404 as for an unknown route; nothing is read or written.
  if (session.role !== "admin" || which === "unknown") return { outcome: "not-found", response: notFoundResponse() };
  if (which === "settings-get") return { outcome: "ok", response: jsonResponse(200, settingsBody(await deps.settings.getSettings())) };
  if (!isJsonContentType(request)) return { outcome: "unsupported-media-type", response: unsupportedMediaTypeResponse() };
  const body = readJsonObject(request);
  const parsed = body === undefined ? undefined : parseCaps(body);
  if (parsed === undefined || !parsed.ok) {
    return { outcome: "invalid-request", response: jsonResponse(400, { message: BAD_SETTINGS_MESSAGE, ...(parsed === undefined ? {} : { invalid: parsed.invalid }) }) };
  }
  await deps.settings.putCaps(parsed.caps, deps.now().toISOString());
  return { outcome: "saved", response: jsonResponse(200, settingsBody(await deps.settings.getSettings())) };
}

/** Routes one request; table failures give a 500 with a generic message (logged by error name only). */
export async function handleAdminRequest(request: HttpRequest, deps: AdminDeps): Promise<HttpResponse> {
  const which = routeOf(request);
  try {
    const { outcome, response } = await route(request, deps, which);
    deps.log({ event: "admin", route: which, outcome });
    return response;
  } catch (error) {
    deps.log({ event: "admin", route: which, outcome: "failed", error: errorName(error) });
    return jsonResponse(500, { message: FAILED_MESSAGE });
  }
}
