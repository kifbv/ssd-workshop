import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { clientSettings } from "../aws.js";
import { CloudFrontCdn, DynamoDeployRecords, S3AppObjects } from "../deploy/aws.js";
import { processDeploy, type DeployDeps, type DeployLogEntry } from "../deploy/deploy.js";
import { downloadForDeployer } from "../deploy/github.js";
import { APPS_BUCKET_NAME, DISTRIBUTION_ID, REGION, TABLE_NAME } from "../settings.js";

/**
 * The deployer (ticket 2.5): one SQS record per invocation (batch size 1, FIFO queue, one message group per
 * app), holding `{ buildId, nickname, commit }`. Rules in ../deploy/deploy.ts.
 */

/** The parts of an SQS event the deployer reads. */
export interface DeployEvent {
  Records?: { body?: string; attributes?: { ApproximateReceiveCount?: string } }[];
}

/** One JSON line per message: outcome, counts, duration and an error name only. */
export function logEntry(entry: DeployLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** The part of the Lambda context the deployer reads: the time left before the runtime stops it. */
export interface DeployContext {
  getRemainingTimeInMillis(): number;
}

/**
 * The handler on given dependencies (tests pass in-memory fakes). A thrown (bare) error makes SQS deliver the
 * message again. The deadline is now (on `deps.now`) plus the context's remaining time; without a context, none.
 */
export function createHandler(deps: DeployDeps): (event: DeployEvent, context?: DeployContext) => Promise<void> {
  return async (event, context) => {
    const left = context?.getRemainingTimeInMillis();
    const deadline = typeof left === "number" && Number.isFinite(left) ? deps.now().getTime() + left : Number.POSITIVE_INFINITY;
    for (const record of event.Records ?? []) {
      const count = Number(record.attributes?.ApproximateReceiveCount ?? "1");
      await processDeploy(record.body, Number.isInteger(count) && count > 0 ? count : 1, deps, deadline);
    }
  };
}

let live: ((event: DeployEvent, context?: DeployContext) => Promise<void>) | undefined;

/** The clients are created once per Lambda instance, on first use; the region is explicit. */
export async function handler(event: DeployEvent, context?: DeployContext): Promise<void> {
  live ??= createHandler({
    download: (url, timeoutMs, signal) => downloadForDeployer(url, { timeoutMs, ...(signal === undefined ? {} : { signal }) }),
    objects: new S3AppObjects(new S3Client({
        region: REGION,
        maxAttempts: 3,
        // Uploads of up to a few MB: longer request timeouts than the API functions' (clientSettings).
        requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 20_000 }),
      }), APPS_BUCKET_NAME),
    cdn: new CloudFrontCdn(
      new CloudFrontClient({ region: "us-east-1", maxAttempts: 3, requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 10_000 }) }),
      DISTRIBUTION_ID,
    ),
    records: new DynamoDeployRecords(new DynamoDBClient(clientSettings()), TABLE_NAME),
    now: () => new Date(),
    log: logEntry,
  });
  return live(event, context);
}
