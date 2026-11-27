// Ticket 3.26: the one write check of app routes (an app's edit secret), and the edit link's make and renewal, written
// before the code.
import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../http.js";
import { FakeAppTokenStore } from "./fakes.js";
import { APP_TOKEN_PATTERN, checkAppWrite, editUrl, ensureEditLink, hashAppToken, newAppToken, readBearerToken, renewEditLink } from "./token.js";

const NOW = new Date("2026-11-27T10:00:00.000Z");
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const withAuth = (value: string | undefined): HttpRequest => ({ headers: value === undefined ? {} : { authorization: value } });
const bearer = (secret: string): HttpRequest => withAuth(`Bearer ${secret}`);

function store() {
  const tokens = new FakeAppTokenStore();
  tokens.addEditLink("ada", "Ada", SECRET);
  return tokens;
}

/** A random source that gives a new 32-byte value on every call. */
function counter(start = 20) {
  let n = start;
  return (size: number) => Buffer.alloc(size, ++n);
}

describe("edit secrets (ticket 3.26)", () => {
  it("makes 43-character base64url secrets from 32 random bytes, looked up by their SHA-256", () => {
    const secret = newAppToken(() => Buffer.alloc(32, 1));
    expect(secret).toMatch(APP_TOKEN_PATTERN);
    expect(hashAppToken(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAppToken(secret)).not.toContain(secret);
    expect(() => newAppToken(() => Buffer.alloc(16))).toThrow();
  });

  it("builds the edit link as the app's absolute address with the secret in the fragment", () => {
    expect(editUrl("Ada", SECRET)).toBe(`https://workshop.rankly.games/apps/ada/#edit=${SECRET}`);
  });

  it("reads only a well-formed `Authorization: Bearer <secret>` (scheme in any case), never a cookie", () => {
    expect(readBearerToken(bearer(SECRET))).toBe(SECRET);
    expect(readBearerToken(withAuth(`bearer ${SECRET}`))).toBe(SECRET);
    for (const bad of [undefined, "", SECRET, `Basic ${SECRET}`, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, `Bearer  ${SECRET}`, "Bearer a.b.c"]) {
      expect(readBearerToken(withAuth(bad)), String(bad)).toBeUndefined();
    }
    expect(readBearerToken({ cookies: [`wt=${SECRET}`], headers: { cookie: `wt=${SECRET}` } })).toBeUndefined();
  });

  it("WHEN a request carries the app's edit secret THEN it may write, as the app's builder (the app compared in any letter case)", async () => {
    const tokens = store();
    await expect(checkAppWrite(bearer(SECRET), "Ada", tokens)).resolves.toEqual({ ok: true, writer: "Ada" });
    await expect(checkAppWrite(bearer(SECRET), "ada", tokens)).resolves.toEqual({ ok: true, writer: "Ada" });
    expect(tokens.reads).toEqual([hashAppToken(SECRET), hashAppToken(SECRET)]);
  });

  it("refuses no secret without a read, an unknown one, another app's, and a 3.24 per-person token (no kind) still in the table", async () => {
    const tokens = store();
    await expect(checkAppWrite(withAuth(undefined), "ada", tokens)).resolves.toEqual({ ok: false, reason: "no-token" });
    expect(tokens.reads).toEqual([]);
    const other = Buffer.alloc(32, 8).toString("base64url");
    await expect(checkAppWrite(bearer(other), "ada", tokens)).resolves.toEqual({ ok: false, reason: "unknown" });
    await expect(checkAppWrite(bearer(SECRET), "carol", tokens)).resolves.toEqual({ ok: false, reason: "other-app" });
    const old = Buffer.alloc(32, 9).toString("base64url");
    tokens.tokens.set(hashAppToken(old), { app: "ada", nickname: "Bob" });
    await expect(checkAppWrite(bearer(old), "ada", tokens)).resolves.toEqual({ ok: false, reason: "not-edit" });
    tokens.tokens.set(hashAppToken(old), { app: "ada", nickname: "Bob", kind: "token" });
    await expect(checkAppWrite(bearer(old), "ada", tokens)).resolves.toEqual({ ok: false, reason: "not-edit" });
  });

  it("makes the builder's link once (create-if-absent) and gives the same one on every later ask", async () => {
    const tokens = new FakeAppTokenStore();
    const first = await ensureEditLink(tokens, "p-1", "Ada", counter(), NOW);
    expect(first?.secret).toMatch(APP_TOKEN_PATTERN);
    expect(first?.nickname).toBe("Ada");
    const again = await ensureEditLink(tokens, "p-1", "Ada", counter(40), NOW);
    expect(again).toEqual(first);
    await expect(checkAppWrite(bearer(first?.secret ?? ""), "ada", tokens)).resolves.toEqual({ ok: true, writer: "Ada" });
    expect(tokens.links.size).toBe(1);
    expect(tokens.tokens.size).toBe(1);
  });

  it("makes no link for a profile marked removed from the allow-list", async () => {
    const tokens = new FakeAppTokenStore(() => true);
    await expect(ensureEditLink(tokens, "p-1", "Ada", counter(), NOW)).resolves.toBeUndefined();
    expect(tokens.links.size).toBe(0);
  });

  it("WHEN the builder asks for a new edit link THEN a new secret works and the old one is unknown at once", async () => {
    const tokens = store();
    const renewed = await renewEditLink(tokens, "p-1", "Ada", counter(), NOW);
    if (!renewed.ok) throw new Error("not renewed");
    expect(renewed.link.secret).not.toBe(SECRET);
    await expect(checkAppWrite(bearer(SECRET), "ada", tokens)).resolves.toEqual({ ok: false, reason: "unknown" });
    await expect(checkAppWrite(bearer(renewed.link.secret), "ada", tokens)).resolves.toEqual({ ok: true, writer: "Ada" });
    await expect(ensureEditLink(tokens, "p-1", "Ada", counter(60), NOW)).resolves.toEqual(renewed.link);
    expect(tokens.tokens.size).toBe(1);
  });

  it("renews nothing for an app without a link, or for a removed profile", async () => {
    await expect(renewEditLink(new FakeAppTokenStore(), "p-1", "Ada", counter(), NOW)).resolves.toEqual({ ok: false, reason: "none" });
    const removed = new FakeAppTokenStore(() => true);
    removed.addEditLink("ada", "Ada", SECRET);
    await expect(renewEditLink(removed, "p-1", "Ada", counter(), NOW)).resolves.toEqual({ ok: false, reason: "removed" });
    await expect(checkAppWrite(bearer(SECRET), "ada", removed)).resolves.toMatchObject({ ok: true });
  });

  it("a renewal that lost a race to another renewal reads again and wins the next try; repeated losses throw", async () => {
    const tokens = store();
    const realRenew = tokens.renewEditLink.bind(tokens);
    let losses = 1;
    tokens.renewEditLink = async (...args) => (losses-- > 0 ? "changed" : realRenew(...args));
    await expect(renewEditLink(tokens, "p-1", "Ada", counter(), NOW)).resolves.toMatchObject({ ok: true });
    tokens.renewEditLink = async () => "changed";
    await expect(renewEditLink(tokens, "p-1", "Ada", counter(), NOW)).rejects.toThrow("edit link kept changing");
  });
});
