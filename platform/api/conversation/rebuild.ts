// Ticket 3.9, Rebuild from my repository (step 4, for participants who edit SPEC.md on GitHub). The route stores
// REBUILD_REQUEST marked `rebuild-from-repo` (an attribute only that route writes) and hands it to the AI worker, which
// runs this module in two passes:
//
// 1. Without a repository read on the message: the same gates as a change (global Stop: hold; budget; changes left),
//    then a spec-read request to the launch queue. Only the build launcher may read the GitHub App's key (the access
//    boundary's `GitHubKeyForTheLauncherOnly`), so it reads SPEC.md on `main` with a read-only one-repository token,
//    stores what it found on the message (`repositoryRead`, `repositorySpec`: attributes only it may write) and sends
//    the job back to the AI worker.
// 2. With the read: no readable SPEC.md (missing, over 20 KB, not UTF-8, empty, GitHub down) ends the request with its
//    text and no AI call; a read from another repository than the profile's fails it; the same spec as the live one
//    (compared in the published form, cleanRepositorySpec on both sides) ends it with "Your repository's spec has not
//    changed."; a spec the platform could not change later (checkSpec: over MAX_SPEC_CHARS, or without the one
//    flowchart and the three sections) is refused with its own text, still without an AI call; otherwise the guardrail
//    (decline or flag: nothing built), then the readiness check, then one transaction that stores the spec as the next
//    version (approved by the press: `rebuildApprovedAt`, with a fixed "What changes" line), counts the change and
//    queues the change build, exactly as Build this change does.
//
// SQS delivers at least once: every final write is conditional on the message still pending and in flight, and the
// build id comes from the message id, so a redelivery after the transaction only re-sends the build id.
import { cleanRepositorySpec, repositoryNameFor } from "../github/repository.js";
import { errorName } from "../sign-in/code-request.js";
import type { TokenUsage } from "../types.js";
import { BUDGET_REPLY, budgetOf, overBudget } from "../workshop/budget.js";
import { changesUsedText, PHASE_3_TEXTS, REBUILD_REQUEST, REBUILD_WHAT_CHANGES, rebuildNotReadyText } from "../workshop/texts.js";
import { checkSpec, MAX_SPEC_CHARS } from "./spec.js";
import { checkGuardrail, declineReply } from "./guardrail.js";
import { addUsage, type ModelClient } from "./model.js";
import { checkReadiness, READINESS_PROMPT_VERSION } from "./readiness.js";
import {
  buildIdFor,
  isStale,
  STOP_HOLD_SECONDS,
  type AiJob,
  type BuildQueue,
  type ConversationStore,
  type GuardrailRecord,
  type HeldJobs,
  type RebuildFinish,
  type RepositoryRead,
  type StoredMessage,
  rebuildSpent,
} from "./state.js";

export { REBUILD_REQUEST } from "../workshop/texts.js";

/** What a rebuild run ends with (the worker logs it). */
export type RebuildOutcome =
  | "reading"
  | "unchanged"
  | "refused"
  | "declined"
  | "not-ready"
  | "building"
  | "resent"
  | "failed"
  | "over-budget"
  | "over-limit"
  | "held"
  | "skipped";

export interface RebuildDeps {
  store: ConversationStore;
  model: ModelClient;
  builds: BuildQueue;
  held: HeldJobs;
  modelId: string;
  now: () => Date;
  /** Waits between tries of the final write. */
  sleep: (ms: number) => Promise<void>;
}

export interface RebuildResult {
  outcome: RebuildOutcome;
  verdict?: GuardrailRecord["verdict"];
  error?: string;
}

/** Ticket 3.9: Rebuild from my repository's request: the platform's text at step 4 with the mark only that route writes. */
export function isRebuildRequest(message: Pick<StoredMessage, "step" | "text" | "request">): boolean {
  return message.step === "building" && message.request === "rebuild-from-repo" && message.text === REBUILD_REQUEST;
}

/** The participant-facing text for a repository read that found no spec to use. */
export function refusalText(read: Exclude<RepositoryRead, { kind: "found" }>): string {
  switch (read.kind) {
    case "too-large":
      return PHASE_3_TEXTS.specTooLarge;
    case "missing":
      return PHASE_3_TEXTS.specMissing;
    case "unreadable":
      return PHASE_3_TEXTS.specUnreadable;
    case "empty":
      return PHASE_3_TEXTS.specEmpty;
    case "github-error":
      return PHASE_3_TEXTS.repositoryUnavailable;
  }
}

