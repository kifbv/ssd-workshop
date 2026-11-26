// The AI worker (ticket 1.7): takes one job from the queue (participant id and message id), runs
// the guardrail check, then asks Claude for the answer, and stores the outcome with its tokens and
// cost in one transaction. SQS delivers at least once: a message that is no longer pending (already
// handled, or left behind and stale) is skipped, and the final write is conditional on it still
// being pending, so a job delivered twice is answered and counted once. The final write is tried
// FINISH_ATTEMPTS times; when it still fails, the tokens already spent are added to the usage on
// their own before the error is thrown (SQS then delivers the job again).
//
// Ticket 2.7: the readiness request that Approve spec stores (READINESS_REQUEST at step approved) gets the
// readiness check instead of the guardrail and answer calls. Its outcome is stored the same way (one
// conditional transaction, tokens counted), and when it passed, the build id goes to the launch queue after
// that transaction. A send that fails is thrown, so SQS delivers the job again: the message is then done and
// the conversation holds that build, so the job only sends the build id again (no second check, no second build).
//
// Ticket 3.3: before each AI call (the guardrail, the answer, the readiness check) and before a build is queued, the
// participant's spend (read once per job, plus what this job's earlier calls cost) is compared with their budget. At or
// over it, the call is not made: the message ends `failed` with the budget text (they send again once a facilitator
// added budget), and a readiness request goes back to step 2 like a failed check, with no build. A build already
// queued (a redelivered readiness job only re-sends its id) or running is never stopped.
//
// Ticket 3.5: while the admin's global Stop is on (read with the budget, at the start of each job), no AI call is made:
// the message stays pending, its `pendingSince` moves to now (so a long Stop never makes it stale) and the job goes back
// on the worker's own queue to come back after STOP_HOLD_SECONDS, as a new message (so the queue's receive count, which
// sends a crashing job to the dead-letter queue, does not grow). After Resume, the next delivery answers it as usual. A
// job already past that read finishes. A redelivered readiness job that only re-sends its build id calls no AI and is
// not held (the launcher holds the build).
//
// Ticket 3.6, change requests: a participant message at step `building` (step 4, sent once the app is live) goes
// through the same Stop hold, budget check and guardrail, and is refused without an AI call when every change request is
// used; on path, the change prompt writes the next spec version and its "What changes" list, stored as the proposal.
// Build this change stores CHANGE_BUILD_REQUEST marked `change-build`: the worker runs the readiness check on the
// proposed version and, when it passes and budget and changes are left, queues a build of kind `change` and counts the
// change in the same transaction (a redelivery only re-sends the build id, as for the first build). A suggestions job
// (no message) asks for three suggested changes once the app is live, under the same Stop hold and budget check.
import { errorName } from "../sign-in/code-request.js";
import { BUDGET_REPLY, budgetOf, overBudget } from "../workshop/budget.js";
import { changesUsedText } from "../workshop/texts.js";
import { answerMessage } from "./answer.js";
import { answerChange, CHANGE_BUILD_REQUEST, CHANGE_FAILURE_REPLY, CHANGE_READY_REPLY, changeNotReadyReply } from "./change.js";
import { suggestChanges } from "./suggestions.js";
import { checkGuardrail, declineReply } from "./guardrail.js";
import { addUsage, usageOf, type ModelClient } from "./model.js";
import { checkReadiness, notReadyReply, READINESS_FAILURE_REPLY, READINESS_PROMPT_VERSION, READINESS_REQUEST, READY_REPLY } from "./readiness.js";
import { WRITE_SPEC_REQUEST } from "./spec.js";
import {
  buildIdFor,
  FAILURE_REPLY,
  isStale,
  STOP_HOLD_SECONDS,
  textHash,
  type AiJob,
  type BuildQueue,
  type ChangeBuildFinish,
  type SuggestionsQueue,
  type ConversationStore,
  type Finish,
  type GuardrailRecord,
  type HeldJobs,
  type ReadinessFinish,
  type StoredMessage,
} from "./state.js";

/**
 * `building`, `not-ready`: the readiness check passed (the build is queued) or failed (ticket 2.7); `resent`: a
 * redelivered readiness job that only sent its build id again.
 */
