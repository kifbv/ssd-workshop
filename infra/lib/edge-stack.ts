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
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";
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
  APP_MEDIA_BUCKET_NAME,
  APP_MEDIA_BUCKET_REGIONAL_DOMAIN,
  APP_MEDIA_CONTENT_SECURITY_POLICY,
  APP_MEDIA_HEADERS_POLICY_NAME,
  APP_MEDIA_HEADERS_POLICY_VERSION,
  APP_MEDIA_PATH_PATTERN,
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
  SITE_INDEX_FUNCTION_NAME,
  WAF_API_PATH_PREFIX,
  WAF_API_RATE_LIMIT,
  WAF_API_RATE_RULE_NAME,
  WAF_BLOCK_BODY,
  WAF_BLOCK_BODY_KEY,
  WAF_BLOCK_STATUS,
  WAF_BEARER_PREFIX,
  WAF_MEDIA_API_PREFIX,
  WAF_MEDIA_API_SEGMENT,
  WAF_MEDIA_AUTH_BODY,
  WAF_MEDIA_AUTH_BODY_KEY,
  WAF_MEDIA_AUTH_METHODS,
  WAF_MEDIA_AUTH_RULE_NAME,
  WAF_MEDIA_AUTH_STATUS,
  WAF_MEDIA_PATH_PREFIX,
  WAF_MEDIA_RATE_LIMIT,
  WAF_MEDIA_RATE_RULE_NAME,
  WAF_RATE_WINDOW_SECONDS,
  WEB_ACL_NAME,
} from "./config.js";

