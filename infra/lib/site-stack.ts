import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { CfnRole, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnFunction, CfnLayerVersion, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership, type IBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { ACCOUNT, PREFIX, SITE_BUCKET_NAME } from "./config.js";

/** The placeholder page and anything else under platform/web. */
export const WEB_DIR = fileURLToPath(new URL("../../platform/web", import.meta.url));

/**
 * The private bucket behind CloudFront and the upload of the web pages into it.
 * The distribution itself lives in the edge stack (us-east-1).
 */
export class SiteStack extends Stack {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.bucket = new Bucket(this, "SiteBucket", {
      bucketName: SITE_BUCKET_NAME,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // ACLs off (the access policy denies ACL writes); the S3 default, made explicit.
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Only CloudFront distributions of this account may read objects (Origin
    // Access Control). The distribution is in another region's stack, so the
    // condition names the account's distributions instead of its exact ARN.
    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "CloudFrontReadOnly",
        actions: ["s3:GetObject"],
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [this.bucket.arnForObjects("*")],
        conditions: {
          StringEquals: { "AWS:SourceAccount": ACCOUNT },
          ArnLike: { "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/*` },
        },
      }),
    );

    const deployLogs = new LogGroup(this, "DeployLogs", {
      logGroupName: `${PREFIX}-site-deploy`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const deployment = new BucketDeployment(this, "WebPages", {
      sources: [Source.asset(WEB_DIR)],
      // Asserted to its interface: aws-cdk-lib breaks exactOptionalPropertyTypes.
      destinationBucket: this.bucket as IBucket,
      // Short browser and CloudFront lifetime: a merged change is live within
      // minutes without an invalidation.
      cacheControl: [CacheControl.setPublic(), CacheControl.maxAge(Duration.seconds(60))],
      logGroup: deployLogs,
    });

    nameDeploymentInternals(deployment, `${PREFIX}-site-deploy`);
  }
}

/**
 * BucketDeployment brings its own Lambda function, role and AWS CLI layer. The
 * access policy only allows Lambda functions and layers, and roles, named
 * `ssd-workshop-*`; CloudFormation would name the layer after its logical id,
 * so all three get explicit names here.
 */
function nameDeploymentInternals(deployment: BucketDeployment, name: string): void {
  const role = deployment.handlerRole.node.defaultChild;
  if (!(role instanceof CfnRole)) throw new Error("BucketDeployment role not found");
  role.roleName = name;

  // The handler function is the role's parent (a singleton at stack level).
  const handler = deployment.handlerRole.node.scope;
  if (!(handler instanceof LambdaFunction)) throw new Error("BucketDeployment handler not found");
  (handler.node.defaultChild as CfnFunction).functionName = name;

  const layer = deployment.node.findChild("AwsCliLayer").node.defaultChild;
  if (!(layer instanceof CfnLayerVersion)) throw new Error("BucketDeployment AWS CLI layer not found");
  layer.layerName = `${PREFIX}-awscli`;
}