export type WorkerOutcome =
  | "done"
  | "declined"
  | "flagged"
  | "failed"
  | "skipped"
  | "invalid"
  | "building"
  | "not-ready"
  | "resent"
  /** Ticket 3.3: the AI budget is used; the (next) AI call was not made and no build was queued. */
  | "over-budget"
  /** Ticket 3.5: the global Stop is on; no AI call, the message stays pending and the job comes back later. */
  | "held"
  /** Ticket 3.6: every change request is used; no AI call was made and no build was queued. */
  | "over-limit"
  /** Ticket 3.6: the suggested changes were stored. */
  | "suggested";

/** The only things ever logged: outcome, verdict and an error name (no text, prompt, reply or id). */
export interface WorkerLogEntry {
  event: "ai-worker";
  outcome: WorkerOutcome;
  verdict?: GuardrailRecord["verdict"];
  error?: string;
}

export interface WorkerDeps {
  store: ConversationStore;
  model: ModelClient;
  /** The launch queue (ticket 2.7). */
  builds: BuildQueue;
  /** Ticket 3.5: the worker's own queue, for jobs held by the global Stop (ticket 3.6: suggestions jobs too). */
  held: HeldJobs & SuggestionsQueue;
  modelId: string;
  now: () => Date;
  log: (entry: WorkerLogEntry) => void;
  /** Waits between tries of the final write (tests pass a recorder); real timers by default. */
  sleep?: (ms: number) => Promise<void>;
}

/** Tries of the final write (a table error, not a lost race), with these waits between them. */
export const FINISH_ATTEMPTS = 3;
export const FINISH_BACKOFF_MS = [200, 800] as const;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The tokens and cost an outcome carries (the guardrail call's and the answer's). */
function spentOn(outcome: Finish) {
  return addUsage(outcome.guardrail?.usage, outcome.kind === "done" ? outcome.answer.usage : undefined);
}

/**
 * Handles one job. A failure while answering (a Bedrock error, the deadline, an empty answer, the
 * history read) ends the message as failed with the neutral reply, so the participant can send
 * again at once; a failure to read the message, or to write the outcome after FINISH_ATTEMPTS tries,
 * is thrown, so SQS delivers the job again.
 */
export async function processJob(job: AiJob | undefined, deps: WorkerDeps, signal?: AbortSignal): Promise<WorkerOutcome> {
  const outcome = await run(job, deps, signal);
  deps.log({ event: "ai-worker", ...outcome });
  return outcome.outcome;
}

