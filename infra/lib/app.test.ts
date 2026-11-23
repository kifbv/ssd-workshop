import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAssembly, CloudFormationStackArtifact } from "aws-cdk-lib/cx-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_THROTTLE,
  SIGN_IN_CODE_ROUTE_KEY,
  SIGN_IN_CODE_THROTTLE,
  SIGN_IN_VERIFY_ROUTE_KEY,
  SIGN_IN_VERIFY_THROTTLE,
  TTL_ATTRIBUTE,
  AI_QUEUE_MAX_RECEIVES,
  AI_QUEUE_VISIBILITY_SECONDS,
  AI_WORKER_TIMEOUT_SECONDS,
} from "./api-stack.js";
import { CONVERSATION_ROUTES as CONVERSATION_ROUTE_KEYS } from "../../platform/api/conversation/conversation.js";
import { buildApp } from "./app.js";
import {
  ACCOUNT,
  API_NAME,
  API_ORIGIN_DOMAIN,
  ASSETS_BUCKET_NAME,
  BOUNDARY_ARN,
  DOMAIN,
  EDGE_REGION,
  HEALTH_FUNCTION_NAME,
  HOSTED_ZONE_ID,
  IAM_PATH,
  PAGES_CONTENT_SECURITY_POLICY,
  PAGES_HEADERS_POLICY_NAME,
  SENDER_ADDRESS,
  SES_CONFIGURATION_SET,
  SIGN_IN_CODE_FUNCTION_NAME,
  SIGN_IN_VERIFY_FUNCTION_NAME,
  PARTICIPANT_FUNCTION_NAME,
  CONVERSATION_FUNCTION_NAME,
  AI_WORKER_FUNCTION_NAME,
  AI_QUEUE_NAME,
  AI_DLQ_NAME,
  REGION,
  SITE_BUCKET_NAME,
  SITE_BUCKET_REGIONAL_DOMAIN,
  STACK_NAMES,
  TABLE_NAME,
} from "./config.js";
import { PARTICIPANT_ROUTES as PARTICIPANT_ROUTE_KEYS } from "../../platform/api/participant/participant.js";
import { ANSWER_AFTER_MS } from "../../platform/api/sign-in/code-request.js";
import { WEB_BUILD_FOLDER, WEB_DIR } from "./site-stack.js";

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
}

const STACKS = [STACK_NAMES.assets, STACK_NAMES.site, STACK_NAMES.edge, STACK_NAMES.api];

/** Types that must carry the project tag in their own template (taggable in CloudFormation). */
const MUST_BE_TAGGED = [
  "AWS::S3::Bucket",
  "AWS::CloudFront::Distribution",
  "AWS::CertificateManager::Certificate",
  "AWS::Lambda::Function",
  "AWS::IAM::Role",
  "AWS::Logs::LogGroup",
  "AWS::DynamoDB::Table",
  "AWS::ApiGatewayV2::Api",
  "AWS::ApiGatewayV2::Stage",
  "AWS::SQS::Queue",
  "AWS::Lambda::EventSourceMapping",
];

/** Types CloudFormation cannot tag; anything else must be tagged or added here on purpose. */
const NOT_TAGGABLE = [
  "AWS::CDK::Metadata",
  "AWS::S3::BucketPolicy",
  "AWS::IAM::Policy",
  "AWS::Lambda::LayerVersion",
  "AWS::CloudFront::OriginAccessControl",
  "AWS::CloudFront::ResponseHeadersPolicy",
  "AWS::Route53::RecordSet",
  "Custom::CDKBucketDeployment",
  "AWS::ApiGatewayV2::Route",
  "AWS::ApiGatewayV2::Integration",
  "AWS::Lambda::Permission",
];

/**
 * Keys ending in "Name" that are not a resource's physical name, so the names
 * test skips them: DNS names, a reference to a bucket, the name of an inline
 * policy inside its (named) role, DynamoDB attribute names (`pk`, `sk`,
 * `expiresAt`) and an API stage name (`$default`, which lives inside its named
 * API). Every other "*Name" key, at any depth, is a name.
 */
const NOT_RESOURCE_NAMES = [
  "DomainName",
  "DNSName",
  "DestinationBucketName",
  "PolicyName",
  "AttributeName",
  "StageName",
];

/**
 * Per type, top-level keys that are not the resource's own name: a record's DNS
 * name, and the function a Lambda permission refers to (named on the function).
 */
const DNS_NAME_PROPERTIES: Record<string, string[]> = {
  "AWS::Route53::RecordSet": ["Name"],
  "AWS::Lambda::Permission": ["FunctionName"],
  "AWS::Lambda::EventSourceMapping": ["FunctionName"],
};

/** Every [path, value] under `value` whose key is a physical name ("Name" or "*Name"). */
function physicalNames(value: unknown, path: string, skip: string[]): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => physicalNames(v, `${path}[${i}]`, []));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, v]): [string, unknown][] => {
    const here = `${path}.${key}`;
    const isName = key.endsWith("Name") && !NOT_RESOURCE_NAMES.includes(key) && !skip.includes(key);
    return [...(isName ? [[here, v] as [string, unknown]] : []), ...physicalNames(v, here, [])];
  });
}

/** Name keys at any depth that the template must carry (proves the walk sees nested ones). */
const EXPECTED_NAME_PATHS = [
  "BucketName",
  "FunctionName",
  "RoleName",
  "LayerName",
  "LogGroupName",
  "OriginAccessControlConfig.Name",
  "TableName",
  "QueueName",
  "Name",
];

let dir: string;
let assembly: CloudAssembly;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ssd-workshop-cdk-"));
  assembly = buildApp({ outdir: dir }).synth();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stack(name: string): CloudFormationStackArtifact {
  return assembly.getStackByName(name);
}

function resources(name: string): [string, Resource][] {
  return Object.entries(stack(name).template.Resources as Record<string, Resource>);
}

function allResources(): [string, string, Resource][] {
  return STACKS.flatMap((s) => resources(s).map(([id, r]): [string, string, Resource] => [s, id, r]));
}

function ofType(type: string): [string, string, Resource][] {
  return allResources().filter(([, , r]) => r.Type === type);
}

/** Tags as a map: most types take a list of {Key, Value}, API Gateway v2 a JSON map. */
function tagsOf(r: Resource): Record<string, unknown> {
  const tags = r.Properties?.Tags as { Key: string; Value: unknown }[] | Record<string, unknown> | undefined;
  if (tags === undefined) return {};
  if (Array.isArray(tags)) return Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
  return tags;
}

