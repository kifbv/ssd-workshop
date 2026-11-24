import { fileURLToPath } from "node:url";
import { Annotations, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  type BehaviorOptions,
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
  APPS_BUCKET_NAME,
  APPS_BUCKET_REGIONAL_DOMAIN,
  APPS_CONTENT_SECURITY_POLICY,
  APPS_HEADERS_POLICY_NAME,
  APPS_HEADERS_POLICY_VERSION,
  APPS_INDEX_FUNCTION_NAME,
  APP_DATA_HEADERS_POLICY_NAME,
  APP_DATA_HEADERS_POLICY_VERSION,
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

/** The code of the CloudFront Function on `/apps/*` (plain JavaScript, unit-tested by evaluating it). */
export const APPS_INDEX_FUNCTION_FILE = fileURLToPath(new URL("./apps-index.js", import.meta.url));

/** How long CloudFront keeps the 404 page it shows for a missing address (S3's 403), in seconds. */
export const NOT_FOUND_CACHE_SECONDS = 60;

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

    // Ticket 2.4: the data API answers sandboxed apps (opaque origin), which can read an answer only
    // with `Access-Control-Allow-Origin`. The function sets it on its own answers, but API Gateway's
    // throttle (429) and other answers made before the function carry none, and the app would see
    // "could not be reached". This policy keeps the managed SecurityHeadersPolicy's headers and adds
    // CORS for every answer of `/api/apps/*`: any origin, never credentials, the same methods,
    // headers and max age as the function's preflight; `originOverride` replaces the function's own
    // header, so an answer never carries it twice. Retained and versioned like the pages' policy.
    const appDataHeaders = new ResponseHeadersPolicy(this, `AppDataHeadersV${APP_DATA_HEADERS_POLICY_VERSION}`, {
      responseHeadersPolicyName: APP_DATA_HEADERS_POLICY_NAME,
      comment: `${PREFIX} data API for apps: security headers and CORS for any origin`,
      corsBehavior: {
        accessControlAllowOrigins: ["*"],
        accessControlAllowCredentials: false,
        accessControlAllowMethods: ["GET", "PUT", "DELETE"],
        accessControlAllowHeaders: ["content-type", "accept"],
        accessControlMaxAge: Duration.seconds(600),
        originOverride: true,
      },
      // The managed SecurityHeadersPolicy's headers and settings, as on /api/*.
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, preload: false, override: false },
        contentTypeOptions: { override: false },
        frameOptions: { frameOption: HeadersFrameOption.SAMEORIGIN, override: false },
        xssProtection: { protection: true, modeBlock: true, override: false },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: false },
      },
    });
    appDataHeaders.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // Ticket 2.5: participants' apps at /apps/<nickname>/, from the apps bucket (apps stack, imported by
    // name like the site bucket; its policy lets this account's distributions read it) through its own
    // origin access control (retained, like the site's).
    const appsBucket = Bucket.fromBucketAttributes(this, "AppsBucket", {
      bucketName: APPS_BUCKET_NAME,
      bucketRegionalDomainName: APPS_BUCKET_REGIONAL_DOMAIN,
      region: REGION,
    });
    const appsAccessControl = new S3OriginAccessControl(this, "AppsOriginAccessControl", {
      originAccessControlName: `${PREFIX}-apps`,
    });
    appsAccessControl.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // The sandbox CSP (an app runs in an opaque origin: no platform cookies, no localStorage) with the
    // loading limits of decision "(2.3) Spec delta", nosniff (a file is only ever what its type says),
    // HSTS and the referrer policy. Overrides whatever S3 would send. Retained and versioned like the others.
    const appsHeaders = new ResponseHeadersPolicy(this, `AppsHeadersV${APPS_HEADERS_POLICY_VERSION}`, {
      responseHeadersPolicyName: APPS_HEADERS_POLICY_NAME,
      comment: `${PREFIX} apps: sandbox Content-Security-Policy and security headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: APPS_CONTENT_SECURITY_POLICY, override: true },
        contentTypeOptions: { override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, preload: false, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });
    appsHeaders.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // `/apps/<nickname>` gets its slash, an upper-case nickname its lower-case address, a folder its
    // index.html (code and tests next to this file).
    const appsIndex = new CloudFrontFunction(this, "AppsIndexFunction", {
      functionName: APPS_INDEX_FUNCTION_NAME,
      comment: `${PREFIX} apps: slash and lower-case redirects, index.html for folders`,
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromFile({ filePath: APPS_INDEX_FUNCTION_FILE }),
    });

    const apps: BehaviorOptions = {
      origin: S3BucketOrigin.withOriginAccessControl(appsBucket, { originAccessControl: appsAccessControl }),
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: appsHeaders,
      functionAssociations: [{ function: appsIndex, eventType: FunctionEventType.VIEWER_REQUEST }],
    };

    // Ticket 1.2: pages and API share one origin (no CORS, no new DNS record).
    const api: BehaviorOptions = {
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
    };

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
      // CloudFront takes the first matching pattern: the data API's comes before /api/*. Both use
      // the same origin and settings; only the headers policy differs. The apps' /apps/* (ticket 2.5)
      // never matches an /api/ path; it comes last.
      additionalBehaviors: {
        "/api/apps/*": { ...api, responseHeadersPolicy: appDataHeaders },
        "/api/*": api,
        "/apps/*": apps,
      },
      // Ticket 2.5: S3 behind an origin access control answers a missing key with 403 (CloudFront may not
      // list the bucket). Show the plain 404 page instead, with status 404, for apps and pages alike. The
      // API never answers 403 and keeps its own 404s (only 403 is replaced).
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: Duration.seconds(NOT_FOUND_CACHE_SECONDS) },
      ],
    });
    // CDK cannot add to an imported bucket's policy; the site and apps stacks do it.
    Annotations.of(this.distribution).acknowledgeWarning(
      "@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac",
      "The site stack's bucket policy grants this account's distributions read access; the apps stack's grants this distribution only (DISTRIBUTION_ARN)",
    );

    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    new ARecord(this, "AliasIPv4", { zone, recordName: `${DOMAIN}.`, target });
    new AaaaRecord(this, "AliasIPv6", { zone, recordName: `${DOMAIN}.`, target });
  }
}
