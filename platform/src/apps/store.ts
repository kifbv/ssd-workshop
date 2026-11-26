// `npm run apps` on AWS (ticket 3.25), with the caller's own credentials: the table's live markers and the deploy queue.
// Run by Franck only (the access stack denies Claude sessions table item reads and every send to `ssd-workshop-deploys*`).
import { ScanCommand, type AttributeValue, type ScanCommandOutput } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import type { LiveApps, RefreshQueue } from "./command.js";

export interface LiveAppsSender {
  send(command: ScanCommand): Promise<ScanCommandOutput>;
}

/** The live markers (`APP#<nickname>` / `LIVE`, `type` `app-live`): their nicknames only. */
export class DynamoLiveApps implements LiveApps {
  constructor(
    private readonly client: LiveAppsSender,
    private readonly table: string,
  ) {}

  async listLiveApps(): Promise<string[]> {
    const nicknames: string[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const answer = await this.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "#type = :live AND begins_with(pk, :prefix) AND sk = :sk",
          ProjectionExpression: "#nickname",
          ExpressionAttributeNames: { "#type": "type", "#nickname": "nickname" },
          ExpressionAttributeValues: { ":live": { S: "app-live" }, ":prefix": { S: "APP#" }, ":sk": { S: "LIVE" } },
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      for (const item of answer.Items ?? []) {
        const nickname = item.nickname?.S;
        if (nickname !== undefined) nicknames.push(nickname);
      }
      start = answer.LastEvaluatedKey;
    } while (start !== undefined);
    return nicknames;
  }
}

export interface RefreshSender {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
}

export class SqsRefreshQueue implements RefreshQueue {
  constructor(
    private readonly client: RefreshSender,
    private readonly queueUrl: string,
  ) {}

  async send(nickname: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ refresh: nickname }),
        MessageGroupId: nickname.toLowerCase(),
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }
}
