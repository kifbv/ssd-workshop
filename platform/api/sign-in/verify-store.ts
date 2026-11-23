// The code check's table access (ticket 1.5). The calls stay thin; the rules live in ./verify.ts.
//
// The function's role (infra/lib/api-stack.ts) may read `EMAIL#*` items, update in `EMAIL#*` only
// the attribute names `attempts`, `version` and `participantId`, delete in `EMAIL#*` (the codes
// item), update in `PARTICIPANT#*` only the profile's attribute names (never `nickname`) and put
// in `SESSION#*` only the session's. Every write here names only those attributes (tested against
// infra/lib/config.ts).
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type PutItemCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { allowListKey, codeKey, participantKey, sessionKey, type ItemKey } from "../keys.js";
import { isRole, isStep } from "../session/session.js";
import type { Role, Step } from "../types.js";
import type { StoredCodes } from "./code-request.js";
import { codesFromItem } from "./store.js";
import type { AllowEntry, VerifyStore } from "./verify.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface VerifySender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

/** True for a lost conditional write; any other error is passed on. */
function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export class DynamoVerifyStore implements VerifyStore {
  constructor(
    private readonly client: VerifySender,
    private readonly tableName: string,
  ) {}

  async getAllowEntry(email: string): Promise<AllowEntry | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(allowListKey(email)),
        ConsistentRead: true,
        ProjectionExpression: "#email, #group, #role, #participantId",
        ExpressionAttributeNames: { "#email": "email", "#group": "group", "#role": "role", "#participantId": "participantId" },
      }),
    );
    const item = output.Item;
    // Only the import writes `email`, so an entry without it does not count (as in the code request).
    if (item?.["email"]?.S === undefined) return undefined;
    const role = item["role"]?.S;
    const group = item["group"]?.S;
    if (!isRole(role) || group === undefined) return undefined;
    const participantId = item["participantId"]?.S;
    return participantId === undefined ? { group, role } : { group, role, participantId };
  }

  async getCode(email: string): Promise<StoredCodes | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(codeKey(email)), ConsistentRead: true }),
    );
    return output.Item === undefined ? undefined : codesFromItem(output.Item);
  }

  async setAttempts(email: string, attempts: number, expectedVersion: number): Promise<boolean> {
    return this.conditional(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: keyOf(codeKey(email)),
        UpdateExpression: "SET #attempts = :attempts, #version = :next",
        ConditionExpression: "#version = :expected",
        ExpressionAttributeNames: { "#attempts": "attempts", "#version": "version" },
        ExpressionAttributeValues: { ":attempts": num(attempts), ":next": num(expectedVersion + 1), ":expected": num(expectedVersion) },
      }),
    );
  }

  async deleteCode(email: string, expectedVersion: number): Promise<boolean> {
    return this.conditional(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: keyOf(codeKey(email)),
        ConditionExpression: "#version = :expected",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":expected": num(expectedVersion) },
      }),
    );
  }

  async linkParticipant(email: string, participantId: string): Promise<boolean> {
    // Only `participantId` changes, so the import's fields stay; never creates an entry.
    return this.conditional(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: keyOf(allowListKey(email)),
        UpdateExpression: "SET #participantId = :id",
        ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#participantId)",
        ExpressionAttributeNames: { "#pk": "pk", "#participantId": "participantId" },
        ExpressionAttributeValues: { ":id": str(participantId) },
      }),
    );
  }

  async upsertProfile(participantId: string, role: Role, group: string, nowIso: string): Promise<Step> {
    const output = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: keyOf(participantKey(participantId)),
        UpdateExpression:
          "SET #type = :type, #id = :id, #role = :role, #group = :group, #createdAt = if_not_exists(#createdAt, :now), #step = if_not_exists(#step, :first)",
        ExpressionAttributeNames: {
          "#type": "type",
          "#id": "id",
          "#role": "role",
          "#group": "group",
          "#createdAt": "createdAt",
          "#step": "step",
        },
        ExpressionAttributeValues: {
          ":type": str("participant"),
          ":id": str(participantId),
          ":role": str(role),
          ":group": str(group),
          ":now": str(nowIso),
          ":first": str("nickname"),
        },
        // Only the attributes this update names come back (no ALL_NEW, which would return any attribute).
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const step = output.Attributes?.["step"]?.S;
    if (!isStep(step)) throw new Error("profile has no valid step");
    return step;
  }

  async putSession(tokenHash: string, participantId: string, createdAtIso: string, expiresAt: number): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          ...keyOf(sessionKey(tokenHash)),
          type: str("session"),
          tokenHash: str(tokenHash),
          participantId: str(participantId),
          createdAt: str(createdAtIso),
          expiresAt: num(expiresAt),
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      }),
    );
  }

  private async conditional(command: UpdateItemCommand | DeleteItemCommand): Promise<boolean> {
    try {
      if (command instanceof UpdateItemCommand) await this.client.send(command);
      else await this.client.send(command);
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }
}
