// The AI worker (ticket 1.7): takes one job from the queue (participant id and message id), runs
// the guardrail check, then asks Claude for the answer, and stores the outcome with its tokens and
// cost in one transaction. SQS delivers at least once: a message that is no longer pending (already
// handled, or left behind and stale) is skipped, and the final write is conditional on it still
// being pending, so a job delivered twice is answered and counted once.
import { errorName } from "../sign-in/code-request.js";
import { answerMessage } from "./answer.js";
import { checkGuardrail, declineReply } from "./guardrail.js";
import { usageOf, type ModelClient } from "./model.js";
import { FAILURE_REPLY, isStale, type AiJob, type ConversationStore, type Finish, type GuardrailRecord } from "./state.js";

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
}

/**
 * Handles one job. A failure while answering (a Bedrock error, the deadline, an empty answer, the
 * history read) ends the message as failed with the neutral reply, so the participant can send
 * again at once; a failure to read the message or to write the outcome is thrown, so SQS delivers
 * the job again.
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

  const finish = async (outcome: Finish): Promise<boolean> =>
    deps.store.finish(participantId, messageId, outcome, "pending", deps.now().toISOString());

  let guardrail: GuardrailRecord | undefined;
  let finishing = false;
  try {
    // A facilitator approved this message after a flag: no new check.
    if (!message.approved) {
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
    // A failed final write is a table problem: let SQS deliver the job again.
    if (finishing) throw error;
    const applied = await finish({ kind: "failed", reply: FAILURE_REPLY, ...(guardrail === undefined ? {} : { guardrail }) });
    return { outcome: applied ? "failed" : "skipped", error: errorName(error) };
  }
}
