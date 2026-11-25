// The participant routes' table access (ticket 1.5). The calls stay thin; the rules live in
// ./participant.ts and ../session/session.ts.
//
// The function's role (infra/lib/api-stack.ts) may read `SESSION#*` and `PARTICIPANT#*` items,
// read in `EMAIL#*` only the allow-list entry's `role`, `group` and `participantId` (ticket 3.1, never
// `email`), delete in `SESSION#*` (sign-out and removed people, ticket 3.1), update in `PARTICIPANT#*`
// only `nickname` and `step`, and put in `NICK#*` only the claim's attribute names. A transaction is
// authorized item by item as PutItem and UpdateItem. The conversation function reads sessions through
// this store too, with the same session rights.
import {
  DeleteItemCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { allowListKey, nicknameKey, participantKey, sessionKey, type ItemKey } from "../keys.js";
import { isRole, isStep, type ParticipantRecord, type SessionAllowEntry, type StoredSession } from "../session/session.js";
import type { ClaimResult, ParticipantStore } from "./participant.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface ParticipantSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
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
        ProjectionExpression: "#participantId, #expiresAt, #allowRef",
        ExpressionAttributeNames: { "#participantId": "participantId", "#expiresAt": "expiresAt", "#allowRef": "allowRef" },
      }),
    );
    const participantId = output.Item?.["participantId"]?.S;
    const expiresAt = Number(output.Item?.["expiresAt"]?.N);
    if (participantId === undefined || !Number.isFinite(expiresAt)) return undefined;
    const allowRef = output.Item?.["allowRef"]?.S;
    return { participantId, expiresAt, ...(allowRef === undefined ? {} : { allowRef }) };
  }

  async getAllowEntry(email: string): Promise<SessionAllowEntry | undefined> {
    // Consistent, so a removal or a new role applies at the very next call. Never projects `email`.
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(allowListKey(email)),
        ConsistentRead: true,
        ProjectionExpression: "#role, #group, #participantId",
        ExpressionAttributeNames: { "#role": "role", "#group": "group", "#participantId": "participantId" },
      }),
    );
    const role = output.Item?.["role"]?.S;
    const group = output.Item?.["group"]?.S;
    if (!isRole(role) || group === undefined) return undefined;
    const participantId = output.Item?.["participantId"]?.S;
    return { role, group, ...(participantId === undefined ? {} : { participantId }) };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: keyOf(sessionKey(tokenHash)) }));
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
