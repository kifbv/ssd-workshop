import { Annotations, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  S3OriginAccessControl,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import {
  API_ORIGIN_DOMAIN,
  DOMAIN,
  HOSTED_ZONE_ID,
  HOSTED_ZONE_NAME,
  PAGES_CONTENT_SECURITY_POLICY,
  PAGES_HEADERS_POLICY_NAME,
  PAGES_HEADERS_POLICY_VERSION,
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

    // Named explicitly: CDK would generate a name outside ssd-workshop-*. Retained:
    // origin access controls have no tags, so the deploy rights can create one but
    // not change or delete it (see docs/decisions.md).
    const originAccessControl = new S3OriginAccessControl(this, "OriginAccessControl", {
      originAccessControlName: `${PREFIX}-site`,
    });
    originAccessControl.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // Ticket 1.6: the pages have scripts now, so they get a Content-Security-Policy, which needs
    // a custom policy (the managed SecurityHeadersPolicy has none). It keeps the managed policy's
    // headers (HSTS one year, nosniff, frame and referrer). Retained like the origin access
    // control: custom policies have no tags, so the deploy rights can create but not change or
    // delete one; a change needs a new PAGES_HEADERS_POLICY_VERSION, which is also in the
    // construct id, so CloudFormation replaces the policy instead of updating it.
    const pagesHeaders = new ResponseHeadersPolicy(this, `PagesHeadersV${PAGES_HEADERS_POLICY_VERSION}`, {
      responseHeadersPolicyName: PAGES_HEADERS_POLICY_NAME,
      comment: `${PREFIX} pages: security headers and Content-Security-Policy`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: PAGES_CONTENT_SECURITY_POLICY, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, preload: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });
    pagesHeaders.applyRemovalPolicy(RemovalPolicy.RETAIN);

    this.distribution = new Distribution(this, "Distribution", {
      comment: `${PREFIX} site`,
      domainNames: [DOMAIN],
      certificate,
      defaultRootObject: "index.html",
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket, {
          originAccessControl,
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: pagesHeaders,
      },
      // Ticket 1.2: pages and API share one origin (no CORS, no new DNS record).
      // Managed policies only, so no new untaggable resource.
      additionalBehaviors: {
        "/api/*": {
          origin: new HttpOrigin(API_ORIGIN_DOMAIN, {
            protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
          }),
          allowedMethods: AllowedMethods.ALLOW_ALL,
          // Never cache API answers; pass cookies, query strings and every
          // header except Host (API Gateway needs its own Host) to the API.
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          // HTTPS only, not a redirect: a redirect would turn a POST into a GET.
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          // JSON answers: the managed SecurityHeadersPolicy as before (no CSP needed).
          responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        },
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
