// The deployer's AWS side (ticket 2.5): the apps bucket (S3), the distribution (CloudFront) and the
// table's build items and live markers (DynamoDB). The rules live in ./deploy.ts.
//
// The function's role (infra/lib/apps-stack.ts) may put and delete objects under `apps/*` and list the
// bucket under that prefix; invalidate the one distribution; in the table, only UpdateItem: in `APP#*`
// naming only DEPLOYER_LIVE_UPDATE_ATTRIBUTES and in `BUILD#*` only DEPLOYER_BUILD_UPDATE_ATTRIBUTES
// (infra/lib/config.ts), condition names included. No call returns attributes (ReturnValues NONE; the role
// allows only NONE, UPDATED_OLD and UPDATED_NEW). A call given a signal passes it to the SDK (`abortSignal`), so a
// phase cut off by the deployer's deadline stops its request. Ticket 3.4: once a build is marked live or failed, its
// build slot is freed (../build/slots.ts, one transaction naming SLOT_RELEASE_ATTRIBUTES); a failed release is left to
// the launcher's check.
import { CreateInvalidationCommand, type CreateInvalidationCommandOutput } from "@aws-sdk/client-cloudfront";
import {
  ConditionalCheckFailedException,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type DeleteObjectsCommandOutput,
  type ListObjectsV2CommandOutput,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { releaseSlotQuietly } from "../build/slots.js";
import { appLiveKey, buildKey, type ItemKey } from "../keys.js";
import type { AppObjects, Cdn, DeployRecords } from "./deploy.js";

/** What every `send` takes besides the command: the signal that stops the request. */
export interface SendOptions {
  abortSignal?: AbortSignal;
}

const optionsOf = (signal: AbortSignal | undefined): SendOptions => (signal === undefined ? {} : { abortSignal: signal });

/** The methods of S3Client this store uses, so tests can stub it. */
export interface S3Sender {
  send(command: PutObjectCommand, options: SendOptions): Promise<PutObjectCommandOutput>;
  send(command: ListObjectsV2Command, options: SendOptions): Promise<ListObjectsV2CommandOutput>;
  send(command: DeleteObjectsCommand, options: SendOptions): Promise<DeleteObjectsCommandOutput>;
}

/** S3 deletes at most this many keys per DeleteObjects call. */
const DELETE_BATCH = 1000;

export class S3AppObjects implements AppObjects {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
  ) {}

  async put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: cacheControl }),
      optionsOf(signal),
    );
  }

  async list(prefix: string, signal?: AbortSignal): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ...(token === undefined ? {} : { ContinuationToken: token }) }),
        optionsOf(signal),
      );
      for (const object of page.Contents ?? []) if (object.Key !== undefined) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return keys;
  }

  async remove(keys: readonly string[], signal?: AbortSignal): Promise<void> {
    for (let at = 0; at < keys.length; at += DELETE_BATCH) {
      const batch = keys.slice(at, at + DELETE_BATCH);
      const answer = await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
        optionsOf(signal),
      );
      // A key S3 could not delete is reported here, not thrown.
      if ((answer.Errors ?? []).length > 0) {
        throw Object.assign(new Error("some objects were not deleted"), { name: "DeleteObjectsError" });
      }
    }
  }
}

/** The methods of CloudFrontClient this store uses. */
export interface CloudFrontSender {
  send(command: CreateInvalidationCommand, options: SendOptions): Promise<CreateInvalidationCommandOutput>;
}

export class CloudFrontCdn implements Cdn {
  constructor(
    private readonly client: CloudFrontSender,
    private readonly distributionId: string,
  ) {}

  async invalidate(paths: readonly string[], reference: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: { CallerReference: reference, Paths: { Quantity: paths.length, Items: [...paths] } },
      }),
      optionsOf(signal),
    );
  }
}

/** The methods of DynamoDBClient this store uses. */
export interface DeployTableSender {
  send(command: UpdateItemCommand, options: SendOptions): Promise<UpdateItemCommandOutput>;
  send(command: TransactWriteItemsCommand, options?: SendOptions): Promise<TransactWriteItemsCommandOutput>;
}

const str = (value: string): AttributeValue => ({ S: value });

/** A build's last writes (live, failed) land only while it is `deploying`: never on a build already finished. */
export const FINISH_CONDITION = "attribute_exists(pk) AND #status = :deploying";
/**
 * A deploy starts only for an existing build of the message's app whose builder pushed the message's commit
 * (decision "(2.5) Deploy message", the commit binding) and that waits for its deploy.
 */
