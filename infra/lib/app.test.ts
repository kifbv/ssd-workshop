import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAssembly, CloudFormationStackArtifact } from "aws-cdk-lib/cx-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  ACCOUNT,
  ASSETS_BUCKET_NAME,
  BOUNDARY_ARN,
  DOMAIN,
  EDGE_REGION,
  HOSTED_ZONE_ID,
  IAM_PATH,
  REGION,
  SITE_BUCKET_NAME,
  SITE_BUCKET_REGIONAL_DOMAIN,
  STACK_NAMES,
} from "./config.js";
import { WEB_DIR } from "./site-stack.js";

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

const STACKS = [STACK_NAMES.assets, STACK_NAMES.site, STACK_NAMES.edge];

/** Types that must carry the project tag in their own template (taggable in CloudFormation). */
const MUST_BE_TAGGED = [
  "AWS::S3::Bucket",
  "AWS::CloudFront::Distribution",
  "AWS::CertificateManager::Certificate",
  "AWS::Lambda::Function",
  "AWS::IAM::Role",
  "AWS::Logs::LogGroup",
];

/** Types CloudFormation cannot tag; anything else must be tagged or added here on purpose. */
const NOT_TAGGABLE = [
  "AWS::CDK::Metadata",
  "AWS::S3::BucketPolicy",
  "AWS::IAM::Policy",
  "AWS::Lambda::LayerVersion",
  "AWS::CloudFront::OriginAccessControl",
  "AWS::Route53::RecordSet",
  "Custom::CDKBucketDeployment",
];

/**
 * Keys ending in "Name" that are not a resource's physical name, so the names
 * test skips them: DNS names, a reference to a bucket, and the name of an inline
 * policy inside its (named) role. Every other "*Name" key, at any depth, is a name.
 */
const NOT_RESOURCE_NAMES = ["DomainName", "DNSName", "DestinationBucketName", "PolicyName"];

/** Per type, top-level keys that are DNS names rather than resource names. */
const DNS_NAME_PROPERTIES: Record<string, string[]> = { "AWS::Route53::RecordSet": ["Name"] };

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

function tagsOf(r: Resource): Record<string, unknown> {
  const tags = r.Properties?.Tags as { Key: string; Value: unknown }[] | undefined;
  return Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));
}

describe("stacks", () => {
  it("synthesizes the assets and site stacks in eu-central-1 and the edge stack in us-east-1", () => {
    expect(stack(STACK_NAMES.assets).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.site).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.edge).environment).toMatchObject({ account: ACCOUNT, region: EDGE_REGION });
  });

  it("deploys assets, then site, then edge", () => {
    const deps = (name: string) => stack(name).dependencies.map((d) => d.id);
    expect(deps(STACK_NAMES.site)).toContain(STACK_NAMES.assets);
    expect(deps(STACK_NAMES.edge)).toContain(STACK_NAMES.site);
  });

  it.each(STACKS)("%s needs no CDK bootstrap (no BootstrapVersion parameter, no bootstrap roles)", (name) => {
    const s = stack(name);
    expect(s.template.Parameters?.BootstrapVersion).toBeUndefined();
    expect(s.assumeRoleArn).toBeUndefined();
    expect(s.cloudFormationExecutionRoleArn).toBeUndefined();
  });

  it("uploads only the site stack's assets and template, to our assets bucket in eu-central-1", () => {
    const site = stack(STACK_NAMES.site);
    expect(site.stackTemplateAssetObjectUrl?.startsWith(`s3://${ASSETS_BUCKET_NAME}/`)).toBe(true);
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
});

describe("placeholder page", () => {
  it("says SSD Workshop, coming soon", () => {
    const html = readFileSync(join(WEB_DIR, "index.html"), "utf8");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>SSD Workshop, coming soon</title>");
    expect(html).toMatch(/<h1>SSD Workshop, coming soon<\/h1>/);
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
        // Managed SecurityHeadersPolicy (HSTS, X-Content-Type-Options,
        // X-Frame-Options, Referrer-Policy, X-XSS-Protection).
        ResponseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03",
      },
      ViewerCertificate: {
        AcmCertificateArn: { Ref: certId },
        SslSupportMethod: "sni-only",
        MinimumProtocolVersion: "TLSv1.2_2021",
      },
    });

    const origins = config.Origins as Record<string, unknown>[];
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({ DomainName: SITE_BUCKET_REGIONAL_DOMAIN });
    expect(origins[0]?.OriginAccessControlId).toBeDefined();
    expect(ofType("AWS::CloudFront::OriginAccessControl")).toHaveLength(1);
    // The managed headers policy creates no resource of its own.
    expect(ofType("AWS::CloudFront::ResponseHeadersPolicy")).toEqual([]);
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