async function run(
  job: AiJob | undefined,
  deps: WorkerDeps,
  signal: AbortSignal | undefined,
): Promise<Omit<WorkerLogEntry, "event">> {
  if (job === undefined) return { outcome: "invalid" };
  const { participantId, messageId } = job;
  const message = await deps.store.getMessage(participantId, messageId);
  const nowSeconds = () => Math.floor(deps.now().getTime() / 1000);
  if (message !== undefined && isReadinessRequest(message)) return runReadiness(job, message, deps, signal);
  if (message !== undefined && isChangeBuildRequest(message)) return runChangeBuild(job, message, deps, signal);
  if (message === undefined || message.status !== "pending" || isStale(message, nowSeconds())) return { outcome: "skipped" };

  const sleep = deps.sleep ?? realSleep;
  const finish = async (outcome: Finish): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await deps.store.finish(participantId, messageId, outcome, "pending", deps.now().toISOString());
      } catch (error) {
        if (attempt < FINISH_ATTEMPTS) {
          await sleep(FINISH_BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }
        // The tokens were spent: count them even though the outcome could not be stored. The job runs
        // again from the start on redelivery, and those calls are counted again (they are spent too).
        try {
          await deps.store.addUsage(participantId, spentOn(outcome), deps.now().toISOString());
        } catch {
          // Nothing more to do: the original error is the one that matters.
        }
        throw error;
      }
    }
  };

  let guardrail: GuardrailRecord | undefined;
  let finishing = false;
  try {
    const facts = await deps.store.getBudgetFacts(participantId);
    // Ticket 3.5: no AI call while the global Stop is on; a failed hold is thrown (SQS delivers the job again).
    if (facts.settings.stopped) {
      finishing = true;
      return await hold(job, deps);
    }
    // Ticket 3.3: no AI call once the budget is used (also for an approved flag or Write my spec's request).
    const budget = budgetOf(facts);
    if (budget.reached) {
      finishing = true;
      const applied = await finish({ kind: "over-budget", reply: BUDGET_REPLY });
      return { outcome: applied ? "over-budget" : "skipped" };
    }
    // Ticket 3.6: a change request (step 4) when every change is used gets the limit text, without an AI call.
    const change = message.step === "building";
    if (change && facts.limits.changeRequestsUsed >= facts.settings.changeRequestsPerPerson) {
      finishing = true;
      const applied = await finish({ kind: "over-limit", reply: changesUsedText(facts.settings.changeRequestsPerPerson) });
      return { outcome: applied ? "over-limit" : "skipped" };
    }
    // A facilitator approved this very text after a flag: no new check. A text changed since (by
    // anyone) has another hash and is checked again. Write my spec's own request (ticket 1.9) is the
    // platform's fixed text, so it needs no check either.
    const approved = message.approvedTextHash !== undefined && message.approvedTextHash === textHash(message.text);
    const writeSpec = message.step === "spec" && message.text === WRITE_SPEC_REQUEST;
    if (!approved && !writeSpec) {
      const check = await checkGuardrail(deps.model, message.text, signal);
      guardrail = { verdict: check.verdict, reason: check.reason, suggestion: check.suggestion, usage: check.usage };
      if (check.verdict === "decline") {
        finishing = true;
        const applied = await finish({ kind: "declined", reply: declineReply(check.suggestion), guardrail });
        return { outcome: applied ? "declined" : "skipped", verdict: "decline" };
      }
      if (check.verdict === "flag") {
        finishing = true;
        const applied = await finish({ kind: "flagged", guardrail });
        return { outcome: applied ? "flagged" : "skipped", verdict: "flag" };
      }
      // The guardrail call itself may have used the last of the budget: no answer call then.
      if (overBudget(budget, guardrail.usage.costUsd)) {
        finishing = true;
        const applied = await finish({ kind: "over-budget", reply: BUDGET_REPLY, guardrail });
        return { outcome: applied ? "over-budget" : "skipped", verdict: guardrail.verdict };
      }
    }
    const history = await deps.store.getHistory(participantId, messageId);
    if (change) return await runChange(job, message, history, guardrail, deps, finish, () => (finishing = true), signal);
    // Step 2 (ticket 1.9): the model sees the current spec, and an answer may carry a new version.
    const current = message.step === "spec" ? await deps.store.getLatestSpec(participantId) : undefined;
    const answer = await answerMessage(deps.model, message.step, history, message.text, signal, current?.text);
    finishing = true;
    const applied = await finish({
      kind: "done",
      reply: answer.text,
      answer: {
        prompt: message.text,
        modelId: deps.modelId,
        promptVersion: answer.promptVersion,
        historyCount: answer.historyCount,
        usage: usageOf(answer),
      },
      ...(answer.offersSpec ? { offersSpec: true } : {}),
      ...(answer.spec === undefined ? {} : { spec: { version: (current?.version ?? 0) + 1, text: answer.spec } }),
      ...(guardrail === undefined ? {} : { guardrail }),
    });
    return { outcome: applied ? "done" : "skipped", ...(guardrail === undefined ? {} : { verdict: guardrail.verdict }) };
  } catch (error) {
    // A final write that failed every try is a table problem: let SQS deliver the job again.
    if (finishing) throw error;
    const applied = await finish({ kind: "failed", reply: FAILURE_REPLY, ...(guardrail === undefined ? {} : { guardrail }) });
    return { outcome: applied ? "failed" : "skipped", error: errorName(error) };
  }
}

/**
 * Ticket 3.6: the change answer (after the guardrail and the checks above): the live spec (the version last built) and the
 * open proposal, if any, go to the change prompt; a new version is stored with its list as the new proposal. Errors
 * before the final write are the caller's (the neutral failure reply); `finishing` is set before it.
 */
async function runChange(
  job: AiJob,
  message: StoredMessage,
  history: Awaited<ReturnType<WorkerDeps["store"]["getHistory"]>>,
  guardrail: GuardrailRecord | undefined,
  deps: WorkerDeps,
  finish: (outcome: Finish) => Promise<boolean>,
  markFinishing: () => void,
  signal: AbortSignal | undefined,
): Promise<Omit<WorkerLogEntry, "event">> {
  const conversation = await deps.store.getConversation(job.participantId);
  const live = conversation?.approvedSpecVersion === undefined ? undefined : await deps.store.getSpec(job.participantId, conversation.approvedSpecVersion);
  if (live === undefined) throw Object.assign(new Error("the live spec is missing"), { name: "MissingSpec" });
  const proposed =
    conversation?.proposedSpecVersion === undefined ? undefined : await deps.store.getSpec(job.participantId, conversation.proposedSpecVersion);
  const latest = await deps.store.getLatestSpec(job.participantId);
  const answer = await answerChange(deps.model, history, message.text, live.text, proposed?.text, signal);
  markFinishing();
  const applied = await finish({
    kind: "done",
    reply: answer.text,
    answer: { prompt: message.text, modelId: deps.modelId, promptVersion: answer.promptVersion, historyCount: answer.historyCount, usage: usageOf(answer) },
    ...(answer.spec === undefined || answer.whatChanges === undefined
      ? {}
      : { spec: { version: Math.max(latest?.version ?? 0, live.version) + 1, text: answer.spec, whatChanges: answer.whatChanges } }),
    ...(guardrail === undefined ? {} : { guardrail }),
  });
  return { outcome: applied ? "done" : "skipped", ...(guardrail === undefined ? {} : { verdict: guardrail.verdict }) };
}