describe("stacks", () => {
  it("synthesizes the assets, site and api stacks in eu-central-1 and the edge stack in us-east-1", () => {
    expect(stack(STACK_NAMES.assets).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.site).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.api).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.edge).environment).toMatchObject({ account: ACCOUNT, region: EDGE_REGION });
  });

  it("deploys assets, then site, then edge; the api stack after assets", () => {
    const deps = (name: string) => stack(name).dependencies.map((d) => d.id);
    expect(deps(STACK_NAMES.site)).toContain(STACK_NAMES.assets);
    expect(deps(STACK_NAMES.edge)).toContain(STACK_NAMES.site);
    expect(deps(STACK_NAMES.api)).toContain(STACK_NAMES.assets);
  });

  it.each(STACKS)("%s needs no CDK bootstrap (no BootstrapVersion parameter, no bootstrap roles)", (name) => {
    const s = stack(name);
    expect(s.template.Parameters?.BootstrapVersion).toBeUndefined();
    expect(s.assumeRoleArn).toBeUndefined();
    expect(s.cloudFormationExecutionRoleArn).toBeUndefined();
  });

  it("uploads only the site and api stacks' assets and templates, to our assets bucket in eu-central-1", () => {
    for (const name of [STACK_NAMES.site, STACK_NAMES.api]) {
      const s = stack(name);
      expect(s.stackTemplateAssetObjectUrl?.startsWith(`s3://${ASSETS_BUCKET_NAME}/`), name).toBe(true);
      for (const [, r] of resources(name).filter(([, r]) => r.Type === "AWS::Lambda::Function")) {
        expect((r.Properties?.Code as { S3Bucket?: unknown }).S3Bucket, name).toBe(ASSETS_BUCKET_NAME);
      }
    }
    // The assets stack creates the bucket and the edge stack is in another region,
    // so both send their template inline and must have no file assets.
    for (const name of [STACK_NAMES.assets, STACK_NAMES.edge]) {
      const s = stack(name);
      expect(s.stackTemplateAssetObjectUrl).toBeUndefined();
      expect(s.assets).toEqual([]);
      expect(s.template.Parameters ?? {}).toEqual({});
    }
  });

  it.each(STACKS)("%s carries the project=ssd-workshop stack tag", (name) => {
    expect(stack(name).tags).toEqual({ project: "ssd-workshop" });
  });
});

