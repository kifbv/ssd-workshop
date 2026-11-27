// Edit links (ticket 3.26, replacing 3.24's per-person app write tokens): saving in a participant's app needs the app's
// edit secret. Each live app has one, made when its builder's `GET /api/build` first sees the app live, and shown only
// to that builder (step 4: `/apps/<nick>/#edit=<secret>`, the secret in the fragment, so no server or referrer sees
// it). The app sends it on every write as `Authorization: Bearer <secret>`; whoever holds it saves as the app's builder.
//
// A secret is 32 random bytes (base64url, 43 characters). Two items hold it (docs/decisions.md "(3.26) Storage"):
// - `APPEDIT#<lower-cased nickname>` / `EDIT`: the secret itself (so step 4 can show it again), its SHA-256 and the
//   builder's nickname; only the conversation function may read or write it (IAM).
// - `APPTOKEN#<sha-256>` / `TOKEN`: the lookup the write check reads (`app`, `nickname` = the builder, `kind` = "edit").
//   A 3.24 token item (no `kind`) left until its TTL is refused, so no per-person token writes after this deploy.
// "New edit link" replaces both in one transaction (the old lookup is deleted, so the old secret stops at once);
// `npm run participant -- reset` and `npm run allowlist -- remove` delete them.
//
// This module is the one write check every app route uses: data (2.4/3.24), media (3.18), AI tasks (3.21).
// Never log a secret or its hash.
import type { HttpRequest } from "../http.js";
import { hashToken, newSessionToken } from "../session/session.js";
import { appAddress } from "../settings.js";

/** 32 random bytes, base64url without padding. */
export const APP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The `kind` of an edit link's lookup item: the only kind the write check accepts (3.24's tokens have none). */
export const EDIT_KIND = "edit";
/** "New edit link" (and the first make) try again this many times when the per-app item changed under them. */
export const EDIT_LINK_ATTEMPTS = 3;

/** What the write check reads of a lookup item (under the secret's hash). */
export interface StoredAppToken {
  /** The app: its lower-cased nickname. */
  app: string;
  /** The writer: the app's builder's nickname, as they chose it. */
  nickname: string;
  /** `edit` for an edit link; undefined for a 3.24 per-person token still in the table until its TTL. */
  kind?: string;
}

/** What the write check needs from the table. */
export interface AppTokenReader {
  /** The lookup item stored under this hash (consistent read), or undefined. */
  getAppToken(tokenHash: string): Promise<StoredAppToken | undefined>;
}

/** An app's edit link as its per-app item keeps it. */
export interface EditLink {
  secret: string;
  /** SHA-256 (hex) of the secret: the key of its lookup item. */
  secretHash: string;
  /** The app's builder's nickname (the writer of every save through the link). */
  nickname: string;
}

/** `saved`; `exists`/`changed`: the per-app item was made or replaced meanwhile (read again); `removed`: the builder's profile is gone or marked removed from the allow-list. */
export type EditLinkWrite = "saved" | "exists" | "changed" | "removed";

/** What the build routes (conversation function), the reset and the allow-list removal need from the table. */
export interface EditLinkStore {
  /** The app's edit link (consistent read), or undefined. */
  getEditLink(app: string): Promise<EditLink | undefined>;
  /**
   * Makes the app's edit link, only if it has none (`exists` otherwise), in one transaction with its lookup item and a
   * check that the builder's profile (`participantId`) exists and is not marked removed (`removed`).
   */
  createEditLink(app: string, participantId: string, link: EditLink, nowIso: string): Promise<EditLinkWrite>;
  /**
   * Replaces the app's edit link, only while its hash is still `oldHash` (`changed` otherwise), in one transaction: the
   * per-app item, the new lookup item, the old lookup item's delete, and the same profile check as createEditLink.
   */
  renewEditLink(app: string, participantId: string, oldHash: string, link: EditLink, nowIso: string): Promise<EditLinkWrite>;
  /** Deletes the app's edit link and its lookup item; true when there was one. */
  deleteEditLink(app: string): Promise<boolean>;
}

/** A new secret from a cryptographic source such as `crypto.randomBytes` (same form as a session token). */
export function newAppToken(randomBytes: (size: number) => Buffer): string {
  return newSessionToken(randomBytes);
}