/**
 * Ticket 3.5: keeps a pending message waiting while the global Stop is on: its time in flight moves to now, then the job
 * goes back on the queue for STOP_HOLD_SECONDS. A message no longer pending or in flight is skipped (nothing sent).
 */
async function hold(job: AiJob, deps: WorkerDeps): Promise<Omit<WorkerLogEntry, "event">> {
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  if (!(await deps.store.holdMessage(job.participantId, job.messageId, nowSeconds))) return { outcome: "skipped" };
  await deps.held.sendLater(job, STOP_HOLD_SECONDS);
  return { outcome: "held" };
}

/** The readiness request (ticket 2.7): the platform's own text, at the step only Approve spec stores messages at. */
export function isReadinessRequest(message: Pick<StoredMessage, "step" | "text">): boolean {
  return message.step === "approved" && message.text === READINESS_REQUEST;
}

async function runReadiness(
  job: AiJob,
  message: StoredMessage,
  deps: WorkerDeps,
  signal: AbortSignal | undefined,
): Promise<Omit<WorkerLogEntry, "event">> {
  const { participantId, messageId } = job;
  const buildId = buildIdFor(messageId);
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const conversation = await deps.store.getConversation(participantId);
  if (message.status === "done") {
    // Passed on an earlier delivery: the build exists (same transaction as buildId), but the send may have
    // failed. Send it again; the queue drops a duplicate within 5 minutes, the launcher acts only on `queued`.
    if (conversation?.buildId !== buildId) return { outcome: "skipped" };
    await deps.builds.send({ buildId, participantId });
    return { outcome: "resent" };
  }
  const version = conversation?.approvedSpecVersion;
  if (message.status !== "pending" || isStale(message, nowSeconds) || version === undefined || conversation?.pendingId !== messageId) {
    return { outcome: "skipped" };
  }
  const profile = await deps.store.getParticipantInfo(participantId);
  if (profile?.step !== "approved" || profile.nickname === undefined) return { outcome: "skipped" };
  const nickname = profile.nickname;

  const sleep = deps.sleep ?? realSleep;
  const finish = async (outcome: ReadinessFinish): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await deps.store.finishReadiness(participantId, messageId, outcome, deps.now().toISOString());
      } catch (error) {
        if (attempt < FINISH_ATTEMPTS) {
          await sleep(FINISH_BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }
        // The check's tokens were spent: count them although the outcome could not be stored (as above).
        const spent = outcome.kind === "failed" || outcome.kind === "over-budget" ? outcome.usage : outcome.answer.usage;
        try {
          if (spent !== undefined) await deps.store.addUsage(participantId, spent, deps.now().toISOString());
        } catch {
          // The original error is the one that matters.
        }
        throw error;
      }
    }
  };

  let finishing = false;
  let usage: ReturnType<typeof usageOf> | undefined;
  try {
    const facts = await deps.store.getBudgetFacts(participantId);
    // Ticket 3.5: no readiness check while the global Stop is on (held as any message).
    if (facts.settings.stopped) {
      finishing = true;
      return await hold(job, deps);
    }
    // Ticket 3.3: no readiness check (and so no build) once the budget is used.
    const budget = budgetOf(facts);
    if (budget.reached) {
      finishing = true;
      const applied = await finish({ kind: "over-budget", reply: BUDGET_REPLY, version });
      return { outcome: applied ? "over-budget" : "skipped" };
    }
    const spec = await deps.store.getSpec(participantId, version);
    if (spec === undefined) throw Object.assign(new Error("the approved spec is missing"), { name: "MissingSpec" });
    const check = await checkReadiness(deps.model, spec.text, signal);
    usage = check.usage;
    const answer = { prompt: message.text, modelId: deps.modelId, promptVersion: READINESS_PROMPT_VERSION, historyCount: 0, usage: check.usage };
    if (check.verdict === "unreadable") throw Object.assign(new Error("unreadable readiness answer"), { name: "UnreadableVerdict" });
    finishing = true;
    if (check.verdict === "not-ready") {
      const applied = await finish({ kind: "not-ready", reply: notReadyReply(check.reasons), version, answer });
      return { outcome: applied ? "not-ready" : "skipped" };
    }
    // The check itself may have used the last of the budget: then no build is queued (its tokens are counted).
    if (overBudget(budget, check.usage.costUsd)) {
      const applied = await finish({ kind: "over-budget", reply: BUDGET_REPLY, version, usage: check.usage });
      return { outcome: applied ? "over-budget" : "skipped" };
    }
    const applied = await finish({ kind: "ready", reply: READY_REPLY, version, answer, build: { buildId, nickname } });
    if (!applied) return { outcome: "skipped" };
    // A failed send is thrown (finishing is set): SQS delivers the job again, which only re-sends the build id.
    await deps.builds.send({ buildId, participantId });
    return { outcome: "building" };
  } catch (error) {
    if (finishing) throw error;
    // No verdict (a model error, the deadline, an unreadable answer): no build. Back to step 2 with the
    // neutral reply, the tokens of a call that answered still counted.
    const applied = await finish({ kind: "failed", reply: READINESS_FAILURE_REPLY, version, ...(usage === undefined ? {} : { usage }) });
    return { outcome: applied ? "failed" : "skipped", error: errorName(error) };
  }
}

