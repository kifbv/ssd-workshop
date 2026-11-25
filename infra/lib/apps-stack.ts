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
 * Apps hosting (ticket 2.5): the private apps bucket served by CloudFront at `/apps/*` (edge stack), the
 * FIFO deploy queue and the deployer Lambda. The table is looked up by name (api stack), and the
 * distribution by its id constant: nothing crosses stacks.
 */
export class AppsStack extends Stack {
  readonly bucket: Bucket;

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

    const deployer = workshopFunction(this, "Deployer", DEPLOYER_FUNCTION_NAME, "deployer.ts", DEPLOYER_MEMORY_MB, DEPLOYER_TIMEOUT_SECONDS);
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
