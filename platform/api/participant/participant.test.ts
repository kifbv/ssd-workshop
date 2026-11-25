import { describe, expect, it } from "vitest";
import { FakeTable } from "../fakes.js";
import type { HttpRequest } from "../http.js";
import { hashToken, SESSION_COOKIE } from "../session/session.js";
import type { Role } from "../types.js";
import {
  checkNickname,
  handleParticipantRequest,
  ME_ROUTE,
  NICKNAME_ROUTE,
  PARTICIPANT_ROUTE,
  RESERVED_NICKNAMES,
  SIGN_OUT_ROUTE,
  type ParticipantDeps,
  type ParticipantLogEntry,
} from "./participant.js";

const NOW = new Date("2026-11-23T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const MINE = token(1);
const THEIRS = token(2);

function setup(role: Role = "participant") {
  const table = new FakeTable();
  table.profiles.set("me-1", { id: "me-1", role, group: "blue", step: "nickname", createdAt: "x" });
  table.profiles.set("other-2", { id: "other-2", role: "participant", group: "red", step: "clarify", nickname: "Bob", createdAt: "x" });
  table.nicknames.set("bob", { nickname: "Bob", participantId: "other-2" });
  table.addSession(MINE, "me-1", NOW_S + 3600);
  table.addSession(THEIRS, "other-2", NOW_S + 3600);
  const logs: ParticipantLogEntry[] = [];
  const deps: ParticipantDeps = { store: table, now: () => NOW, log: (e) => logs.push(e) };
  return { table, logs, deps };
}

const cookie = (t: string): string[] => [`${SESSION_COOKIE}=${t}`];
const me = (cookies?: string[]): HttpRequest => ({ routeKey: ME_ROUTE, ...(cookies ? { cookies } : {}) });
const byId = (id: string, cookies?: string[]): HttpRequest => ({
  routeKey: PARTICIPANT_ROUTE,
  pathParameters: { id },
  ...(cookies ? { cookies } : {}),
});
/** A nickname request, with my session cookie unless `cookies` is null. */
const nickname = (value: unknown, cookies: string[] | null = cookie(MINE), contentType = "application/json"): HttpRequest => ({
  routeKey: NICKNAME_ROUTE,
  headers: { "content-type": contentType },
  body: JSON.stringify({ nickname: value }),
  ...(cookies !== null ? { cookies } : {}),
});
const json = (body: string | undefined): unknown => JSON.parse(body ?? "");

describe("checkNickname", () => {
  it("accepts 3 to 20 letters, digits or dashes", () => {
    for (const ok of ["abc", "Ada-42", "a-b", "X".repeat(20), "007", "--a"]) expect(checkNickname(ok), ok).toBe("ok");
  });

  it("refuses anything else as breaking the rules", () => {
    for (const bad of ["", "ab", "X".repeat(21), "ada lovelace", "ada_l", "adé", "ada.l", "ada#1", "<b>x</b>"]) {
      expect(checkNickname(bad), bad).toBe("rules");
    }
  });

  it("refuses the reserved names in any letter case", () => {
    for (const name of ["admin", "api", "globe", "intro", "apps", "facilitator", "root", "system", "www", "static", "assets", "sign-in"]) {
      expect(RESERVED_NICKNAMES).toContain(name);
      expect(checkNickname(name), name).toBe("reserved");
      expect(checkNickname(name.toUpperCase()), name).toBe("reserved");
    }
    expect(RESERVED_NICKNAMES).toContain("x");
    for (const name of RESERVED_NICKNAMES) expect(name).toBe(name.toLowerCase());
  });
});

describe("POST /api/me/nickname (ticket 1.5 criterion 4)", () => {
  it("criterion 4: WHEN a nickname breaks the rules, is reserved or is taken in any letter case THEN it is refused with a reason, and a valid one is saved", async () => {
    const s = setup();
    const rules = await handleParticipantRequest(nickname("a b"), s.deps);
    expect(rules.statusCode).toBe(400);
    expect(json(rules.body)).toEqual({ message: "A nickname has 3 to 20 letters, digits or dashes.", reason: "rules" });

    const reserved = await handleParticipantRequest(nickname("Admin"), s.deps);
    expect(reserved.statusCode).toBe(400);
    expect(json(reserved.body)).toEqual({ message: "That nickname is reserved. Please pick another one.", reason: "reserved" });

    for (const variant of ["bob", "BOB", "bOb"]) {
      const taken = await handleParticipantRequest(nickname(variant), s.deps);
      expect(taken.statusCode, variant).toBe(409);
      expect(json(taken.body)).toEqual({ message: "That nickname is already taken. Please pick another one.", reason: "taken" });
    }
    expect(s.table.profiles.get("me-1")?.nickname).toBeUndefined();

    const saved = await handleParticipantRequest(nickname(" Ada-42 "), s.deps);
    expect(saved.statusCode).toBe(200);
    expect(json(saved.body)).toEqual({ id: "me-1", nickname: "Ada-42", role: "participant", group: "blue", step: "clarify" });
    expect(s.table.profiles.get("me-1")).toMatchObject({ nickname: "Ada-42", step: "clarify" });
    expect(s.table.nicknames.get("ada-42")).toEqual({ nickname: "Ada-42", participantId: "me-1" });
    expect(s.logs.map((l) => l.outcome)).toEqual(["rules", "reserved", "taken", "taken", "taken", "ok"]);
  });

  it("refuses a second nickname: it is set once", async () => {
    const s = setup();
    await handleParticipantRequest(nickname("Ada"), s.deps);
    const again = await handleParticipantRequest(nickname("Grace"), s.deps);
    expect(again.statusCode).toBe(409);
    expect(json(again.body)).toMatchObject({ reason: "already-set" });
    expect(s.table.nicknames.has("grace")).toBe(false);
  });

  it("refuses a nickname another person claimed at the same moment (the claim decides)", async () => {
    const s = setup();
    s.table.nicknames.set("ada", { nickname: "ADA", participantId: "other-2" });
    expect((await handleParticipantRequest(nickname("ada"), s.deps)).statusCode).toBe(409);
    expect(s.table.profiles.get("me-1")?.step).toBe("nickname");
  });

  it("needs a JSON body with a string nickname and the JSON content type", async () => {
    const s = setup();
    expect((await handleParticipantRequest(nickname(42), s.deps)).statusCode).toBe(400);
    expect((await handleParticipantRequest({ ...nickname("Ada"), body: "nickname=Ada" }, s.deps)).statusCode).toBe(400);
    expect((await handleParticipantRequest(nickname("Ada", cookie(MINE), "text/plain"), s.deps)).statusCode).toBe(415);
    expect(s.table.profiles.get("me-1")?.nickname).toBeUndefined();
  });
});

describe("protected routes (ticket 1.5 criteria 5 and 6)", () => {
  const routes: [string, (cookies?: string[]) => HttpRequest][] = [
    ["GET /api/me", (c) => me(c)],
    ["POST /api/me/nickname", (c) => ({ ...nickname("Ada", null), ...(c ? { cookies: c } : {}) })],
    ["GET /api/participants/{id}", (c) => byId("me-1", c)],
  ];

  it("criterion 5: WHEN a call to a protected route has no session, an expired one or a forged one THEN the API answers 401", async () => {
    for (const [name, build] of routes) {
      const s = setup();
      const expired = token(9);
      s.table.sessions.set(hashToken(expired), { participantId: "me-1", expiresAt: NOW_S, createdAt: "x" });
      const cases: [string, string[] | undefined][] = [
        ["no cookie", undefined],
        ["other cookies only", ["theme=dark"]],
        ["expired session", cookie(expired)],
        ["forged token", cookie(token(7))],
        ["malformed token", cookie("not-a-token")],
        ["session hash as token", cookie(hashToken(MINE))],
      ];
      for (const [label, cookies] of cases) {
        const res = await handleParticipantRequest(build(cookies), s.deps);
        expect(res.statusCode, `${name}: ${label}`).toBe(401);
        expect(json(res.body)).toEqual({ message: "Please sign in." });
      }
      // Nothing was written by a refused call.
      expect(s.table.profiles.get("me-1")?.nickname).toBeUndefined();
      expect(s.logs.every((l) => l.outcome === "unauthorized")).toBe(true);
    }
  });

  it("criterion 6: WHEN a participant asks for another participant's record by id THEN the API answers \"not found\"", async () => {
    for (const role of ["participant", "facilitator", "admin"] as Role[]) {
      const s = setup(role);
      const other = await handleParticipantRequest(byId("other-2", cookie(MINE)), s.deps);
      const missing = await handleParticipantRequest(byId("no-such-id", cookie(MINE)), s.deps);
      expect(other.statusCode, role).toBe(404);
      expect(json(other.body)).toEqual({ message: "Not found." });
      // The same answer as for an id that does not exist: nothing tells the other one exists.
      expect([missing.statusCode, missing.headers, missing.body]).toEqual([other.statusCode, other.headers, other.body]);
      expect(other.body).not.toContain("Bob");
      const own = await handleParticipantRequest(byId("me-1", cookie(MINE)), s.deps);
      expect(own.statusCode).toBe(200);
      expect(json(own.body)).toEqual({ id: "me-1", nickname: null, role, group: "blue", step: "nickname" });
    }
  });

  it("GET /api/me returns the caller's own record only (id, nickname or null, role, group, step)", async () => {
    const s = setup();
    const mine = await handleParticipantRequest(me(cookie(MINE)), s.deps);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(json(mine.body)).toEqual({ id: "me-1", nickname: null, role: "participant", group: "blue", step: "nickname" });
    const theirs = await handleParticipantRequest(me(cookie(THEIRS)), s.deps);
    expect(json(theirs.body)).toEqual({ id: "other-2", nickname: "Bob", role: "participant", group: "red", step: "clarify" });
  });

  it("answers 500 with a generic message when the table fails, logging the error name only", async () => {
    const s = setup();
    s.table.failOn = "getSession";
    s.table.failure = Object.assign(new Error("table down for me-1"), { name: "ProvisionedThroughputExceededException" });
    const res = await handleParticipantRequest(me(cookie(MINE)), s.deps);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("me-1");
    expect(s.logs).toEqual([{ event: "participant", route: "me", outcome: "failed", error: "ProvisionedThroughputExceededException" }]);
  });

  it("answers an unknown route 404 after the session check", async () => {
    const s = setup();
    expect((await handleParticipantRequest({ routeKey: "GET /api/other" }, s.deps)).statusCode).toBe(401);
    expect((await handleParticipantRequest({ routeKey: "GET /api/other", cookies: cookie(MINE) }, s.deps)).statusCode).toBe(404);
  });
});

describe("sessions follow the allow-list, and sign-out (ticket 3.1)", () => {
  const signOut = (cookies?: string[], contentType = "application/json"): HttpRequest => ({
    routeKey: SIGN_OUT_ROUTE,
    headers: { "content-type": contentType },
    body: "{}",
    ...(cookies ? { cookies } : {}),
  });
  const CLEARED = "__Host-ssd_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";

  it("criterion 1: WHEN a signed-in person's allow-list entry is removed THEN their next protected call answers 401 and the session item is deleted", async () => {
    for (const build of [() => me(cookie(MINE)), () => byId("me-1", cookie(MINE)), () => nickname("Ada")]) {
      const s = setup();
      s.table.allow.delete(FakeTable.emailOf("me-1"));
      const res = await handleParticipantRequest(build(), s.deps);
      expect(res.statusCode).toBe(401);
      expect(json(res.body)).toEqual({ message: "Please sign in." });
      expect(s.table.sessions.has(hashToken(MINE))).toBe(false);
      // Nothing else changed, and the other person is still signed in.
      expect(s.table.profiles.get("me-1")?.nickname).toBeUndefined();
      expect(s.table.sessions.has(hashToken(THEIRS))).toBe(true);
      expect(s.logs.at(-1)?.outcome).toBe("removed");
      expect((await handleParticipantRequest(me(cookie(MINE)), s.deps)).statusCode).toBe(401);
      expect(s.logs.at(-1)?.outcome).toBe("unauthorized");
    }
  });

  it("criterion 2: WHEN a person's role or group changes in the allow-list THEN their next call uses the new role and group", async () => {
    const s = setup();
    s.table.allow.set(FakeTable.emailOf("me-1"), { role: "admin", group: "green", participantId: "me-1" });
    const res = await handleParticipantRequest(me(cookie(MINE)), s.deps);
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toEqual({ id: "me-1", nickname: null, role: "admin", group: "green", step: "nickname" });
    const own = await handleParticipantRequest(byId("me-1", cookie(MINE)), s.deps);
    expect(json(own.body)).toMatchObject({ role: "admin", group: "green" });
  });

  it("criterion 3: WHEN POST /api/sign-out is called THEN the session item is deleted, the cookie is cleared, and the old cookie answers 401", async () => {
    const s = setup();
    const res = await handleParticipantRequest(signOut(cookie(MINE)), s.deps);
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toEqual({ message: "You're signed out." });
    expect(res.cookies).toEqual([CLEARED]);
    expect(res.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(s.table.sessions.has(hashToken(MINE))).toBe(false);
    expect(s.table.sessions.has(hashToken(THEIRS))).toBe(true);
    expect(s.logs.at(-1)).toEqual({ event: "participant", route: "sign-out", outcome: "signed-out" });
    for (const build of [() => me(cookie(MINE)), () => byId("me-1", cookie(MINE)), () => nickname("Ada"), () => signOut(cookie(MINE))]) {
      const again = await handleParticipantRequest(build(), s.deps);
      expect(again.statusCode).toBe(401);
      expect(json(again.body)).toEqual({ message: "Please sign in." });
    }
    // The other person's session still works.
    expect((await handleParticipantRequest(me(cookie(THEIRS)), s.deps)).statusCode).toBe(200);
  });

  it("answers sign-out without a session, with a forged, expired or removed one 401 (clearing the cookie), deleting no other session", async () => {
    const s = setup();
    const expired = token(9);
    s.table.sessions.set(hashToken(expired), { participantId: "me-1", expiresAt: NOW_S, createdAt: "x" });
    for (const [label, cookies] of [
      ["no cookie", undefined],
      ["forged token", cookie(token(7))],
      ["session hash as token", cookie(hashToken(THEIRS))],
      ["expired", cookie(expired)],
    ] as const) {
      const res = await handleParticipantRequest(signOut(cookies), s.deps);
      expect(res.statusCode, label).toBe(401);
      expect(res.cookies, label).toEqual([CLEARED]);
      expect(json(res.body)).toEqual({ message: "Please sign in." });
    }
    expect(s.table.sessions.has(hashToken(MINE))).toBe(true);
    expect(s.table.sessions.has(hashToken(THEIRS))).toBe(true);
    s.table.allow.delete(FakeTable.emailOf("me-1"));
    const removed = await handleParticipantRequest(signOut(cookie(MINE)), s.deps);
    expect([removed.statusCode, removed.cookies]).toEqual([401, [CLEARED]]);
    expect(s.table.sessions.has(hashToken(MINE))).toBe(false);
    expect(s.logs.at(-1)?.outcome).toBe("removed");
  });

  it("refuses a sign-out that is not sent as JSON 415, keeping the session", async () => {
    const s = setup();
    const res = await handleParticipantRequest(signOut(cookie(MINE), "text/plain"), s.deps);
    expect(res.statusCode).toBe(415);
    expect(res.cookies).toBeUndefined();
    expect(s.table.sessions.has(hashToken(MINE))).toBe(true);
  });

  it("answers 500 when the session delete fails, logging the error name only", async () => {
    const s = setup();
    s.table.failOn = "deleteSession";
    const res = await handleParticipantRequest(signOut(cookie(MINE)), s.deps);
    expect(res.statusCode).toBe(500);
    expect(s.logs).toEqual([{ event: "participant", route: "sign-out", outcome: "failed", error: "Error" }]);
  });
});
