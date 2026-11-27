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
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { DynamoAppTokenStore, REMOVED_ROLE as REMOVED_PROFILE_ROLE } from "../../api/app-token/store.js";
import type { EditLinkStore } from "../../api/app-token/token.js";
import { allowListKey, participantKey } from "../../api/keys.js";
import type { Role } from "../../api/types.js";
import type { GroupRole } from "./logic.js";

export interface AllowListInput {
  /** Trimmed and lower-cased. */
  email: string;
  group: string;
  role: Role;
}

/**
 * The role a profile gets when its allow-list entry is removed (ticket 3.10): not a Role, so the dashboard (rows with role
 * `participant` only) drops the person and no facilitator action reaches them; their session already stopped working.
 */
export const REMOVED_ROLE = REMOVED_PROFILE_ROLE;

export interface AllowListStore {
  /**
   * Adds the person, or updates group and role of an existing entry (createdAt and participantId are kept). An entry
   * already linked to a participant (`participantId`, set at the first sign-in) also gets the profile's `group` and
   * `role` updated, so the dashboard follows the allow-list without waiting for the next sign-in (ticket 3.10).
   */
  upsert(entry: AllowListInput): Promise<"added" | "updated">;
  /** Group and role of every entry; the addresses are not read. */
  listAll(): Promise<GroupRole[]>;
  /** True when this (normalized) address has an entry; reads only the key (consistent read). */
  exists(email: string): Promise<boolean>;
  /**
   * Deletes this address's entry (`removed` false when there was none). A linked profile gets the role REMOVED_ROLE
   * (ticket 3.10), and the edit link of the linked participant's app is deleted (ticket 3.26: `editLinkDeleted`);
   * nothing else is touched.
   */
  remove(email: string): Promise<RemoveResult>;
}

export interface RemoveResult {
  removed: boolean;
  /** Ticket 3.26: whether the linked participant's app had an edit link, now deleted (false without a link). */
  editLinkDeleted: boolean;
}

/** The one method of DynamoDBClient this store uses, so tests can stub it. */
export interface DynamoSender {
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  send(command: ScanCommand): Promise<ScanCommandOutput>;
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });
const isConditionFailed = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";

export class DynamoAllowListStore implements AllowListStore {
  private readonly tokens: Pick<EditLinkStore, "deleteEditLink">;

  constructor(
    private readonly client: DynamoSender,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
    tokens?: Pick<EditLinkStore, "deleteEditLink">,
  ) {
    this.tokens = tokens ?? new DynamoAppTokenStore(client, tableName);
  }

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
    const result = output.Attributes !== undefined && Object.keys(output.Attributes).length > 0 ? "updated" : "added";
    const participantId = await this.linkedParticipant(entry.email);
    if (participantId !== undefined) await this.updateProfile(participantId, { group: entry.group, role: entry.role });
    return result;
  }

  /** The participant id an entry is linked to (consistent read of that one attribute; the address is not read back). */
  private async linkedParticipant(email: string): Promise<string | undefined> {
    const key = allowListKey(email);
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: str(key.pk), sk: str(key.sk) },
        ProjectionExpression: "#participantId",
        ExpressionAttributeNames: { "#participantId": "participantId" },
        ConsistentRead: true,
      }),
    );
    return output.Item?.["participantId"]?.S;
  }

  /** Ticket 3.26: the linked profile's nickname (its app's name), if it has chosen one; read only, never printed. */
  private async profileNickname(participantId: string): Promise<string | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: str(participantKey(participantId).pk), sk: str(participantKey(participantId).sk) },
        ProjectionExpression: "#nickname",
        ExpressionAttributeNames: { "#nickname": "nickname" },
        ConsistentRead: true,
      }),
    );
    const nickname = output.Item?.["nickname"]?.S;
    return nickname !== undefined && /^[A-Za-z0-9-]{3,20}$/.test(nickname) ? nickname : undefined;
  }

  /** Copies group and role (or only the role) to an existing profile; a profile not created yet is left to the sign-in. */
  private async updateProfile(participantId: string, values: { group?: string; role: string }): Promise<void> {
    const key = participantKey(participantId);
    const names = Object.keys(values);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: str(key.pk), sk: str(key.sk) },
          UpdateExpression: `SET ${names.map((name) => `#${name} = :${name}`).join(", ")}`,
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk", ...Object.fromEntries(names.map((name) => [`#${name}`, name])) },
          ExpressionAttributeValues: Object.fromEntries(Object.entries(values).map(([name, value]) => [`:${name}`, str(value as string)])),
          ReturnValues: "NONE",
        }),
      );
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
    }
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

  async remove(email: string): Promise<RemoveResult> {
    const key = allowListKey(email);
    // Read the link before the entry goes (the delete itself returns no old values). The participant id is the only
    // thing read, never printed; the address itself is only the key.
    const participantId = await this.linkedParticipant(email);
    // Profile and edit link first: if the delete then fails, a second `remove` still finds the entry (and its link) and
    // finishes; the other order would leave a person off the list but still on the dashboard, or with a working edit
    // link, with nothing left to rerun.
    let editLinkDeleted = false;
    if (participantId !== undefined) {
      await this.updateProfile(participantId, { role: REMOVED_ROLE });
      // Ticket 3.26: their app's edit link stops at once. The profile is marked first, and making or renewing a link
      // checks that mark in its own transaction, so none can be made after this delete.
      const nickname = await this.profileNickname(participantId);
      if (nickname !== undefined) editLinkDeleted = await this.tokens.deleteEditLink(nickname);
    }
    try {
      // The condition tells "removed" from "there was none" without returning the old item.
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: { pk: str(key.pk), sk: str(key.sk) },
          ConditionExpression: "attribute_exists(pk)",
        }),
      );
    } catch (error) {
      if (isConditionFailed(error)) return { removed: false, editLinkDeleted };
      throw error;
    }
    return { removed: true, editLinkDeleted };
  }
}
