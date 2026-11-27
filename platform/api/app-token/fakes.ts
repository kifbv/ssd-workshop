// An in-memory stand-in for the edit links' table access (ticket 3.26), shared by the tests of the build routes, the
// data, media and AI APIs, and the reset (not bundled: no handler imports it). Same rules as DynamoAppTokenStore: a
// link is made only if the app has none, replaced only while its hash is the one read (the old lookup item goes in the
// same step), and neither happens for a profile marked removed (`profileRemoved`). Each call is atomic here.
import { EDIT_KIND, hashAppToken, type AppTokenReader, type EditLink, type EditLinkStore, type EditLinkWrite, type StoredAppToken } from "./token.js";

export class FakeAppTokenStore implements AppTokenReader, EditLinkStore {
  /** Whether a participant's profile is gone or marked removed; none is unless a test says otherwise. */
  constructor(private readonly profileRemoved: (participantId: string) => boolean = () => false) {}

  /** Lookup items by hash (a test may add a 3.24 token without `kind`). */
  readonly tokens = new Map<string, StoredAppToken>();
  /** Per-app items by lower-cased nickname. */
  readonly links = new Map<string, EditLink>();
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

  async getEditLink(app: string): Promise<EditLink | undefined> {
    this.check();
    const link = this.links.get(app.toLowerCase());
    return link && { ...link };
  }

  async createEditLink(app: string, participantId: string, link: EditLink): Promise<EditLinkWrite> {
    this.check();
    if (this.profileRemoved(participantId)) return "removed";
    if (this.links.has(app.toLowerCase()) || this.tokens.has(link.secretHash)) return "exists";
    this.links.set(app.toLowerCase(), { ...link });
    this.tokens.set(link.secretHash, { app: app.toLowerCase(), nickname: link.nickname, kind: EDIT_KIND });
    return "saved";
  }

  async renewEditLink(app: string, participantId: string, oldHash: string, link: EditLink): Promise<EditLinkWrite> {
    this.check();
    if (this.profileRemoved(participantId)) return "removed";
    const stored = this.links.get(app.toLowerCase());
    if (stored?.secretHash !== oldHash || this.tokens.has(link.secretHash)) return "changed";
    this.tokens.delete(oldHash);
    this.links.set(app.toLowerCase(), { ...stored, secret: link.secret, secretHash: link.secretHash });
    this.tokens.set(link.secretHash, { app: app.toLowerCase(), nickname: stored.nickname, kind: EDIT_KIND });
    return "saved";
  }

  async deleteEditLink(app: string): Promise<boolean> {
    this.check();
    const stored = this.links.get(app.toLowerCase());
    if (stored === undefined) return false;
    this.tokens.delete(stored.secretHash);
    this.links.delete(app.toLowerCase());
    return true;
  }

  /** Test helper: makes the app's edit link for its builder, as the builder's first GET /api/build would. */
  addEditLink(app: string, builder: string, secret: string): void {
    const secretHash = hashAppToken(secret);
    this.links.set(app.toLowerCase(), { secret, secretHash, nickname: builder });
    this.tokens.set(secretHash, { app: app.toLowerCase(), nickname: builder, kind: EDIT_KIND });
  }
}