describe("tags, boundary and names (criterion 3)", () => {
  it("tags every taggable resource project=ssd-workshop", () => {
    for (const type of MUST_BE_TAGGED) expect(ofType(type).length, type).toBeGreaterThan(0);

    for (const [s, id, r] of allResources()) {
      if (NOT_TAGGABLE.includes(r.Type)) continue;
      expect(tagsOf(r).project, `${s}/${id} (${r.Type})`).toBe("ssd-workshop");
    }
  });

  it("gives every IAM role the /ssd-workshop/ path and the ssd-workshop-boundary permissions boundary", () => {
    const roles = ofType("AWS::IAM::Role");
    // The BucketDeployment role, which CDK creates with path "/" by default.
    expect(roles.map(([, , r]) => r.Properties?.RoleName)).toContain("ssd-workshop-site-deploy");
    for (const [s, id, r] of roles) {
      expect(r.Properties?.Path, `${s}/${id}`).toBe(IAM_PATH);
      expect(r.Properties?.PermissionsBoundary, `${s}/${id}`).toBe(BOUNDARY_ARN);
    }
    expect(IAM_PATH).toBe("/ssd-workshop/");
  });

  it("puts every IAM instance profile under the /ssd-workshop/ path", () => {
    for (const [s, id, r] of ofType("AWS::IAM::InstanceProfile")) {
      expect(r.Properties?.Path, `${s}/${id}`).toBe(IAM_PATH);
    }
  });

  it("starts every physical name, nested ones included, with ssd-workshop-", () => {
    const seen = new Set<string>();
    for (const [s, id, r] of allResources()) {
      for (const [path, value] of physicalNames(r.Properties, "", DNS_NAME_PROPERTIES[r.Type] ?? [])) {
        seen.add(path.slice(1));
        expect(value, `${s}/${id}${path}`).toMatch(/^ssd-workshop-/);
      }
    }
    for (const path of EXPECTED_NAME_PATHS) expect(seen, path).toContain(path);
  });

  it("names the Origin Access Control ssd-workshop-site", () => {
    const oacs = ofType("AWS::CloudFront::OriginAccessControl");
    expect(oacs).toHaveLength(1);
    expect(oacs[0]?.[2].Properties?.OriginAccessControlConfig).toMatchObject({ Name: "ssd-workshop-site" });
  });

  it("retains the Origin Access Control (the deploy rights cannot update or delete one)", () => {
    const oacs = ofType("AWS::CloudFront::OriginAccessControl");
    expect(oacs).toHaveLength(1);
    expect(oacs[0]?.[2]).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("names every Lambda function, layer and role explicitly (the access policy allows only ssd-workshop-*)", () => {
    const required: Record<string, string> = {
      "AWS::Lambda::Function": "FunctionName",
      "AWS::Lambda::LayerVersion": "LayerName",
      "AWS::IAM::Role": "RoleName",
      "AWS::S3::Bucket": "BucketName",
    };
    for (const [type, prop] of Object.entries(required)) {
      for (const [s, id, r] of ofType(type)) {
        expect(r.Properties?.[prop], `${s}/${id}.${prop}`).toMatch(/^ssd-workshop-/);
      }
    }
  });

  it("writes no SSM parameter (no cross-region references under /cdk/)", () => {
    expect(ofType("AWS::SSM::Parameter")).toEqual([]);
    for (const s of STACKS) {
      expect(JSON.stringify(stack(s).template)).not.toContain("/cdk/exports");
      expect(resources(s).some(([, r]) => r.Type.startsWith("Custom::CrossRegion"))).toBe(false);
    }
  });
});

describe("buckets (criterion 2)", () => {
  it("creates the assets bucket and the site bucket with their fixed names", () => {
    const names = ofType("AWS::S3::Bucket").map(([, , r]) => r.Properties?.BucketName);
    expect(names.sort()).toEqual([ASSETS_BUCKET_NAME, SITE_BUCKET_NAME].sort());
  });

  it("blocks all public access, turns ACLs off and encrypts every bucket", () => {
    for (const [s, id, r] of ofType("AWS::S3::Bucket")) {
      expect(r.Properties?.OwnershipControls, `${s}/${id}`).toEqual({
        Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
      });
      expect(r.Properties?.PublicAccessBlockConfiguration, `${s}/${id}`).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(JSON.stringify(r.Properties?.BucketEncryption)).toContain("AES256");
    }
  });

  it("lets only CloudFront of this account read the site bucket, and only over TLS", () => {
    const policies = resources(STACK_NAMES.site).filter(([, r]) => r.Type === "AWS::S3::BucketPolicy");
    expect(policies).toHaveLength(1);
    const statements = (policies[0]?.[1].Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })
      .Statement;

    const allows = statements.filter((st) => st.Effect === "Allow");
    expect(allows).toHaveLength(1);
    expect(allows[0]).toMatchObject({
      Action: "s3:GetObject",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Condition: {
        StringEquals: { "AWS:SourceAccount": ACCOUNT },
        ArnLike: { "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/*` },
      },
    });

    const denies = statements.filter((st) => st.Effect === "Deny");
    expect(denies).toEqual([
      expect.objectContaining({
        Action: "s3:*",
        Principal: { AWS: "*" },
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      }),
    ]);
  });

  it("uploads platform/web with a 60-second cache lifetime", () => {
    const [deployment] = resources(STACK_NAMES.site).filter(([, r]) => r.Type === "Custom::CDKBucketDeployment");
    expect(deployment?.[1].Properties?.SystemMetadata).toEqual({ "cache-control": "public, max-age=60" });
    expect(deployment?.[1].Properties?.DestinationBucketName).toBeDefined();
  });

  it("uploads the pages built at synth time: the page, its stylesheet and app.js, no TypeScript or tests (ticket 1.6)", () => {
    // The built folder in the assembly, and the asset CDK staged from it (same content).
    expect(readdirSync(join(dir, WEB_BUILD_FOLDER)).sort()).toEqual(["app.js", "index.html", "style.css"]);
    const staged = readdirSync(dir).filter((name) => name.startsWith("asset.") && existsSync(join(dir, name, "app.js")));
    expect(staged).toHaveLength(1);
    expect(readdirSync(join(dir, staged[0] ?? "")).sort()).toEqual(["app.js", "index.html", "style.css"]);
  });
});

describe("sign-in page (ticket 1.6)", () => {
  it("has the stable SSD Workshop heading the deploy smoke check looks for, and loads its script from a file", () => {
    const html = readFileSync(join(WEB_DIR, "index.html"), "utf8");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>SSD Workshop</title>");
    expect(html).toMatch(/<h1>SSD Workshop<\/h1>/);
    expect(html).toContain('<script src="app.js" defer></script>');
  });
});

describe("certificate, CloudFront and DNS (criteria 1, 4, 5)", () => {
  it("requests a DNS-validated certificate for workshop.rankly.games in the rankly.games zone", () => {
    const certs = ofType("AWS::CertificateManager::Certificate");
    expect(certs).toHaveLength(1);
    expect(certs[0]?.[0]).toBe(STACK_NAMES.edge);
    expect(certs[0]?.[2].Properties).toMatchObject({
      DomainName: DOMAIN,
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: DOMAIN, HostedZoneId: HOSTED_ZONE_ID }],
    });
    expect(certs[0]?.[2].Properties?.SubjectAlternativeNames).toBeUndefined();
  });

  it("serves the private bucket over HTTPS only, with the certificate and the workshop alias", () => {
    const dists = ofType("AWS::CloudFront::Distribution");
    expect(dists).toHaveLength(1);
    const config = dists[0]?.[2].Properties?.DistributionConfig as Record<string, unknown>;
    const certId = ofType("AWS::CertificateManager::Certificate")[0]?.[1];

    expect(config).toMatchObject({
      Aliases: [DOMAIN],
      DefaultRootObject: "index.html",
      PriceClass: "PriceClass_100",
      HttpVersion: "http2and3",
      DefaultCacheBehavior: {
        ViewerProtocolPolicy: "redirect-to-https",
        // Managed CachingOptimized policy.
        CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
      },
      ViewerCertificate: {
        AcmCertificateArn: { Ref: certId },
        SslSupportMethod: "sni-only",
        MinimumProtocolVersion: "TLSv1.2_2021",
      },
    });

    // Two origins: the site bucket (default) and, from ticket 1.2, the HTTP API.
    const origins = config.Origins as Record<string, unknown>[];
    expect(origins).toHaveLength(2);
    const siteOrigin = origins.find((o) => o.DomainName === SITE_BUCKET_REGIONAL_DOMAIN);
    expect(siteOrigin).toBeDefined();
    expect(siteOrigin?.OriginAccessControlId).toBeDefined();
    expect((config.DefaultCacheBehavior as Record<string, unknown>).TargetOriginId).toBe(siteOrigin?.Id);
    expect(ofType("AWS::CloudFront::OriginAccessControl")).toHaveLength(1);
  });

  it("changes only the workshop.rankly.games records (A and AAAA aliases to CloudFront)", () => {
    const records = ofType("AWS::Route53::RecordSet");
    expect(records.map(([, , r]) => r.Properties?.Type).sort()).toEqual(["A", "AAAA"]);
    for (const [s, id, r] of records) {
      expect(r.Properties?.Name, `${s}/${id}`).toBe(`${DOMAIN}.`);
      expect(r.Properties?.HostedZoneId, `${s}/${id}`).toBe(HOSTED_ZONE_ID);
      expect(JSON.stringify(r.Properties?.AliasTarget)).toContain("Distribution");
    }
    // No other Route53 resource types (zones, record groups, custom record deleters).
    const route53Types = allResources()
      .map(([, , r]) => r.Type)
      .filter((t) => t.startsWith("AWS::Route53") || t.startsWith("Custom::"));
    expect(new Set(route53Types)).toEqual(new Set(["AWS::Route53::RecordSet", "Custom::CDKBucketDeployment"]));
  });
});

describe("CloudFront /api/* behaviour (ticket 1.2 criteria 2, 3)", () => {
  const distributionConfig = (): Record<string, unknown> =>
    ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as Record<string, unknown>;
  const apiBehaviour = (): Record<string, unknown> | undefined =>
    (distributionConfig().CacheBehaviors as Record<string, unknown>[] | undefined)?.find(
      (b) => b.PathPattern === "/api/*",
    );

  it("derives the API origin domain from the live API id in eu-central-1", () => {
    expect(API_ORIGIN_DOMAIN).toBe(`ut2mzqmbb4.execute-api.${REGION}.amazonaws.com`);
  });

  it("sends /api/* to the HTTP API with managed CachingDisabled and AllViewerExceptHostHeader, all methods, HTTPS only", () => {
    const behaviours = distributionConfig().CacheBehaviors as Record<string, unknown>[];
    expect(behaviours).toHaveLength(1);
    const behaviour = apiBehaviour();
    expect(behaviour).toMatchObject({
      PathPattern: "/api/*",
      // Managed CachingDisabled.
      CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      // Managed AllViewerExceptHostHeader: cookies, query strings and headers except Host.
      OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
      // Managed SecurityHeadersPolicy, as on the pages.
      ResponseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03",
      // A redirect would turn a POST into a GET: refuse plain HTTP instead.
      ViewerProtocolPolicy: "https-only",
    });
    expect([...(behaviour?.AllowedMethods as string[])].sort()).toEqual(
      ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].sort(),
    );
    expect(behaviour?.ForwardedValues).toBeUndefined();

    const origins = distributionConfig().Origins as Record<string, unknown>[];
    const apiOrigin = origins.find((o) => o.Id === behaviour?.TargetOriginId);
    expect(apiOrigin).toMatchObject({
      DomainName: API_ORIGIN_DOMAIN,
      CustomOriginConfig: { OriginProtocolPolicy: "https-only" },
    });
    expect(apiOrigin?.OriginAccessControlId).toBeUndefined();
  });

  it("uses managed policies only (no new untaggable CloudFront resource)", () => {
    for (const type of ["AWS::CloudFront::CachePolicy", "AWS::CloudFront::OriginRequestPolicy", "AWS::CloudFront::Function"]) {
      expect(ofType(type), type).toEqual([]);
    }
    // The pages' headers policy (ticket 1.6) is the only custom CloudFront policy, and /api/*
    // keeps the managed SecurityHeadersPolicy (asserted above), not the pages' policy.
    const custom = ofType("AWS::CloudFront::ResponseHeadersPolicy");
    expect(custom).toHaveLength(1);
    expect(JSON.stringify(apiBehaviour())).not.toContain(custom[0]?.[1] ?? "-");
  });

  it("still creates exactly the A and AAAA records for workshop.rankly.games, and no other Route53 record", () => {
    const records = ofType("AWS::Route53::RecordSet");
    expect(records).toHaveLength(2);
    expect(records.every(([s]) => s === STACK_NAMES.edge)).toBe(true);
    expect(records.map(([, , r]) => `${String(r.Properties?.Type)} ${String(r.Properties?.Name)}`).sort()).toEqual([
      `A ${DOMAIN}.`,
      `AAAA ${DOMAIN}.`,
    ]);
    expect(ofType("AWS::Route53::RecordSetGroup")).toEqual([]);
    expect(ofType("AWS::Route53::HostedZone")).toEqual([]);
  });
});

