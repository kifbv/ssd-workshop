import { CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { UpdateItemCommand, type UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { DEPLOYER_BUILD_UPDATE_ATTRIBUTES, DEPLOYER_LIVE_UPDATE_ATTRIBUTES } from "../../../infra/lib/config.js";
import { CloudFrontCdn, DynamoDeployRecords, S3AppObjects, type CloudFrontSender, type DeployTableSender, type S3Sender } from "./aws.js";

function stub<T>(answers: (Record<string, unknown> | Error)[]): { client: T; sent: { input: unknown; constructor: unknown }[] } {
  const sent: { input: unknown; constructor: unknown }[] = [];
  const client = {
    send: async (command: { input: unknown }) => {
      sent.push(command as { input: unknown; constructor: unknown });
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected call");
      if (answer instanceof Error) throw answer;
      return { $metadata: {}, ...answer };
    },
  } as unknown as T;
  return { client, sent };
}

const BUCKET = "ssd-workshop-apps-360206963848";
const TABLE = "ssd-workshop-data";
const NOW = "2026-11-24T10:00:00.000Z";

/** Every placeholder defined and used, and the top-level attribute names the update names (what IAM's `dynamodb:Attributes` sees). */
function namesOf(input: UpdateItemCommandInput): string[] {
  const text = `${input.UpdateExpression ?? ""} ${input.ConditionExpression ?? ""}`;
  const used = new Set(text.match(/[#:][A-Za-z_]+/g) ?? []);
  const defined = new Set([...Object.keys(input.ExpressionAttributeNames ?? {}), ...Object.keys(input.ExpressionAttributeValues ?? {})]);
  expect([...used].sort(), text).toEqual([...defined].sort());
  const bare = (input.ConditionExpression ?? "").match(/attribute_exists\((\w+)\)/)?.[1];
  return [...Object.keys(input.Key ?? {}), ...Object.values(input.ExpressionAttributeNames ?? {}), ...(bare ? [bare] : [])];
}

describe("S3AppObjects (ticket 2.5)", () => {
  it("puts a file with its content type and cache lifetime", async () => {
    const { client, sent } = stub<S3Sender>([{}]);
    await new S3AppObjects(client, BUCKET).put("apps/ada/index.html", new Uint8Array([1]), "text/html; charset=utf-8", "public, max-age=60");
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0]?.input).toEqual({ Bucket: BUCKET, Key: "apps/ada/index.html", Body: new Uint8Array([1]), ContentType: "text/html; charset=utf-8", CacheControl: "public, max-age=60" });
  });

  it("lists every key under the prefix, page by page", async () => {
    const { client, sent } = stub<S3Sender>([
      { Contents: [{ Key: "apps/ada/a" }, { Key: "apps/ada/b" }], IsTruncated: true, NextContinuationToken: "t1" },
      { Contents: [{ Key: "apps/ada/c" }], IsTruncated: false },
    ]);
    expect(await new S3AppObjects(client, BUCKET).list("apps/ada/")).toEqual(["apps/ada/a", "apps/ada/b", "apps/ada/c"]);
    expect(sent.every((c) => c instanceof ListObjectsV2Command)).toBe(true);
    expect(sent.map((c) => c.input)).toEqual([
      { Bucket: BUCKET, Prefix: "apps/ada/" },
      { Bucket: BUCKET, Prefix: "apps/ada/", ContinuationToken: "t1" },
    ]);
  });

  it("removes keys in batches of 1000 and fails when S3 reports a key it could not delete", async () => {
    const keys = Array.from({ length: 1500 }, (_, i) => `apps/ada/f${i}`);
    const { client, sent } = stub<S3Sender>([{}, {}]);
    await new S3AppObjects(client, BUCKET).remove(keys);
    expect(sent.every((c) => c instanceof DeleteObjectsCommand)).toBe(true);
    expect(sent.map((c) => (c.input as { Delete: { Objects: unknown[] } }).Delete.Objects.length)).toEqual([1000, 500]);
    expect((sent[0]?.input as { Delete: { Quiet: boolean } }).Delete.Quiet).toBe(true);
    const failing = stub<S3Sender>([{ Errors: [{ Key: "apps/ada/f0", Code: "AccessDenied" }] }]);
    await expect(new S3AppObjects(failing.client, BUCKET).remove(["apps/ada/f0"])).rejects.toThrow(/not deleted/);
  });
});

describe("CloudFrontCdn (ticket 2.5)", () => {
  it("invalidates the paths on the distribution", async () => {
    const { client, sent } = stub<CloudFrontSender>([{}]);
    await new CloudFrontCdn(client, "E2TOZV0ERAXKZ9").invalidate(["/apps/ada/*"], "build-1-1");
    expect(sent[0]).toBeInstanceOf(CreateInvalidationCommand);
    expect(sent[0]?.input).toEqual({
      DistributionId: "E2TOZV0ERAXKZ9",
      InvalidationBatch: { CallerReference: "build-1-1", Paths: { Quantity: 1, Items: ["/apps/ada/*"] } },
    });
  });
});

describe("DynamoDeployRecords (ticket 2.5)", () => {
  const conditionFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

  it("updates only an existing build, naming only the build attributes the deployer's role may write", async () => {
    const { client, sent } = stub<DeployTableSender>([{}, {}, {}]);
    const records = new DynamoDeployRecords(client, TABLE);
    expect(await records.startDeploy("build-1", NOW)).toBe(true);
    expect(await records.markLive("build-1", "0123456789abcdef0123456789abcdef01234567", NOW)).toBe(true);
    expect(await records.markFailed("build-1", ["index.html: no", "x"], NOW)).toBe(true);
    for (const command of sent) {
      expect(command).toBeInstanceOf(UpdateItemCommand);
      const input = command.input as UpdateItemCommandInput;
      expect(input).toMatchObject({ TableName: TABLE, Key: { pk: { S: "BUILD#build-1" }, sk: { S: "BUILD" } }, ConditionExpression: "attribute_exists(pk)", ReturnValues: "NONE" });
      for (const name of namesOf(input)) expect(DEPLOYER_BUILD_UPDATE_ATTRIBUTES, name).toContain(name);
    }
    expect((sent[0]?.input as UpdateItemCommandInput).ExpressionAttributeValues?.[":status"]).toEqual({ S: "deploying" });
    expect((sent[1]?.input as UpdateItemCommandInput).ExpressionAttributeValues).toMatchObject({ ":status": { S: "live" }, ":commit": { S: "0123456789abcdef0123456789abcdef01234567" } });
    expect((sent[2]?.input as UpdateItemCommandInput).ExpressionAttributeValues).toMatchObject({ ":status": { S: "failed" }, ":reasons": { L: [{ S: "index.html: no" }, { S: "x" }] } });
  });

  it("answers false for a build that does not exist, and passes other errors on", async () => {
    const { client } = stub<DeployTableSender>([conditionFailed(), Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" })]);
    const records = new DynamoDeployRecords(client, TABLE);
    expect(await records.startDeploy("nope", NOW)).toBe(false);
    await expect(records.markFailed("nope", [], NOW)).rejects.toThrow("x");
  });

  it("writes the live marker under APP#<lower-cased nickname>, keeping the first liveAt, naming only the marker's attributes", async () => {
    const { client, sent } = stub<DeployTableSender>([{}]);
    await new DynamoDeployRecords(client, TABLE).markAppLive("Ada-42", NOW);
    const input = sent[0]?.input as UpdateItemCommandInput;
    expect(input).toMatchObject({ TableName: TABLE, Key: { pk: { S: "APP#ada-42" }, sk: { S: "LIVE" } }, ReturnValues: "NONE" });
    expect(input.UpdateExpression).toContain("#liveAt = if_not_exists(#liveAt, :now)");
    expect(input.ExpressionAttributeValues).toEqual({ ":type": { S: "app-live" }, ":nickname": { S: "Ada-42" }, ":now": { S: NOW } });
    for (const name of namesOf(input)) expect(DEPLOYER_LIVE_UPDATE_ATTRIBUTES, name).toContain(name);
  });
});
