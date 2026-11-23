// The sign-in code request's table access (ticket 1.4): GetItem and PutItem only, on ssd-workshop-data.
// The calls stay thin; the rules live in ./code-request.ts.
//
// The function's role may only touch `EMAIL#*` partitions, and PutItem may only write the attribute
// names of the CODE and CODE_REQUESTS items (infra/lib/api-stack.ts). An allow-list entry counts
// only when it has an `email` attribute, which this role cannot write.
import {
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type PutItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { allowListKey, codeKey, codeRequestsKey, type ItemKey } from "../keys.js";
import type { CodeEntry } from "../types.js";
import type { CodeRequests, SignInStore, StoredCodes } from "./code-request.js";

/** The one method of DynamoDBClient this store uses, so tests can stub it. */
export interface DynamoSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

/** The codes item as read from the table, keeping only well-formed entries (shared with the code check). */
export function codesFromItem(item: Record<string, AttributeValue>): StoredCodes {
  const codes: CodeEntry[] = (item["codes"]?.L ?? []).flatMap((v) => {
    const codeHash = v.M?.["codeHash"]?.S;
    const expiresAt = Number(v.M?.["expiresAt"]?.N);
    return codeHash !== undefined && Number.isFinite(expiresAt) ? [{ codeHash, expiresAt }] : [];
  });
  return { codes, attempts: Number(item["attempts"]?.N ?? "0"), version: Number(item["version"]?.N ?? "0") };
}

export class DynamoSignInStore implements SignInStore {
  constructor(
    private readonly client: DynamoSender,
    private readonly tableName: string,
  ) {}

  async isAllowListed(email: string): Promise<boolean> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(allowListKey(email)),
        ProjectionExpression: "#email",
        ExpressionAttributeNames: { "#email": "email" },
      }),
    );
    return output.Item?.["email"]?.S !== undefined;
  }

  async getCodeRequests(email: string): Promise<CodeRequests | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(codeRequestsKey(email)), ConsistentRead: true }),
    );
    const item = output.Item;
    if (item === undefined) return undefined;
    const sentAt = (item["sentAt"]?.L ?? []).map((v) => Number(v.N)).filter((n) => Number.isFinite(n));
    return { sentAt, version: Number(item["version"]?.N ?? "0") };
  }

  async putCodeRequests(
    email: string,
    sentAt: number[],
    expiresAt: number,
    expectedVersion: number | undefined,
  ): Promise<boolean> {
    return this.putVersioned(
      {
        ...keyOf(codeRequestsKey(email)),
        type: str("code-requests"),
        sentAt: { L: sentAt.map(num) },
        version: num((expectedVersion ?? 0) + 1),
        expiresAt: num(expiresAt),
      },
      expectedVersion,
    );
  }

  async getCode(email: string): Promise<StoredCodes | undefined> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(codeKey(email)), ConsistentRead: true }),
    );
    return output.Item === undefined ? undefined : codesFromItem(output.Item);
  }

  async putCode(
    email: string,
    codes: StoredCodes,
    expiresAt: number,
    expectedVersion: number | undefined,
  ): Promise<boolean> {
    return this.putVersioned(
      {
        ...keyOf(codeKey(email)),
        type: str("code"),
        codes: { L: codes.codes.map((c) => ({ M: { codeHash: str(c.codeHash), expiresAt: num(c.expiresAt) } })) },
        attempts: num(codes.attempts),
        version: num((expectedVersion ?? 0) + 1),
        expiresAt: num(expiresAt),
      },
      expectedVersion,
    );
  }

  /** PutItem if the item is still at `expectedVersion` (undefined: absent); false on a conflict. */
  private async putVersioned(item: Record<string, AttributeValue>, expectedVersion: number | undefined): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: item,
          ...(expectedVersion === undefined
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : {
                ConditionExpression: "#version = :expected",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: { ":expected": num(expectedVersion) },
              }),
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}
