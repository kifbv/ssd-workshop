import { Annotations, Stack, type StackProps } from "aws-cdk-lib";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import {
  CachePolicy,
  Distribution,
  HttpVersion,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import {
  DOMAIN,
  HOSTED_ZONE_ID,
  HOSTED_ZONE_NAME,
  PREFIX,
  REGION,
  SITE_BUCKET_NAME,
  SITE_BUCKET_REGIONAL_DOMAIN,
} from "./config.js";

/**
 * Everything in front of the site bucket: the certificate (must be in us-east-1),
 * the CloudFront distribution and the workshop.rankly.games records. CloudFront
 * and Route53 are global, so they sit with the certificate and nothing crosses
 * regions (see docs/decisions.md).
 */
export class EdgeStack extends Stack {
  readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: HOSTED_ZONE_NAME,
    });

    const certificate = new Certificate(this, "Certificate", {
      domainName: DOMAIN,
      certificateName: `${PREFIX}-site`,
      validation: CertificateValidation.fromDns(zone),
    });

    // Imported by name: the bucket's own policy (site stack) already lets this
    // account's CloudFront distributions read it.
    const bucket = Bucket.fromBucketAttributes(this, "SiteBucket", {
      bucketName: SITE_BUCKET_NAME,
      bucketRegionalDomainName: SITE_BUCKET_REGIONAL_DOMAIN,
      region: REGION,
    });

    this.distribution = new Distribution(this, "Distribution", {
      comment: `${PREFIX} site`,
      domainNames: [DOMAIN],
      certificate,
      defaultRootObject: "index.html",
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      },
    });
    // CDK cannot add to an imported bucket's policy; the site stack does it.
    Annotations.of(this.distribution).acknowledgeWarning(
      "@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac",
      "The site stack's bucket policy grants this account's distributions read access",
    );

    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    new ARecord(this, "AliasIPv4", { zone, recordName: `${DOMAIN}.`, target });
    new AaaaRecord(this, "AliasIPv6", { zone, recordName: `${DOMAIN}.`, target });
  }
}
