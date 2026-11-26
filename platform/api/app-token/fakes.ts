// An in-memory stand-in for the app write tokens' table access (ticket 3.24), shared by the tests of the token route,
// the data API and the reset (not bundled: no handler imports it). Same rules as DynamoAppTokenStore: a participant's
// list drops expired entries on each new token and refuses one when MAX_APP_TOKENS are live; revocation deletes every
// listed token and the list.
import { MAX_APP_TOKENS, type AppTokenReader, type AppTokenWriter, type CreateTokenResult, type StoredAppToken } from "./token.js";

export class FakeAppTokenStore implements AppTokenReader, AppTokenWriter {
  /** Token items by hash. */
  readonly tokens = new Map<string, StoredAppToken>();
  /** Each participant's list: hash -> expiry. */
  readonly lists = new Map<string, Map<string, number>>();
  /** Hashes looked up, in order (to prove what was read). */
  readonly reads: string[] = [];
  /** When set, every call fails with it. */
  failure: Error | undefined;

  private check(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  async getAppToken(tokenHash: string): Promise<StoredAppToken | undefined> {
    this.check();
    this.reads.push(tokenHash);
    const token = this.tokens.get(tokenHash);
    return token && { ...token };
  }

  async createAppToken(participantId: string, tokenHash: string, token: StoredAppToken, nowSeconds: number): Promise<CreateTokenResult> {
    this.check();
    const list = this.lists.get(participantId) ?? new Map<string, number>();
    for (const [hash, expiresAt] of list) if (!(expiresAt > nowSeconds)) list.delete(hash);
    if (list.size >= MAX_APP_TOKENS) return "too-many";
    if (this.tokens.has(tokenHash)) return "conflict";
    this.tokens.set(tokenHash, { ...token });
    list.set(tokenHash, token.expiresAt);
    this.lists.set(participantId, list);
    return "saved";
  }

  async revokeAppTokens(participantId: string): Promise<number> {
    this.check();
    const list = this.lists.get(participantId);
    if (list === undefined) return 0;
    for (const hash of list.keys()) this.tokens.delete(hash);
    this.lists.delete(participantId);
    return list.size;
  }
}