describe("pages' response headers (ticket 1.6 criterion 5)", () => {
  const policies = (): [string, string, Resource][] => ofType("AWS::CloudFront::ResponseHeadersPolicy");
  const policyConfig = (): Record<string, unknown> =>
    policies()[0]?.[2].Properties?.ResponseHeadersPolicyConfig as Record<string, unknown>;
  const distributionConfig = (): Record<string, unknown> =>
    ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as Record<string, unknown>;

  it("serves the pages (default behaviour) with one custom headers policy ssd-workshop-pages-v1 in the edge stack, retained", () => {
    expect(policies()).toHaveLength(1);
    const [stackName, id, policy] = policies()[0] ?? [];
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(PAGES_HEADERS_POLICY_NAME).toBe("ssd-workshop-pages-v1");
    expect(policyConfig().Name).toBe(PAGES_HEADERS_POLICY_NAME);
    // The version is in the logical id too: a changed policy is a replacement, never an update.
    expect(id).toMatch(/^PagesHeadersV1[0-9A-F]{8}$/);
    // Untaggable, so the deploy rights can create but never update or delete it.
    expect(policy?.DeletionPolicy).toBe("Retain");
    expect(policy?.UpdateReplacePolicy).toBe("Retain");
    expect((distributionConfig().DefaultCacheBehavior as Record<string, unknown>).ResponseHeadersPolicyId).toEqual({ Ref: id });
  });

  it("sends a Content-Security-Policy that allows scripts only from the site itself (no inline scripts)", () => {
    const security = policyConfig().SecurityHeadersConfig as Record<string, Record<string, unknown>>;
    expect(security.ContentSecurityPolicy).toEqual({ ContentSecurityPolicy: PAGES_CONTENT_SECURITY_POLICY, Override: true });
    const directives = new Map(
      PAGES_CONTENT_SECURITY_POLICY.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(PAGES_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|\*|https?:|nonce-|sha\d+-/);
  });

  it("keeps the managed policy's security headers: HSTS one year, nosniff, frame and referrer", () => {
    const security = policyConfig().SecurityHeadersConfig as Record<string, unknown>;
    expect(security).toMatchObject({
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: true },
      ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: "DENY", Override: true },
      ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
    });
    expect(policyConfig().CustomHeadersConfig).toBeUndefined();
    expect(policyConfig().CorsConfig).toBeUndefined();
  });
});

describe("api stack: table (ticket 1.1 criterion 4)", () => {
  it("creates one table ssd-workshop-data, on demand, with point-in-time recovery, retained", () => {
    const tables = ofType("AWS::DynamoDB::Table");
    expect(tables).toHaveLength(1);
    const [s, , table] = tables[0] ?? [];
    expect(s).toBe(STACK_NAMES.api);
    expect(table).toMatchObject({
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        TableName: TABLE_NAME,
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
      },
    });
    expect(TABLE_NAME).toBe("ssd-workshop-data");
  });

  it("keys items by pk and sk strings, expires codes and sessions on expiresAt, and uses AWS-owned encryption", () => {
    const table = ofType("AWS::DynamoDB::Table")[0]?.[2].Properties;
    expect(table?.KeySchema).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ]);
    expect(table?.AttributeDefinitions).toEqual([
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ]);
    expect(table?.TimeToLiveSpecification).toEqual({ AttributeName: TTL_ATTRIBUTE, Enabled: true });
    expect(TTL_ATTRIBUTE).toBe("expiresAt");
    // No customer managed key (KMS costs and key policy rights): the AWS-owned default.
    expect(table?.SSESpecification).toEqual({ SSEEnabled: false });
    expect(ofType("AWS::KMS::Key")).toEqual([]);
  });
});

