// The conversation reset store over the in-memory table the API's own tests use (FakeConversationTable), so a reset
// is checked through the real routes. Shared by the conversation command's tests and the full participant reset's
// (ticket 2.13); not bundled.
import type { FakeConversationTable } from "../../api/conversation/fakes.js";
import type { ResetItems, ResetState, ResetStore } from "./store.js";

/** The reset store over the in-memory table the API's own tests use, so a reset is checked through the real routes. */
export class FakeResetStore implements ResetStore {
  restarts = 0;
  constructor(protected readonly t: FakeConversationTable) {}
  async findParticipantId(nickname: string) {
    return this.t.findParticipantId(nickname);
  }
  async getStep(id: string) {
    return this.t.profiles.get(id)?.step;
  }
  async getResetState(id: string): Promise<ResetState> {
    const c = this.t.conversations.get(id);
    return {
      exists: c !== undefined,
      // The fake has no updatedAt: the item's whole content stands in for it (any change changes it).
      ...(c === undefined ? {} : { updatedAt: JSON.stringify(c) }),
      ...(c?.pendingId === undefined ? {} : { pendingId: c.pendingId }),
      ...(c?.pendingSince === undefined ? {} : { pendingSince: c.pendingSince }),
      ...(c === undefined ? {} : { state: c.state }),
      ...(c?.buildId === undefined ? {} : { buildId: c.buildId }),
    };
  }
  async getBuildStatus(buildId: string) {
    return this.t.builds.get(buildId)?.status;
  }
  async listResetItems(id: string): Promise<ResetItems> {
    const ids = [...(this.t.messages.get(id)?.keys() ?? [])];
    const replies = [...(this.t.replies.get(id)?.keys() ?? [])].map((m) => `MSG#${m}-r`);
    return {
      messages: [...ids.map((m) => `MSG#${m}`), ...replies],
      specs: (this.t.specs.get(id) ?? []).map((s) => `SPEC#${String(s.version).padStart(4, "0")}`),
    };
  }
  async restart(id: string, seen: ResetState) {
    this.restarts++;
    const c = this.t.conversations.get(id);
    if ((c !== undefined) !== seen.exists || (c !== undefined && JSON.stringify(c) !== seen.updatedAt)) return false;
    const profile = this.t.profiles.get(id);
    if (profile === undefined || profile.step === "nickname") return false;
    this.t.conversations.delete(id);
    profile.step = "clarify";
    return true;
  }
  async deleteItems(id: string, sortKeys: readonly string[]) {
    for (const sk of sortKeys) {
      if (sk.startsWith("SPEC#")) this.t.specs.set(id, (this.t.specs.get(id) ?? []).filter((s) => s.version !== Number(sk.slice(5))));
      else if (sk.endsWith("-r")) this.t.replies.get(id)?.delete(sk.slice(4, -2));
      else this.t.messages.get(id)?.delete(sk.slice(4));
    }
  }
}

