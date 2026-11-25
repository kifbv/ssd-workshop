// Where the allow-list lives: a small interface, implemented on the DynamoDB table.
// The calls stay thin; the rules live in ./logic.ts and ./command.ts.
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type ScanCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { allowListKey } from "../../api/keys.js";
import type { Role } from "../../api/types.js";
import type { GroupRole } from "./logic.js";

export interface AllowListInput {
  /** Trimmed and lower-cased. */
  email: string;
  group: string;
  role: Role;
}

export interface AllowListStore {
  /** Adds the person, or updates group and role of an existing entry (createdAt and participantId are kept). */
  upsert(entry: AllowListInput): Promise<"added" | "updated">;
  /** Group and role of every entry; the addresses are not read. */
  listAll(): Promise<GroupRole[]>;
  /** True when this (normalized) address has an entry; reads only the key (consistent read). */
  exists(email: string): Promise<boolean>;
  /** Deletes this address's entry; false when there was none. Nothing else is touched. */
  remove(email: string): Promise<boolean>;
}

/** The one method of DynamoDBClient this store uses, so tests can stub it. */
export interface DynamoSender {
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
  send(command: ScanCommand): Promise<ScanCommandOutput>;
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });

export class DynamoAllowListStore implements AllowListStore {
  constructor(
    private readonly client: DynamoSender,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsert(entry: AllowListInput): Promise<"added" | "updated"> {
    const key = allowListKey(entry.email);
    const output = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: str(key.pk), sk: str(key.sk) },
        // type, group and role are DynamoDB reserved words, hence the #names.
        UpdateExpression:
          "SET #type = :type, #email = :email, #group = :group, #role = :role, #createdAt = if_not_exists(#createdAt, :now)",
        ExpressionAttributeNames: {
          "#type": "type",
          "#email": "email",
          "#group": "group",
          "#role": "role",
          "#createdAt": "createdAt",
        },
        ExpressionAttributeValues: {
          ":type": str("allow"),
          ":email": str(entry.email),
          ":group": str(entry.group),
          ":role": str(entry.role),
          ":now": str(this.now().toISOString()),
        },
        // Old values come back only when the item already existed.
        ReturnValues: "UPDATED_OLD",
      }),
    );
    return output.Attributes !== undefined && Object.keys(output.Attributes).length > 0 ? "updated" : "added";
  }

  async listAll(): Promise<GroupRole[]> {
    const items: GroupRole[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "#type = :allow",
          ProjectionExpression: "#group, #role",
          ExpressionAttributeNames: { "#type": "type", "#group": "group", "#role": "role" },
          ExpressionAttributeValues: { ":allow": str("allow") },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        items.push({ group: item["group"]?.S ?? "", role: item["role"]?.S ?? "" });
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
    return items;
  }

  async exists(email: string): Promise<boolean> {
    const key = allowListKey(email);
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: str(key.pk), sk: str(key.sk) },
        ProjectionExpression: "pk",
        ConsistentRead: true,
      }),
    );
    return output.Item !== undefined;
  }

  async remove(email: string): Promise<boolean> {
    const key = allowListKey(email);
    try {
      // The condition tells "removed" from "there was none" without returning the old item.
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: { pk: str(key.pk), sk: str(key.sk) },
          ConditionExpression: "attribute_exists(pk)",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}
