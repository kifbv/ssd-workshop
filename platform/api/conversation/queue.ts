// The hand-off from the conversation function to the AI worker (ticket 1.7): one SQS message per
// stored participant message, holding only the participant id and the message id (never the text).
// Ticket 2.7: the hand-off from the AI worker to the build launcher, holding only the build id.
import { SendMessageCommand, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import { buildJobBody, jobBody, specReadJobBody, suggestionsJobBody, type AiJob, type BuildJob, type BuildQueue, type HeldJobs, type MessageQueue, type SuggestionsQueue } from "./state.js";

/** The one method of SQSClient the queue uses, so tests can stub it. */
export interface SqsSender {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
}

export class SqsMessageQueue implements MessageQueue, HeldJobs, SuggestionsQueue {
  constructor(
    private readonly client: SqsSender,
    private readonly queueUrl: string,
  ) {}

  async send(job: AiJob): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: jobBody(job) }));
  }

  /** Ticket 3.5: the same job again, delivered after `delaySeconds` (a new message: its receive count starts again). */
  async sendLater(job: AiJob, delaySeconds: number): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: jobBody(job), DelaySeconds: delaySeconds }));
  }

  /** Ticket 3.6: asks the AI worker for a participant's suggested changes (the participant id only), after an optional delay. */
  async sendSuggestions(participantId: string, delaySeconds?: number): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: suggestionsJobBody(participantId),
        ...(delaySeconds === undefined ? {} : { DelaySeconds: delaySeconds }),
      }),
    );
  }
}

/**
 * The FIFO launch queue (ticket 2.7): the build id is the deduplication id (SQS drops a re-send of the same build
 * within 5 minutes) and the participant id the message group (one participant's launches run one at a time).
 */
export class SqsBuildQueue implements BuildQueue {
  constructor(
    private readonly client: SqsSender,
    private readonly queueUrl: string,
  ) {}

  async send(job: BuildJob): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: buildJobBody(job),
        MessageDeduplicationId: job.buildId,
        MessageGroupId: job.participantId,
      }),
    );
  }

  /**
   * Ticket 3.9: the spec-read request for a Rebuild from my repository message, in the participant's message group,
   * deduplicated by its message id (a redelivered AI job sends it again; SQS drops the copy within 5 minutes).
   */
  async sendSpecRead(job: AiJob): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: specReadJobBody(job),
        MessageDeduplicationId: `spec-read-${job.messageId.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 128),
        MessageGroupId: job.participantId,
      }),
    );
  }
}
