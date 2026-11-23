// The AI worker (ticket 1.7): takes one job from the queue (participant id and message id), runs
// the guardrail check, then asks Claude for the answer, and stores the outcome with its tokens and
// cost in one transaction. SQS delivers at least once: a message that is no longer pending (already
// handled, or left behind and stale) is skipped, and the final write is conditional on it still
// being pending, so a job delivered twice is answered and counted once. The final write is tried
// FINISH_ATTEMPTS times; when it still fails, the tokens already spent are added to the usage on
// their own before the error is thrown (SQS then delivers the job again).
import { errorName } from "../sign-in/code-request.js";
import { answerMessage } from "./answer.js";
import { checkGuardrail, declineReply } from "./guardrail.js";
import { addUsage, usageOf, type ModelClient } from "./model.js";
import { FAILURE_REPLY, isStale, textHash, type AiJob, type ConversationStore, type Finish, type GuardrailRecord } from "./state.js";

export type WorkerOutcome = "done" | "declined" | "flagged" | "failed" | "skipped" | "invalid";

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
    // A facilitator approved this very text after a flag: no new check. A text changed since (by
    // anyone) has another hash and is checked again.
    if (message.approvedTextHash === undefined || message.approvedTextHash !== textHash(message.text)) {
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
    }
    const history = await deps.store.getHistory(participantId, messageId);
    const answer = await answerMessage(deps.model, message.step, history, message.text, signal);
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
