// The flags command's table access (ticket 1.7): the conversation store plus the reads and the one
// write only a facilitator makes. It runs with the owner's own AWS credentials, not a Lambda role.
import {
  GetItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type QueryCommand,
  type QueryCommandOutput,
  type ScanCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { conversationKey, messageKey, nicknameKey, participantKey } from "../../api/keys.js";
import { textHash, type ConversationStore } from "../../api/conversation/state.js";
import { conditionFailed, DynamoConversationStore, setItem } from "../../api/conversation/store.js";

export interface FlagsStore extends ConversationStore {
  /** The participant id that claimed the nickname (any letter case), if any. */
  findParticipantId(nickname: string): Promise<string | undefined>;
  getNickname(participantId: string): Promise<string | undefined>;
  /** Ids of the participants whose conversation waits for a decision. */
  listWaiting(): Promise<string[]>;
  /**
   * The flagged message goes back to pending, approved for the given text: its SHA-256 is stored as
   * `approvedTextHash` (no Lambda role may write it), and the worker answers without a new check only
   * while the message's text still has that hash. The conversation is open again with it in flight.
   * False when it was no longer flagged or no longer waiting (nothing written).
   */
  approve(participantId: string, messageId: string, text: string, nowSeconds: number, nowIso: string): Promise<boolean>;
}

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface FlagsSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: ScanCommand): Promise<ScanCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });

export class DynamoFlagsStore extends DynamoConversationStore implements FlagsStore {
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

  async approve(participantId: string, messageId: string, text: string, nowSeconds: number, nowIso: string): Promise<boolean> {
    try {
      await this.sender.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            setItem(
              this.table,
              messageKey(participantId, messageId),
              { status: str("pending"), approvedTextHash: str(textHash(text)), pendingSince: num(nowSeconds) },
              { expression: "#status = :flagged", values: { ":flagged": str("flagged") } },
            ),
            setItem(
              this.table,
              conversationKey(participantId),
              { state: str("open"), pendingSince: num(nowSeconds), updatedAt: str(nowIso) },
              {
                expression: "#state = :waiting AND #pendingId = :messageId",
                names: { "#pendingId": "pendingId" },
                values: { ":waiting": str("waiting"), ":messageId": str(messageId) },
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
