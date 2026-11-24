/**
 * The hand-over to the deployer (ticket 2.8): one message on the FIFO deploy queue `ssd-workshop-deploys.fifo`, body
 * exactly `{"buildId", "nickname", "commit"}` (decision "(2.5) Deploy message"), deduplication id the build id (a
 * second send of the same build within 5 minutes is dropped by SQS), message group the lower-cased nickname (one
 * app's deploys run one at a time, in order).
 */
import { SendMessageCommand, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import type { DeployMessage, DeployQueue } from "./runner.js";

export interface DeploySender {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
}

/** The SendMessage request for a message (exported for its test). */
export function deployRequest(queueUrl: string, message: DeployMessage): SendMessageCommand {
  return new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ buildId: message.buildId, nickname: message.nickname, commit: message.commit }),
    MessageDeduplicationId: message.buildId,
    MessageGroupId: message.nickname.toLowerCase(),
  });
}

export class SqsDeployQueue implements DeployQueue {
  constructor(
    private readonly client: DeploySender,
    private readonly queueUrl: string,
  ) {}

  async send(message: DeployMessage): Promise<void> {
    await this.client.send(deployRequest(this.queueUrl, message));
  }
}
