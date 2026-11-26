import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeTable } from "../fakes.js";
import {
  clearedSessionCookie,
  hashToken,
  newSessionToken,
  openAllowRef,
  readSessionToken,
  requireSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sealAllowRef,
  sessionCookie,
} from "./session.js";

const TOKEN = Buffer.alloc(32, 5).toString("base64url");
const NOW = new Date("2026-11-23T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;

describe("session token and cookie", () => {
  it("makes a 43-character base64url token from 32 random bytes", () => {
    const sizes: number[] = [];
    const token = newSessionToken((n) => (sizes.push(n), Buffer.alloc(n, 5)));
    expect(sizes).toEqual([32]);
    expect(token).toBe(TOKEN);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => newSessionToken(() => Buffer.alloc(8))).toThrow();
  });

  it("stores the token as its SHA-256 hash in hex", () => {
    expect(hashToken(TOKEN)).toBe(createHash("sha256").update(TOKEN).digest("hex"));
    expect(hashToken(TOKEN)).not.toContain(TOKEN);
  });

  it("sets an HttpOnly, Secure, SameSite=Strict, host-only cookie for 8 hours", () => {
    expect(SESSION_TTL_SECONDS).toBe(28800);
    expect(sessionCookie(TOKEN)).toBe(
      `__Host-ssd_session=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
    );
    expect(() => sessionCookie("bad; Domain=evil")).toThrow();
  });

  it("clears the cookie with the same name and attributes, expired at once (ticket 3.1)", () => {
    expect(clearedSessionCookie()).toBe("__Host-ssd_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  });

  it("seals the allow-list address under the token: only that token opens it, and the sealed value never shows the address (ticket 3.1)", () => {
    const email = "ada.lovelace@example.test";
    const sealed = sealAllowRef(TOKEN, email, (n) => Buffer.alloc(n, 3));
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("ada");
    expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain("example");
    expect(openAllowRef(TOKEN, sealed)).toBe(email);
    expect(openAllowRef(Buffer.alloc(32, 6).toString("base64url"), sealed)).toBeUndefined();
    expect(openAllowRef(hashToken(TOKEN), sealed)).toBeUndefined();
    // A changed byte, a cut value, garbage or nothing never open.
    const raw = Buffer.from(sealed, "base64url");
    raw[14] = (raw[14] ?? 0) ^ 1;
    expect(openAllowRef(TOKEN, raw.toString("base64url"))).toBeUndefined();
    expect(openAllowRef(TOKEN, sealed.slice(0, 30))).toBeUndefined();
    expect(openAllowRef(TOKEN, "%%%")).toBeUndefined();
    expect(openAllowRef(TOKEN, undefined)).toBeUndefined();
    // A fresh IV each time: two sessions of one person do not share a value.
    expect(sealAllowRef(TOKEN, email, (n) => Buffer.alloc(n, 4))).not.toBe(sealed);
    expect(() => sealAllowRef(TOKEN, email, () => Buffer.alloc(4))).toThrow();
  });

  it("reads the token from API Gateway's cookies list, ignoring other and malformed cookies", () => {
    expect(readSessionToken({ cookies: ["theme=dark", `${SESSION_COOKIE}=${TOKEN}`] })).toBe(TOKEN);
    expect(readSessionToken({ cookies: [` ${SESSION_COOKIE}=${TOKEN}`] })).toBe(TOKEN);
    expect(readSessionToken({ cookies: [`${SESSION_COOKIE}=short`, `${SESSION_COOKIE}=${TOKEN}`] })).toBe(TOKEN);
    expect(readSessionToken({ cookies: [`ssd_session=${TOKEN}`] })).toBeUndefined();
    expect(readSessionToken({ cookies: [`${SESSION_COOKIE}=${TOKEN}x`] })).toBeUndefined();
    expect(readSessionToken({})).toBeUndefined();
  });
});

describe("requireSession (ticket 1.5 criterion 5)", () => {
  function signedIn(expiresAt = NOW_S + 60) {
    const table = new FakeTable();
    table.profiles.set("p-1", { id: "p-1", role: "facilitator", group: "blue", step: "clarify", nickname: "Ada", createdAt: "x" });
    table.addSession(TOKEN, "p-1", expiresAt);
    return { sessions: table, now: () => NOW };
  }
  const withCookie = { cookies: [`${SESSION_COOKIE}=${TOKEN}`] };

  it("returns the caller's own participant record and role", async () => {
    await expect(requireSession(withCookie, signedIn())).resolves.toEqual({
      ok: true,
      participant: { id: "p-1", role: "facilitator", group: "blue", step: "clarify", nickname: "Ada" },
      role: "facilitator",
      tokenHash: hashToken(TOKEN),
      // Ticket 3.24: the session's end (app write tokens never outlive it).
      expiresAt: NOW_S + 60,
    });
  });

  it("answers 401 for no cookie, a forged token, an expired session or a missing participant", async () => {
    const forged = { cookies: [`${SESSION_COOKIE}=${Buffer.alloc(32, 6).toString("base64url")}`] };
    const gone = signedIn();
    gone.sessions.profiles.clear();
    const cases = [
      await requireSession({}, signedIn()),
      await requireSession(forged, signedIn()),
      await requireSession(withCookie, signedIn(NOW_S)),
      await requireSession(withCookie, signedIn(NOW_S - 1)),
      await requireSession(withCookie, gone),
    ];
    for (const check of cases) {
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.response.statusCode).toBe(401);
        expect(check.reason).toBe("no-session");
        expect(JSON.parse(check.response.body ?? "")).toEqual({ message: "Please sign in." });
      }
    }
  });

  it("passes table errors on (a failure does not sign anyone out)", async () => {
    for (const method of ["getSession", "getAllowEntry", "getParticipant", "deleteSession"] as const) {
      const deps = signedIn();
      if (method === "deleteSession") deps.sessions.allow.clear();
      deps.sessions.failOn = method;
      await expect(requireSession(withCookie, deps), method).rejects.toThrow("boom");
      if (method !== "deleteSession") expect(deps.sessions.sessions.has(hashToken(TOKEN)), method).toBe(true);
    }
  });
});

describe("requireSession follows the allow-list (ticket 3.1)", () => {
  const EMAIL = FakeTable.emailOf("p-1");
  function signedIn() {
    const table = new FakeTable();
    table.profiles.set("p-1", { id: "p-1", role: "participant", group: "blue", step: "clarify", nickname: "Ada", createdAt: "x" });
    table.addSession(TOKEN, "p-1", NOW_S + 3600);
    return { table, deps: { sessions: table, now: () => NOW } };
  }
  const withCookie = { cookies: [`${SESSION_COOKIE}=${TOKEN}`] };

  it("criterion 1: WHEN a signed-in person's allow-list entry is removed THEN their next protected call answers 401 and the session item is deleted", async () => {
    const { table, deps } = signedIn();
    expect((await requireSession(withCookie, deps)).ok).toBe(true);
    table.allow.delete(EMAIL);
    const check = await requireSession(withCookie, deps);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("removed");
      expect(check.response.statusCode).toBe(401);
      expect(JSON.parse(check.response.body ?? "")).toEqual({ message: "Please sign in." });
    }
    expect(table.sessions.has(hashToken(TOKEN))).toBe(false);
  });

  it("criterion 2: WHEN a person's role or group changes in the allow-list THEN their next call uses the new role and group", async () => {
    const { table, deps } = signedIn();
    table.allow.set(EMAIL, { role: "facilitator", group: "red", participantId: "p-1" });
    await expect(requireSession(withCookie, deps)).resolves.toMatchObject({
      ok: true,
      role: "facilitator",
      participant: { id: "p-1", role: "facilitator", group: "red", step: "clarify", nickname: "Ada" },
    });
    table.allow.set(EMAIL, { role: "participant", group: "green", participantId: "p-1" });
    await expect(requireSession(withCookie, deps)).resolves.toMatchObject({ ok: true, role: "participant", participant: { role: "participant", group: "green" } });
    expect(table.sessions.has(hashToken(TOKEN))).toBe(true);
  });

  it("signs out a session whose entry is linked to someone else, or that has no sealed link (from before ticket 3.1)", async () => {
    const relinked = signedIn();
    relinked.table.allow.set(EMAIL, { role: "participant", group: "blue", participantId: "p-other" });
    const unlinked = signedIn();
    unlinked.table.allow.set(EMAIL, { role: "participant", group: "blue" });
    const old = signedIn();
    const session = old.table.sessions.get(hashToken(TOKEN));
    if (session === undefined) throw new Error("no session");
    delete session.allowRef;
    const forged = signedIn();
    forged.table.sessions.set(hashToken(TOKEN), { participantId: "p-1", expiresAt: NOW_S + 3600, createdAt: "x", allowRef: sealAllowRef(Buffer.alloc(32, 8).toString("base64url"), EMAIL, (n) => Buffer.alloc(n, 1)) });
    for (const [label, s] of [["relinked", relinked], ["unlinked", unlinked], ["no link", old], ["other token's link", forged]] as const) {
      const check = await requireSession(withCookie, s.deps);
      expect(check.ok, label).toBe(false);
      if (!check.ok) expect(check.reason, label).toBe("removed");
      expect(s.table.sessions.has(hashToken(TOKEN)), label).toBe(false);
    }
  });

  it("deletes the session when the allow-list entry is valid but the profile is missing (try 2: no session is left behind)", async () => {
    const { table, deps } = signedIn();
    table.profiles.delete("p-1");
    const check = await requireSession(withCookie, deps);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("no-session");
      expect(check.response.statusCode).toBe(401);
    }
    expect(table.sessions.has(hashToken(TOKEN))).toBe(false);
    // The entry itself is untouched: signing in again recreates the profile.
    expect(table.allow.get(EMAIL)).toEqual({ role: "participant", group: "blue", participantId: "p-1" });
  });
});