describe("api stack: HTTP API and health function (ticket 1.1 criteria 1, 2, 3)", () => {
  const apiResources = () => resources(STACK_NAMES.api);
  const apiId = () => apiResources().find(([, r]) => r.Type === "AWS::ApiGatewayV2::Api")?.[0];

  it("creates one HTTP API ssd-workshop-api, without CORS", () => {
    const apis = ofType("AWS::ApiGatewayV2::Api");
    expect(apis).toHaveLength(1);
    expect(apis[0]?.[2].Properties).toMatchObject({ Name: API_NAME, ProtocolType: "HTTP" });
    expect(apis[0]?.[2].Properties?.CorsConfiguration).toBeUndefined();
    expect(API_NAME).toBe("ssd-workshop-api");
  });

  it("tags the API and its stage project=ssd-workshop (API Gateway v2 tags are a map)", () => {
    for (const type of ["AWS::ApiGatewayV2::Api", "AWS::ApiGatewayV2::Stage"]) {
      for (const [s, id, r] of ofType(type)) {
        expect(r.Properties?.Tags, `${s}/${id}`).toEqual({ project: "ssd-workshop" });
      }
    }
  });

  it("deploys one auto-deployed $default stage with throttling", () => {
    const stages = ofType("AWS::ApiGatewayV2::Stage");
    expect(stages).toHaveLength(1);
    expect(stages[0]?.[2].Properties).toMatchObject({
      ApiId: { Ref: apiId() },
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: {
        ThrottlingRateLimit: API_THROTTLE.rateLimit,
        ThrottlingBurstLimit: API_THROTTLE.burstLimit,
      },
    });
  });

  it("routes GET /api/health to the health function", () => {
    const routes = ofType("AWS::ApiGatewayV2::Route");
    expect(routes.map(([, , r]) => r.Properties?.RouteKey)).toEqual([
      "GET /api/health",
      "POST /api/sign-in/code",
      "POST /api/sign-in/verify",
      "GET /api/me",
      "POST /api/me/nickname",
      "GET /api/participants/{id}",
      "POST /api/conversation/messages",
      "GET /api/conversation/messages/{id}",
    ]);
    const health = routes.find(([, , r]) => r.Properties?.RouteKey === "GET /api/health")?.[2];
    const integrationId = (health?.Properties?.Target as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1][1] as {
      Ref: string;
    };
    const integration = apiResources().find(([id]) => id === integrationId.Ref)?.[1];
    expect(ofType("AWS::ApiGatewayV2::Integration")).toHaveLength(5);
    const fnId = apiResources().find(([, r]) => r.Properties?.FunctionName === HEALTH_FUNCTION_NAME)?.[0];
    expect(integration?.Properties).toMatchObject({
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
      IntegrationUri: { "Fn::GetAtt": [fnId, "Arn"] },
    });
  });

  it("creates no account-wide API Gateway CloudWatch role and no REST API", () => {
    const types = allResources().map(([, , r]) => r.Type);
    expect(types).not.toContain("AWS::ApiGateway::Account");
    expect(types.filter((t) => t.startsWith("AWS::ApiGateway::"))).toEqual([]);
    for (const [s, id, r] of ofType("AWS::IAM::Role")) {
      expect(JSON.stringify(r.Properties?.AssumeRolePolicyDocument), `${s}/${id}`).not.toContain(
        "apigateway.amazonaws.com",
      );
      expect(JSON.stringify(r.Properties?.ManagedPolicyArns ?? []), `${s}/${id}`).not.toContain(
        "AmazonAPIGatewayPushToCloudWatchLogs",
      );
    }
  });

  it("names the API's own execute-api ARN as source of every Lambda permission", () => {
    const permissions = ofType("AWS::Lambda::Permission");
    expect(permissions.length).toBeGreaterThan(0);
    for (const [s, id, r] of permissions) {
      expect(s).toBe(STACK_NAMES.api);
      expect(r.Properties?.Principal, `${s}/${id}`).toBe("apigateway.amazonaws.com");
      expect(r.Properties?.SourceArn, `${s}/${id}`).toEqual({
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            `:execute-api:${REGION}:${ACCOUNT}:`,
            { Ref: apiId() },
            // One route (`/*/*/api/...`), or any route of this API for a function behind several.
            expect.stringMatching(/^\/\*\/\*\/(api\/.*|\*)$/),
          ],
        ],
      });
    }
  });

  it("runs the health function on Node.js 22, arm64, with code from the assets bucket", () => {
    const fns = apiResources().filter(([, r]) => r.Type === "AWS::Lambda::Function");
    expect(fns.map(([, r]) => r.Properties?.FunctionName)).toEqual([
      HEALTH_FUNCTION_NAME,
      SIGN_IN_CODE_FUNCTION_NAME,
      SIGN_IN_VERIFY_FUNCTION_NAME,
      PARTICIPANT_FUNCTION_NAME,
      CONVERSATION_FUNCTION_NAME,
      AI_WORKER_FUNCTION_NAME,
    ]);
    expect(fns.find(([, r]) => r.Properties?.FunctionName === HEALTH_FUNCTION_NAME)?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    expect(HEALTH_FUNCTION_NAME).toBe("ssd-workshop-api-health");
  });

  it("bundles the health handler into a self-contained index.js that answers 200 {\"ok\":true}", async () => {
    // Find the bundle in the stack's asset manifest by the S3 key the function names.
    const fn = apiResources().find(([, r]) => r.Properties?.FunctionName === HEALTH_FUNCTION_NAME)?.[1];
    const key = (fn?.Properties?.Code as { S3Key?: string } | undefined)?.S3Key;
    const manifest = JSON.parse(readFileSync(join(dir, `${STACK_NAMES.api}.assets.json`), "utf8")) as {
      files: Record<string, { source: { path: string }; destinations: Record<string, { objectKey: string }> }>;
    };
    const asset = Object.values(manifest.files).find((f) =>
      Object.values(f.destinations).some((d) => d.objectKey === key),
    );
    expect(asset).toBeDefined();
    const assetPath = asset?.source.path ?? "?";
    const bundle = createRequire(import.meta.url)(join(dir, assetPath, "index.js")) as {
      handler: () => Promise<{ statusCode: number; body: string }>;
    };
    const res = await bundle.handler();
    expect(res).toMatchObject({ statusCode: 200, body: '{"ok":true}' });
  });

  it("sends the health function's logs to its own ssd-workshop-* log group, kept two weeks", () => {
    const fn = apiResources().find(([, r]) => r.Properties?.FunctionName === HEALTH_FUNCTION_NAME)?.[1];
    const logGroupId = (fn?.Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
    const logGroup = apiResources().find(([id]) => id === logGroupId)?.[1];
    expect(logGroup).toMatchObject({
      Type: "AWS::Logs::LogGroup",
      DeletionPolicy: "Delete",
      Properties: { LogGroupName: HEALTH_FUNCTION_NAME, RetentionInDays: 14 },
    });
  });

  it("gives the health function's role no rights beyond writing its own logs", () => {
    const role = apiResources().find(
      ([, r]) => r.Type === "AWS::IAM::Role" && r.Properties?.RoleName === HEALTH_FUNCTION_NAME,
    );
    expect(role).toBeDefined();
    expect(role?.[1].Properties?.ManagedPolicyArns).toBeUndefined();
    const policies = apiResources().filter(
      ([, r]) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles).includes(role?.[0] ?? "?"),
    );
    const statements = policies.flatMap(
      ([, r]) => (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );
    const fn = apiResources().find(([, r]) => r.Properties?.FunctionName === HEALTH_FUNCTION_NAME)?.[1];
    const logGroupId = (fn?.Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
    expect(statements).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: { "Fn::GetAtt": [logGroupId, "Arn"] },
      },
    ]);
  });

  it("outputs the API's own endpoint as ApiEndpoint (read by the post-deploy health check)", () => {
    expect(stack(STACK_NAMES.api).template.Outputs?.ApiEndpoint).toMatchObject({
      Value: { "Fn::GetAtt": [apiId(), "ApiEndpoint"] },
    });
  });
});