export const START_CONDITION =
  "attribute_exists(pk) AND #nickname = :nickname AND #pushedCommit = :commit AND #status IN (:queued, :building, :deploying)";
const keyOf = (key: ItemKey): Record<string, AttributeValue> => ({ pk: str(key.pk), sk: str(key.sk) });

export class DynamoDeployRecords implements DeployRecords {
  constructor(
    private readonly client: DeployTableSender,
    private readonly table: string,
  ) {}

  /** Updates an existing build only; false when the condition fails (no such build, or not in the state the update needs). */
  private async updateBuild(
    buildId: string,
    expression: string,
    names: Record<string, string>,
    values: Record<string, AttributeValue>,
    condition: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: keyOf(buildKey(buildId)),
          UpdateExpression: expression,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "NONE",
        }),
        optionsOf(signal),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || (error as { name?: unknown }).name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  /**
   * Only a build that exists, belongs to the message's app (its `nickname` equals the message's exactly, as
   * typed: DynamoDB cannot compare without case), whose builder pushed exactly the message's commit
   * (`pushedCommit`, ticket 2.8: a commit id alone does not prove it is the app's repository's) and that is
   * still waiting to be deployed (`queued`, `building`, or `deploying` on a redelivery) is marked `deploying`.
   */
  startDeploy(buildId: string, nickname: string, commit: string, nowIso: string): Promise<boolean> {
    return this.updateBuild(
      buildId,
      "SET #status = :status, #updatedAt = :now",
      { "#status": "status", "#updatedAt": "updatedAt", "#nickname": "nickname", "#pushedCommit": "pushedCommit" },
      {
        ":status": str("deploying"),
        ":now": str(nowIso),
        ":nickname": str(nickname),
        ":commit": str(commit),
        ":queued": str("queued"),
        ":building": str("building"),
        ":deploying": str("deploying"),
      },
      START_CONDITION,
    );
  }

  /** Ticket 3.4: after the build's last write, its slot is freed (exactly once, whoever frees it first). */
  private async released(buildId: string, marked: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    if (!(await marked)) return false;
    await releaseSlotQuietly(this.client, this.table, buildId, signal);
    return true;
  }

  /** Only while the build is `deploying` (FINISH_CONDITION): a late write never changes a finished build. */
  markLive(buildId: string, commit: string, nowIso: string, signal?: AbortSignal): Promise<boolean> {
    return this.released(buildId, this.updateBuild(
      buildId,
      "SET #status = :status, #updatedAt = :now, #finishedAt = :now, #deployedCommit = :commit REMOVE #failureReasons",
      { "#status": "status", "#updatedAt": "updatedAt", "#finishedAt": "finishedAt", "#deployedCommit": "deployedCommit", "#failureReasons": "failureReasons" },
      { ":status": str("live"), ":now": str(nowIso), ":commit": str(commit), ":deploying": str("deploying") },
      FINISH_CONDITION,
      signal,
    ), signal);
  }

  /** Only while the build is `deploying`, as markLive. */
  markFailed(buildId: string, reasons: readonly string[], nowIso: string): Promise<boolean> {
    return this.released(buildId, this.updateBuild(
      buildId,
      "SET #status = :status, #updatedAt = :now, #finishedAt = :now, #failureReasons = :reasons REMOVE #deployedCommit",
      { "#status": "status", "#updatedAt": "updatedAt", "#finishedAt": "finishedAt", "#failureReasons": "failureReasons", "#deployedCommit": "deployedCommit" },
      { ":status": str("failed"), ":now": str(nowIso), ":reasons": { L: reasons.map(str) }, ":deploying": str("deploying") },
      FINISH_CONDITION,
    ));
  }

  async markAppLive(nickname: string, nowIso: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: keyOf(appLiveKey(nickname)),
        UpdateExpression: "SET #type = :type, #nickname = :nickname, #liveAt = if_not_exists(#liveAt, :now)",
        ExpressionAttributeNames: { "#type": "type", "#nickname": "nickname", "#liveAt": "liveAt" },
        ExpressionAttributeValues: { ":type": str("app-live"), ":nickname": str(nickname), ":now": str(nowIso) },
        ReturnValues: "NONE",
      }),
      optionsOf(signal),
    );
  }
}
