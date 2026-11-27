import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { AnyPrincipal, Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { slotReleaseStatements, workshopFunction } from "./api-stack.js";
import {
  ACCOUNT,
  APP_AI_TRANSCRIPTS_EXPIRY_DAYS,
  APP_AI_TRANSCRIPTS_PREFIX,
  APP_MEDIA_BUCKET_NAME,
  APP_MEDIA_KEY_PREFIX,
  APP_MEDIA_ROLE_ARN,
  APP_MEDIA_ROLE_ARN_WITHOUT_PATH,
  APPS_BUCKET_NAME,
  ATTRIBUTE_LIMITED_RETURN_VALUES,
  DEPLOY_DLQ_NAME,
  DEPLOY_QUEUE_NAME,
  DEPLOYER_BUILD_UPDATE_ATTRIBUTES,
  DEPLOYER_FUNCTION_NAME,
  DEPLOYER_LIVE_UPDATE_ATTRIBUTES,
  DEPLOYER_ROLE_ARN,
  DEPLOYER_ROLE_ARN_WITHOUT_PATH,
  DISTRIBUTION_ARN,
  TABLE_NAME,
} from "./config.js";

/** Ticket 3.25: the platform's data client, copied next to the deployer's bundled code as `workshop-data.js`. */
export const DATA_CLIENT_FILE = fileURLToPath(new URL("../../templates/basic/workshop-data.js", import.meta.url));

/** The deployer downloads, checks and uploads an app of at most 5 MB; 2 minutes leave a wide margin. */
export const DEPLOYER_TIMEOUT_SECONDS = 120;
/** Memory for the download, the unpacked archive (at most 8 MB) and the uploads. */
export const DEPLOYER_MEMORY_MB = 512;
/** Just above the deployer's timeout, so SQS delivers a crashed deploy again only once it has surely stopped. */
export const DEPLOY_QUEUE_VISIBILITY_SECONDS = DEPLOYER_TIMEOUT_SECONDS + 30;
/** Deliveries of one message; the last one marks the build failed (platform/api/settings.ts DEPLOY_MAX_RECEIVES). */
export const DEPLOY_QUEUE_MAX_RECEIVES = 3;
/** At most this many deploys at once (apps differ: a FIFO message group, one per app, runs one at a time). */
export const DEPLOYER_MAX_CONCURRENCY = 5;

/**
 * Object-changing S3 actions on the apps bucket that only the deployer's role may take (bucket policy
 * deny for every other principal, the deploy role and the Claude user included).
 */
export const APPS_OBJECT_WRITE_ACTIONS = [
  "s3:PutObject",
  "s3:PutObjectAcl",
  "s3:PutObjectVersionAcl",
  "s3:PutObjectTagging",
  "s3:PutObjectVersionTagging",
  "s3:PutObjectRetention",
  "s3:PutObjectLegalHold",
  "s3:DeleteObject",
  "s3:DeleteObjectVersion",
  "s3:DeleteObjectTagging",
  "s3:DeleteObjectVersionTagging",
  "s3:RestoreObject",
  "s3:ReplicateObject",
  "s3:ReplicateDelete",
] as const;

/**
 * Ticket 3.18: object-writing S3 actions on the media bucket that only the media function's role may take. Deletes are
 * left to identity policies, so Franck's `npm run participant -- reset` can remove an app's media; a synth test checks
 * that no other workload role may write or delete there.
 */
export const APP_MEDIA_OBJECT_WRITE_ACTIONS = [
  "s3:PutObject",
  "s3:PutObjectAcl",
  "s3:PutObjectVersionAcl",
  "s3:PutObjectTagging",
  "s3:PutObjectVersionTagging",
  "s3:PutObjectRetention",
  "s3:PutObjectLegalHold",
  "s3:RestoreObject",
  "s3:ReplicateObject",
] as const;

/**
 * Apps hosting (ticket 2.5): the private apps bucket served by CloudFront at `/apps/*` (edge stack), the
 * FIFO deploy queue and the deployer Lambda. The table is looked up by name (api stack), and the
 * distribution by its id constant: nothing crosses stacks.
 */
export class AppsStack extends Stack {
  readonly bucket: Bucket;
  readonly mediaBucket: Bucket;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.bucket = new Bucket(this, "AppsBucket", {
      bucketName: APPS_BUCKET_NAME,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Participants' published apps: kept when the stack is deleted.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Only the workshop's distribution may read objects (Origin Access Control, its exact ARN). No ListBucket: a missing key answers 403, which the distribution turns into its 404 page.
    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "CloudFrontReadOnly",
        actions: ["s3:GetObject"],
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [this.bucket.arnForObjects("*")],
        conditions: { StringEquals: { "AWS:SourceAccount": ACCOUNT, "AWS:SourceArn": DISTRIBUTION_ARN } },
      }),
    );
    // Only the deployer changes app files: every other principal (the deploy role, the Claude user, any
    // other workload role) is refused, whatever its own policy grants. Bucket settings are not covered, so
    // the deploys can still manage the bucket itself (no deny that could lock CloudFormation out); a synth test
    // checks that no workload role is granted the bucket's policy, lifecycle, website, CORS or deletion.
    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "OnlyTheDeployerWritesApps",
        effect: Effect.DENY,
        actions: [...APPS_OBJECT_WRITE_ACTIONS],
        principals: [new AnyPrincipal()],
        resources: [this.bucket.arnForObjects("*")],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": [DEPLOYER_ROLE_ARN, DEPLOYER_ROLE_ARN_WITHOUT_PATH] } },
      }),
    );

    // Ticket 3.18: photos and voice recordings that apps upload through the media API, served at `/app-media/*`.
    this.mediaBucket = new Bucket(this, "AppMediaBucket", {
      bucketName: APP_MEDIA_BUCKET_NAME,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Participants' photos and recordings: kept when the stack is deleted (reset removes an app's media).
      removalPolicy: RemovalPolicy.RETAIN,
      // Ticket 3.21: Amazon Transcribe's results, deleted once read; one left behind (an app that never asked again)
      // expires after a day.
      lifecycleRules: [{ id: "ssd-workshop-transcripts-expiry", prefix: APP_AI_TRANSCRIPTS_PREFIX, expiration: Duration.days(APP_AI_TRANSCRIPTS_EXPIRY_DAYS) }],
    });
    // The distribution reads only the served files (`app-media/`, ticket 3.21 narrowed it): never Transcribe's results.
    this.mediaBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "CloudFrontReadOnly",
        actions: ["s3:GetObject"],
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [this.mediaBucket.arnForObjects(`${APP_MEDIA_KEY_PREFIX}*`)],
        conditions: { StringEquals: { "AWS:SourceAccount": ACCOUNT, "AWS:SourceArn": DISTRIBUTION_ARN } },
      }),
    );
    // Only the media function stores files: nobody else (the deploy role and the Claude user included) can plant a
    // file that the workshop's address would then serve. Ticket 3.21: except under `transcripts/` (never served), where
    // Amazon Transcribe writes results for the AI function; there only identity policies decide (the AI function's
    // role alone is granted it, synth test), since whether Transcribe's write presents that role as `aws:PrincipalArn`
    // is not verified.
    this.mediaBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "OnlyTheMediaFunctionWrites",
        effect: Effect.DENY,
        actions: [...APP_MEDIA_OBJECT_WRITE_ACTIONS],
        principals: [new AnyPrincipal()],
        notResources: [this.mediaBucket.arnForObjects(`${APP_AI_TRANSCRIPTS_PREFIX}*`)],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": [APP_MEDIA_ROLE_ARN, APP_MEDIA_ROLE_ARN_WITHOUT_PATH] } },
      }),
    );

    // FIFO: the builder (ticket 2.8) sends each app's deploys in one message group (its lower-cased
    // nickname), so they run one at a time and in order; the deduplication id is the build id.
    const deadLetters = new Queue(this, "DeploysDlq", {
      queueName: DEPLOY_DLQ_NAME,
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const queue = new Queue(this, "Deploys", {
      queueName: DEPLOY_QUEUE_NAME,
      fifo: true,
      contentBasedDeduplication: false,
      encryption: QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(DEPLOY_QUEUE_VISIBILITY_SECONDS),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: DEPLOY_QUEUE_MAX_RECEIVES },
    });

    const deployer = workshopFunction(this, "Deployer", DEPLOYER_FUNCTION_NAME, "deployer.ts", DEPLOYER_MEMORY_MB, DEPLOYER_TIMEOUT_SECONDS, {
      beforeBundling: () => [],
      beforeInstall: () => [],
      // Ticket 3.25: every app the deployer publishes gets the platform's current workshop-data.js, which travels with
      // its code (whatever the app's repository holds).
      afterBundling: (_inputDir: string, outputDir: string) => [`cp "${DATA_CLIENT_FILE}" "${outputDir}/workshop-data.js"`],
    });
    deployer.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [this.bucket.arnForObjects("apps/*")],
      }),
    );
    deployer.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [this.bucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": ["apps/*"] } },
      }),
    );
    deployer.addToRolePolicy(
      new PolicyStatement({ effect: Effect.ALLOW, actions: ["cloudfront:CreateInvalidation"], resources: [DISTRIBUTION_ARN] }),
    );
    const tableArn = Table.fromTableName(this, "Data", TABLE_NAME).tableArn;
    deployer.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...DEPLOYER_LIVE_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": [...ATTRIBUTE_LIMITED_RETURN_VALUES] },
        },
      }),
    );
    deployer.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...DEPLOYER_BUILD_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": [...ATTRIBUTE_LIMITED_RETURN_VALUES] },
        },
      }),
    );
    // Ticket 3.4: a build that goes live or fails frees its slot.
    for (const statement of slotReleaseStatements(tableArn)) deployer.addToRolePolicy(statement);
    // One deploy per invocation; the source grants the role the consume rights on this queue only.
    deployer.addEventSource(new SqsEventSource(queue, { batchSize: 1, maxConcurrency: DEPLOYER_MAX_CONCURRENCY }));
  }
}