describe("api stack: sign-in code function (ticket 1.4)", () => {
  const apiResources = () => resources(STACK_NAMES.api);
  const fnEntry = () => apiResources().find(([, r]) => r.Properties?.FunctionName === SIGN_IN_CODE_FUNCTION_NAME);
  const roleEntry = () =>
    apiResources().find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties?.RoleName === SIGN_IN_CODE_FUNCTION_NAME);

  it("names the function, role and log group ssd-workshop-api-sign-in-code", () => {
    expect(SIGN_IN_CODE_FUNCTION_NAME).toBe("ssd-workshop-api-sign-in-code");
    expect(fnEntry()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    const logGroupId = (fnEntry()?.[1].Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
    expect(apiResources().find(([id]) => id === logGroupId)?.[1].Properties).toMatchObject({
      LogGroupName: SIGN_IN_CODE_FUNCTION_NAME,
      RetentionInDays: 14,
    });
  });

  it("has 512 MB (scrypt runs at a predictable speed) and a 10 s timeout, well above the 3 s answer time", () => {
    expect(fnEntry()?.[1].Properties).toMatchObject({ MemorySize: 512, Timeout: 10 });
    expect(ANSWER_AFTER_MS).toBe(3000);
    expect((fnEntry()?.[1].Properties?.Timeout as number) * 1000).toBeGreaterThanOrEqual(3 * ANSWER_AFTER_MS);
  });

  it("gives the role the /ssd-workshop/ path and the boundary (through the aspect)", () => {
    expect(roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(roleEntry()?.[1].Properties?.ManagedPolicyArns).toBeUndefined();
  });

  it("routes POST /api/sign-in/code to the function, invoked only by this API", () => {
    const route = ofType("AWS::ApiGatewayV2::Route").find(([, , r]) => r.Properties?.RouteKey === "POST /api/sign-in/code");
    expect(route).toBeDefined();
    const target = route?.[2].Properties?.Target as { "Fn::Join": [string, unknown[]] };
    const integrationId = (target["Fn::Join"][1][1] as { Ref: string }).Ref;
    expect(apiResources().find(([id]) => id === integrationId)?.[1].Properties).toMatchObject({
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
      IntegrationUri: { "Fn::GetAtt": [fnEntry()?.[0], "Arn"] },
    });
    const permissions = ofType("AWS::Lambda::Permission").filter(
      ([, , r]) => JSON.stringify(r.Properties?.FunctionName) === JSON.stringify({ "Fn::GetAtt": [fnEntry()?.[0], "Arn"] }),
    );
    expect(permissions).toHaveLength(1);
    expect(JSON.stringify(permissions[0]?.[2].Properties?.SourceArn)).toContain("/*/*/api/sign-in/code");
  });

  it("throttles POST /api/sign-in/code at 5 requests/s, burst 10, on the $default stage (after the route exists)", () => {
    expect(SIGN_IN_CODE_ROUTE_KEY).toBe("POST /api/sign-in/code");
    expect(SIGN_IN_CODE_THROTTLE).toEqual({ rateLimit: 5, burstLimit: 10 });
    const stages = apiResources().filter(([, r]) => r.Type === "AWS::ApiGatewayV2::Stage");
    expect(stages).toHaveLength(1);
    const [, stage] = stages[0] ?? [];
    expect(stage?.Properties?.RouteSettings).toMatchObject({
      "POST /api/sign-in/code": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
    });
    const routeId = apiResources().find(
      ([, r]) => r.Type === "AWS::ApiGatewayV2::Route" && r.Properties?.RouteKey === SIGN_IN_CODE_ROUTE_KEY,
    )?.[0];
    expect(routeId).toBeDefined();
    expect([stage?.DependsOn].flat()).toContain(routeId);
    // The stage-wide default stays as it was.
    expect(stage?.Properties?.DefaultRouteSettings).toMatchObject({
      ThrottlingRateLimit: API_THROTTLE.rateLimit,
      ThrottlingBurstLimit: API_THROTTLE.burstLimit,
    });
  });

  it("allows only its logs, GetItem/PutItem in EMAIL# partitions (PutItem: code attributes only) and SES sends from the workshop address", () => {
    const role = roleEntry();
    const statements = apiResources()
      .filter(([, r]) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles).includes(role?.[0] ?? "?"))
      .flatMap(([, r]) => (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    const logGroupId = (fnEntry()?.[1].Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
    const tableId = apiResources().find(([, r]) => r.Type === "AWS::DynamoDB::Table")?.[0];
    expect(statements).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: { "Fn::GetAtt": [logGroupId, "Arn"] },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: { "Fn::GetAtt": [tableId, "Arn"] },
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:PutItem",
        Resource: { "Fn::GetAtt": [tableId, "Arn"] },
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] },
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": ["pk", "sk", "type", "codes", "attempts", "sentAt", "version", "expiresAt"],
          },
        },
      },
      {
        Effect: "Allow",
        Action: "ses:SendEmail",
        Resource: [
          `arn:aws:ses:${REGION}:${ACCOUNT}:identity/ssd-workshop@rankly.games`,
          `arn:aws:ses:${REGION}:${ACCOUNT}:identity/rankly.games`,
          `arn:aws:ses:${REGION}:${ACCOUNT}:configuration-set/ssd-workshop-email`,
        ],
        Condition: { StringEquals: { "ses:FromAddress": "ssd-workshop@rankly.games" } },
      },
    ]);
    expect(SENDER_ADDRESS).toBe("ssd-workshop@rankly.games");
    expect(SES_CONFIGURATION_SET).toBe("ssd-workshop-email");
  });

  it("bundles the handler into a self-contained index.js that answers a malformed request 400", async () => {
    const key = (fnEntry()?.[1].Properties?.Code as { S3Key?: string } | undefined)?.S3Key;
    const manifest = JSON.parse(readFileSync(join(dir, `${STACK_NAMES.api}.assets.json`), "utf8")) as {
      files: Record<string, { source: { path: string }; destinations: Record<string, { objectKey: string }> }>;
    };
    const asset = Object.values(manifest.files).find((f) =>
      Object.values(f.destinations).some((d) => d.objectKey === key),
    );
    expect(asset).toBeDefined();
    const bundle = createRequire(import.meta.url)(join(dir, asset?.source.path ?? "?", "index.js")) as {
      handler: (event: { body?: string }) => Promise<{ statusCode: number }>;
    };
    const log = console.log;
    console.log = () => undefined;
    try {
      await expect(bundle.handler({ body: "not json" })).resolves.toMatchObject({ statusCode: 400 });
    } finally {
      console.log = log;
    }
  });
});

