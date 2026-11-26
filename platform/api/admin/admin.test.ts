import { describe, expect, it } from "vitest";
import { FakeTable } from "../fakes.js";
import type { HttpRequest } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import type { Role } from "../types.js";
import { FakeSettingsTable } from "../workshop/fakes.js";
import {
  ADMIN_ROUTES,
  BAD_SETTINGS_MESSAGE,
  handleAdminRequest,
  RESUME_ROUTE,
  SETTINGS_GET_ROUTE,
  SETTINGS_PUT_ROUTE,
  STOP_ROUTE,
  type AdminDeps,
  type AdminLogEntry,
} from "./admin.js";

const NOW = new Date("2026-11-25T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const TOKENS: Record<Role, string> = { participant: token(1), facilitator: token(2), admin: token(3) };

function setup() {
  const table = new FakeTable();
  for (const role of ["participant", "facilitator", "admin"] as const) {
    table.profiles.set(`${role}-1`, { id: `${role}-1`, role, group: "blue", step: "clarify", nickname: role, createdAt: "x" });
    table.addSession(TOKENS[role], `${role}-1`, NOW_S + 3600);
  }
  const settings = new FakeSettingsTable();
  const logs: AdminLogEntry[] = [];
  const deps: AdminDeps = { sessions: table, settings, now: () => NOW, log: (e) => logs.push(e) };
  return { table, settings, logs, deps };
}

const VALID = { aiBudgetUsd: 7.5, changeRequestsPerPerson: 3, buildsAtOnce: 10 };
const cookie = (role: Role): string[] => [`${SESSION_COOKIE}=${TOKENS[role]}`];
const get = (role?: Role): HttpRequest => ({ routeKey: SETTINGS_GET_ROUTE, ...(role ? { cookies: cookie(role) } : {}) });
const put = (body: unknown, role?: Role, contentType = "application/json"): HttpRequest => ({
  routeKey: SETTINGS_PUT_ROUTE,
  headers: { "content-type": contentType },
  body: JSON.stringify(body),
  ...(role ? { cookies: cookie(role) } : {}),
});
const json = (body: string | undefined): unknown => JSON.parse(body ?? "");

describe("admin settings routes (ticket 3.2)", () => {
  it("serves exactly GET and PUT /api/admin/settings, and (ticket 3.5) POST /api/admin/stop and /api/admin/resume", () => {
    expect([...ADMIN_ROUTES]).toEqual(["GET /api/admin/settings", "PUT /api/admin/settings", "POST /api/admin/stop", "POST /api/admin/resume"]);
  });

  it("WHEN no SETTINGS item exists THEN the admin reads the defaults $5, 5 and 15 with Stop off", async () => {
    const { deps, logs } = setup();
    const res = await handleAdminRequest(get("admin"), deps);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
    expect(json(res.body)).toEqual({ aiBudgetUsd: 5, changeRequestsPerPerson: 5, buildsAtOnce: 15, stopped: false });
    expect(logs).toEqual([{ event: "admin", route: "settings-get", outcome: "ok" }]);
  });

  it("WHEN an admin sends valid values THEN they are stored and answered, and the next GET reads them", async () => {
    const { deps, settings, logs } = setup();
    const res = await handleAdminRequest(put(VALID, "admin"), deps);
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toEqual({ ...VALID, stopped: false });
    expect(settings.writes).toBe(1);
    expect(settings.item?.["updatedAt"]).toEqual({ S: NOW.toISOString() });
    expect(json((await handleAdminRequest(get("admin"), deps)).body)).toEqual({ ...VALID, stopped: false });
    expect(logs[0]).toEqual({ event: "admin", route: "settings-put", outcome: "saved" });
  });

  it("keeps Stop as it is when the caps change", async () => {
    const { deps, settings } = setup();
    settings.item = { stopped: { BOOL: true } };
    const res = await handleAdminRequest(put(VALID, "admin"), deps);
    expect(json(res.body)).toEqual({ ...VALID, stopped: true });
    // A `stopped` in the body is ignored: Stop has its own routes (ticket 3.5).
    await handleAdminRequest(put({ ...VALID, stopped: false }, "admin"), deps);
    expect(settings.item["stopped"]).toEqual({ BOOL: true });
  });

  it("WHEN a participant or facilitator sends PUT or GET THEN the answer is 404 and nothing changes", async () => {
    for (const role of ["participant", "facilitator"] as const) {
      const { deps, settings, logs } = setup();
      settings.item = { aiBudgetUsd: { N: "9" } };
      const before = JSON.stringify(settings.item);
      for (const request of [put(VALID, role), get(role), put({ aiBudgetUsd: 999 }, role), put(VALID, role, "text/plain")]) {
        const res = await handleAdminRequest(request, deps);
        expect(res.statusCode, role).toBe(404);
        expect(json(res.body)).toEqual({ message: "Not found." });
      }
      expect(settings.writes, role).toBe(0);
      expect(JSON.stringify(settings.item)).toBe(before);
      expect(logs.every((l) => l.outcome === "not-found")).toBe(true);
    }
  });

  it("takes the role from the allow-list, not the profile (ticket 3.1)", async () => {
    const { deps, table, settings } = setup();
    // A profile that says admin, behind an allow-list entry that says participant: refused.
    const profile = table.profiles.get("participant-1");
    if (profile === undefined) throw new Error("no profile");
    table.profiles.set("participant-1", { ...profile, role: "admin" });
    expect((await handleAdminRequest(put(VALID, "participant"), deps)).statusCode).toBe(404);
    // An allow-list entry changed to admin: allowed at the next call.
    const email = FakeTable.emailOf("participant-1");
    const entry = table.allow.get(email);
    if (entry === undefined) throw new Error("no entry");
    table.allow.set(email, { ...entry, role: "admin" });
    expect((await handleAdminRequest(put(VALID, "participant"), deps)).statusCode).toBe(200);
    expect(settings.writes).toBe(1);
  });

  it("answers 401 without a session, and signs a removed admin out", async () => {
    const { deps, table, settings, logs } = setup();
    for (const request of [get(), put(VALID)]) expect((await handleAdminRequest(request, deps)).statusCode).toBe(401);
    table.allow.delete(FakeTable.emailOf("admin-1"));
    const res = await handleAdminRequest(put(VALID, "admin"), deps);
    expect(res.statusCode).toBe(401);
    expect(json(res.body)).toEqual({ message: "Please sign in." });
    expect(settings.writes).toBe(0);
    expect(logs.map((l) => l.outcome)).toEqual(["unauthorized", "unauthorized", "removed"]);
  });

  it("WHEN a value is out of range THEN the answer is 400 and nothing is stored", async () => {
    const { deps, settings } = setup();
    const bad: Record<string, unknown>[] = [
      { ...VALID, aiBudgetUsd: -1 },
      { ...VALID, aiBudgetUsd: 50.5 },
      { ...VALID, changeRequestsPerPerson: -1 },
      { ...VALID, changeRequestsPerPerson: 21 },
      { ...VALID, buildsAtOnce: 0 },
      { ...VALID, buildsAtOnce: 31 },
      { ...VALID, buildsAtOnce: 2.5 },
      { ...VALID, aiBudgetUsd: "5" },
      { aiBudgetUsd: 5 },
    ];
    for (const body of bad) {
      const res = await handleAdminRequest(put(body, "admin"), deps);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect((json(res.body) as { message: string }).message).toBe(BAD_SETTINGS_MESSAGE);
    }
    expect(json((await handleAdminRequest(put({ ...VALID, buildsAtOnce: 31 }, "admin"), deps)).body)).toEqual({ message: BAD_SETTINGS_MESSAGE, invalid: ["buildsAtOnce"] });
    for (const body of ["not json", "[1]"]) {
      const res = await handleAdminRequest({ ...put(VALID, "admin"), body }, deps);
      expect(res.statusCode, body).toBe(400);
      expect(json(res.body)).toEqual({ message: BAD_SETTINGS_MESSAGE });
    }
    expect(settings.writes).toBe(0);
    expect(BAD_SETTINGS_MESSAGE).toBe(
      "Send aiBudgetUsd (0 to 50 dollars), changeRequestsPerPerson (0 to 20) and buildsAtOnce (1 to 30), as numbers.",
    );
  });

  it("refuses a PUT that is not JSON with 415, and answers an unknown route 404", async () => {
    const { deps, settings } = setup();
    expect((await handleAdminRequest(put(VALID, "admin", "text/plain"), deps)).statusCode).toBe(415);
    expect((await handleAdminRequest({ routeKey: "DELETE /api/admin/settings", cookies: cookie("admin") }, deps)).statusCode).toBe(404);
    expect(settings.writes).toBe(0);
  });

  it("answers a table failure 500 with the generic message, logging the error name only", async () => {
    const { deps, settings, logs } = setup();
    settings.failure = Object.assign(new Error("secret detail"), { name: "ProvisionedThroughputExceededException" });
    const res = await handleAdminRequest(get("admin"), deps);
    expect(res.statusCode).toBe(500);
    expect(json(res.body)).toEqual({ message: "Something went wrong. Please try again in a moment." });
    expect(logs).toEqual([{ event: "admin", route: "settings-get", outcome: "failed", error: "ProvisionedThroughputExceededException" }]);
  });
});

const post = (routeKey: string, role?: Role, contentType = "application/json"): HttpRequest => ({
  routeKey,
  headers: { "content-type": contentType },
  body: "{}",
  ...(role ? { cookies: cookie(role) } : {}),
});

describe("global Stop and Resume (ticket 3.5)", () => {
  it("WHEN the admin presses Stop THEN Stop is on (with its time) and the caps stay; WHEN Resume THEN it is off again", async () => {
    const { deps, settings, logs } = setup();
    settings.item = { aiBudgetUsd: { N: "8" } };
    const stopped = await handleAdminRequest(post(STOP_ROUTE, "admin"), deps);
    expect(stopped.statusCode).toBe(200);
    expect(json(stopped.body)).toEqual({ aiBudgetUsd: 8, changeRequestsPerPerson: 5, buildsAtOnce: 15, stopped: true });
    expect(settings.item).toMatchObject({ stopped: { BOOL: true }, stoppedAt: { S: NOW.toISOString() }, aiBudgetUsd: { N: "8" } });
    // Pressed twice: still on, no harm.
    expect((await handleAdminRequest(post(STOP_ROUTE, "admin"), deps)).statusCode).toBe(200);
    const resumed = await handleAdminRequest(post(RESUME_ROUTE, "admin"), deps);
    expect(resumed.statusCode).toBe(200);
    expect(json(resumed.body)).toEqual({ aiBudgetUsd: 8, changeRequestsPerPerson: 5, buildsAtOnce: 15, stopped: false });
    expect(settings.item).toMatchObject({ stopped: { BOOL: false }, resumedAt: { S: NOW.toISOString() } });
    expect(logs.map((l) => [l.route, l.outcome])).toEqual([
      ["stop", "stopped"],
      ["stop", "stopped"],
      ["resume", "resumed"],
    ]);
    // Caps saved while stopped keep Stop on.
    await handleAdminRequest(post(STOP_ROUTE, "admin"), deps);
    expect(json((await handleAdminRequest(put(VALID, "admin"), deps)).body)).toEqual({ ...VALID, stopped: true });
  });

  it("criterion 5: WHEN a non-admin calls Stop or Resume THEN the answer is 404 and nothing changes", async () => {
    for (const role of ["participant", "facilitator"] as const) {
      const { deps, settings, logs } = setup();
      for (const request of [post(STOP_ROUTE, role), post(RESUME_ROUTE, role), post(STOP_ROUTE, role, "text/plain")]) {
        const res = await handleAdminRequest(request, deps);
        expect(res.statusCode, role).toBe(404);
        expect(json(res.body)).toEqual({ message: "Not found." });
      }
      expect(settings.writes, role).toBe(0);
      expect(settings.item).toBeUndefined();
      expect(logs.every((l) => l.outcome === "not-found")).toBe(true);
    }
  });

  it("answers 401 without a session, 415 to the admin without JSON, and 500 when the table fails", async () => {
    const { deps, settings, logs } = setup();
    for (const route of [STOP_ROUTE, RESUME_ROUTE]) expect((await handleAdminRequest(post(route), deps)).statusCode).toBe(401);
    expect((await handleAdminRequest(post(STOP_ROUTE, "admin", "text/plain"), deps)).statusCode).toBe(415);
    expect(settings.writes).toBe(0);
    settings.failure = Object.assign(new Error("secret detail"), { name: "InternalServerError" });
    expect((await handleAdminRequest(post(RESUME_ROUTE, "admin"), deps)).statusCode).toBe(500);
    expect(logs.at(-1)).toEqual({ event: "admin", route: "resume", outcome: "failed", error: "InternalServerError" });
  });
});
