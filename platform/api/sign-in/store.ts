// The sign-in code request's table access (ticket 1.4): GetItem and PutItem only, on ssd-workshop-data.
// The calls stay thin; the rules live in ./code-request.ts.
import {
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type PutItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { allowListKey, codeKey, codeRequestsKey, type ItemKey } from "../keys.js";
import type { CodeItem } from "../types.js";
import type { CodeRequests, SignInStore } from "./code-request.js";

/** The one method of DynamoDBClient this store uses, so tests can stub it. */
export interface DynamoSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

export class DynamoSignInStore implements SignInStore {
  constructor(
    private readonly client: DynamoSender,
    private readonly tableName: string,
  ) {}

  async isAllowListed(email: string): Promise<boolean> {
    const output = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: keyOf(allowListKey(email)), ProjectionExpression: "pk" }),
    );
    return output.Item !== undefined;
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
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            ...keyOf(codeRequestsKey(email)),
            type: str("code-requests"),
            sentAt: { L: sentAt.map(num) },
            version: num((expectedVersion ?? 0) + 1),
            expiresAt: num(expiresAt),
          },
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

  async putCode(email: string, code: Omit<CodeItem, "pk" | "sk" | "type">): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          ...keyOf(codeKey(email)),
          type: str("code"),
          codeHash: str(code.codeHash),
          expiresAt: num(code.expiresAt),
          attempts: num(code.attempts),
          createdAt: str(code.createdAt),
        },
      }),
    );
  }
}