/** Ticket 3.6: Build this change's request: the platform's text at step 4 with the mark only that route writes. */
export function isChangeBuildRequest(message: Pick<StoredMessage, "step" | "text" | "request">): boolean {
  return message.step === "building" && message.request === "change-build" && message.text === CHANGE_BUILD_REQUEST;
}

/**
 * Ticket 3.6: the readiness check on the proposed version and, when it passes (budget and changes left), the change build
 * queued with the change counted, in one transaction (`finishChangeBuild`). Not ready, no verdict, over budget or no
 * changes left: the proposal stays and nothing counts. A redelivery after the transaction only re-sends the build id.
 */
async function runChangeBuild(
  job: AiJob,
  message: StoredMessage,
  deps: WorkerDeps,
  signal: AbortSignal | undefined,
): Promise<Omit<WorkerLogEntry, "event">> {
  const { participantId, messageId } = job;
  const buildId = buildIdFor(messageId);
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const conversation = await deps.store.getConversation(participantId);
  if (message.status === "done") {
    // Queued on an earlier delivery (same transaction as buildId), but the send may have failed: send it again. Nothing
    // is counted again (the count was in that transaction).
    if (conversation?.buildId !== buildId) return { outcome: "skipped" };
    await deps.builds.send({ buildId, participantId });
    return { outcome: "resent" };
  }
  const version = conversation?.proposedSpecVersion;
  const previousBuildId = conversation?.buildId;
  if (
    message.status !== "pending" ||
    isStale(message, nowSeconds) ||
    version === undefined ||
    previousBuildId === undefined ||
    conversation?.pendingId !== messageId
  ) {
    return { outcome: "skipped" };
  }
  const profile = await deps.store.getParticipantInfo(participantId);
  if (profile?.step !== "building" || profile.nickname === undefined) return { outcome: "skipped" };
  const nickname = profile.nickname;

  const sleep = deps.sleep ?? realSleep;
  const finish = async (outcome: ChangeBuildFinish): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await deps.store.finishChangeBuild(participantId, messageId, outcome, deps.now().toISOString());
      } catch (error) {
        if (attempt < FINISH_ATTEMPTS) {
          await sleep(FINISH_BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }
        const spent = outcome.kind === "ready" || outcome.kind === "not-ready" ? outcome.answer.usage : outcome.usage;
        try {
          if (spent !== undefined) await deps.store.addUsage(participantId, spent, deps.now().toISOString());
        } catch {
          // The original error is the one that matters.
        }
        throw error;
      }
    }
  };

  const base = { version, previousBuildId };
  let finishing = false;
  let usage: ReturnType<typeof usageOf> | undefined;
  try {
    const facts = await deps.store.getBudgetFacts(participantId);
    if (facts.settings.stopped) {
      finishing = true;
      return await hold(job, deps);
    }
    const budget = budgetOf(facts);
    if (budget.reached) {
      finishing = true;
      const applied = await finish({ kind: "over-budget", reply: BUDGET_REPLY, ...base });
      return { outcome: applied ? "over-budget" : "skipped" };
    }
    const used = facts.limits.changeRequestsUsed;
    const cap = facts.settings.changeRequestsPerPerson;
    if (used >= cap) {
      finishing = true;
      const applied = await finish({ kind: "over-limit", reply: changesUsedText(cap), ...base });
      return { outcome: applied ? "over-limit" : "skipped" };
    }
    const spec = await deps.store.getSpec(participantId, version);
    if (spec === undefined) throw Object.assign(new Error("the proposed spec is missing"), { name: "MissingSpec" });
    const check = await checkReadiness(deps.model, spec.text, signal);
    usage = check.usage;
    const answer = { prompt: message.text, modelId: deps.modelId, promptVersion: READINESS_PROMPT_VERSION, historyCount: 0, usage: check.usage };
    if (check.verdict === "unreadable") throw Object.assign(new Error("unreadable readiness answer"), { name: "UnreadableVerdict" });
    finishing = true;
    if (check.verdict === "not-ready") {
      const applied = await finish({ kind: "not-ready", reply: changeNotReadyReply(check.reasons), answer, ...base });
      return { outcome: applied ? "not-ready" : "skipped" };
    }
    if (overBudget(budget, check.usage.costUsd)) {
      const applied = await finish({ kind: "over-budget", reply: BUDGET_REPLY, usage: check.usage, ...base });
      return { outcome: applied ? "over-budget" : "skipped" };
    }
    const applied = await finish({ kind: "ready", reply: CHANGE_READY_REPLY, answer, build: { buildId, nickname, changeNumber: used + 1 }, used, cap, ...base });
    if (!applied) {
      // A condition failed (the count moved, the previous build is running again, the proposal changed): nothing was
      // written, so the tokens of the check are counted on their own.
      await deps.store.addUsage(participantId, check.usage, deps.now().toISOString()).catch(() => undefined);
      return { outcome: "skipped" };
    }
    await deps.builds.send({ buildId, participantId });
    return { outcome: "building" };
  } catch (error) {
    if (finishing) throw error;
    const applied = await finish({ kind: "failed", reply: CHANGE_FAILURE_REPLY, ...base, ...(usage === undefined ? {} : { usage }) });
    return { outcome: applied ? "failed" : "skipped", error: errorName(error) };
  }
}