/** Resources, policy statements and bundle of one API function (ticket 1.5 blocks). */
function apiFunction(name: string) {
  const apiResources = () => resources(STACK_NAMES.api);
  const fnEntry = () => apiResources().find(([, r]) => r.Properties?.FunctionName === name);
  const roleEntry = () => apiResources().find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties?.RoleName === name);
  const statements = () =>
    apiResources()
      .filter(([, r]) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles).includes(roleEntry()?.[0] ?? "?"))
      .flatMap(([, r]) => (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
  const logGroupId = () => (fnEntry()?.[1].Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
  const tableArn = () => ({ "Fn::GetAtt": [apiResources().find(([, r]) => r.Type === "AWS::DynamoDB::Table")?.[0], "Arn"] });
  const bundle = <T>(): T => {
    const key = (fnEntry()?.[1].Properties?.Code as { S3Key?: string } | undefined)?.S3Key;
    const manifest = JSON.parse(readFileSync(join(dir, `${STACK_NAMES.api}.assets.json`), "utf8")) as {
      files: Record<string, { source: { path: string }; destinations: Record<string, { objectKey: string }> }>;
    };
    const asset = Object.values(manifest.files).find((f) => Object.values(f.destinations).some((d) => d.objectKey === key));
    expect(asset).toBeDefined();
    return createRequire(import.meta.url)(join(dir, asset?.source.path ?? "?", "index.js")) as T;
  };
  const integrationOf = (routeKey: string) => {
    const route = ofType("AWS::ApiGatewayV2::Route").find(([, , r]) => r.Properties?.RouteKey === routeKey);
    const target = route?.[2].Properties?.Target as { "Fn::Join": [string, unknown[]] } | undefined;
    const id = (target?.["Fn::Join"][1][1] as { Ref: string } | undefined)?.Ref;
    return apiResources().find(([rid]) => rid === id)?.[1].Properties;
  };
  const permissions = () =>
    ofType("AWS::Lambda::Permission").filter(
      ([, , r]) => JSON.stringify(r.Properties?.FunctionName) === JSON.stringify({ "Fn::GetAtt": [fnEntry()?.[0], "Arn"] }),
    );
  return { apiResources, fnEntry, roleEntry, statements, logGroupId, tableArn, bundle, integrationOf, permissions };
}

const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await work();
  } finally {
    console.log = log;
  }
};

describe("api stack: sign-in verify function (ticket 1.5)", () => {
  const f = apiFunction(SIGN_IN_VERIFY_FUNCTION_NAME);

  it("names the function, role and log group ssd-workshop-api-sign-in-verify; 512 MB, 10 s, Node.js 22 arm64", () => {
    expect(SIGN_IN_VERIFY_FUNCTION_NAME).toBe("ssd-workshop-api-sign-in-verify");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 10,
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    expect((f.fnEntry()?.[1].Properties?.Timeout as number) * 1000).toBeGreaterThanOrEqual(3 * ANSWER_AFTER_MS);
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({
      LogGroupName: SIGN_IN_VERIFY_FUNCTION_NAME,
      RetentionInDays: 14,
    });
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(f.roleEntry()?.[1].Properties?.ManagedPolicyArns).toBeUndefined();
  });

  it("routes POST /api/sign-in/verify to the function, invoked only by this API from that route", () => {
    expect(f.integrationOf(SIGN_IN_VERIFY_ROUTE_KEY)).toMatchObject({
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
      IntegrationUri: { "Fn::GetAtt": [f.fnEntry()?.[0], "Arn"] },
    });
    expect(f.permissions()).toHaveLength(1);
    expect(JSON.stringify(f.permissions()[0]?.[2].Properties?.SourceArn)).toContain("/*/*/api/sign-in/verify");
  });

  it("throttles POST /api/sign-in/verify at 5 requests/s, burst 10, on the $default stage (after the route exists)", () => {
    expect(SIGN_IN_VERIFY_ROUTE_KEY).toBe("POST /api/sign-in/verify");
    expect(SIGN_IN_VERIFY_THROTTLE).toEqual({ rateLimit: 5, burstLimit: 10 });
    const [, stage] = f.apiResources().find(([, r]) => r.Type === "AWS::ApiGatewayV2::Stage") ?? [];
    expect(stage?.Properties?.RouteSettings).toEqual({
      "POST /api/sign-in/code": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "POST /api/sign-in/verify": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
    });
    const routeId = f
      .apiResources()
      .find(([, r]) => r.Type === "AWS::ApiGatewayV2::Route" && r.Properties?.RouteKey === SIGN_IN_VERIFY_ROUTE_KEY)?.[0];
    expect([stage?.DependsOn].flat()).toContain(routeId);
  });

  it("allows only its logs; in EMAIL# GetItem, DeleteItem and UpdateItem of attempts/version/participantId; profile updates without nickname; session puts", () => {
    expect(f.statements()).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "attempts", "version", "participantId"] },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:DeleteItem",
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": ["pk", "sk", "type", "id", "role", "group", "step", "createdAt"],
          },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:PutItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*"] },
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": ["pk", "sk", "type", "tokenHash", "participantId", "createdAt", "expiresAt"],
          },
        },
      },
    ]);
  });

  it("bundles the handler into a self-contained index.js that answers a request without the JSON content type 415", async () => {
    const bundle = f.bundle<{ handler: (event: { body?: string }) => Promise<{ statusCode: number }> }>();
    await expect(quietly(() => bundle.handler({ body: "{}" }))).resolves.toMatchObject({ statusCode: 415 });
  });
});

describe("api stack: participant function (ticket 1.5)", () => {
  const f = apiFunction(PARTICIPANT_FUNCTION_NAME);

  it("names the function, role and log group ssd-workshop-api-participant; Node.js 22 arm64", () => {
    expect(PARTICIPANT_FUNCTION_NAME).toBe("ssd-workshop-api-participant");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 256,
      Timeout: 10,
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({
      LogGroupName: PARTICIPANT_FUNCTION_NAME,
      RetentionInDays: 14,
    });
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
  });

  it("routes GET /api/me, POST /api/me/nickname and GET /api/participants/{id} to it, invoked only by this API", () => {
    expect([...PARTICIPANT_ROUTE_KEYS]).toEqual(["GET /api/me", "POST /api/me/nickname", "GET /api/participants/{id}"]);
    for (const routeKey of PARTICIPANT_ROUTE_KEYS) {
      expect(f.integrationOf(routeKey), routeKey).toMatchObject({
        IntegrationType: "AWS_PROXY",
        PayloadFormatVersion: "2.0",
        IntegrationUri: { "Fn::GetAtt": [f.fnEntry()?.[0], "Arn"] },
      });
    }
    expect(f.permissions()).toHaveLength(1);
    const source = JSON.stringify(f.permissions()[0]?.[2].Properties?.SourceArn);
    expect(source).toContain(`:execute-api:${REGION}:${ACCOUNT}:`);
    expect(source).toContain('"/*/*/*"');
  });

  it("allows only its logs, GetItem on sessions and profiles, nickname claim puts and profile updates of nickname and step", () => {
    expect(f.statements()).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:PutItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["NICK#*"] },
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": ["pk", "sk", "type", "nickname", "participantId", "createdAt"],
          },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "nickname", "step"] },
        },
      },
    ]);
  });

  it("bundles the handler into a self-contained index.js that answers a call without a session 401", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string }) => Promise<{ statusCode: number }> }>();
    await expect(quietly(() => bundle.handler({ routeKey: "GET /api/me" }))).resolves.toMatchObject({ statusCode: 401 });
  });
});