/**
 * True when the repository's spec is the live one as published: both through cleanRepositorySpec (line endings, control
 * and format characters, email addresses as SPEC.md shows them, trailing spaces and blank lines).
 */
export function sameSpec(repositoryText: string, liveText: string): boolean {
  return cleanRepositorySpec(repositoryText) === cleanRepositorySpec(liveText);
}

/**
 * Ticket 3.9 try 2: the participant-facing refusal of a repository spec the platform cannot keep (checkSpec's problems),
 * or undefined when it has the shape every stored version has. A spec over MAX_SPEC_CHARS has its own text; any other
 * problem (no title, not one flowchart, other sections) gets the shape text.
 */
export function shapeRefusal(text: string): string | undefined {
  const problems = checkSpec(text);
  if (problems.length === 0) return undefined;
  return text.length > MAX_SPEC_CHARS ? PHASE_3_TEXTS.specTooLongForPlatform : PHASE_3_TEXTS.specWrongShape;
}

const FINISH_ATTEMPTS = 3;
const FINISH_BACKOFF_MS = [200, 800] as const;

export async function runRebuild(job: AiJob, message: StoredMessage, deps: RebuildDeps, signal: AbortSignal | undefined): Promise<RebuildResult> {
  const { participantId, messageId } = job;
  const buildId = buildIdFor(messageId);
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const conversation = await deps.store.getConversation(participantId);
  if (message.status === "done") {
    // Queued on an earlier delivery (same transaction as the build), but the send may have failed: send it again.
    if (conversation?.buildId !== buildId) return { outcome: "skipped" };
    await deps.builds.send({ buildId, participantId });
    return { outcome: "resent" };
  }
  const previousBuildId = conversation?.buildId;
  const liveVersion = conversation?.approvedSpecVersion;
  if (
    message.status !== "pending" ||
    isStale(message, nowSeconds) ||
    previousBuildId === undefined ||
    liveVersion === undefined ||
    conversation?.pendingId !== messageId
  ) {
    return { outcome: "skipped" };
  }
  const profile = await deps.store.getParticipantInfo(participantId);
  if (profile?.step !== "building" || profile.nickname === undefined) return { outcome: "skipped" };
  const nickname = profile.nickname;

  const finish = async (outcome: RebuildFinish): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await deps.store.finishRebuild(participantId, messageId, outcome, deps.now().toISOString());
      } catch (error) {
        if (attempt < FINISH_ATTEMPTS) {
          await deps.sleep(FINISH_BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }
        // The calls' tokens were spent: count them although the outcome could not be stored.
        const spent = rebuildSpent(outcome);
        try {
          if (spent !== undefined) await deps.store.addUsage(participantId, spent, deps.now().toISOString());
        } catch {
          // The original error is the one that matters.
        }
        throw error;
      }
    }
  };
  const ended = async (outcome: RebuildFinish, as: RebuildOutcome, verdict?: GuardrailRecord["verdict"]): Promise<RebuildResult> => {
    const applied = await finish(outcome);
    return { outcome: applied ? as : "skipped", ...(verdict === undefined ? {} : { verdict }) };
  };

  let finishing = false;
  let guardrail: GuardrailRecord | undefined;
  let usage: TokenUsage | undefined;
  try {
    const facts = await deps.store.getBudgetFacts(participantId);
    if (facts.settings.stopped) {
      finishing = true;
      if (!(await deps.store.holdMessage(participantId, messageId, nowSeconds))) return { outcome: "skipped" };
      await deps.held.sendLater(job, STOP_HOLD_SECONDS);
      return { outcome: "held" };
    }
    const budget = budgetOf(facts);
    if (budget.reached) {
      finishing = true;
      return await ended({ kind: "over-budget", reply: BUDGET_REPLY, previousBuildId }, "over-budget");
    }
    const used = facts.limits.changeRequestsUsed;
    const cap = facts.settings.changeRequestsPerPerson;
    if (used >= cap) {
      finishing = true;
      return await ended({ kind: "over-limit", reply: changesUsedText(cap), previousBuildId }, "over-limit");
    }
    const read = message.repository;
    if (read === undefined) {
      // First pass: the launcher reads SPEC.md and hands the job back. A failed send is thrown (SQS delivers again).
      finishing = true;
      await deps.builds.sendSpecRead(job);
      return { outcome: "reading" };
    }
    if (read.kind !== "found") {
      finishing = true;
      return await ended({ kind: "refused", reply: refusalText(read), previousBuildId }, "refused");
    }
    // The text must come from the participant's own repository (the launcher stores the name it read from).
    if (read.repository !== repositoryNameFor(nickname)) throw Object.assign(new Error("read from another repository"), { name: "RepositoryMismatch" });
    const live = await deps.store.getSpec(participantId, liveVersion);
    if (live === undefined) throw Object.assign(new Error("the live spec is missing"), { name: "MissingSpec" });
    // Order: the 20 KB cap and the cleaning (launcher), the same-spec check, the shape check, then the AI calls.
    if (sameSpec(read.text, live.text)) {
      finishing = true;
      return await ended({ kind: "unchanged", reply: PHASE_3_TEXTS.specUnchanged, previousBuildId }, "unchanged");
    }
    const refusal = shapeRefusal(read.text);
    if (refusal !== undefined) {
      finishing = true;
      return await ended({ kind: "refused", reply: refusal, previousBuildId }, "refused");
    }
    const check = await checkGuardrail(deps.model, read.text, signal);
    guardrail = { verdict: check.verdict, reason: check.reason, suggestion: check.suggestion, usage: check.usage };
    if (check.verdict !== "on-path") {
      // Decline or flag: nothing is built. A flagged repository spec does not wait for a facilitator (the message's text
      // is the platform's request, not the spec): the participant is told to talk to them or change SPEC.md.
      finishing = true;
      const reply = check.verdict === "decline" ? declineReply(check.suggestion) : PHASE_3_TEXTS.rebuildFlagged;
      return await ended({ kind: "declined", reply, previousBuildId, guardrail }, "declined", check.verdict);
    }
    if (overBudget(budget, guardrail.usage.costUsd)) {
      finishing = true;
      return await ended({ kind: "over-budget", reply: BUDGET_REPLY, previousBuildId, guardrail }, "over-budget", "on-path");
    }
    const readiness = await checkReadiness(deps.model, read.text, signal);
    usage = readiness.usage;
    if (readiness.verdict === "unreadable") throw Object.assign(new Error("unreadable readiness answer"), { name: "UnreadableVerdict" });
    const answer = { prompt: message.text, modelId: deps.modelId, promptVersion: READINESS_PROMPT_VERSION, historyCount: 0, usage: readiness.usage };
    finishing = true;
    if (readiness.verdict === "not-ready") {
      return await ended({ kind: "not-ready", reply: rebuildNotReadyText(readiness.reasons), previousBuildId, guardrail, answer }, "not-ready", "on-path");
    }
    if (overBudget(budget, guardrail.usage.costUsd + readiness.usage.costUsd)) {
      return await ended({ kind: "over-budget", reply: BUDGET_REPLY, previousBuildId, guardrail, usage: readiness.usage }, "over-budget", "on-path");
    }
    const latest = await deps.store.getLatestSpec(participantId);
    const version = Math.max(latest?.version ?? 0, live.version) + 1;
    const ready: RebuildFinish = {
      kind: "ready",
      reply: PHASE_3_TEXTS.rebuildReady,
      previousBuildId,
      spec: { version, text: read.text, whatChanges: [REBUILD_WHAT_CHANGES] },
      guardrail,
      answer,
      build: { buildId, nickname, changeNumber: used + 1 },
      used,
      cap,
    };
    if (!(await finish(ready))) {
      // A condition failed (the count moved, a build is running, the request is no longer in flight): nothing was
      // written, so the calls' tokens are counted on their own.
      await deps.store.addUsage(participantId, addUsage(guardrail.usage, readiness.usage), deps.now().toISOString()).catch(() => undefined);
      return { outcome: "skipped", verdict: "on-path" };
    }
    await deps.builds.send({ buildId, participantId });
    return { outcome: "building", verdict: "on-path" };
  } catch (error) {
    if (finishing) throw error;
    const applied = await finish({
      kind: "failed",
      reply: PHASE_3_TEXTS.rebuildFailed,
      previousBuildId,
      ...(guardrail === undefined ? {} : { guardrail }),
      ...(usage === undefined ? {} : { usage }),
    });
    return { outcome: applied ? "failed" : "skipped", error: errorName(error), ...(guardrail === undefined ? {} : { verdict: guardrail.verdict }) };
  }
}
