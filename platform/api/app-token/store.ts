// App write tokens' table access (ticket 3.24). The rules live in ./token.ts.
//
// Rights (infra/lib/api-stack.ts): the data function may only read `APPTOKEN#*` items' `app`, `nickname` and
// `expiresAt` (projection required). The participant function may put in `APPTOKEN#*` and update in `TOKENS#*` only
// the names below, read `TOKENS#*` items' `tokens` and `version`, delete in `APPTOKEN#*` (sign-out), and check that a
// `SESSION#*` item exists and that a `PARTICIPANT#*` profile is not marked removed (ConditionCheckItem, inside the create
// transaction; `pk`, `sk` and `role` only). The reset command
// (`npm run participant -- reset`) runs with the owner's own credentials. No call returns old or new items.
import {
  DeleteItemCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { appTokenKey, appTokenListKey, participantKey, sessionKey, type ItemKey } from "../keys.js";
import { APP_TOKEN_TTL_SECONDS, MAX_APP_TOKENS, type AppTokenReader, type AppTokenWriter, type CreateTokenResult, type StoredAppToken } from "./token.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface AppTokenSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  send(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>;
}

/**
 * The role a profile gets when its allow-list entry is removed (ticket 3.10, `npm run allowlist -- remove`, which
 * re-exports it): a token is never made for such a profile (ticket 3.24 try 3).
 */
export const REMOVED_ROLE = "removed";

/** Revocation reads the list again when a token was added meanwhile, this many times in all. */
export const REVOKE_ATTEMPTS = 3;

const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

/** True when a cancelled transaction failed on the condition of its item number `index`. */
function failedAt(error: unknown, index: number): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons[index]?.Code === "ConditionalCheckFailed";
}

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

  /** The participant's list (hash -> expiry, epoch seconds) and its version, or undefined when there is none. */
  private async readList(participantId: string): Promise<TokenList | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appTokenListKey(participantId)),
        ConsistentRead: true,
        ProjectionExpression: "#tokens, #version",
        ExpressionAttributeNames: { "#tokens": "tokens", "#version": "version" },
      }),
    );
    if (output.Item === undefined) return undefined;
    const tokens = new Map<string, number>();
    for (const [hash, value] of Object.entries(output.Item["tokens"]?.M ?? {})) tokens.set(hash, Number(value.N));
    const version = Number(output.Item["version"]?.N);
    return { tokens, version: Number.isSafeInteger(version) ? version : undefined };
  }

  /**
   * One transaction: the token item (only if new), its entry in the participant's list (which drops expired entries and
   * bumps the list's `version`), a check that the session still exists, and (try 3) a check that the participant's
   * profile exists and is not marked removed from the allow-list. The list's update holds only while its version is still
   * the one read (else a token was added or the list emptied meanwhile: `conflict`, the caller tries again), and is
   * refused before writing when MAX_APP_TOKENS are live; a missing session or a removed profile is `no-session` (401).
   */
  async createAppToken(participantId: string, sessionTokenHash: string, tokenHash: string, token: StoredAppToken, nowSeconds: number): Promise<CreateTokenResult> {
    const list = await this.readList(participantId);
    const entries = [...(list?.tokens ?? new Map<string, number>())];
    const expired = entries.filter(([, expiresAt]) => !(expiresAt > nowSeconds)).map(([hash]) => hash);
    if (entries.length - expired.length >= MAX_APP_TOKENS) return "too-many";
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
    const version = versionCondition(list?.version);
    const names: Record<string, string> = { "#type": "type", "#tokens": "tokens", "#expiresAt": "expiresAt", ...version.names };
    const values: Record<string, AttributeValue> = { ":type": str("app-tokens"), ":listExpiresAt": num(listExpiresAt), ...version.values };
    let set: string;
    let removed: string[] = [];
    if (list === undefined) {
      // The first token: the map is created with the item (a nested SET on a missing map fails).
      values[":tokens"] = { M: { [tokenHash]: num(token.expiresAt) } };
      set = "#tokens = :tokens";
    } else {
      names["#new"] = tokenHash;
      values[":expiresAt"] = num(token.expiresAt);
      set = "#tokens.#new = :expiresAt";
      removed = expired.map((hash, i) => {
        names[`#old${i}`] = hash;
        return `#tokens.#old${i}`;
      });
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
                UpdateExpression: `SET #type = :type, ${set}, #expiresAt = :listExpiresAt, ${version.set}${removed.length > 0 ? ` REMOVE ${removed.join(", ")}` : ""}`,
                ConditionExpression: version.condition,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
            {
              // No token once the session is gone (a sign-out that ran after this request's session check).
              ConditionCheck: {
                TableName: this.tableName,
                Key: keyOf(sessionKey(sessionTokenHash)),
                ConditionExpression: "attribute_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" },
              },
            },
            {
              // No token once the person is removed from the allow-list (try 3, access review L1): `remove` marks the
              // profile before it revokes, so a create that commits after the revocation's read meets this check.
              ConditionCheck: {
                TableName: this.tableName,
                Key: keyOf(participantKey(participantId)),
                ConditionExpression: "attribute_exists(#pk) AND #role <> :removed",
                ExpressionAttributeNames: { "#pk": "pk", "#role": "role" },
                ExpressionAttributeValues: { ":removed": str(REMOVED_ROLE) },
              },
            },
          ],
        }),
      );
      return "saved";
    } catch (error) {
      if (failedAt(error, 2) || failedAt(error, 3)) return "no-session";
      if (isConditionFailure(error)) return "conflict";
      throw error;
    }
  }

  /**
   * Deletes every listed token, then empties the list, only while its version is still the one read (a token added
   * meanwhile is read and deleted on the next pass). The list item is kept (emptied, its version bumped), so the version
   * only ever rises and a create that read the list before can never commit after. Tokens first: a failure leaves the
   * list, and a retry finishes.
   */
  async revokeAppTokens(participantId: string): Promise<number> {
    for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt += 1) {
      const list = await this.readList(participantId);
      if (list === undefined || list.tokens.size === 0) return 0;
      await Promise.all(
        [...list.tokens.keys()].map((hash) =>
          /^[0-9a-f]{64}$/.test(hash) ? this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: keyOf(appTokenKey(hash)) })) : Promise.resolve(),
        ),
      );
      const version = versionCondition(list.version);
      try {
        await this.client.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: keyOf(appTokenListKey(participantId)),
            UpdateExpression: `SET #tokens = :empty, ${version.set}`,
            ConditionExpression: version.condition,
            ExpressionAttributeNames: { "#tokens": "tokens", ...version.names },
            ExpressionAttributeValues: { ":empty": { M: {} }, ...version.values },
          }),
        );
        return list.tokens.size;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    throw new Error("app tokens kept changing during revocation");
  }
}

interface TokenList {
  tokens: Map<string, number>;
  /** Rises by one with every change of the list; undefined only before its first token. */
  version: number | undefined;
}

/** The list's version condition and its bump: equal to the one read, or absent (the first token) and then 1. */
function versionCondition(read: number | undefined): { condition: string; set: string; names: Record<string, string>; values: Record<string, AttributeValue> } {
  if (read === undefined) {
    return { condition: "attribute_not_exists(#version)", set: "#version = :nextVersion", names: { "#version": "version" }, values: { ":nextVersion": num(1) } };
  }
  return {
    condition: "#version = :version",
    set: "#version = :nextVersion",
    names: { "#version": "version" },
    values: { ":version": num(read), ":nextVersion": num(read + 1) },
  };
}