describe("api stack: conversation queue (ticket 1.7)", () => {
  const queues = () => ofType("AWS::SQS::Queue").map(([, id, r]) => [id, r] as const);
  const queue = (name: string) => queues().find(([, r]) => r.Properties?.QueueName === name);

  it("creates the queue ssd-workshop-ai-messages and its dead-letter queue, SQS-encrypted and tagged, without a queue policy", () => {
    expect(queues().map(([, r]) => r.Properties?.QueueName).sort()).toEqual([AI_QUEUE_NAME, AI_DLQ_NAME].sort());
    expect(AI_QUEUE_NAME).toBe("ssd-workshop-ai-messages");
    expect(AI_DLQ_NAME).toBe("ssd-workshop-ai-messages-dlq");
    for (const [id, r] of queues()) {
      expect(r.Properties?.SqsManagedSseEnabled, id).toBe(true);
      expect(tagsOf(r).project, id).toBe("ssd-workshop");
    }
    // The access stack denies sqs:AddPermission; no resource policy is needed (identity-based rights).
    expect(ofType("AWS::SQS::QueuePolicy")).toEqual([]);
  });

  it("hides a job for six times the worker's timeout and moves it to the dead-letter queue after 3 receives", () => {
    expect(AI_WORKER_TIMEOUT_SECONDS).toBe(300);
    expect(queue(AI_QUEUE_NAME)?.[1].Properties).toMatchObject({
      VisibilityTimeout: AI_QUEUE_VISIBILITY_SECONDS,
      RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [queue(AI_DLQ_NAME)?.[0], "Arn"] }, maxReceiveCount: AI_QUEUE_MAX_RECEIVES },
    });
    expect(AI_QUEUE_VISIBILITY_SECONDS).toBe(1800);
    expect(AI_QUEUE_MAX_RECEIVES).toBe(3);
  });

  it("feeds the worker one job at a time through a tagged event source mapping", () => {
    const mappings = ofType("AWS::Lambda::EventSourceMapping");
    expect(mappings).toHaveLength(1);
    const worker = apiFunction(AI_WORKER_FUNCTION_NAME);
    expect(mappings[0]?.[2].Properties).toMatchObject({
      BatchSize: 1,
      EventSourceArn: { "Fn::GetAtt": [queue(AI_QUEUE_NAME)?.[0], "Arn"] },
      FunctionName: { Ref: worker.fnEntry()?.[0] },
      Tags: [{ Key: "project", Value: "ssd-workshop" }],
    });
  });
});

describe("api stack: conversation function (ticket 1.7)", () => {
  const f = apiFunction(CONVERSATION_FUNCTION_NAME);
  const queueArn = () => ({ "Fn::GetAtt": [ofType("AWS::SQS::Queue").find(([, , r]) => r.Properties?.QueueName === AI_QUEUE_NAME)?.[1], "Arn"] });

  it("names the function, role and log group ssd-workshop-api-conversation; Node.js 22 arm64, 256 MB, 10 s", () => {
    expect(CONVERSATION_FUNCTION_NAME).toBe("ssd-workshop-api-conversation");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({ Runtime: "nodejs22.x", Architectures: ["arm64"], MemorySize: 256, Timeout: 10 });
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({
      LogGroupName: CONVERSATION_FUNCTION_NAME,
      RetentionInDays: 14,
    });
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
  });

  it("routes POST /api/conversation/messages and GET /api/conversation/messages/{id} to it, invoked only by this API", () => {
    expect([...CONVERSATION_ROUTE_KEYS]).toEqual(["POST /api/conversation/messages", "GET /api/conversation/messages/{id}"]);
    for (const routeKey of CONVERSATION_ROUTE_KEYS) {
      expect(f.integrationOf(routeKey), routeKey).toMatchObject({
        IntegrationType: "AWS_PROXY",
        PayloadFormatVersion: "2.0",
        IntegrationUri: { "Fn::GetAtt": [f.fnEntry()?.[0], "Arn"] },
      });
    }
    expect(f.permissions()).toHaveLength(1);
    expect(JSON.stringify(f.permissions()[0]?.[2].Properties?.SourceArn)).toContain('"/*/*/*"');
  });

  it("allows only its logs, GetItem on sessions and participants, updates of listed attributes in participants, and sends to the queue", () => {
    expect(f.statements()).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] } },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": [
              "pk", "sk", "type", "author", "step", "text", "status", "createdAt", "pendingSince", "state", "pendingId", "updatedAt", "kind", "replyTo",
            ],
          },
        },
      },
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: queueArn() },
    ]);
  });

  it("bundles the handler into a self-contained index.js that answers a call without a session 401", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string; body: string }) => Promise<{ statusCode: number }> }>();
    await expect(quietly(() => bundle.handler({ routeKey: "POST /api/conversation/messages", body: "{}" }))).resolves.toMatchObject({ statusCode: 401 });
  });
});

describe("api stack: AI worker (ticket 1.7)", () => {
  const f = apiFunction(AI_WORKER_FUNCTION_NAME);

  it("names the function, role and log group ssd-workshop-api-ai-worker; Node.js 22 arm64, 256 MB, 300 s; no route", () => {
    expect(AI_WORKER_FUNCTION_NAME).toBe("ssd-workshop-api-ai-worker");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({ Runtime: "nodejs22.x", Architectures: ["arm64"], MemorySize: 256, Timeout: 300 });
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({
      LogGroupName: AI_WORKER_FUNCTION_NAME,
      RetentionInDays: 14,
    });
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(f.permissions()).toEqual([]);
  });

  it("allows only its logs, reads and updates of listed attributes in participants, the one model and consuming its queue", () => {
    const queueArn = { "Fn::GetAtt": [ofType("AWS::SQS::Queue").find(([, , r]) => r.Properties?.QueueName === AI_QUEUE_NAME)?.[1], "Arn"] };
    expect(f.statements()).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] } },
      {
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": expect.not.arrayContaining(["approved", "step", "role", "group", "nickname", "id"]) },
        },
      },
      {
        Effect: "Allow",
        Action: "bedrock:InvokeModel",
        Resource: [
          `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/eu.anthropic.claude-sonnet-4-6`,
          "arn:aws:bedrock:eu-*::foundation-model/anthropic.claude-sonnet-4-6",
        ],
      },
      {
        Effect: "Allow",
        Action: ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        Resource: queueArn,
      },
    ]);
  });

  it("bundles the handler into a self-contained index.js that skips a malformed job without any AWS call", async () => {
    const bundle = f.bundle<{ handler: (event: { Records: { body: string }[] }) => Promise<void> }>();
    await expect(quietly(() => bundle.handler({ Records: [{ body: "not json" }] }))).resolves.toBeUndefined();
  });
});
