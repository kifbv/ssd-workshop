// App write tokens' table access (ticket 3.24). The rules live in ./token.ts.
//
// Rights (infra/lib/api-stack.ts): the data function may only read `APPTOKEN#*` items' `app`, `nickname` and
// `expiresAt` (projection required). The participant function may put in `APPTOKEN#*` and update in `TOKENS#*` only
// the names below, read `TOKENS#*` items' `tokens`, and delete in both partitions (sign-out). The reset command
// (`npm run participant -- reset`) runs with the owner's own credentials. No call returns old or new items.
import {
  DeleteItemCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { appTokenKey, appTokenListKey, type ItemKey } from "../keys.js";
import { APP_TOKEN_TTL_SECONDS, MAX_APP_TOKENS, type AppTokenReader, type AppTokenWriter, type CreateTokenResult, type StoredAppToken } from "./token.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface AppTokenSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
}

/** Revocation reads the list again when a token was added meanwhile, this many times in all. */
export const REVOKE_ATTEMPTS = 3;

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

function isConditionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  if (error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code === "ConditionalCheckFailed" || r.Code === "TransactionConflict");
}

export class DynamoAppTokenStore implements AppTokenReader, AppTokenWriter {
  constructor(
    private readonly client: AppTokenSender,
    private readonly tableName: string,
  ) {}

  async getAppToken(tokenHash: string): Promise<StoredAppToken | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appTokenKey(tokenHash)),
        // Made moments before the app's first write.
        ConsistentRead: true,
        ProjectionExpression: "#app, #nickname, #expiresAt",
        ExpressionAttributeNames: { "#app": "app", "#nickname": "nickname", "#expiresAt": "expiresAt" },
      }),
    );
    const app = output.Item?.["app"]?.S;
    const nickname = output.Item?.["nickname"]?.S;
    const expiresAt = Number(output.Item?.["expiresAt"]?.N);
    if (app === undefined || nickname === undefined || !Number.isFinite(expiresAt)) return undefined;
    return { app, nickname, expiresAt };
  }

  /** The participant's list: hash -> expiry (epoch seconds), or undefined when there is none. */
  private async readList(participantId: string): Promise<Map<string, number> | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appTokenListKey(participantId)),
        ConsistentRead: true,
        ProjectionExpression: "#tokens",
        ExpressionAttributeNames: { "#tokens": "tokens" },
      }),
    );
    const map = output.Item?.["tokens"]?.M;
    if (map === undefined) return undefined;
    const tokens = new Map<string, number>();
    for (const [hash, value] of Object.entries(map)) tokens.set(hash, Number(value.N));
    return tokens;
  }

  /**
   * One transaction: the token item (only if new) and its entry in the participant's list, which drops expired entries.
   * The list's update holds only while its size is still the one read (else another token was added or removed
   * meanwhile: `conflict`, the caller tries again), and is refused before writing when MAX_APP_TOKENS are live.
   */
  async createAppToken(participantId: string, tokenHash: string, token: StoredAppToken, nowSeconds: number): Promise<CreateTokenResult> {
    const list = await this.readList(participantId);
    const expired = [...(list ?? new Map<string, number>())].filter(([, expiresAt]) => !(expiresAt > nowSeconds)).map(([hash]) => hash);
    const live = (list?.size ?? 0) - expired.length;
    if (live >= MAX_APP_TOKENS) return "too-many";
    // The list outlives every token in it (each ends within 12 hours of being made); the table's TTL removes it.
    const listExpiresAt = nowSeconds + APP_TOKEN_TTL_SECONDS;
    const put = {
      Put: {
        TableName: this.tableName,
        Item: {
          ...keyOf(appTokenKey(tokenHash)),
          type: str("app-token"),
          app: str(token.app),
          nickname: str(token.nickname),
          createdAt: str(new Date(nowSeconds * 1000).toISOString()),
          expiresAt: num(token.expiresAt),
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    };
    const names: Record<string, string> = { "#type": "type", "#tokens": "tokens", "#expiresAt": "expiresAt" };
    const values: Record<string, AttributeValue> = { ":type": str("app-tokens"), ":listExpiresAt": num(listExpiresAt) };
    let update;
    if (list === undefined) {
      // The first token: the map is created with the item (a nested SET on a missing map fails).
      values[":tokens"] = { M: { [tokenHash]: num(token.expiresAt) } };
      update = {
        UpdateExpression: "SET #type = :type, #tokens = :tokens, #expiresAt = :listExpiresAt",
        ConditionExpression: "attribute_not_exists(#tokens)",
      };
    } else {
      names["#new"] = tokenHash;
      values[":expiresAt"] = num(token.expiresAt);
      values[":size"] = num(list.size);
      const removed = expired.map((hash, i) => {
        names[`#old${i}`] = hash;
        return `#tokens.#old${i}`;
      });
      update = {
        UpdateExpression: `SET #type = :type, #tokens.#new = :expiresAt, #expiresAt = :listExpiresAt${removed.length > 0 ? ` REMOVE ${removed.join(", ")}` : ""}`,
        ConditionExpression: "size(#tokens) = :size",
      };
    }
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            put,
            {
              Update: {
                TableName: this.tableName,
                Key: keyOf(appTokenListKey(participantId)),
                ...update,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
          ],
        }),
      );
      return "saved";
    } catch (error) {
      if (isConditionFailure(error)) return "conflict";
      throw error;
    }
  }

  /**
   * Deletes every listed token, then the list, only while it still holds as many entries as were read (a token added
   * meanwhile is read and deleted on the next pass). Tokens first: a failure leaves the list, and a retry finishes.
   */
  async revokeAppTokens(participantId: string): Promise<number> {
    for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt += 1) {
      const list = await this.readList(participantId);
      if (list === undefined) return 0;
      await Promise.all(
        [...list.keys()].map((hash) =>
          /^[0-9a-f]{64}$/.test(hash) ? this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: keyOf(appTokenKey(hash)) })) : Promise.resolve(),
        ),
      );
      try {
        await this.client.send(
          new DeleteItemCommand({
            TableName: this.tableName,
            Key: keyOf(appTokenListKey(participantId)),
            ConditionExpression: "attribute_not_exists(#pk) OR size(#tokens) = :size",
            ExpressionAttributeNames: { "#pk": "pk", "#tokens": "tokens" },
            ExpressionAttributeValues: { ":size": num(list.size) },
          }),
        );
        return list.size;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    throw new Error("app tokens kept changing during revocation");
  }
}
