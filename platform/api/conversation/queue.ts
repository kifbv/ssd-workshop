// The hand-off from the conversation function to the AI worker (ticket 1.7): one SQS message per
// stored participant message, holding only the participant id and the message id (never the text).
import { SendMessageCommand, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import { jobBody, type AiJob, type MessageQueue } from "./state.js";

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
