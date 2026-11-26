// An in-memory stand-in for the facilitator routes' table (ticket 3.10), for their tests (not bundled): the conversation
// fake plus the roster read, Pause, Add budget and Retry requests, with the same conditions as DynamoFacilitatorStore.
import { FakeConversationTable } from "../conversation/fakes.js";
import type { FacilitatorStore, RetryBuild, Roster } from "./facilitator.js";

export class FakeFacilitatorTable extends FakeConversationTable implements FacilitatorStore {
  /** Retry requests: build id -> requested at (the `BUILD_RETRIES` partition). */
  readonly retryRequests = new Map<string, string>();
  /** Calls to `roster` (the list reads everything in a few queries, never per row beyond the flagged message). */
  rosterCalls = 0;

  async roster(): Promise<Roster> {
    this.rosterCalls += 1;
    const roster: Roster = { profiles: [], conversations: new Map(), spend: new Map(), builds: new Map(), retries: new Set(this.retryRequests.keys()) };
    for (const p of this.profiles.values()) {
      roster.profiles.push({
        participantId: p.id,
        ...(p.nickname === undefined ? {} : { nickname: p.nickname }),
        role: p.role,
        group: p.group,
        step: p.step,
        ...(p.stepSince === undefined ? {} : { stepSince: p.stepSince }),
        createdAt: p.createdAt,
        paused: p.paused === true,
        extraBudget: p.extraBudget ?? 0,
        changeRequestsUsed: p.changeRequestsUsed ?? 0,
      });
    }
    for (const [id, c] of this.conversations) {
      roster.conversations.set(id, {
        ...(c.buildId === undefined ? {} : { buildId: c.buildId }),
        state: c.state,
        ...(c.pendingId === undefined ? {} : { pendingId: c.pendingId }),
      });
    }
    for (const [id, u] of this.usage) roster.spend.set(id, u.costUsd);
    for (const b of this.builds.values()) {
      roster.builds.set(b.buildId, {
        participantId: b.participantId,
        status: b.status,
        ...(b.launchedAt === undefined ? {} : { launchedAt: b.launchedAt }),
        ...(b.kind === "change" ? { kind: "change" as const } : {}),
        ...(b.changeNumber === undefined ? {} : { changeNumber: b.changeNumber }),
      });
    }
    return roster;
  }

  async getRetryBuild(buildId: string): Promise<RetryBuild | undefined> {
    const b = this.builds.get(buildId);
    return b && { participantId: b.participantId, status: b.status, ...(b.launchedAt === undefined ? {} : { launchedAt: b.launchedAt }) };
  }

  async setPaused(participantId: string, paused: boolean): Promise<boolean> {
    const profile = this.profiles.get(participantId);
    if (profile === undefined) return false;
    this.profiles.set(participantId, { ...profile, paused });
    return true;
  }

  /** Like `ADD #extraBudget :step` under `attribute_exists(pk)`: atomic, two presses add twice. */
  async addBudget(participantId: string, dollars: number): Promise<number | undefined> {
    const profile = this.profiles.get(participantId);
    if (profile === undefined) return undefined;
    const extraBudget = (profile.extraBudget ?? 0) + dollars;
    this.profiles.set(participantId, { ...profile, extraBudget });
    return extraBudget;
  }

  async requestRetry(buildId: string, participantId: string, nowIso: string): Promise<void> {
    this.retryRequests.set(buildId, nowIso);
    const conversation = this.conversations.get(participantId);
    if (conversation !== undefined) this.conversationUpdatedAt.set(participantId, nowIso);
  }

  /** The conversation's `updatedAt` as Retry moves it (the participant's page reads the build again). */
  readonly conversationUpdatedAt = new Map<string, string>();
}