/** The code of the CloudFront Function on `/apps/*` (plain JavaScript, unit-tested by evaluating it). */
export const APPS_INDEX_FUNCTION_FILE = fileURLToPath(new URL("./apps-index.js", import.meta.url));
/** The code of the CloudFront Function on `/facilitator*` (ticket 3.11). */
export const SITE_INDEX_FUNCTION_FILE = fileURLToPath(new URL("./site-index.js", import.meta.url));

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
        // Ticket 3.24 (policy v2): writes carry `Authorization: Bearer <app write token>`; still never credentials.
        accessControlAllowHeaders: ["content-type", "accept", "authorization"],
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

    // Ticket 3.18: photos and recordings that apps upload, at /app-media/<nickname>/<id>, from the media bucket (apps
    // stack, imported by name; its policy lets this distribution only read it) through its own origin access control
    // (retained, like the others). Each file keeps the type the media API stored (from its allow-list) and S3's
    // Cache-Control (since 3.18 try 2: a day in browsers, an hour in CloudFront, so a deleted file stops being served
    // from CloudFront within an hour).
    const mediaBucket = Bucket.fromBucketAttributes(this, "AppMediaBucket", {
      bucketName: APP_MEDIA_BUCKET_NAME,
      bucketRegionalDomainName: APP_MEDIA_BUCKET_REGIONAL_DOMAIN,
      region: REGION,
    });
    const mediaAccessControl = new S3OriginAccessControl(this, "AppMediaOriginAccessControl", {
      originAccessControlName: `${PREFIX}-app-media`,
    });
    mediaAccessControl.applyRemovalPolicy(RemovalPolicy.RETAIN);
    // nosniff (a file is only ever its stored type), HSTS, the referrer policy, and a CSP that leaves a file opened on
    // its own inert (nothing loads, sandboxed, no script). No CORS: apps show media with <img> and <audio>, which need
    // none. Retained and versioned like the others.
    const mediaHeaders = new ResponseHeadersPolicy(this, `AppMediaHeadersV${APP_MEDIA_HEADERS_POLICY_VERSION}`, {
      responseHeadersPolicyName: APP_MEDIA_HEADERS_POLICY_NAME,
      comment: `${PREFIX} app media: nosniff, inert sandbox Content-Security-Policy and security headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: APP_MEDIA_CONTENT_SECURITY_POLICY, override: true },
        contentTypeOptions: { override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, preload: false, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });
    mediaHeaders.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const media: BehaviorOptions = {
      origin: S3BucketOrigin.withOriginAccessControl(mediaBucket, { originAccessControl: mediaAccessControl }),
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: mediaHeaders,
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

    // The pages, from the site bucket.
    const site: BehaviorOptions = {
      origin: S3BucketOrigin.withOriginAccessControl(bucket, {
        originAccessControl,
      }),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: pagesHeaders,
    };

    // Ticket 3.11: the facilitator dashboard at /facilitator/ (the bucket's `facilitator/index.html`): `/facilitator`
    // gets its slash, the folder its index.html. Same origin, cache and headers as the other pages.
    const siteIndex = new CloudFrontFunction(this, "SiteIndexFunction", {
      functionName: SITE_INDEX_FUNCTION_NAME,
      comment: `${PREFIX} site: slash redirect and index.html for /facilitator/ and /app-sign-in/`,
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromFile({ filePath: SITE_INDEX_FUNCTION_FILE }),
    });

    // Ticket 3.13: AWS WAF in front of the API. A CLOUDFRONT-scope web ACL must be in us-east-1, which is why it is
    // here, next to the distribution that names it by ARN (same stack, no cross-region reference). One rule: an address
    // sending more than WAF_API_RATE_LIMIT requests to /api/* within WAF_RATE_WINDOW_SECONDS gets 429 there until its
    // count falls back under the limit; pages and apps are never counted or blocked. The path is URL-decoded first, so
    // an encoded `/%61pi/` counts too. Not WAF's default 403: the distribution's 403 -> 404 page error response would
    // turn a block into a missing page. Tagged by the app's Tags; metric names ssd-workshop-*.
    const webAcl = new CfnWebACL(this, "WebAcl", {
      name: WEB_ACL_NAME,
      scope: "CLOUDFRONT",
      description: `${PREFIX}: per-address rate limits on ${WAF_API_PATH_PREFIX} and ${WAF_MEDIA_PATH_PREFIX}, media writes need a Bearer token`,
      defaultAction: { allow: {} },
      customResponseBodies: {
        [WAF_BLOCK_BODY_KEY]: { contentType: "APPLICATION_JSON", content: WAF_BLOCK_BODY },
        [WAF_MEDIA_AUTH_BODY_KEY]: { contentType: "APPLICATION_JSON", content: WAF_MEDIA_AUTH_BODY },
      },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: WEB_ACL_NAME, sampledRequestsEnabled: true },
      rules: [
        {
          name: WAF_API_RATE_RULE_NAME,
          priority: 0,
          action: { block: { customResponse: { responseCode: WAF_BLOCK_STATUS, customResponseBodyKey: WAF_BLOCK_BODY_KEY } } },
          statement: {
            rateBasedStatement: {
              limit: WAF_API_RATE_LIMIT,
              evaluationWindowSec: WAF_RATE_WINDOW_SECONDS,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: WAF_API_PATH_PREFIX,
                  textTransformations: [{ priority: 0, type: "URL_DECODE" }],
                },
              },
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: WAF_API_RATE_RULE_NAME, sampledRequestsEnabled: true },
        },
        // Ticket 3.18: downloads of apps' media are counted apart (their own limit), so photos never block the API.
        {
          name: WAF_MEDIA_RATE_RULE_NAME,
          priority: 1,
          action: { block: { customResponse: { responseCode: WAF_BLOCK_STATUS, customResponseBodyKey: WAF_BLOCK_BODY_KEY } } },
          statement: {
            rateBasedStatement: {
              limit: WAF_MEDIA_RATE_LIMIT,
              evaluationWindowSec: WAF_RATE_WINDOW_SECONDS,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: WAF_MEDIA_PATH_PREFIX,
                  textTransformations: [{ priority: 0, type: "URL_DECODE" }],
                },
              },
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: WAF_MEDIA_RATE_RULE_NAME, sampledRequestsEnabled: true },
        },
        // Ticket 3.18 try 2: a media upload or delete without `Authorization: Bearer ...` never reaches API Gateway or
        // Lambda (a junk filter; the function still checks every token). Answered like the API's own 401, with the CORS
        // header, so an app can read the reason.
        {
          name: WAF_MEDIA_AUTH_RULE_NAME,
          priority: 2,
          action: {
            block: {
              customResponse: {
                responseCode: WAF_MEDIA_AUTH_STATUS,
                customResponseBodyKey: WAF_MEDIA_AUTH_BODY_KEY,
                responseHeaders: [{ name: "access-control-allow-origin", value: "*" }],
              },
            },
          },
          statement: {
            andStatement: {
              statements: [
                {
                  orStatement: {
                    statements: WAF_MEDIA_AUTH_METHODS.map((method) => ({
                      byteMatchStatement: { fieldToMatch: { method: {} }, positionalConstraint: "EXACTLY", searchString: method, textTransformations: [{ priority: 0, type: "NONE" }] },
                    })),
                  },
                },
                {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: "STARTS_WITH",
                    searchString: WAF_MEDIA_API_PREFIX,
                    textTransformations: [{ priority: 0, type: "URL_DECODE" }],
                  },
                },
                {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: "CONTAINS",
                    searchString: WAF_MEDIA_API_SEGMENT,
                    textTransformations: [{ priority: 0, type: "URL_DECODE" }],
                  },
                },
                {
                  notStatement: {
                    statement: {
                      byteMatchStatement: {
                        fieldToMatch: { singleHeader: { Name: "authorization" } },
                        positionalConstraint: "STARTS_WITH",
                        searchString: WAF_BEARER_PREFIX,
                        textTransformations: [{ priority: 0, type: "NONE" }],
                      },
                    },
                  },
                },
              ],
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: WAF_MEDIA_AUTH_RULE_NAME, sampledRequestsEnabled: true },
        },
      ],
    });

    this.distribution = new Distribution(this, "Distribution", {
      webAclId: webAcl.attrArn,
      comment: `${PREFIX} site`,
      domainNames: [DOMAIN],
      certificate,
      defaultRootObject: "index.html",
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: site,
      // CloudFront takes the first matching pattern: the data API's comes before /api/*. Both use
      // the same origin and settings; only the headers policy differs. The apps' /apps/* (ticket 2.5)
      // never matches an /api/ path; it comes last.
      additionalBehaviors: {
        "/api/apps/*": { ...api, responseHeadersPolicy: appDataHeaders },
        "/api/*": api,
        "/apps/*": apps,
        [APP_MEDIA_PATH_PATTERN]: media,
        "/facilitator*": { ...site, functionAssociations: [{ function: siteIndex, eventType: FunctionEventType.VIEWER_REQUEST }] },
        // Ticket 3.24: the hand-off page for saving in apps, /app-sign-in/ (top level, the pages' CSP), like the dashboard.
        "/app-sign-in*": { ...site, functionAssociations: [{ function: siteIndex, eventType: FunctionEventType.VIEWER_REQUEST }] },
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
      "The site stack's bucket policy grants this account's distributions read access; the apps stack's (apps and app media buckets) grant this distribution only (DISTRIBUTION_ARN)",
    );

    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    new ARecord(this, "AliasIPv4", { zone, recordName: `${DOMAIN}.`, target });
    new AaaaRecord(this, "AliasIPv6", { zone, recordName: `${DOMAIN}.`, target });
  }
}
