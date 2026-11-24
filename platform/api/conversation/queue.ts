// The hand-off from the conversation function to the AI worker (ticket 1.7): one SQS message per
// stored participant message, holding only the participant id and the message id (never the text).
// Ticket 2.7: the hand-off from the AI worker to the build launcher, holding only the build id.
import { SendMessageCommand, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import { buildJobBody, jobBody, type AiJob, type BuildJob, type BuildQueue, type MessageQueue } from "./state.js";

/** The one method of SQSClient the queue uses, so tests can stub it. */
export interface SqsSender {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
}

export class SqsMessageQueue implements MessageQueue {
  constructor(
    private readonly client: SqsSender,
    private readonly queueUrl: string,
  ) {}

  async send(job: AiJob): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: jobBody(job) }));
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
}