/**
 * Ticket 3.6: asks for the suggested changes of a live app, once: skipped when they are stored or there is no built spec;
 * held while the global Stop is on (sent again later); no AI call once the budget is used (nothing stored, a later page
 * load asks again). An unreadable answer stores nothing (its tokens still count).
 */
export async function processSuggestionsJob(participantId: string, deps: WorkerDeps, signal?: AbortSignal): Promise<WorkerOutcome> {
  const outcome = await runSuggestions(participantId, deps, signal);
  deps.log({ event: "ai-worker", ...outcome });
  return outcome.outcome;
}

async function runSuggestions(participantId: string, deps: WorkerDeps, signal: AbortSignal | undefined): Promise<Omit<WorkerLogEntry, "event">> {
  const conversation = await deps.store.getConversation(participantId);
  if (conversation === undefined || conversation.suggestions !== undefined || conversation.approvedSpecVersion === undefined) return { outcome: "skipped" };
  const facts = await deps.store.getBudgetFacts(participantId);
  if (facts.settings.stopped) {
    await deps.held.sendSuggestions(participantId, STOP_HOLD_SECONDS);
    return { outcome: "held" };
  }
  if (budgetOf(facts).reached) return { outcome: "over-budget" };
  const spec = await deps.store.getSpec(participantId, conversation.approvedSpecVersion);
  if (spec === undefined) return { outcome: "skipped" };
  let result;
  try {
    result = await suggestChanges(deps.model, spec.text, signal);
  } catch (error) {
    return { outcome: "failed", error: errorName(error) };
  }
  const nowIso = deps.now().toISOString();
  if (result.suggestions === undefined) {
    await deps.store.addUsage(participantId, result.usage, nowIso);
    return { outcome: "failed", error: "UnreadableSuggestions" };
  }
  if (!(await deps.store.storeSuggestions(participantId, result.suggestions, result.usage, nowIso))) {
    await deps.store.addUsage(participantId, result.usage, nowIso);
    return { outcome: "skipped" };
  }
  return { outcome: "suggested" };
}
