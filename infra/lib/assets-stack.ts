import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { ASSETS_BUCKET_NAME } from "./config.js";

/**
 * Holds the bucket the other stacks upload their file assets to. It must have no
 * file assets itself, since it creates the bucket they would go to.
 */
export class AssetsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    new Bucket(this, "AssetsBucket", {
      bucketName: ASSETS_BUCKET_NAME,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // ACLs off (the access policy denies ACL writes); the S3 default, made explicit.
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