/** The lookup key: SHA-256, hex (256 random bits: a leaked hash cannot be reversed by guessing). */
export function hashAppToken(token: string): string {
  return hashToken(token);
}

/** The edit link's address: the app's address (absolute, as `appUrl`) with the secret in the fragment. */
export function editUrl(nickname: string, secret: string): string {
  return `${appAddress(nickname)}#edit=${secret}`;
}

function newLink(nickname: string, randomBytes: (size: number) => Buffer): EditLink {
  const secret = newAppToken(randomBytes);
  return { secret, secretHash: hashAppToken(secret), nickname };
}

/** Whether a stored link belongs to this builder (nicknames are unique and compared lower-cased, as the app's key is). */
const ownedBy = (link: EditLink, nickname: string): boolean => link.nickname.toLowerCase() === nickname.toLowerCase();

/**
 * The builder's edit link for their live app: the stored one, or a new one made now (create-if-absent; a racing make
 * wins and is read back). Undefined when the builder's profile is marked removed or the stored link names someone else.
 */
export async function ensureEditLink(store: EditLinkStore, participantId: string, nickname: string, randomBytes: (size: number) => Buffer, now: Date): Promise<EditLink | undefined> {
  for (let attempt = 0; attempt < EDIT_LINK_ATTEMPTS; attempt += 1) {
    const stored = await store.getEditLink(nickname);
    if (stored !== undefined) return ownedBy(stored, nickname) ? stored : undefined;
    const link = newLink(nickname, randomBytes);
    const result = await store.createEditLink(nickname, participantId, link, now.toISOString());
    if (result === "saved") return link;
    if (result === "removed") return undefined;
  }
  throw new Error("edit link kept changing");
}

/** `none`: the app has no edit link (not live yet, or reset); `removed`: the builder's profile is marked removed. */
export type RenewResult = { ok: true; link: EditLink } | { ok: false; reason: "none" | "removed" };

/** "New edit link": a new secret for the builder's app; the old one stops at once (its lookup item is deleted). */
export async function renewEditLink(store: EditLinkStore, participantId: string, nickname: string, randomBytes: (size: number) => Buffer, now: Date): Promise<RenewResult> {
  for (let attempt = 0; attempt < EDIT_LINK_ATTEMPTS; attempt += 1) {
    const stored = await store.getEditLink(nickname);
    if (stored === undefined || !ownedBy(stored, nickname)) return { ok: false, reason: "none" };
    const link = newLink(stored.nickname, randomBytes);
    const result = await store.renewEditLink(nickname, participantId, stored.secretHash, link, now.toISOString());
    if (result === "saved") return { ok: true, link };
    if (result === "removed") return { ok: false, reason: "removed" };
  }
  throw new Error("edit link kept changing");
}

/** The secret from `Authorization: Bearer <secret>` (scheme in any case), if well formed. Never reads a cookie. */
export function readBearerToken(request: HttpRequest): string | undefined {
  const header = request.headers?.["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header.trim());
  return match?.[1];
}

/** Why a write was refused (logged as an outcome; never the secret). `not-edit`: a 3.24 per-person token. */
export type AppWriteRefusal = "no-token" | "unknown" | "not-edit" | "other-app";
export type AppWriteCheck = { ok: true; writer: string } | { ok: false; reason: AppWriteRefusal };

/**
 * The one write check of every app route: the request carries the edit secret of this app (`app` compared
 * lower-cased), whose lookup item is an edit link's (`kind` = "edit"). Gives the writer: the app's builder's nickname.
 * "New edit link", a reset or an allow-list removal deletes the lookup item, so the old secret is then unknown. Table
 * errors are thrown to the caller.
 */
export async function checkAppWrite(request: HttpRequest, app: string, tokens: AppTokenReader): Promise<AppWriteCheck> {
  const token = readBearerToken(request);
  if (token === undefined) return { ok: false, reason: "no-token" };
  const stored = await tokens.getAppToken(hashAppToken(token));
  if (stored === undefined) return { ok: false, reason: "unknown" };
  if (stored.kind !== EDIT_KIND) return { ok: false, reason: "not-edit" };
  if (stored.app !== app.toLowerCase()) return { ok: false, reason: "other-app" };
  return { ok: true, writer: stored.nickname };
}
