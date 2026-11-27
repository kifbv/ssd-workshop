// An in-memory stand-in for the table behind the code check, the session check and the participant
// routes (ticket 1.5), shared by their tests (not bundled: no handler imports it). It follows the
// same conditions as the DynamoDB adapters: an atomic wrong-try count, versioned code deletes, a link only when none exists,
// and the nickname claim and profile update as one all-or-nothing step.
import { FakeAppTokenStore } from "./app-token/fakes.js";
import type { ClaimResult, ParticipantStore } from "./participant/participant.js";
import { randomBytes } from "node:crypto";
import { hashToken, sealAllowRef, type ParticipantRecord, type StoredSession } from "./session/session.js";
import type { StoredCodes } from "./sign-in/code-request.js";
import type { AllowEntry, VerifyStore } from "./sign-in/verify.js";
import type { Role, Step } from "./types.js";

type Method = keyof VerifyStore | keyof ParticipantStore;

export class FakeTable implements VerifyStore, ParticipantStore {
  readonly allow = new Map<string, AllowEntry>();
  readonly codes = new Map<string, StoredCodes>();
  /**
   * `stepSince` is set with every step change, as the stores do (ticket 3.2); `extraBudget` as a facilitator grants it
   * (ticket 3.3 tests); `changeRequestsUsed` as the AI worker counts a queued change build (ticket 3.6); `paused` as a
   * facilitator's Pause sets it (ticket 3.10).
   */
  readonly profiles = new Map<string, ParticipantRecord & { createdAt: string; stepSince?: string; extraBudget?: number; changeRequestsUsed?: number; paused?: boolean }>();
  /** By token hash; `allowRef` is the address sealed under the token (as the verify function stores it). */
  readonly sessions = new Map<string, StoredSession & { createdAt: string }>();
  /** Nickname claims by lower-cased nickname. */
  readonly nicknames = new Map<string, { nickname: string; participantId: string }>();
  /**
   * Ticket 3.26: the edit links (the build routes' tests pass it as `editLinks`). A profile marked removed from the
   * allow-list (role `removed`) or missing gets no link, as the DynamoDB transactions' profile check says.
   */
  readonly appTokens = new FakeAppTokenStore((participantId) => {
    const role: string | undefined = this.profiles.get(participantId)?.role;
    return role === undefined || role === "removed";
  });
  failOn: Method | undefined;
  failure: Error = new Error("boom");
  /** Runs once before the next getCode returns (simulates another writer in between). */
  beforeCodeRead: (() => void) | undefined;

  private maybeFail(method: Method): void {
    if (this.failOn === method) throw this.failure;
  }

  async getAllowEntry(email: string): Promise<AllowEntry | undefined> {
    this.maybeFail("getAllowEntry");
    const entry = this.allow.get(email);
    return entry && { ...entry };
  }

  async getCode(email: string): Promise<StoredCodes | undefined> {
    this.maybeFail("getCode");
    const item = this.codes.get(email);
    const copy = item && { codes: item.codes.map((c) => ({ ...c })), attempts: item.attempts, version: item.version };
    const hook = this.beforeCodeRead;
    this.beforeCodeRead = undefined;
    hook?.();
    return copy;
  }

  /** Like DynamoDB's `ADD attempts :one, version :one` on an existing item: atomic, never refused for a race. */
  async addWrongTry(email: string): Promise<{ attempts: number; version: number } | undefined> {
    this.maybeFail("addWrongTry");
    const item = this.codes.get(email);
    if (item === undefined) return undefined;
    const updated = { ...item, attempts: item.attempts + 1, version: item.version + 1 };
    this.codes.set(email, updated);
    return { attempts: updated.attempts, version: updated.version };
  }

  async deleteCode(email: string, expectedVersion: number): Promise<boolean> {
    this.maybeFail("deleteCode");
    if (this.codes.get(email)?.version !== expectedVersion) return false;
    this.codes.delete(email);
    return true;
  }

  async linkParticipant(email: string, participantId: string): Promise<boolean> {
    this.maybeFail("linkParticipant");
    const entry = this.allow.get(email);
    if (entry === undefined || entry.participantId !== undefined) return false;
    this.allow.set(email, { ...entry, participantId });
    return true;
  }

  async upsertProfile(participantId: string, role: Role, group: string, nowIso: string): Promise<Step> {
    this.maybeFail("upsertProfile");
    const existing = this.profiles.get(participantId);
    const profile = existing
      ? { ...existing, role, group }
      : { id: participantId, role, group, step: "nickname" as const, createdAt: nowIso };
    this.profiles.set(participantId, profile);
    return profile.step;
  }

  async putSession(tokenHash: string, participantId: string, createdAtIso: string, expiresAt: number, allowRef: string): Promise<void> {
    this.maybeFail("putSession");
    if (this.sessions.has(tokenHash)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
    this.sessions.set(tokenHash, { participantId, expiresAt, createdAt: createdAtIso, allowRef });
  }

  async getSession(tokenHash: string): Promise<StoredSession | undefined> {
    this.maybeFail("getSession");
    const session = this.sessions.get(tokenHash);
    if (session === undefined) return undefined;
    const { participantId, expiresAt, allowRef } = session;
    return { participantId, expiresAt, ...(allowRef === undefined ? {} : { allowRef }) };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.maybeFail("deleteSession");
    this.sessions.delete(tokenHash);
  }

  /** The address tests use for a participant's allow-list entry. */
  static emailOf(participantId: string): string {
    return `${participantId.toLowerCase()}@example.test`;
  }

  /**
   * Signs a participant in with `token`, as the verify function would: the session item (its address sealed under the
   * token) and, unless the address already has one, an allow-list entry linked to the participant with the profile's
   * role and group (participant, blue when there is no profile yet).
   */
  addSession(token: string, participantId: string, expiresAt: number, email = FakeTable.emailOf(participantId)): void {
    if (!this.allow.has(email)) {
      const profile = this.profiles.get(participantId);
      this.allow.set(email, { role: profile?.role ?? "participant", group: profile?.group ?? "blue", participantId });
    }
    this.sessions.set(hashToken(token), { participantId, expiresAt, createdAt: "x", allowRef: sealAllowRef(token, email, randomBytes) });
  }

  async getParticipant(participantId: string): Promise<ParticipantRecord | undefined> {
    this.maybeFail("getParticipant");
    const p = this.profiles.get(participantId);
    if (p === undefined) return undefined;
    return { id: p.id, role: p.role, group: p.group, step: p.step, ...(p.nickname === undefined ? {} : { nickname: p.nickname }) };
  }

  async claimNickname(participantId: string, nickname: string, nowIso: string): Promise<ClaimResult> {
    this.maybeFail("claimNickname");
    const profile = this.profiles.get(participantId);
    if (profile === undefined || profile.nickname !== undefined || profile.step !== "nickname") return "already-set";
    const key = nickname.toLowerCase();
    if (this.nicknames.has(key)) return "taken";
    this.nicknames.set(key, { nickname, participantId });
    this.profiles.set(participantId, { ...profile, nickname, step: "clarify", stepSince: nowIso });
    return "saved";
  }
}
