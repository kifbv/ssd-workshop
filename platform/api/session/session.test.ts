import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeTable } from "../fakes.js";
import {
  hashToken,
  newSessionToken,
  readSessionToken,
  requireSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
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
    table.sessions.set(hashToken(TOKEN), { participantId: "p-1", expiresAt, createdAt: "x" });
    return { sessions: table, now: () => NOW };
  }
  const withCookie = { cookies: [`${SESSION_COOKIE}=${TOKEN}`] };

  it("returns the caller's own participant record and role", async () => {
    await expect(requireSession(withCookie, signedIn())).resolves.toEqual({
      ok: true,
      participant: { id: "p-1", role: "facilitator", group: "blue", step: "clarify", nickname: "Ada" },
      role: "facilitator",
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
        expect(JSON.parse(check.response.body ?? "")).toEqual({ message: "Please sign in." });
      }
    }
  });

  it("passes table errors on (a failure does not sign anyone out)", async () => {
    const deps = signedIn();
    deps.sessions.failOn = "getSession";
    await expect(requireSession(withCookie, deps)).rejects.toThrow("boom");
  });
});
