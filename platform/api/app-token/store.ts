// Edit links' table access (ticket 3.26). The rules live in ./token.ts.
//
// Rights (infra/lib/api-stack.ts): the data, media and AI functions may only read `APPTOKEN#*` items' `app`, `nickname`
// and `kind` (projection required). The conversation function (the build routes) reads `APPEDIT#*` items' `secret`,
// `secretHash` and `nickname` (projected), puts and updates `APPEDIT#*` and puts `APPTOKEN#*` items with the names
// below only, deletes in `APPTOKEN#*`, and checks the builder's profile's `role` (ConditionCheckItem in `PARTICIPANT#*`).
// The reset and the allow-list removal run with the owner's own credentials. No Lambda call returns old or new items;
// only the owner's delete, after lost races, reads back the per-app item it deleted (ALL_OLD), never printed.
import {
  DeleteItemCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { appEditKey, appTokenKey, participantKey, type ItemKey } from "../keys.js";
import { EDIT_KIND, type AppTokenReader, type EditLink, type EditLinkStore, type EditLinkWrite, type StoredAppToken } from "./token.js";

/** The methods of DynamoDBClient this store uses, so tests can stub it. */
export interface AppTokenSender {
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
  send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
}

/**
 * The role a profile gets when its allow-list entry is removed (ticket 3.10, `npm run allowlist -- remove`, which
 * re-exports it): no edit link is made or renewed for such a profile (ticket 3.24 try 3, kept by 3.26).
 */
export const REMOVED_ROLE = "removed";

/**
 * A delete reads the link again when it was renewed meanwhile, this many times in all, then deletes the per-app item
 * whatever its hash (access review try 1, L2: parallel renewals must never stop a reset).
 */
export const DELETE_ATTEMPTS = 3;

const str = (value: string): AttributeValue => ({ S: value });
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

export class DynamoAppTokenStore implements AppTokenReader, EditLinkStore {
  constructor(
    private readonly client: AppTokenSender,
    private readonly tableName: string,
  ) {}

  async getAppToken(tokenHash: string): Promise<StoredAppToken | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appTokenKey(tokenHash)),
        // A renewal deletes the old lookup item: the next write must see it gone.
        ConsistentRead: true,
        ProjectionExpression: "#app, #nickname, #kind",
        ExpressionAttributeNames: { "#app": "app", "#nickname": "nickname", "#kind": "kind" },
      }),
    );
    const app = output.Item?.["app"]?.S;
    const nickname = output.Item?.["nickname"]?.S;
    const kind = output.Item?.["kind"]?.S;
    if (app === undefined || nickname === undefined) return undefined;
    return { app, nickname, ...(kind === undefined ? {} : { kind }) };
  }

  async getEditLink(app: string): Promise<EditLink | undefined> {
    const output = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: keyOf(appEditKey(app)),
        ConsistentRead: true,
        ProjectionExpression: "#secret, #secretHash, #nickname",
        ExpressionAttributeNames: { "#secret": "secret", "#secretHash": "secretHash", "#nickname": "nickname" },
      }),
    );
    const secret = output.Item?.["secret"]?.S;
    const secretHash = output.Item?.["secretHash"]?.S;
    const nickname = output.Item?.["nickname"]?.S;
    if (secret === undefined || secretHash === undefined || nickname === undefined || !/^[0-9a-f]{64}$/.test(secretHash)) return undefined;
    return { secret, secretHash, nickname };
  }

  /** The lookup item of a link: only if absent (a 256-bit secret never repeats; the condition makes sure). */
  private lookupPut(app: string, link: EditLink, nowIso: string) {
    return {
      Put: {
        TableName: this.tableName,
        Item: {
          ...keyOf(appTokenKey(link.secretHash)),
          type: str("app-edit-token"),
          app: str(app.toLowerCase()),
          nickname: str(link.nickname),
          kind: str(EDIT_KIND),
          createdAt: str(nowIso),
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    };
  }

  /** The builder's profile exists and is not marked removed from the allow-list (`remove` marks it first). */
  private profileCheck(participantId: string) {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: keyOf(participantKey(participantId)),
        ConditionExpression: "attribute_exists(#pk) AND #role <> :removed",
        ExpressionAttributeNames: { "#pk": "pk", "#role": "role" },
        ExpressionAttributeValues: { ":removed": str(REMOVED_ROLE) },
      },
    };
  }

  async createEditLink(app: string, participantId: string, link: EditLink, nowIso: string): Promise<EditLinkWrite> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...keyOf(appEditKey(app)),
                  type: str("app-edit"),
                  app: str(app.toLowerCase()),
                  nickname: str(link.nickname),
                  secret: str(link.secret),
                  secretHash: str(link.secretHash),
                  createdAt: str(nowIso),
                },
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" },
              },
            },
            this.lookupPut(app, link, nowIso),
            this.profileCheck(participantId),
          ],
        }),
      );
      return "saved";
    } catch (error) {
      if (failedAt(error, 2)) return "removed";
      if (isConditionFailure(error)) return "exists";
      throw error;
    }
  }

  async renewEditLink(app: string, participantId: string, oldHash: string, link: EditLink, nowIso: string): Promise<EditLinkWrite> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keyOf(appEditKey(app)),
                UpdateExpression: "SET #secret = :secret, #secretHash = :secretHash, #updatedAt = :now",
                ConditionExpression: "#secretHash = :oldHash",
                ExpressionAttributeNames: { "#secret": "secret", "#secretHash": "secretHash", "#updatedAt": "updatedAt" },
                ExpressionAttributeValues: { ":secret": str(link.secret), ":secretHash": str(link.secretHash), ":now": str(nowIso), ":oldHash": str(oldHash) },
              },
            },
            this.lookupPut(app, link, nowIso),
            { Delete: { TableName: this.tableName, Key: keyOf(appTokenKey(oldHash)) } },
            this.profileCheck(participantId),
          ],
        }),
      );
      return "saved";
    } catch (error) {
      if (failedAt(error, 3)) return "removed";
      if (isConditionFailure(error)) return "changed";
      throw error;
    }
  }

  /**
   * Deletes the lookup item and the per-app item together, the latter only while its hash is the one read (a renewal
   * in between is read and deleted on the next pass). After DELETE_ATTEMPTS lost races it never gives up: the per-app
   * item goes whatever its hash (a renewal after that fails its condition), then the lookup item of the hash it held;
   * a second such pass catches a link made between the two (a make needs the per-app item gone). A link made after
   * that is a new one, made after this delete (a removed profile's make is refused; reset deletes again at its end).
   */
  async deleteEditLink(app: string): Promise<boolean> {
    for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
      const link = await this.getEditLink(app);
      if (link === undefined) return false;
      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              { Delete: { TableName: this.tableName, Key: keyOf(appTokenKey(link.secretHash)) } },
              {
                Delete: {
                  TableName: this.tableName,
                  Key: keyOf(appEditKey(app)),
                  ConditionExpression: "#secretHash = :hash",
                  ExpressionAttributeNames: { "#secretHash": "secretHash" },
                  ExpressionAttributeValues: { ":hash": str(link.secretHash) },
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    await this.deleteWhateverHash(app);
    await this.deleteWhateverHash(app);
    return true;
  }

  /** Deletes the per-app item unconditionally, then the lookup item of the hash it held (the owner's credentials only). */
  private async deleteWhateverHash(app: string): Promise<void> {
    const output = await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: keyOf(appEditKey(app)), ReturnValues: "ALL_OLD" }));
    const hash = output.Attributes?.["secretHash"]?.S;
    if (hash === undefined || !/^[0-9a-f]{64}$/.test(hash)) return;
    await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: keyOf(appTokenKey(hash)) }));
  }
}
