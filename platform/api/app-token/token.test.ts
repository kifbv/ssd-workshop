// Ticket 3.24: the one write check of app routes (authorization, expiry and scope), written before the code.
import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../http.js";
import { FakeAppTokenStore } from "./fakes.js";
import {
  APP_TOKEN_TTL_SECONDS,
  appTokenExpiry,
  checkAppWrite,
  hashAppToken,
  newAppToken,
  readBearerToken,
  APP_TOKEN_PATTERN,
  LAST_REVOKE_ATTEMPTS,
  signOutWithAppTokens,
} from "./token.js";

const NOW = new Date("2026-11-26T10:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const withAuth = (value: string | undefined): HttpRequest => ({ headers: value === undefined ? {} : { authorization: value } });

function store(over: Partial<{ app: string; nickname: string; expiresAt: number }> = {}) {
  const tokens = new FakeAppTokenStore();
  tokens.tokens.set(hashAppToken(TOKEN), { app: "ada", nickname: "Bob", expiresAt: NOW_S + 3600, ...over });
  return tokens;
}

describe("app write tokens (ticket 3.24)", () => {
  it("makes 43-character base64url tokens from 32 random bytes, stored only as their SHA-256", () => {
    const token = newAppToken(() => Buffer.alloc(32, 1));
    expect(token).toMatch(APP_TOKEN_PATTERN);
    expect(hashAppToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAppToken(token)).not.toContain(token);
    expect(() => newAppToken(() => Buffer.alloc(16))).toThrow();
  });

  it("expires 12 hours after it is made, but never after the session it came from", () => {
    expect(APP_TOKEN_TTL_SECONDS).toBe(12 * 3600);
    expect(appTokenExpiry(NOW_S, NOW_S + 20 * 3600)).toBe(NOW_S + 12 * 3600);
    expect(appTokenExpiry(NOW_S, NOW_S + 2 * 3600)).toBe(NOW_S + 2 * 3600);
  });

  it("reads only a well-formed `Authorization: Bearer <token>` (scheme in any case), never a cookie", () => {
    expect(readBearerToken(withAuth(`Bearer ${TOKEN}`))).toBe(TOKEN);
    expect(readBearerToken(withAuth(`bearer ${TOKEN}`))).toBe(TOKEN);
    for (const bad of [undefined, "", TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Bearer  ${TOKEN}`, "Bearer a.b.c"]) {
      expect(readBearerToken(withAuth(bad)), String(bad)).toBeUndefined();
    }
    expect(readBearerToken({ cookies: [`wt=${TOKEN}`], headers: { cookie: `wt=${TOKEN}` } })).toBeUndefined();
  });

  it("lets a valid token of this app write, as its participant's nickname (the app compared in any letter case)", async () => {
    const tokens = store();
    await expect(checkAppWrite(withAuth(`Bearer ${TOKEN}`), "Ada", tokens, NOW)).resolves.toEqual({ ok: true, writer: "Bob" });
    await expect(checkAppWrite(withAuth(`Bearer ${TOKEN}`), "ada", tokens, NOW)).resolves.toEqual({ ok: true, writer: "Bob" });
    expect(tokens.reads).toEqual([hashAppToken(TOKEN), hashAppToken(TOKEN)]);
  });

  it("refuses no token without a read, and an unknown (revoked), expired or other app's token", async () => {
    const tokens = store();
    await expect(checkAppWrite(withAuth(undefined), "ada", tokens, NOW)).resolves.toEqual({ ok: false, reason: "no-token" });
    expect(tokens.reads).toEqual([]);
    const other = Buffer.alloc(32, 8).toString("base64url");
    await expect(checkAppWrite(withAuth(`Bearer ${other}`), "ada", tokens, NOW)).resolves.toEqual({ ok: false, reason: "unknown" });
    await expect(checkAppWrite(withAuth(`Bearer ${TOKEN}`), "carol", tokens, NOW)).resolves.toEqual({ ok: false, reason: "other-app" });
    const atExpiry = store({ expiresAt: NOW_S });
    await expect(checkAppWrite(withAuth(`Bearer ${TOKEN}`), "ada", atExpiry, NOW)).resolves.toEqual({ ok: false, reason: "expired" });
    const second = store({ expiresAt: NOW_S + 1 });
    await expect(checkAppWrite(withAuth(`Bearer ${TOKEN}`), "ada", second, NOW)).resolves.toMatchObject({ ok: true });
  });
});

describe("sign-out's last revocation (ticket 3.24 try 3)", () => {
  /** A sign-out store whose revocations fail as scripted (true = throws), recording the calls in order. */
  function scripted(failures: boolean[]) {
    const calls: string[] = [];
    const store = {
      createAppToken: () => Promise.reject(new Error("unused")),
      revokeAppTokens: async () => {
        calls.push("revoke");
        if (failures.shift() === true) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        return 0;
      },
      deleteSession: async () => {
        calls.push("delete-session");
      },
    };
    return { store, calls };
  }

  it("revokes, deletes the session, revokes again: done", async () => {
    const { store, calls } = scripted([]);
    await expect(signOutWithAppTokens(store, "p-1", "h")).resolves.toBe("done");
    expect(calls).toEqual(["revoke", "delete-session", "revoke"]);
  });

  it("WHEN the first revocation fails THEN it throws before the session is deleted (the person stays signed in to try again)", async () => {
    const { store, calls } = scripted([true]);
    await expect(signOutWithAppTokens(store, "p-1", "h")).rejects.toThrow("throttled");
    expect(calls).toEqual(["revoke"]);
  });

  it("WHEN the last revocation fails THEN it is tried again, up to LAST_REVOKE_ATTEMPTS times in all", async () => {
    expect(LAST_REVOKE_ATTEMPTS).toBe(3);
    const { store, calls } = scripted([false, true, true]);
    await expect(signOutWithAppTokens(store, "p-1", "h")).resolves.toBe("done");
    expect(calls).toEqual(["revoke", "delete-session", "revoke", "revoke", "revoke"]);
  });

  it("WHEN every try of the last revocation fails THEN the sign-out still completes, as `last-revoke-failed` (never thrown)", async () => {
    const { store, calls } = scripted([false, true, true, true]);
    await expect(signOutWithAppTokens(store, "p-1", "h")).resolves.toBe("last-revoke-failed");
    expect(calls).toEqual(["revoke", "delete-session", "revoke", "revoke", "revoke"]);
  });
});
