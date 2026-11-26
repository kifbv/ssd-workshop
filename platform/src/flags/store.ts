// The flags command's table access (ticket 1.7): the conversation store plus the reads and the one
// write only a facilitator makes. It runs with the owner's own AWS credentials, not a Lambda role.
import {
  GetItemCommand,
  ScanCommand,
  type TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type QueryCommand,
  type QueryCommandOutput,
  type ScanCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { nicknameKey, participantKey } from "../../api/keys.js";
import type { ConversationStore } from "../../api/conversation/state.js";
import { DynamoFlagDecisions, type FlagDecisionStore } from "../../api/flags/flags.js";

export interface FlagsStore extends ConversationStore, FlagDecisionStore {
  /** The participant id that claimed the nickname (any letter case), if any. */
  findParticipantId(nickname: string): Promise<string | undefined>;
  getNickname(participantId: string): Promise<string | undefined>;
  /** Ids of the participants whose conversation waits for a decision. */
  listWaiting(): Promise<string[]>;
}

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface FlagsSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: ScanCommand): Promise<ScanCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });

/**
 * The approval transaction is the dashboard's (ticket 3.10, platform/api/flags/flags.ts DynamoFlagDecisions): the
 * message's text hash goes in `approvedTextHash`, which only the facilitator function and the owner's credentials may write.
 */
export class DynamoFlagsStore extends DynamoFlagDecisions implements FlagsStore {
  constructor(
    private readonly sender: FlagsSender,
    private readonly table: string,
  ) {
    super(sender, table);
  }

  async findParticipantId(nickname: string): Promise<string | undefined> {
    const key = nicknameKey(nickname);
    const output = await this.sender.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { pk: str(key.pk), sk: str(key.sk) },
        ProjectionExpression: "#participantId",
        ExpressionAttributeNames: { "#participantId": "participantId" },
      }),
    );
    return output.Item?.["participantId"]?.S;
  }

  async getNickname(participantId: string): Promise<string | undefined> {
    const key = participantKey(participantId);
    const output = await this.sender.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { pk: str(key.pk), sk: str(key.sk) },
        ProjectionExpression: "#nickname",
        ExpressionAttributeNames: { "#nickname": "nickname" },
      }),
    );
    return output.Item?.["nickname"]?.S;
  }

  async listWaiting(): Promise<string[]> {
    const ids: string[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const page = await this.sender.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "#type = :conversation AND #state = :waiting",
          ProjectionExpression: "#pk",
          ExpressionAttributeNames: { "#type": "type", "#state": "state", "#pk": "pk" },
          ExpressionAttributeValues: { ":conversation": str("conversation"), ":waiting": str("waiting") },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        const pk = item["pk"]?.S ?? "";
        if (pk.startsWith("PARTICIPANT#")) ids.push(pk.slice("PARTICIPANT#".length));
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
    return ids;
  }
}
