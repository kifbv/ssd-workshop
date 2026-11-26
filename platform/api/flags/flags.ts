// A facilitator's decision on a flagged message (ticket 1.7's `npm run flags -- approve|reject`, ticket 3.10's dashboard
// Approve and Reject): one rule for both, so the dashboard's buttons do exactly what the command did.
//
// Approve: the flagged message goes back to `pending`, approved for its text (the SHA-256 stored as `approvedTextHash`,
// an attribute only the facilitator function and the owner's own credentials may write), and the conversation is open
// again with it in flight, in one transaction; then the job goes to the AI queue and the worker answers it without a new
// guardrail check (only while the message's text still has that hash). Reject: the message is declined with the
// guardrail's polite sentence (its suggestion, or the default) and the participant can write again.
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { declineReply } from "../conversation/guardrail.js";
import { textHash, type ConversationStore, type MessageQueue } from "../conversation/state.js";
import { conditionFailed, DynamoConversationStore, setItem, type ConversationSender } from "../conversation/store.js";
import { conversationKey, messageKey } from "../keys.js";

/** What a flag decision needs of the table. */
export interface FlagDecisionStore extends Pick<ConversationStore, "getConversation" | "getMessage" | "finish"> {
  /**
   * The flagged message goes back to pending, approved for the given text (`approvedTextHash`), and the conversation is
   * open again with it in flight, in one transaction. False when it was no longer flagged or no longer waiting.
   */
  approve(participantId: string, messageId: string, text: string, nowSeconds: number, nowIso: string): Promise<boolean>;
}

/**
 * How a decision ended: `approved` (and queued), `approved-not-queued` (stored, but the AI queue refused the job: the
 * message goes stale within 20 minutes and the participant can send it again), `rejected`, `nothing-waiting` (no flagged
 * message waits), `decided-meanwhile` (someone else decided first; nothing changed).
 */
export type FlagDecision =
  | { outcome: "approved" | "rejected" | "nothing-waiting" | "decided-meanwhile" }
  | { outcome: "approved-not-queued"; error: unknown };

export interface FlagDecisionDeps {
  store: FlagDecisionStore;
  /** The AI worker's queue (created only when an approval needs it). */
  queue: () => MessageQueue;
  now: () => Date;
}

/** The participant's waiting flagged message, if one waits for a decision. */
export async function waitingFlag(store: Pick<ConversationStore, "getConversation" | "getMessage">, participantId: string) {
  const conversation = await store.getConversation(participantId);
  const messageId = conversation?.pendingId;
  if (conversation?.state !== "waiting" || messageId === undefined) return undefined;
  const message = await store.getMessage(participantId, messageId);
  return message?.status === "flagged" ? { messageId, message } : undefined;
}

/** Approve or Reject the participant's waiting flagged message. */
export async function decideFlag(participantId: string, decision: "approve" | "reject", deps: FlagDecisionDeps): Promise<FlagDecision> {
  const waiting = await waitingFlag(deps.store, participantId);
  if (waiting === undefined) return { outcome: "nothing-waiting" };
  const { messageId, message } = waiting;
  const now = deps.now();
  if (decision === "reject") {
    const done = await deps.store.finish(participantId, messageId, { kind: "declined", reply: declineReply(message.suggestion) }, "flagged", now.toISOString());
    return { outcome: done ? "rejected" : "decided-meanwhile" };
  }
  if (!(await deps.store.approve(participantId, messageId, message.text, Math.floor(now.getTime() / 1000), now.toISOString()))) {
    return { outcome: "decided-meanwhile" };
  }
  try {
    await deps.queue().send({ participantId, messageId });
  } catch (error) {
    return { outcome: "approved-not-queued", error };
  }
  return { outcome: "approved" };
}

/** The conversation store plus the approval transaction (DynamoDB). */
export class DynamoFlagDecisions extends DynamoConversationStore implements FlagDecisionStore {
  constructor(
    private readonly decisionSender: ConversationSender,
    private readonly decisionTable: string,
  ) {
    super(decisionSender, decisionTable);
  }

  async approve(participantId: string, messageId: string, text: string, nowSeconds: number, nowIso: string): Promise<boolean> {
    try {
      await this.decisionSender.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(
              this.decisionTable,
              messageKey(participantId, messageId),
              { status: { S: "pending" }, approvedTextHash: { S: textHash(text) }, pendingSince: { N: String(nowSeconds) } },
              { expression: "#status = :flagged", values: { ":flagged": { S: "flagged" } } },
            ),
            setItem(
              this.decisionTable,
              conversationKey(participantId),
              { state: { S: "open" }, pendingSince: { N: String(nowSeconds) }, updatedAt: { S: nowIso } },
              {
                expression: "#state = :waiting AND #pendingId = :messageId",
                names: { "#pendingId": "pendingId" },
                values: { ":waiting": { S: "waiting" }, ":messageId": { S: messageId } },
              },
            ),
          ],
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }
}
