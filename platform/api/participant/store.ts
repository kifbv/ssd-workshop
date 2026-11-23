// The participant routes' table access (ticket 1.5). The calls stay thin; the rules live in
// ./participant.ts and ../session/session.ts.
//
// The function's role (infra/lib/api-stack.ts) may read `SESSION#*` and `PARTICIPANT#*` items,
// update in `PARTICIPANT#*` only `nickname` and `step`, and put in `NICK#*` only the claim's
// attribute names. A transaction is authorized item by item as PutItem and UpdateItem.
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { nicknameKey, participantKey, sessionKey, type ItemKey } from "../keys.js";
import { isRole, isStep, type ParticipantRecord, type StoredSession } from "../session/session.js";
import type { ClaimResult, ParticipantStore } from "./participant.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface ParticipantSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

/** The reasons DynamoDB gives, in item order, when it cancels a transaction. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.map((r) => r.Code);
}

export class DynamoParticipantStore implements ParticipantStore {
  constructor(
    private readonly client: ParticipantSender,
    private readonly tableName: string,
  ) {}

  async getSession(tokenHash: string): Promise<StoredSession | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(sessionKey(tokenHash)),
        // The session was written moments before the first call that uses it.
        ConsistentRead: true,
        ProjectionExpression: "#participantId, #expiresAt",
        ExpressionAttributeNames: { "#participantId": "participantId", "#expiresAt": "expiresAt" },
      }),
    );
    const participantId = output.Item?.["participantId"]?.S;
    const expiresAt = Number(output.Item?.["expiresAt"]?.N);
    if (participantId === undefined || !Number.isFinite(expiresAt)) return undefined;
    return { participantId, expiresAt };
  }

  async getParticipant(participantId: string): Promise<ParticipantRecord | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(participantKey(participantId)), ConsistentRead: true }),
    );
    const item = output.Item;
    const role = item?.["role"]?.S;
    const step = item?.["step"]?.S;
    const group = item?.["group"]?.S;
    if (item?.["id"]?.S !== participantId || !isRole(role) || !isStep(step) || group === undefined) return undefined;
    const nickname = item["nickname"]?.S;
    return { id: participantId, role, group, step, ...(nickname === undefined ? {} : { nickname }) };
  }

  async claimNickname(participantId: string, nickname: string, nowIso: string): Promise<ClaimResult> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...keyOf(nicknameKey(nickname)),
                  type: str("nick"),
                  nickname: str(nickname),
                  participantId: str(participantId),
                  createdAt: str(nowIso),
                },
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keyOf(participantKey(participantId)),
                UpdateExpression: "SET #nickname = :nickname, #step = :next",
                ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#nickname) AND #step = :current",
                ExpressionAttributeNames: { "#pk": "pk", "#nickname": "nickname", "#step": "step" },
                ExpressionAttributeValues: { ":nickname": str(nickname), ":next": str("clarify"), ":current": str("nickname") },
              },
            },
          ],
        }),
      );
      return "saved";
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes?.[1] === "ConditionalCheckFailed") return "already-set";
      if (codes?.[0] === "ConditionalCheckFailed") return "taken";
      throw error;
    }
  }
}
