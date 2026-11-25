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
  AI_WORKER_MAX_CONCURRENCY,
  AI_WORKER_TIMEOUT_SECONDS,
  APP_DATA_METHODS,
  APP_DATA_PATH,
  APP_DATA_PREFLIGHT_THROTTLE,
  APP_DATA_READ_THROTTLE,
  APP_DATA_WRITE_THROTTLE,
} from "./api-stack.js";
import { APP_DATA_ROUTES as APP_DATA_ROUTE_KEYS, PREFLIGHT_HEADERS } from "../../platform/api/app-data/data.js";
import { STALE_PENDING_SECONDS } from "../../platform/api/conversation/state.js";
import { WRITE_RESERVE_MS } from "../../platform/api/handlers/ai-worker.js";
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
  APP_DATA_HEADERS_POLICY_NAME,
  APPS_BUCKET_NAME,
  APPS_BUCKET_REGIONAL_DOMAIN,
  APPS_CONTENT_SECURITY_POLICY,
  APPS_HEADERS_POLICY_NAME,
  APPS_INDEX_FUNCTION_NAME,
  DEPLOY_DLQ_NAME,
  DEPLOY_QUEUE_NAME,
  AI_WORKER_BUILD_UPDATE_ATTRIBUTES,
  BUILD_DLQ_NAME,
  BUILD_QUEUE_NAME,
  DEPLOYER_FUNCTION_NAME,
  DEPLOYER_LIVE_UPDATE_ATTRIBUTES,
  DEPLOYER_ROLE_ARN,
  DEPLOYER_ROLE_ARN_WITHOUT_PATH,
  DISTRIBUTION_ID,
  SENDER_ADDRESS,
  SES_CONFIGURATION_SET,
  SIGN_IN_CODE_FUNCTION_NAME,
  SIGN_IN_VERIFY_FUNCTION_NAME,
  PARTICIPANT_FUNCTION_NAME,
  CONVERSATION_FUNCTION_NAME,
  AI_WORKER_FUNCTION_NAME,
  APP_DATA_FUNCTION_NAME,
  AI_QUEUE_NAME,
  AI_DLQ_NAME,
  REGION,
  SITE_BUCKET_NAME,
  SITE_BUCKET_REGIONAL_DOMAIN,
  STACK_NAMES,
  BUILDS_AVAILABILITY_ZONES,
  BUILDS_CLUSTER_NAME,
  BUILDS_SECURITY_GROUP_NAME,
  BUILDS_VPC_CIDR,
  BUILDS_VPC_NAME,
  BUILDER_IMAGES_KEPT,
  BUILDER_REPOSITORY_NAME,
  BUILD_CHECK_QUEUE_NAME,
  BUILD_CHECK_SCHEDULE_NAME,
  BUILD_CHECK_SCHEDULER_ROLE_NAME,
  BUILD_LAUNCHER_FUNCTION_NAME,
  BUILDER_BUILD_READ_ATTRIBUTES,
  BUILDER_BUILD_UPDATE_ATTRIBUTES,
  BUILDER_CONTAINER_NAME,
  BUILDER_CPU,
  BUILDER_EXECUTION_ROLE_NAME,
  BUILDER_IMAGE_DIGEST_UNSET,
  BUILDER_LOG_GROUP_NAME,
  BUILDER_MEMORY_MB,
  BUILDER_TASK_FAMILY,
  BUILDER_TASK_ROLE_NAME,
  BUILDER_USAGE_UPDATE_ATTRIBUTES,
  LAUNCHER_BUILD_UPDATE_ATTRIBUTES,
  LAUNCHER_LAUNCH_ATTRIBUTES,
  LAUNCHER_READ_ATTRIBUTES,
  LAUNCHES_PARTITION,
  ATTRIBUTE_LIMITED_RETURN_VALUES,
  GITHUB_SECRET_NAME,
  TABLE_NAME,
} from "./config.js";
import { PARTICIPANT_ROUTES as PARTICIPANT_ROUTE_KEYS } from "../../platform/api/participant/participant.js";
import { ANSWER_AFTER_MS } from "../../platform/api/sign-in/code-request.js";
import { WEB_BUILD_FOLDER, WEB_DIR } from "./site-stack.js";
import {
  APPS_OBJECT_WRITE_ACTIONS,
  DEPLOY_QUEUE_MAX_RECEIVES,
  DEPLOY_QUEUE_VISIBILITY_SECONDS,
  DEPLOYER_MAX_CONCURRENCY,
  DEPLOYER_MEMORY_MB,
  DEPLOYER_TIMEOUT_SECONDS,
} from "./apps-stack.js";
import { APPS_INDEX_FUNCTION_FILE, NOT_FOUND_CACHE_SECONDS } from "./edge-stack.js";
import {
  BUILD_CHECK_SCHEDULE,
  BUILD_QUEUE_MAX_RECEIVES,
  BUILD_QUEUE_VISIBILITY_SECONDS,
  LAUNCHER_MAX_CONCURRENCY,
  LAUNCHER_MEMORY_MB,
  LAUNCHER_TIMEOUT_SECONDS,
  TEMPLATE_DIR,
} from "./builds-stack.js";
import { LAUNCH_RESERVE_MS } from "../../platform/api/handlers/builds-launcher.js";
import {
  APPS_BUCKET_NAME as PLATFORM_APPS_BUCKET_NAME,
  BUILD_QUEUE_NAME as PLATFORM_BUILD_QUEUE_NAME,
  DEPLOY_MAX_RECEIVES as PLATFORM_DEPLOY_MAX_RECEIVES,
  DEPLOY_QUEUE_NAME as PLATFORM_DEPLOY_QUEUE_NAME,
  DISTRIBUTION_ID as PLATFORM_DISTRIBUTION_ID,
  GITHUB_SECRET_NAME as PLATFORM_GITHUB_SECRET_NAME,
  HANDED_OVER_GRACE_MS,
} from "../../platform/api/settings.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
}

const STACKS = [STACK_NAMES.assets, STACK_NAMES.site, STACK_NAMES.edge, STACK_NAMES.api, STACK_NAMES.builds, STACK_NAMES.apps];

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
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::RouteTable",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::SecurityGroup",
  "AWS::ECS::Cluster",
  "AWS::ECR::Repository",
  "AWS::CloudFront::Function",
  "AWS::SecretsManager::Secret",
  "AWS::ECS::TaskDefinition",
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
  "AWS::EC2::VPCGatewayAttachment",
  "AWS::EC2::Route",
  "AWS::EC2::SubnetRouteTableAssociation",
  // Ticket 2.9: EventBridge Scheduler schedules take no tags (its schedule groups do; the check uses the default group).
  "AWS::Scheduler::Schedule",
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

/**
 * Per type, nested paths whose "Name" key is a setting, not a name: an ECS cluster
 * setting's `Name` (`containerInsights`).
 */
const NOT_NAME_PATHS: Record<string, RegExp[]> = {
  "AWS::ECS::Cluster": [/^\.ClusterSettings\[\d+\]\.Name$/],
  // Ticket 2.9: a container's name lives inside its (named) task definition, like an inline policy's.
  "AWS::ECS::TaskDefinition": [/^\.ContainerDefinitions\[\d+\]\.Name$/],
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
  "GroupName",
  "ClusterName",
  "RepositoryName",
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
/** Whether an IAM action pattern (`*` and `?` wildcards, any letter case) covers the action. */
function actionCovers(granted: string, action: string): boolean {
  const pattern = granted.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i").test(action);
}

/**
 * An IAM resource as a pattern: a string as is, an `Fn::Join` with its pseudo parameters filled in (partition,
 * region, account); any other reference (a logical id, `Fn::GetAtt`) becomes a character no ARN holds, so only
 * the literal parts and their wildcards can match.
 */
function resourcePattern(resource: unknown): string {
  if (typeof resource === "string") return resource;
  if (resource !== null && typeof resource === "object") {
    const join = (resource as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
    if (join !== undefined) return join[1].map(resourcePattern).join(join[0]);
    const sub = (resource as { "Fn::Sub"?: unknown })["Fn::Sub"];
    if (sub !== undefined) {
      const text = typeof sub === "string" ? sub : Array.isArray(sub) && typeof sub[0] === "string" ? sub[0] : undefined;
      // A template we cannot read counts as reaching everything (the safe direction).
      if (text === undefined) return "*";
      return text.replace(/\$\{([^}]*)\}/g, (_, name: string) => PSEUDO_VALUES[name] ?? "\u0000");
    }
    const ref = (resource as { Ref?: unknown }).Ref;
    if (typeof ref === "string") return PSEUDO_VALUES[ref] ?? "\u0000";
    // A reference to a resource (its literal parts are matched by resourceReaches); any other intrinsic
    // (Fn::ImportValue, Fn::If, ...) could name anything, so it counts as `*`.
    if ("Fn::GetAtt" in resource) return "\u0000";
    return "*";
  }
  return "\u0000";
}

/** CloudFormation pseudo parameters as they resolve in this account. */
const PSEUDO_VALUES: Record<string, string> = { "AWS::Partition": "aws", "AWS::AccountId": ACCOUNT, "AWS::Region": REGION };

/** An Allow statement the guards cannot read safely: `NotResource` or `NotAction` grant by exclusion. */
function assertNoExclusions(where: string, st: Record<string, unknown>): void {
  if (st.Effect !== "Allow") return;
  expect(st.NotResource, where).toBeUndefined();
  expect(st.NotAction, where).toBeUndefined();
}

/** The apps bucket and one of its app keys, as IAM sees them. */
const APPS_BUCKET_ARNS = [`arn:aws:s3:::${APPS_BUCKET_NAME}`, `arn:aws:s3:::${APPS_BUCKET_NAME}/apps/x`];

/**
 * Whether an IAM resource (string, `Fn::Join`, `Ref`, `Fn::GetAtt`) can name one of `arns`: its pattern matched with
 * the same `*`/`?` glob as actionCovers (any letter case, to err on the safe side), or a reference to one of
 * `logicalIds`, or one of `names` anywhere in it.
 */
function resourceReaches(resource: unknown, arns: readonly string[], logicalIds: readonly string[], names: readonly string[]): boolean {
  const pattern = resourcePattern(resource);
  if (arns.some((arn) => actionCovers(pattern, arn))) return true;
  const text = JSON.stringify(resource);
  return logicalIds.some((id) => text.includes(`"${id}"`)) || names.some((name) => text.includes(name));
}

function tagsOf(r: Resource): Record<string, unknown> {
  const tags = r.Properties?.Tags as { Key: string; Value: unknown }[] | Record<string, unknown> | undefined;
  if (tags === undefined) return {};
  if (Array.isArray(tags)) return Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
  return tags;
}

describe("stacks", () => {
  it("synthesizes the assets, site, api and builds stacks in eu-central-1 and the edge stack in us-east-1", () => {
    expect(stack(STACK_NAMES.assets).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.builds).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.site).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.api).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.apps).environment).toMatchObject({ account: ACCOUNT, region: REGION });
    expect(stack(STACK_NAMES.edge).environment).toMatchObject({ account: ACCOUNT, region: EDGE_REGION });
  });

  it("deploys assets, then site, then edge; the api stack after assets", () => {
    const deps = (name: string) => stack(name).dependencies.map((d) => d.id);
    expect(deps(STACK_NAMES.site)).toContain(STACK_NAMES.assets);
    expect(deps(STACK_NAMES.edge)).toContain(STACK_NAMES.site);
    expect(deps(STACK_NAMES.api)).toContain(STACK_NAMES.assets);
    // Ticket 2.5: the apps stack (bundled deployer) after assets; the edge stack serves its bucket, so after it.
    expect(deps(STACK_NAMES.apps)).toContain(STACK_NAMES.assets);
    expect(deps(STACK_NAMES.edge)).toContain(STACK_NAMES.apps);
    // Ticket 2.9: the builds stack (bundled launcher) after assets.
    expect(deps(STACK_NAMES.builds)).toContain(STACK_NAMES.assets);
  });

  it.each(STACKS)("%s needs no CDK bootstrap (no BootstrapVersion parameter, no bootstrap roles)", (name) => {
    const s = stack(name);
    expect(s.template.Parameters?.BootstrapVersion).toBeUndefined();
    expect(s.assumeRoleArn).toBeUndefined();
    expect(s.cloudFormationExecutionRoleArn).toBeUndefined();
  });

  it("uploads only the site, api, apps and builds stacks' assets and templates, to our assets bucket in eu-central-1", () => {
    for (const name of [STACK_NAMES.site, STACK_NAMES.api, STACK_NAMES.apps, STACK_NAMES.builds]) {
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

  it("needs no context lookup, so synth runs in CI without AWS credentials (ticket 2.1: fixed zones)", () => {
    expect(assembly.manifest.missing ?? []).toEqual([]);
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
        if ((NOT_NAME_PATHS[r.Type] ?? []).some((p) => p.test(path))) continue;
        seen.add(path.slice(1));
        // ECS task logs live under /ecs/ssd-workshop-* (the access stack's log rights name exactly that prefix).
        const ecsLogGroup = r.Type === "AWS::Logs::LogGroup" && path === ".LogGroupName" && typeof value === "string" && value.startsWith("/ecs/");
        expect(ecsLogGroup ? (value as string).slice("/ecs/".length) : value, `${s}/${id}${path}`).toMatch(/^ssd-workshop-/);
      }
    }
    for (const path of EXPECTED_NAME_PATHS) expect(seen, path).toContain(path);
  });

  it("names the Origin Access Controls ssd-workshop-site and, from ticket 2.5, ssd-workshop-apps", () => {
    const oacs = ofType("AWS::CloudFront::OriginAccessControl");
    expect(oacs.map(([, , r]) => (r.Properties?.OriginAccessControlConfig as { Name?: string }).Name).sort()).toEqual(["ssd-workshop-apps", "ssd-workshop-site"]);
  });

  it("retains the Origin Access Controls (the deploy rights cannot update or delete one)", () => {
    const oacs = ofType("AWS::CloudFront::OriginAccessControl");
    expect(oacs).toHaveLength(2);
    for (const [, , oac] of oacs) expect(oac).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
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
    expect(names.sort()).toEqual([ASSETS_BUCKET_NAME, SITE_BUCKET_NAME, APPS_BUCKET_NAME].sort());
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

  it("uploads the pages built at synth time: the page, its stylesheet, app.js and diagram.js (ticket 1.9), the 404 page (ticket 2.5), no TypeScript or tests (ticket 1.6)", () => {
    // The built folder in the assembly, and the asset CDK staged from it (same content).
    const site = ["404.html", "app.js", "diagram.js", "index.html", "style.css"];
    expect(readdirSync(join(dir, WEB_BUILD_FOLDER)).sort()).toEqual(site);
    const staged = readdirSync(dir).filter((name) => name.startsWith("asset.") && existsSync(join(dir, name, "app.js")) && existsSync(join(dir, name, "style.css")));
    expect(staged).toHaveLength(1);
    expect(readdirSync(join(dir, staged[0] ?? "")).sort()).toEqual(site);
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

    // Three origins: the site bucket (default), from ticket 1.2 the HTTP API, from ticket 2.5 the apps bucket.
    const origins = config.Origins as Record<string, unknown>[];
    expect(origins).toHaveLength(3);
    const siteOrigin = origins.find((o) => o.DomainName === SITE_BUCKET_REGIONAL_DOMAIN);
    expect(siteOrigin).toBeDefined();
    expect(siteOrigin?.OriginAccessControlId).toBeDefined();
    expect((config.DefaultCacheBehavior as Record<string, unknown>).TargetOriginId).toBe(siteOrigin?.Id);
    expect(ofType("AWS::CloudFront::OriginAccessControl")).toHaveLength(2);
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
    // /api/*, the data API's /api/apps/* (ticket 2.4) and the apps' /apps/* (ticket 2.5), in this order.
    expect(behaviours.map((b) => b.PathPattern)).toEqual(["/api/apps/*", "/api/*", "/apps/*"]);
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
    for (const type of ["AWS::CloudFront::CachePolicy", "AWS::CloudFront::OriginRequestPolicy"]) {
      expect(ofType(type), type).toEqual([]);
    }
    // The one CloudFront Function is the apps' (ticket 2.5), on /apps/* only.
    expect(ofType("AWS::CloudFront::Function").map(([, , r]) => r.Properties?.Name)).toEqual([APPS_INDEX_FUNCTION_NAME]);
    // The pages' headers policy (ticket 1.6), the data API's (ticket 2.4) and the apps' (ticket 2.5) are the
    // only custom CloudFront policies, and /api/* keeps the managed SecurityHeadersPolicy (asserted above).
    const custom = ofType("AWS::CloudFront::ResponseHeadersPolicy");
    expect(custom.map(([, , r]) => (r.Properties?.ResponseHeadersPolicyConfig as { Name?: string }).Name).sort()).toEqual(
      [APP_DATA_HEADERS_POLICY_NAME, APPS_HEADERS_POLICY_NAME, PAGES_HEADERS_POLICY_NAME].sort(),
    );
    for (const [, id] of custom) expect(JSON.stringify(apiBehaviour())).not.toContain(id);
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

describe("CloudFront /api/apps/* behaviour: every data API answer readable by sandboxed apps, throttles included (ticket 2.4)", () => {
  const distributionConfig = (): Record<string, unknown> =>
    ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as Record<string, unknown>;
  const behaviour = (pattern: string): Record<string, unknown> | undefined =>
    (distributionConfig().CacheBehaviors as Record<string, unknown>[]).find((b) => b.PathPattern === pattern);
  const policy = () =>
    ofType("AWS::CloudFront::ResponseHeadersPolicy").find(
      ([, , r]) => (r.Properties?.ResponseHeadersPolicyConfig as { Name?: string }).Name === APP_DATA_HEADERS_POLICY_NAME,
    );
  const config = (): Record<string, Record<string, unknown>> =>
    policy()?.[2].Properties?.ResponseHeadersPolicyConfig as Record<string, Record<string, unknown>>;

  it("sends /api/apps/* to the API exactly like /api/*, matched first, with its own headers policy", () => {
    const apps = behaviour("/api/apps/*");
    const api = behaviour("/api/*");
    const behaviours = distributionConfig().CacheBehaviors as Record<string, unknown>[];
    expect(behaviours.indexOf(apps ?? {})).toBeLessThan(behaviours.indexOf(api ?? {}));
    const without = (b: Record<string, unknown> | undefined) =>
      Object.fromEntries(Object.entries(b ?? {}).filter(([name]) => name !== "PathPattern" && name !== "ResponseHeadersPolicyId"));
    const [appsRest, apiRest] = [without(apps), without(api)];
    const [appsPolicy, apiPolicy] = [apps?.ResponseHeadersPolicyId, api?.ResponseHeadersPolicyId];
    // Same origin, methods, HTTPS only, caching disabled, origin request policy.
    expect(appsRest).toEqual(apiRest);
    expect(appsRest).toMatchObject({ ViewerProtocolPolicy: "https-only", CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac" });
    expect((distributionConfig().Origins as unknown[]).length).toBe(3);
    expect(apiPolicy).toBe("67f7725c-6f97-4210-82d7-5512b31e9d03");
    expect(appsPolicy).toEqual({ Ref: policy()?.[1] });
  });

  it("names the policy ssd-workshop-app-data-v1 in the edge stack, retained, versioned in its logical id", () => {
    const [stackName, id, resource] = policy() ?? [];
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(APP_DATA_HEADERS_POLICY_NAME).toBe("ssd-workshop-app-data-v1");
    expect(id).toMatch(/^AppDataHeadersV1[0-9A-F]{8}$/);
    expect(resource?.DeletionPolicy).toBe("Retain");
    expect(resource?.UpdateReplacePolicy).toBe("Retain");
  });

  it("adds Access-Control-Allow-Origin: * to every answer, replacing the function's own (one header), never with credentials, like the function's preflight", () => {
    expect(config().CorsConfig).toEqual({
      AccessControlAllowOrigins: { Items: ["*"] },
      AccessControlAllowCredentials: false,
      AccessControlAllowMethods: { Items: ["GET", "PUT", "DELETE"] },
      AccessControlAllowHeaders: { Items: ["content-type", "accept"] },
      AccessControlMaxAgeSec: 600,
      OriginOverride: true,
    });
    // The same values the function answers the preflight with.
    expect((config().CorsConfig?.AccessControlAllowMethods as { Items: string[] }).Items.join(", ")).toBe(PREFLIGHT_HEADERS["access-control-allow-methods"]);
    expect((config().CorsConfig?.AccessControlAllowHeaders as { Items: string[] }).Items.join(", ")).toBe(PREFLIGHT_HEADERS["access-control-allow-headers"]);
    expect(String(config().CorsConfig?.AccessControlMaxAgeSec)).toBe(PREFLIGHT_HEADERS["access-control-max-age"]);
    expect(PREFLIGHT_HEADERS["access-control-allow-origin"]).toBe("*");
    expect(config().CorsConfig?.AccessControlExposeHeaders).toBeUndefined();
    expect(JSON.stringify(config())).not.toMatch(/"AccessControlAllowCredentials":true/);
  });

  it("keeps the managed SecurityHeadersPolicy's headers (HSTS one year, nosniff, SAMEORIGIN, XSS block, referrer), without a CSP or custom headers", () => {
    expect(config().SecurityHeadersConfig).toEqual({
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: false },
      ContentTypeOptions: { Override: false },
      FrameOptions: { FrameOption: "SAMEORIGIN", Override: false },
      XSSProtection: { Protection: true, ModeBlock: true, Override: false },
      ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: false },
    });
    expect(config().CustomHeadersConfig).toBeUndefined();
  });
});

describe("pages' response headers (ticket 1.6 criterion 5)", () => {
  const policies = (): [string, string, Resource][] =>
    ofType("AWS::CloudFront::ResponseHeadersPolicy").filter(
      ([, , r]) => (r.Properties?.ResponseHeadersPolicyConfig as { Name?: string }).Name === PAGES_HEADERS_POLICY_NAME,
    );
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
      "GET /api/conversation",
      "POST /api/conversation/step",
      "GET /api/conversation/spec",
      "POST /api/conversation/spec/approve",
      "GET /api/build",
      "GET /api/apps/{nickname}/data/{key}",
      "PUT /api/apps/{nickname}/data/{key}",
      "DELETE /api/apps/{nickname}/data/{key}",
      "OPTIONS /api/apps/{nickname}/data/{key}",
    ]);
    const health = routes.find(([, , r]) => r.Properties?.RouteKey === "GET /api/health")?.[2];
    const integrationId = (health?.Properties?.Target as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1][1] as {
      Ref: string;
    };
    const integration = apiResources().find(([id]) => id === integrationId.Ref)?.[1];
    expect(ofType("AWS::ApiGatewayV2::Integration")).toHaveLength(6);
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
      APP_DATA_FUNCTION_NAME,
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
    expect(stage?.Properties?.RouteSettings).toMatchObject({
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

describe("api stack: data API for apps (ticket 2.4)", () => {
  const f = apiFunction(APP_DATA_FUNCTION_NAME);

  it("names the function, role and log group ssd-workshop-api-app-data; Node.js 22 arm64, tagged, role on /ssd-workshop/ with the boundary", () => {
    expect(APP_DATA_FUNCTION_NAME).toBe("ssd-workshop-api-app-data");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 256,
      Timeout: 10,
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    expect(tagsOf(f.fnEntry()?.[1] as Resource).project).toBe("ssd-workshop");
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({
      LogGroupName: APP_DATA_FUNCTION_NAME,
      RetentionInDays: 14,
    });
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(f.roleEntry()?.[1].Properties?.ManagedPolicyArns).toBeUndefined();
    expect(tagsOf(f.roleEntry()?.[1] as Resource).project).toBe("ssd-workshop");
  });

  it("routes GET, PUT, DELETE and OPTIONS /api/apps/{nickname}/data/{key} to it, invoked only by this API", () => {
    const keys = APP_DATA_METHODS.map((method) => `${method} ${APP_DATA_PATH}`);
    expect(keys).toEqual([...APP_DATA_ROUTE_KEYS]);
    for (const routeKey of keys) {
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

  it("leaves OPTIONS to the function: the HTTP API has no CORS configuration that would answer it first", () => {
    for (const [, , api] of ofType("AWS::ApiGatewayV2::Api")) expect(api.Properties?.CorsConfiguration).toBeUndefined();
  });

  it("allows only its logs, GetItem in APP# and APPDATA#, and writes in APPDATA# of the data items' attributes only (never the live marker)", () => {
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
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*", "APPDATA#*"] } },
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPDATA#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "type", "value", "bytes", "keys", "updatedAt", "writeDay", "writtenBytes", "sizes"] },
        },
      },
    ]);
    // The live marker lives in `APP#<nickname>` and needs `liveAt`: no write right reaches either.
    const writes = f.statements().filter((s) => JSON.stringify(s.Action).match(/dynamodb:(Put|Update|Delete|BatchWrite)/));
    for (const statement of writes) {
      const condition = statement.Condition as Record<string, Record<string, string[]>>;
      expect(condition["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]).toEqual(["APPDATA#*"]);
      expect(condition["ForAllValues:StringEquals"]?.["dynamodb:Attributes"]).not.toContain("liveAt");
    }
    // `APP#*` in IAM's StringLike does not match an `APPDATA#` key, and the reverse.
    const like = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value);
    expect(like("APPDATA#*", "APP#ada")).toBe(false);
    expect(like("APP#*", "APPDATA#ada")).toBe(false);
    expect(like("APPDATA#*", "APPDATA#ada")).toBe(true);
  });

  it("throttles PUT and DELETE at 30 requests/s (burst 60), GET and OPTIONS at 20/s (burst 40), after the routes exist", () => {
    expect(APP_DATA_WRITE_THROTTLE).toEqual({ rateLimit: 30, burstLimit: 60 });
    expect(APP_DATA_READ_THROTTLE).toEqual({ rateLimit: 20, burstLimit: 40 });
    expect(APP_DATA_PREFLIGHT_THROTTLE).toEqual({ rateLimit: 20, burstLimit: 40 });
    const [, stage] = f.apiResources().find(([, r]) => r.Type === "AWS::ApiGatewayV2::Stage") ?? [];
    // Every route setting of the stage, exactly: the sign-in routes' and the data API's.
    expect(stage?.Properties?.RouteSettings).toEqual({
      "POST /api/sign-in/code": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "POST /api/sign-in/verify": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      [`PUT ${APP_DATA_PATH}`]: { ThrottlingRateLimit: 30, ThrottlingBurstLimit: 60 },
      [`DELETE ${APP_DATA_PATH}`]: { ThrottlingRateLimit: 30, ThrottlingBurstLimit: 60 },
      [`GET ${APP_DATA_PATH}`]: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      [`OPTIONS ${APP_DATA_PATH}`]: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const routeId = f
        .apiResources()
        .find(([, r]) => r.Type === "AWS::ApiGatewayV2::Route" && r.Properties?.RouteKey === `${method} ${APP_DATA_PATH}`)?.[0];
      expect(routeId, method).toBeDefined();
      expect([stage?.DependsOn].flat(), method).toContain(routeId);
    }
  });

  it("bundles the handler into a self-contained index.js that answers the preflight with CORS, without the table", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string }) => Promise<{ statusCode: number; headers?: Record<string, string> }> }>();
    const answer = await quietly(() => bundle.handler({ routeKey: `OPTIONS ${APP_DATA_PATH}` }));
    expect(answer.statusCode).toBe(204);
    expect(answer.headers?.["access-control-allow-origin"]).toBe("*");
  });
});

describe("api stack: conversation queue (ticket 1.7)", () => {
  const queues = () => resources(STACK_NAMES.api).filter(([, r]) => r.Type === "AWS::SQS::Queue");
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

  it("hides a job just longer than the worker's timeout and moves it to the dead-letter queue after 3 receives", () => {
    expect(AI_WORKER_TIMEOUT_SECONDS).toBe(300);
    expect(queue(AI_QUEUE_NAME)?.[1].Properties).toMatchObject({
      VisibilityTimeout: AI_QUEUE_VISIBILITY_SECONDS,
      RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [queue(AI_DLQ_NAME)?.[0], "Arn"] }, maxReceiveCount: AI_QUEUE_MAX_RECEIVES },
    });
    expect(AI_QUEUE_VISIBILITY_SECONDS).toBe(330);
    expect(AI_QUEUE_MAX_RECEIVES).toBe(3);
  });

  it("delivers a crashed job again, up to the last receive, while its message is still pending (not stale)", () => {
    // SQS refuses a Lambda source whose visibility timeout is shorter than the function's timeout.
    expect(AI_QUEUE_VISIBILITY_SECONDS).toBeGreaterThan(AI_WORKER_TIMEOUT_SECONDS);
    // The last delivery starts after (receives - 1) visibility timeouts and may run the full timeout.
    const lastRunEnds = (AI_QUEUE_MAX_RECEIVES - 1) * AI_QUEUE_VISIBILITY_SECONDS + AI_WORKER_TIMEOUT_SECONDS;
    expect(lastRunEnds).toBe(960);
    expect(lastRunEnds).toBeLessThan(STALE_PENDING_SECONDS);
    // The AI calls stop before the timeout, leaving the write reserve for the final write and its retries.
    expect(WRITE_RESERVE_MS).toBeLessThan(AI_WORKER_TIMEOUT_SECONDS * 1000);
  });

  it("feeds the worker one job at a time, at most 5 workers at once, through a tagged event source mapping", () => {
    const mappings = ofType("AWS::Lambda::EventSourceMapping").filter(([s]) => s === STACK_NAMES.api);
    expect(mappings).toHaveLength(1);
    const worker = apiFunction(AI_WORKER_FUNCTION_NAME);
    expect(AI_WORKER_MAX_CONCURRENCY).toBe(5);
    expect(mappings[0]?.[2].Properties).toMatchObject({
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 5 },
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

  it("routes the message, poll, history, step, spec and approve routes to it, invoked only by this API", () => {
    expect([...CONVERSATION_ROUTE_KEYS]).toEqual([
      "POST /api/conversation/messages",
      "GET /api/conversation/messages/{id}",
      "GET /api/conversation",
      "POST /api/conversation/step",
      "GET /api/conversation/spec",
      "POST /api/conversation/spec/approve",
      "GET /api/build",
    ]);
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

  it("allows only its logs, GetItem on sessions and participants, Query and updates of listed attributes in participants, and sends to the queue", () => {
    expect(f.statements()).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] } },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*", "BUILD#*"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:Query",
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] } },
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
              "approvedSpecVersion", "latestSpecVersion", "approvedAt", "buildId",
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

  it("allows only its logs, reads and updates of listed attributes in participants, new builds of listed attributes, the one model, sending to the launch queue and consuming its queue", () => {
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
          "ForAllValues:StringEquals": { "dynamodb:Attributes": expect.not.arrayContaining(["approved", "approvedTextHash", "approvedAt", "role", "group", "nickname", "id"]) },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "type", "buildId", "nickname", "participantId", "status", "createdAt", "updatedAt"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
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
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: `arn:aws:sqs:${REGION}:${ACCOUNT}:ssd-workshop-builds.fifo` },
      {
        Effect: "Allow",
        Action: ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        Resource: queueArn,
      },
    ]);
    // Each forbidden name on its own (not.arrayContaining only fails when all of them are listed). The
    // approval marker skips the guardrail check: neither Lambda role may write it.
    const workerUpdate = f.statements().find(
      (st) => st.Action === "dynamodb:UpdateItem" && JSON.stringify(st).includes("PARTICIPANT#*"),
    ) as { Condition: { "ForAllValues:StringEquals": { "dynamodb:Attributes": string[] } } } | undefined;
    const conversationUpdate = apiFunction(CONVERSATION_FUNCTION_NAME).statements().find((st) => st.Action === "dynamodb:UpdateItem") as typeof workerUpdate;
    for (const update of [workerUpdate, conversationUpdate]) {
      const names = update?.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"];
      expect(names?.length).toBeGreaterThan(5);
      for (const forbidden of ["approved", "approvedTextHash", "role", "group", "nickname", "id"]) expect(names, forbidden).not.toContain(forbidden);
    }
    // Ticket 1.9: only the AI worker makes spec versions (readers require specVersion), and only the
    // participant's Approve spec (the conversation function) approves one (approvedAt). Ticket 2.7: the worker's
    // readiness outcome moves the step (approved to building, or back to spec) and clears approvedSpecVersion after a
    // failed check, each conditional on the step being approved with that version approved; it never sets approvedAt.
    const workerNames = workerUpdate?.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"];
    const conversationNames = conversationUpdate?.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"];
    expect(workerNames).toContain("specVersion");
    expect(conversationNames).not.toContain("specVersion");
    expect(workerNames).not.toContain("approvedAt");
    expect(conversationNames).toContain("approvedAt");
    for (const name of ["step", "approvedSpecVersion", "buildId"]) expect(workerNames, name).toContain(name);
    // The worker's build rights never reach the deployer's or the builder's attributes.
    const buildNames = AI_WORKER_BUILD_UPDATE_ATTRIBUTES as readonly string[];
    for (const name of ["deployedCommit", "failureReasons", "finishedAt", "pushedCommit"]) expect(buildNames, name).not.toContain(name);
  });

  it("the launch queue (ticket 2.7): FIFO ssd-workshop-builds.fifo with SQS-managed encryption and a FIFO dead-letter queue, tagged; only the AI worker may send to it", () => {
    const buildsQueues = resources(STACK_NAMES.builds).filter(([, r]) => r.Type === "AWS::SQS::Queue");
    const byName = (name: string) => buildsQueues.find(([, r]) => r.Properties?.QueueName === name);
    expect(BUILD_QUEUE_NAME).toBe("ssd-workshop-builds.fifo");
    expect(byName(BUILD_QUEUE_NAME)?.[1].Properties).toMatchObject({
      FifoQueue: true,
      ContentBasedDeduplication: false,
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 86_400,
      VisibilityTimeout: BUILD_QUEUE_VISIBILITY_SECONDS,
      RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [byName(BUILD_DLQ_NAME)?.[0], "Arn"] }, maxReceiveCount: BUILD_QUEUE_MAX_RECEIVES },
    });
    expect(byName(BUILD_DLQ_NAME)?.[1].Properties).toMatchObject({ FifoQueue: true, SqsManagedSseEnabled: true, MessageRetentionPeriod: 1_209_600 });
    for (const name of [BUILD_QUEUE_NAME, BUILD_DLQ_NAME]) expect(tagsOf(must(byName(name))[1]).project, name).toBe("ssd-workshop");
    // Ticket 2.9 adds the check queue (the schedule's trigger, its own sender, tested below).
    expect(buildsQueues).toHaveLength(3);
    expect(PLATFORM_BUILD_QUEUE_NAME).toBe(BUILD_QUEUE_NAME);

    // Senders: every allowing statement in every stack that may SendMessage to it is the AI worker's own.
    const queueIds = [BUILD_QUEUE_NAME, BUILD_DLQ_NAME].map((name) => must(byName(name))[0]);
    const queueArn = `arn:aws:sqs:${REGION}:${ACCOUNT}:${BUILD_QUEUE_NAME}`;
    const reaches = (resource: unknown): boolean => resourceReaches(resource, [queueArn], queueIds, ["ssd-workshop-builds"]);
    for (const pattern of ["*", "arn:aws:sqs:*", "arn:aws:sqs:*:*:ssd-workshop-build*", "arn:aws:sqs:eu-central-1:*:*.fifo"]) expect(reaches(pattern), pattern).toBe(true);
    expect(reaches(`arn:aws:sqs:${REGION}:${ACCOUNT}:${AI_QUEUE_NAME}`)).toBe(false);
    const workerRoleId = f.roleEntry()?.[0];
    const senders: string[] = [];
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (st.Effect !== "Allow") continue;
        if (!([st.Action].flat() as string[]).some((g) => actionCovers(g, "sqs:SendMessage"))) continue;
        if (![st.Resource].flat().some(reaches)) continue;
        senders.push(`${s}/${id}`);
        expect(JSON.stringify(r.Properties?.Roles), `${s}/${id}`).toBe(JSON.stringify([{ Ref: workerRoleId }]));
      }
    }
    expect(senders).toHaveLength(1);
    expect(resources(STACK_NAMES.builds).filter(([, r]) => r.Type === "AWS::SQS::QueuePolicy")).toEqual([]);
  });

  it("bundles the handler into a self-contained index.js that skips a malformed job without any AWS call", async () => {
    const bundle = f.bundle<{ handler: (event: { Records: { body: string }[] }) => Promise<void> }>();
    await expect(quietly(() => bundle.handler({ Records: [{ body: "not json" }] }))).resolves.toBeUndefined();
  });
});

describe("builds stack: network, cluster and image repository (ticket 2.1)", () => {
  const buildsResources = () => resources(STACK_NAMES.builds);
  const buildsOfType = (type: string) => buildsResources().filter(([, r]) => r.Type === type);
  const nameTag = (r: Resource) => tagsOf(r).Name;

  it("creates one VPC ssd-workshop-builds with DNS, tagged project=ssd-workshop (criterion 1)", () => {
    const vpcs = buildsOfType("AWS::EC2::VPC");
    expect(vpcs).toHaveLength(1);
    const [, vpc] = vpcs[0] as [string, Resource];
    expect(vpc.Properties).toMatchObject({ CidrBlock: BUILDS_VPC_CIDR, EnableDnsSupport: true, EnableDnsHostnames: true });
    expect(nameTag(vpc)).toBe(BUILDS_VPC_NAME);
    expect(tagsOf(vpc).project).toBe("ssd-workshop");
    expect(ofType("AWS::EC2::VPC")).toHaveLength(1);
  });

  it("creates exactly two public subnets in two different zones, named ssd-workshop-* and tagged (criterion 1)", () => {
    const subnets = buildsOfType("AWS::EC2::Subnet");
    expect(subnets).toHaveLength(2);
    const zones = subnets.map(([, r]) => r.Properties?.AvailabilityZone);
    expect([...zones].sort()).toEqual([...BUILDS_AVAILABILITY_ZONES]);
    expect(BUILDS_AVAILABILITY_ZONES).toEqual(["eu-central-1a", "eu-central-1b"]);
    for (const [id, r] of subnets) {
      expect(nameTag(r), id).toMatch(/^ssd-workshop-/);
      expect(tagsOf(r).project, id).toBe("ssd-workshop");
      // Tasks ask for a public IP in RunTask; nothing else gets one by default.
      expect(r.Properties?.MapPublicIpOnLaunch, id).toBe(false);
    }
    expect(ofType("AWS::EC2::Subnet")).toHaveLength(2);
  });

  it("routes both subnets to the internet through one tagged internet gateway (public subnets)", () => {
    const gateways = buildsOfType("AWS::EC2::InternetGateway");
    expect(gateways).toHaveLength(1);
    expect(nameTag(gateways[0]?.[1] as Resource)).toMatch(/^ssd-workshop-/);
    const defaultRoutes = buildsOfType("AWS::EC2::Route").filter(
      ([, r]) => r.Properties?.DestinationCidrBlock === "0.0.0.0/0",
    );
    expect(defaultRoutes).toHaveLength(2);
    for (const [id, r] of defaultRoutes) expect(r.Properties?.GatewayId, id).toBeDefined();
    for (const [id, r] of buildsOfType("AWS::EC2::RouteTable")) {
      expect(nameTag(r), id).toMatch(/^ssd-workshop-/);
      expect(tagsOf(r).project, id).toBe("ssd-workshop");
    }
  });

  it("has no NAT gateway, Elastic IP, VPC endpoint, flow log or custom resource, and one Lambda function: the launcher (criterion 1, ticket 2.9)", () => {
    const types = buildsResources().map(([, r]) => r.Type);
    expect(types).not.toContain("AWS::EC2::NatGateway");
    expect(types).not.toContain("AWS::EC2::EIP");
    expect(types).not.toContain("AWS::EC2::VPCEndpoint");
    expect(types).not.toContain("AWS::EC2::FlowLog");
    expect(buildsOfType("AWS::Lambda::Function").map(([, r]) => r.Properties?.FunctionName)).toEqual([BUILD_LAUNCHER_FUNCTION_NAME]);
    expect(buildsOfType("AWS::IAM::Role").map(([, r]) => r.Properties?.RoleName).sort()).toEqual(
      [BUILD_LAUNCHER_FUNCTION_NAME, BUILDER_TASK_ROLE_NAME, BUILDER_EXECUTION_ROLE_NAME, BUILD_CHECK_SCHEDULER_ROLE_NAME].sort(),
    );
    expect(types.filter((t) => t.startsWith("Custom::"))).toEqual([]);
    // CDK's restrictDefaultSecurityGroup would add a custom resource on the untagged default group.
    expect(JSON.stringify(stack(STACK_NAMES.builds).template)).not.toContain("RestrictDefaultSecurityGroup");
    // Nowhere in the app either.
    expect(ofType("AWS::EC2::NatGateway")).toEqual([]);
    expect(ofType("AWS::EC2::VPCEndpoint")).toEqual([]);
  });

  it("creates one security group ssd-workshop-builds in the VPC, tagged (criterion 1)", () => {
    const groups = buildsOfType("AWS::EC2::SecurityGroup");
    expect(groups).toHaveLength(1);
    const [id, group] = groups[0] as [string, Resource];
    expect(group.Properties?.GroupName, id).toBe(BUILDS_SECURITY_GROUP_NAME);
    expect(tagsOf(group).project, id).toBe("ssd-workshop");
    const [vpcId] = buildsOfType("AWS::EC2::VPC")[0] as [string, Resource];
    expect(group.Properties?.VpcId).toEqual({ Ref: vpcId });
  });

  it("allows only outgoing TCP 443 to anywhere and nothing incoming (criterion 2)", () => {
    const [, group] = buildsOfType("AWS::EC2::SecurityGroup")[0] as [string, Resource];
    expect(group.Properties?.SecurityGroupEgress).toEqual([
      { CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 443, ToPort: 443, Description: expect.any(String) },
    ]);
    expect(group.Properties?.SecurityGroupIngress).toBeUndefined();
    // No rule added as a separate resource either.
    const types = buildsResources().map(([, r]) => r.Type);
    expect(types).not.toContain("AWS::EC2::SecurityGroupIngress");
    expect(types).not.toContain("AWS::EC2::SecurityGroupEgress");
  });

  it("creates the ECS cluster ssd-workshop-builds without Container Insights or capacity on EC2, tagged (criterion 1)", () => {
    const clusters = buildsOfType("AWS::ECS::Cluster");
    expect(clusters).toHaveLength(1);
    const [id, cluster] = clusters[0] as [string, Resource];
    expect(cluster.Properties?.ClusterName, id).toBe(BUILDS_CLUSTER_NAME);
    expect(tagsOf(cluster).project, id).toBe("ssd-workshop");
    expect(cluster.Properties?.ClusterSettings).toEqual([{ Name: "containerInsights", Value: "disabled" }]);
    const types = buildsResources().map(([, r]) => r.Type);
    expect(types).not.toContain("AWS::ECS::CapacityProvider");
    expect(types).not.toContain("AWS::AutoScaling::AutoScalingGroup");
  });

  it("creates the ECR repository ssd-workshop-builder, retained and tagged (criterion 1)", () => {
    const repos = buildsOfType("AWS::ECR::Repository");
    expect(repos).toHaveLength(1);
    const [id, repo] = repos[0] as [string, Resource];
    expect(repo.Properties?.RepositoryName, id).toBe(BUILDER_REPOSITORY_NAME);
    expect(tagsOf(repo).project, id).toBe("ssd-workshop");
    expect(repo).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    // No repository policy: the access stack denies ecr:SetRepositoryPolicy.
    expect(repo.Properties?.RepositoryPolicyText).toBeUndefined();
  });

  it("scans images on push and keeps at most 5 images (criterion 3)", () => {
    const [, repo] = buildsOfType("AWS::ECR::Repository")[0] as [string, Resource];
    expect(repo.Properties?.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
    const policy = JSON.parse((repo.Properties?.LifecyclePolicy as { LifecyclePolicyText: string }).LifecyclePolicyText) as {
      rules: { selection: Record<string, unknown>; action: { type: string } }[];
    };
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]?.selection).toMatchObject({ tagStatus: "any", countType: "imageCountMoreThan", countNumber: 5 });
    expect(policy.rules[0]?.action).toEqual({ type: "expire" });
    expect(BUILDER_IMAGES_KEPT).toBe(5);
  });
});

describe("builds stack: the GitHub App's secret (ticket 2.6)", () => {
  const secrets = () => ofType("AWS::SecretsManager::Secret");
  /** Actions that read a secret's value (BatchGetSecretValue takes Resource "*" and is checked per secret). */
  const SECRET_READS = ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"];

  it("creates exactly one secret, ssd-workshop-github, in the builds stack, retained and tagged, its value left to Franck", () => {
    expect(secrets()).toHaveLength(1);
    const [s, id, secret] = secrets()[0] as [string, string, Resource];
    expect(s, id).toBe(STACK_NAMES.builds);
    expect(GITHUB_SECRET_NAME).toBe("ssd-workshop-github");
    expect(PLATFORM_GITHUB_SECRET_NAME).toBe(GITHUB_SECRET_NAME);
    expect(secret).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    expect(tagsOf(secret).project).toBe("ssd-workshop");
    // Pinned whole: a change to these properties is an update of the secret, which must be deliberate (decision 2.6).
    expect(secret.Properties).toEqual({
      Name: GITHUB_SECRET_NAME,
      Description: "SSD Workshop GitHub App credentials {appId, privateKey}; Franck loads the value (infra/README.md)",
      GenerateSecretString: {},
      Tags: [{ Key: "project", Value: "ssd-workshop" }],
    });
  });

  it("has no resource policy, no rotation and no other secret resource anywhere", () => {
    for (const type of ["AWS::SecretsManager::ResourcePolicy", "AWS::SecretsManager::RotationSchedule", "AWS::SecretsManager::SecretTargetAttachment"]) {
      expect(ofType(type), type).toEqual([]);
    }
  });

  it("no IAM policy in any stack may read the secret but the build launcher's own GetSecretValue on it (ticket 2.9)", () => {
    const secretIds = secrets().map(([, id]) => id);
    const secretArn = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${GITHUB_SECRET_NAME}-AbCdEf`;
    const reachesSecret = (resource: unknown): boolean => resourceReaches(resource, [secretArn], secretIds, [GITHUB_SECRET_NAME]);
    for (const pattern of ["*", "arn:aws:secretsmanager:*", "arn:aws:secretsmanager:*:*:secret:ssd-*", `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:ssd-workshop-github-??????`]) {
      expect(reachesSecret(pattern), pattern).toBe(true);
    }
    expect(reachesSecret(`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:ssd-workshop-other-*`)).toBe(false);
    expect(actionCovers("secretsmanager:Get*", "secretsmanager:GetSecretValue")).toBe(true);
    const launcherRoleId = must(ofType("AWS::IAM::Role").find(([, , r]) => r.Properties?.RoleName === BUILD_LAUNCHER_FUNCTION_NAME))[1];
    let policies = 0;
    const readers: string[] = [];
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      policies += 1;
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        assertNoExclusions(`${s}/${id}`, st);
        if (st.Effect !== "Allow") continue;
        if (!([st.Action].flat() as string[]).some((g) => SECRET_READS.some((action) => actionCovers(g, action)))) continue;
        if (![st.Resource].flat().some(reachesSecret)) continue;
        readers.push(`${s}/${id}`);
        // The one reader: the launcher's role, GetSecretValue on this secret only.
        expect(s).toBe(STACK_NAMES.builds);
        expect(JSON.stringify(r.Properties?.Roles), `${s}/${id}`).toBe(JSON.stringify([{ Ref: launcherRoleId }]));
        expect(st.Action).toBe("secretsmanager:GetSecretValue");
        expect(st.Resource).toEqual({ Ref: secrets()[0]?.[1] });
      }
    }
    expect(readers).toHaveLength(1);
    expect(policies).toBeGreaterThan(5);
    // No role's inline policies either (CDK puts grants in AWS::IAM::Policy, but a raw role could carry them).
    for (const [s, id, role] of ofType("AWS::IAM::Role")) {
      expect(JSON.stringify(role.Properties?.Policies ?? []), `${s}/${id}`).not.toContain("secretsmanager");
    }
  });
});

describe("builds stack: builder task and launcher (ticket 2.9)", () => {
  const buildsResources = () => resources(STACK_NAMES.builds);
  const buildsOfType = (type: string) => buildsResources().filter(([, r]) => r.Type === type);
  const roleEntry = (name: string) => must(buildsOfType("AWS::IAM::Role").find(([, r]) => r.Properties?.RoleName === name));
  const statementsOf = (name: string) =>
    buildsOfType("AWS::IAM::Policy")
      .filter(([, r]) => JSON.stringify(r.Properties?.Roles) === JSON.stringify([{ Ref: roleEntry(name)[0] }]))
      .flatMap(([, r]) => (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
  const idOf = (type: string, key: string, value: string) => must(buildsOfType(type).find(([, r]) => r.Properties?.[key] === value))[0];
  const arnOf = (id: string) => ({ "Fn::GetAtt": [id, "Arn"] });
  const queueArn = (name: string) => arnOf(idOf("AWS::SQS::Queue", "QueueName", name));
  const tableArn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE_NAME}`]] };
  const taskDefinition = () => must(buildsOfType("AWS::ECS::TaskDefinition")[0]);
  const launcher = () => must(buildsOfType("AWS::Lambda::Function").find(([, r]) => r.Properties?.FunctionName === BUILD_LAUNCHER_FUNCTION_NAME));
  const launcherAsset = (): string => {
    const key = (launcher()[1].Properties?.Code as { S3Key?: string }).S3Key;
    const manifest = JSON.parse(readFileSync(join(dir, `${STACK_NAMES.builds}.assets.json`), "utf8")) as {
      files: Record<string, { source: { path: string }; destinations: Record<string, { objectKey: string }> }>;
    };
    const asset = Object.values(manifest.files).find((f) => Object.values(f.destinations).some((d) => d.objectKey === key));
    return join(dir, must(asset).source.path);
  };
  const filesUnder = (root: string, sub = ""): string[] =>
    readdirSync(join(root, sub), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? filesUnder(root, join(sub, e.name)) : [join(sub, e.name)]))
      .sort();

  it("criterion 1: the builder task's role carries the boundary and may only invoke the build model, write build records and usage counters, and send to the deploy queue", () => {
    const [, role] = roleEntry(BUILDER_TASK_ROLE_NAME);
    expect(role.Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(JSON.stringify(role.Properties?.AssumeRolePolicyDocument)).toContain("ecs-tasks.amazonaws.com");
    expect(role.Properties?.Policies).toBeUndefined();
    expect(role.Properties?.ManagedPolicyArns).toBeUndefined();
    expect(statementsOf(BUILDER_TASK_ROLE_NAME)).toEqual([
      {
        Effect: "Allow",
        Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        Resource: [`arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/eu.anthropic.claude-sonnet-4-6`, "arn:aws:bedrock:eu-*::foundation-model/anthropic.claude-sonnet-4-6"],
      },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...BUILDER_BUILD_READ_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...BUILDER_BUILD_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...BUILDER_USAGE_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      },
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: `arn:aws:sqs:${REGION}:${ACCOUNT}:${DEPLOY_QUEUE_NAME}` },
    ]);
    // The usage writes reach only the token counters: no nickname, status or spec attribute.
    expect([...BUILDER_USAGE_UPDATE_ATTRIBUTES]).not.toContain("nickname");
    expect([...BUILDER_USAGE_UPDATE_ATTRIBUTES]).not.toContain("status");
    // No write to the launcher's triggers (launch and check queues) or its launches partition.
    expect(JSON.stringify(statementsOf(BUILDER_TASK_ROLE_NAME))).not.toContain("ssd-workshop-builds");
    expect(JSON.stringify(statementsOf(BUILDER_TASK_ROLE_NAME))).not.toContain(LAUNCHES_PARTITION);
  });

  it("criterion 1: the task definition holds no secret and no environment; the image is pinned by digest; logs go to /ecs/ssd-workshop-builder", () => {
    const [, td] = taskDefinition();
    expect(td.Properties).toMatchObject({
      Family: BUILDER_TASK_FAMILY,
      Cpu: String(BUILDER_CPU),
      Memory: String(BUILDER_MEMORY_MB),
      NetworkMode: "awsvpc",
      RequiresCompatibilities: ["FARGATE"],
      RuntimePlatform: { CpuArchitecture: "X86_64", OperatingSystemFamily: "LINUX" },
      TaskRoleArn: arnOf(roleEntry(BUILDER_TASK_ROLE_NAME)[0]),
      ExecutionRoleArn: arnOf(roleEntry(BUILDER_EXECUTION_ROLE_NAME)[0]),
    });
    const containers = td.Properties?.ContainerDefinitions as Record<string, unknown>[];
    expect(containers).toHaveLength(1);
    const [container] = containers;
    expect(container?.Name).toBe(BUILDER_CONTAINER_NAME);
    expect(container?.Environment).toBeUndefined();
    expect(container?.Secrets).toBeUndefined();
    expect(container?.EnvironmentFiles).toBeUndefined();
    expect(JSON.stringify(container?.Image)).toContain(`@${BUILDER_IMAGE_DIGEST_UNSET}`);
    expect(JSON.stringify(container?.Image)).toContain(idOf("AWS::ECR::Repository", "RepositoryName", BUILDER_REPOSITORY_NAME));
    const logs = container?.LogConfiguration as { LogDriver: string; Options: Record<string, unknown> };
    expect(logs.LogDriver).toBe("awslogs");
    expect(logs.Options["awslogs-group"]).toEqual({ Ref: idOf("AWS::Logs::LogGroup", "LogGroupName", BUILDER_LOG_GROUP_NAME) });
    expect(BUILDER_LOG_GROUP_NAME).toBe("/ecs/ssd-workshop-builder");
    // The execution role pulls the image and writes the logs: nothing else, and no secret.
    expect(roleEntry(BUILDER_EXECUTION_ROLE_NAME)[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    const repositoryArn = arnOf(idOf("AWS::ECR::Repository", "RepositoryName", BUILDER_REPOSITORY_NAME));
    expect(statementsOf(BUILDER_EXECUTION_ROLE_NAME)).toEqual([
      { Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource: repositoryArn },
      { Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: arnOf(idOf("AWS::Logs::LogGroup", "LogGroupName", BUILDER_LOG_GROUP_NAME)) },
    ]);
  });

  it("refuses an image digest that is not sha256:<64 hex digits>", () => {
    const out = mkdtempSync(join(tmpdir(), "ssd-workshop-cdk-digest-"));
    try {
      expect(() => buildApp({ outdir: out, context: { builderImageDigest: "latest" } })).toThrow(/builderImageDigest/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("the launcher: its own role and log group, memory and timeout; only the task definition and security group in its environment", () => {
    const [, fn] = launcher();
    expect(fn.Properties).toMatchObject({ MemorySize: LAUNCHER_MEMORY_MB, Timeout: LAUNCHER_TIMEOUT_SECONDS, Role: arnOf(roleEntry(BUILD_LAUNCHER_FUNCTION_NAME)[0]) });
    expect(roleEntry(BUILD_LAUNCHER_FUNCTION_NAME)[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(JSON.stringify(roleEntry(BUILD_LAUNCHER_FUNCTION_NAME)[1].Properties?.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");
    const variables = (fn.Properties?.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toEqual({
      BUILDER_TASK_DEFINITION_ARN: { Ref: taskDefinition()[0] },
      BUILDS_SECURITY_GROUP_ID: { "Fn::GetAtt": [idOf("AWS::EC2::SecurityGroup", "GroupName", BUILDS_SECURITY_GROUP_NAME), "GroupId"] },
    });
    const logGroupId = (fn.Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
    expect(buildsResources().find(([id]) => id === logGroupId)?.[1].Properties?.LogGroupName).toBe(BUILD_LAUNCHER_FUNCTION_NAME);
  });

  it("the launcher's rights: the secret, reads and writes by attribute list, RunTask of the builder on the builds cluster only, the dead-letter queues; no send", () => {
    const tasks = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${BUILDS_CLUSTER_NAME}/*`;
    const limited = [...ATTRIBUTE_LIMITED_RETURN_VALUES];
    const queueReads = ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:DeleteMessage", "sqs:GetQueueAttributes"];
    const logGroupId = (launcher()[1].Properties?.LoggingConfig as { LogGroup: { Ref: string } }).LogGroup.Ref;
    expect(statementsOf(BUILD_LAUNCHER_FUNCTION_NAME)).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: arnOf(logGroupId) },
      { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: idOf("AWS::SecretsManager::Secret", "Name", GITHUB_SECRET_NAME) } },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*", "PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAUNCHER_READ_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAUNCHER_BUILD_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": limited },
        },
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [LAUNCHES_PARTITION], "dynamodb:Attributes": [...LAUNCHER_LAUNCH_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": limited },
        },
      },
      {
        Effect: "Allow",
        Action: "ecs:RunTask",
        Resource: { Ref: taskDefinition()[0] },
        Condition: { ArnEquals: { "ecs:cluster": arnOf(idOf("AWS::ECS::Cluster", "ClusterName", BUILDS_CLUSTER_NAME)) } },
      },
      { Effect: "Allow", Action: "ecs:TagResource", Resource: tasks, Condition: { StringEquals: { "ecs:CreateAction": "RunTask" } } },
      { Effect: "Allow", Action: ["ecs:DescribeTasks", "ecs:StopTask"], Resource: tasks },
      {
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: [arnOf(roleEntry(BUILDER_TASK_ROLE_NAME)[0]), arnOf(roleEntry(BUILDER_EXECUTION_ROLE_NAME)[0])],
        Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      },
      { Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage"], Resource: [queueArn(BUILD_DLQ_NAME), `arn:aws:sqs:${REGION}:${ACCOUNT}:${DEPLOY_DLQ_NAME}`] },
      // The event sources' own reads (CDK's grant) on the launch and check queues.
      { Effect: "Allow", Action: queueReads, Resource: queueArn(BUILD_QUEUE_NAME) },
      { Effect: "Allow", Action: queueReads, Resource: queueArn(BUILD_CHECK_QUEUE_NAME) },
    ]);
    // The launches partition cannot overlap the build or participant prefixes.
    expect(LAUNCHES_PARTITION).not.toMatch(/^(BUILD|PARTICIPANT)#/);
  });

  it("nothing but the launcher may RunTask, StartTask, StopTask or pass a role", () => {
    const launcherRole = roleEntry(BUILD_LAUNCHER_FUNCTION_NAME)[0];
    let seen = 0;
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        assertNoExclusions(`${s}/${id}`, st);
        if (st.Effect !== "Allow") continue;
        const actions = [st.Action].flat() as string[];
        if (!actions.some((g) => ["ecs:RunTask", "ecs:StartTask", "ecs:StopTask", "iam:PassRole"].some((a) => actionCovers(g, a)))) continue;
        seen += 1;
        expect(s).toBe(STACK_NAMES.builds);
        expect(JSON.stringify(r.Properties?.Roles), `${s}/${id}`).toBe(JSON.stringify([{ Ref: launcherRole }]));
      }
    }
    expect(seen).toBe(3);
  });

  it("the launch and check queues feed the launcher one message at a time; the launch queue's visibility is just above its timeout", () => {
    const mappings = buildsOfType("AWS::Lambda::EventSourceMapping").map(([, r]) => r.Properties ?? {});
    expect(mappings).toHaveLength(2);
    expect(mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ EventSourceArn: queueArn(BUILD_QUEUE_NAME), BatchSize: 1, ScalingConfig: { MaximumConcurrency: LAUNCHER_MAX_CONCURRENCY } }),
        expect.objectContaining({ EventSourceArn: queueArn(BUILD_CHECK_QUEUE_NAME), BatchSize: 1 }),
      ]),
    );
    for (const m of mappings) expect(m.FunctionName).toEqual({ Ref: launcher()[0] });
    expect(BUILD_QUEUE_VISIBILITY_SECONDS).toBe(LAUNCHER_TIMEOUT_SECONDS + 30);
    expect(LAUNCHER_TIMEOUT_SECONDS * 1000).toBeGreaterThan(LAUNCH_RESERVE_MS * 3);
    expect(must(buildsOfType("AWS::SQS::Queue").find(([, r]) => r.Properties?.QueueName === BUILD_CHECK_QUEUE_NAME))[1].Properties).toMatchObject({
      SqsManagedSseEnabled: true,
      VisibilityTimeout: BUILD_QUEUE_VISIBILITY_SECONDS,
    });
  });

  it("criterion 3: the check runs every minute (Scheduler sends to the check queue; its role may send only there)", () => {
    const schedule = must(buildsOfType("AWS::Scheduler::Schedule")[0])[1];
    expect(schedule.Properties).toMatchObject({
      Name: BUILD_CHECK_SCHEDULE_NAME,
      ScheduleExpression: "rate(1 minute)",
      State: "ENABLED",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: { Arn: queueArn(BUILD_CHECK_QUEUE_NAME), RoleArn: arnOf(roleEntry(BUILD_CHECK_SCHEDULER_ROLE_NAME)[0]) },
    });
    expect(BUILD_CHECK_SCHEDULE).toBe("rate(1 minute)");
    expect(statementsOf(BUILD_CHECK_SCHEDULER_ROLE_NAME)).toEqual([{ Effect: "Allow", Action: "sqs:SendMessage", Resource: queueArn(BUILD_CHECK_QUEUE_NAME) }]);
    expect(roleEntry(BUILD_CHECK_SCHEDULER_ROLE_NAME)[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(JSON.stringify(roleEntry(BUILD_CHECK_SCHEDULER_ROLE_NAME)[1].Properties?.AssumeRolePolicyDocument)).toContain("scheduler.amazonaws.com");
  });

  it("trusts the scheduler only for the default schedule group of this account, and both builder roles for ECS in this account (task role widened after the first live build)", () => {
    const trust = (name: string) => (roleEntry(name)[1].Properties?.AssumeRolePolicyDocument as { Statement: { Principal: unknown; Condition: unknown }[] }).Statement;
    expect(trust(BUILD_CHECK_SCHEDULER_ROLE_NAME)).toEqual([
      expect.objectContaining({
        Principal: { Service: "scheduler.amazonaws.com" },
        Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT, "aws:SourceArn": `arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule-group/default` } },
      }),
    ]);
    const sources: [string, string][] = [
      [BUILDER_TASK_ROLE_NAME, `arn:aws:ecs:${REGION}:${ACCOUNT}:*`],
      // The form AWS documents for task execution roles (the confused-deputy condition): ECS in this account only.
      [BUILDER_EXECUTION_ROLE_NAME, `arn:aws:ecs:${REGION}:${ACCOUNT}:*`],
    ];
    for (const [name, sourceArn] of sources) {
      expect(trust(name), name).toEqual([
        expect.objectContaining({
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT }, ArnLike: { "aws:SourceArn": sourceArn } },
        }),
      ]);
    }
  });

  it("WHEN a handed-over build waits for its deploy THEN the check gives it longer than every delivery of the deploy message (checker 1)", () => {
    const lastDelivery = ((DEPLOY_QUEUE_MAX_RECEIVES - 1) * DEPLOY_QUEUE_VISIBILITY_SECONDS + DEPLOYER_TIMEOUT_SECONDS) * 1000;
    expect(HANDED_OVER_GRACE_MS).toBeGreaterThan(2 * lastDelivery);
  });

  it("bundles the launcher with templates/basic as template/, file for file", () => {
    const bundled = join(launcherAsset(), "template");
    expect(existsSync(join(launcherAsset(), "index.js"))).toBe(true);
    const files = filesUnder(TEMPLATE_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(filesUnder(bundled)).toEqual(files);
    for (const file of files) expect(readFileSync(join(bundled, file)).equals(readFileSync(join(TEMPLATE_DIR, file))), file).toBe(true);
  });

  it("the bundled launcher ignores a record from another queue without any AWS call", async () => {
    const bundle = createRequire(import.meta.url)(join(launcherAsset(), "index.js")) as { handler: (event: unknown) => Promise<void> };
    await expect(quietly(() => bundle.handler({ Records: [{ body: "{}", eventSourceARN: `arn:aws:sqs:${REGION}:${ACCOUNT}:other` }] }))).resolves.toBeUndefined();
  });
});

describe("apps stack: bucket, queue and deployer (ticket 2.5)", () => {
  const appsResources = () => resources(STACK_NAMES.apps);
  const bucketEntry = () => appsResources().find(([, r]) => r.Type === "AWS::S3::Bucket");
  const bucketStatements = () =>
    (appsResources().find(([, r]) => r.Type === "AWS::S3::BucketPolicy")?.[1].Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement;
  const fnEntry = () => appsResources().find(([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties?.FunctionName === DEPLOYER_FUNCTION_NAME);
  const roleEntry = () => appsResources().find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties?.RoleName === DEPLOYER_FUNCTION_NAME);
  const deployerStatements = () =>
    appsResources()
      .filter(([, r]) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles).includes(roleEntry()?.[0] ?? "?"))
      .flatMap(([, r]) => (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
  const queue = (name: string) => appsResources().find(([, r]) => r.Type === "AWS::SQS::Queue" && r.Properties?.QueueName === name);
  const bucketArn = () => ({ "Fn::GetAtt": [bucketEntry()?.[0], "Arn"] });

  it("creates the private apps bucket ssd-workshop-apps-<account>: no public access, ACLs off, encrypted, retained", () => {
    expect(APPS_BUCKET_NAME).toBe(`ssd-workshop-apps-${ACCOUNT}`);
    expect(bucketEntry()?.[1]).toMatchObject({
      DeletionPolicy: "Retain",
      Properties: {
        BucketName: APPS_BUCKET_NAME,
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      },
    });
  });

  it("lets only the workshop's distribution (its exact ARN) read app files, only over TLS", () => {
    const allows = bucketStatements().filter((st) => st.Effect === "Allow");
    expect(allows).toEqual([
      expect.objectContaining({
        Action: "s3:GetObject",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Condition: { StringEquals: { "AWS:SourceAccount": ACCOUNT, "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/${DISTRIBUTION_ID}` } },
      }),
    ]);
    expect(JSON.stringify(bucketStatements())).not.toContain("distribution/*");
    expect(bucketStatements()).toContainEqual(
      expect.objectContaining({ Effect: "Deny", Action: "s3:*", Principal: { AWS: "*" }, Condition: { Bool: { "aws:SecureTransport": "false" } } }),
    );
  });

  it("criterion 4: the bucket policy refuses every object write and delete to any principal but the deployer's role (deploy role and Claude user included)", () => {
    const deny = bucketStatements().find((st) => st.Sid === "OnlyTheDeployerWritesApps");
    expect(deny).toEqual({
      Sid: "OnlyTheDeployerWritesApps",
      Effect: "Deny",
      Action: [...APPS_OBJECT_WRITE_ACTIONS],
      Principal: { AWS: "*" },
      Resource: { "Fn::Join": ["", [bucketArn(), "/*"]] },
      Condition: { ArnNotEquals: { "aws:PrincipalArn": [DEPLOYER_ROLE_ARN, DEPLOYER_ROLE_ARN_WITHOUT_PATH] } },
    });
    for (const action of ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectAcl", "s3:RestoreObject"]) {
      expect(APPS_OBJECT_WRITE_ACTIONS, action).toContain(action);
    }
    expect(DEPLOYER_ROLE_ARN).toBe(`arn:aws:iam::${ACCOUNT}:role/ssd-workshop/ssd-workshop-apps-deployer`);
    expect(DEPLOYER_ROLE_ARN_WITHOUT_PATH).toBe(`arn:aws:iam::${ACCOUNT}:role/ssd-workshop-apps-deployer`);
    // The deployer's role is that ARN: its name and path.
    expect(roleEntry()?.[1].Properties).toMatchObject({ RoleName: DEPLOYER_FUNCTION_NAME, Path: IAM_PATH });
  });

  it("criterion 4: no IAM policy in any stack, other than the deployer's, may write to the apps bucket", () => {
    const writes = (action: string): boolean => action === "*" || /^s3:(\*|Put|Delete|Restore|Replicate|Abort|Object)/i.test(action) || /^s3:.*\*/.test(action);
    const appsBucketIds = appsResources().filter(([, r]) => r.Type === "AWS::S3::Bucket").map(([id]) => id);
    const reachesApps = (resource: unknown): boolean => resourceReaches(resource, APPS_BUCKET_ARNS, appsBucketIds, [APPS_BUCKET_NAME, "ssd-workshop-apps"]);
    const deployerRole = roleEntry()?.[0];
    let checked = 0;
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      const forDeployer = s === STACK_NAMES.apps && JSON.stringify(r.Properties?.Roles) === JSON.stringify([{ Ref: deployerRole }]);
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        assertNoExclusions(`${s}/${id}`, st);
        if (st.Effect !== "Allow") continue;
        const actions = [st.Action].flat() as string[];
        if (!actions.some(writes)) continue;
        checked += 1;
        if (forDeployer) continue;
        for (const resource of [st.Resource].flat()) expect(reachesApps(resource), `${s}/${id}: ${JSON.stringify(st)}`).toBe(false);
      }
    }
    // The BucketDeployment's and the deployer's write statements were seen.
    expect(checked).toBeGreaterThanOrEqual(2);
    // No role carries inline policies of its own (all rights are in AWS::IAM::Policy above), and the only
    // managed policy any role gets is AWS's basic Lambda logging one (the BucketDeployment's; no S3 right).
    for (const [s, id, r] of ofType("AWS::IAM::Role")) {
      expect(r.Properties?.Policies, `${s}/${id}`).toBeUndefined();
      for (const arn of (r.Properties?.ManagedPolicyArns as unknown[] | undefined) ?? []) {
        expect(JSON.stringify(arn), `${s}/${id}`).toMatch(/:iam::aws:policy\/service-role\/AWSLambdaBasicExecutionRole"/);
      }
    }
  });

  it("criterion 4: no IAM policy in any stack, the deployer's included, may change the apps bucket's policy, lifecycle, website, CORS or delete it", () => {
    // The bucket policy denies only object writes (a deny on bucket-level actions could lock CloudFormation out), and the
    // boundary allows s3:* on ssd-workshop-*: the deny holds only while no workload role is granted these (decision "(2.5) Bucket-level actions").
    const bucketActions = ["s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutLifecycleConfiguration", "s3:PutBucketWebsite", "s3:PutBucketCORS", "s3:DeleteBucket"];
    const appsBucketIds = appsResources().filter(([, r]) => r.Type === "AWS::S3::Bucket").map(([id]) => id);
    const reachesAppsBucket = (resource: unknown): boolean => resourceReaches(resource, APPS_BUCKET_ARNS, appsBucketIds, ["ssd-workshop-apps"]);
    // Any wildcard that can name the bucket or an app's key counts, whatever its form.
    for (const pattern of ["*", "arn:aws:s3:::*", "arn:aws:s3:::ssd-*", "arn:*:s3:::ssd-workshop-a?ps-*", "arn:aws:s3:::*/apps/*"]) {
      expect(reachesAppsBucket(pattern), pattern).toBe(true);
    }
    expect(reachesAppsBucket({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":s3:::ssd-*"]] })).toBe(true);
    expect(reachesAppsBucket("arn:aws:s3:::ssd-workshop-site-*")).toBe(false);
    expect(reachesAppsBucket({ "Fn::Sub": "arn:${AWS::Partition}:s3:::ssd-*" })).toBe(true);
    expect(reachesAppsBucket({ "Fn::ImportValue": "SomeExport" })).toBe(true);
    expect(reachesAppsBucket({ "Fn::Sub": "arn:${AWS::Partition}:s3:::ssd-workshop-site-*" })).toBe(false);
    expect(actionCovers("s3:Put*", "s3:PutBucketPolicy")).toBe(true);
    expect(actionCovers("s3:*Bucket*", "s3:DeleteBucket")).toBe(true);
    expect(actionCovers("s3:PutObject", "s3:PutBucketPolicy")).toBe(false);
    let policies = 0;
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      policies += 1;
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        assertNoExclusions(`${s}/${id}`, st);
        if (st.Effect !== "Allow") continue;
        const granted = [st.Action].flat() as string[];
        const covered = bucketActions.filter((action) => granted.some((g) => actionCovers(g, action)));
        if (covered.length === 0) continue;
        for (const resource of [st.Resource].flat()) expect(reachesAppsBucket(resource), `${s}/${id} ${covered.join(",")}: ${JSON.stringify(st)}`).toBe(false);
      }
    }
    expect(policies).toBeGreaterThan(5);
  });

  it("no IAM policy in any stack may send to the deploy queue but the builder task's role (ticket 2.9)", () => {
    const queueIds = appsResources().filter(([, r]) => r.Type === "AWS::SQS::Queue").map(([id]) => id);
    const queueArn = `arn:aws:sqs:${REGION}:${ACCOUNT}:${DEPLOY_QUEUE_NAME}`;
    const reachesDeployQueue = (resource: unknown): boolean => resourceReaches(resource, [queueArn], queueIds, ["ssd-workshop-deploys"]);
    for (const pattern of ["*", "arn:aws:sqs:*", "arn:aws:sqs:*:*:ssd-*", "arn:aws:sqs:eu-central-1:*:*.fifo", "arn:aws:sqs:?u-*:*:ssd-workshop-deploy?.fifo"]) {
      expect(reachesDeployQueue(pattern), pattern).toBe(true);
    }
    expect(reachesDeployQueue({ "Fn::Join": [":", ["arn", { Ref: "AWS::Partition" }, "sqs", { Ref: "AWS::Region" }, { Ref: "AWS::AccountId" }, "ssd-*"]] })).toBe(true);
    expect(reachesDeployQueue(`arn:aws:sqs:${REGION}:${ACCOUNT}:${AI_QUEUE_NAME}`)).toBe(false);
    expect(actionCovers("sqs:Send*", "sqs:SendMessage")).toBe(true);
    expect(actionCovers("*", "sqs:SendMessage")).toBe(true);
    const taskRoleId = must(ofType("AWS::IAM::Role").find(([, , r]) => r.Properties?.RoleName === BUILDER_TASK_ROLE_NAME))[1];
    let sends = 0;
    const senders: string[] = [];
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        assertNoExclusions(`${s}/${id}`, st);
        if (st.Effect !== "Allow") continue;
        if (!([st.Action].flat() as string[]).some((g) => actionCovers(g, "sqs:SendMessage"))) continue;
        sends += 1;
        if (![st.Resource].flat().some(reachesDeployQueue)) continue;
        senders.push(`${s}/${id}`);
        // The one sender: the builder task's role, SendMessage on the deploy queue only.
        expect(s).toBe(STACK_NAMES.builds);
        expect(JSON.stringify(r.Properties?.Roles), `${s}/${id}`).toBe(JSON.stringify([{ Ref: taskRoleId }]));
        expect(st.Action).toBe("sqs:SendMessage");
        expect(st.Resource).toBe(queueArn);
      }
    }
    expect(senders).toHaveLength(1);
    // The conversation function's send to its own queue (ticket 1.7) was seen and passes.
    expect(sends).toBeGreaterThanOrEqual(1);
    expect(appsResources().filter(([, r]) => r.Type === "AWS::SQS::QueuePolicy")).toEqual([]);
  });

  it("criterion 4: the site's BucketDeployment writes to the site bucket only, so it cannot remove app files", () => {
    const deployments = ofType("Custom::CDKBucketDeployment");
    expect(deployments).toHaveLength(1);
    const [s, , deployment] = deployments[0] ?? [];
    expect(s).toBe(STACK_NAMES.site);
    const siteBucket = resources(STACK_NAMES.site).find(([, r]) => r.Type === "AWS::S3::Bucket");
    expect(siteBucket?.[1].Properties?.BucketName).toBe(SITE_BUCKET_NAME);
    expect(deployment?.Properties?.DestinationBucketName).toEqual({ Ref: siteBucket?.[0] });
    expect(JSON.stringify(deployment?.Properties)).not.toContain("ssd-workshop-apps");
    // Its role's rights name the site bucket and the assets bucket, never the apps bucket.
    const role = resources(STACK_NAMES.site).find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties?.RoleName === "ssd-workshop-site-deploy");
    const statements = resources(STACK_NAMES.site)
      .filter(([, r]) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles).includes(role?.[0] ?? "?"))
      .flatMap(([, r]) => (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    expect(statements.length).toBeGreaterThan(0);
    expect(JSON.stringify(statements)).not.toContain("ssd-workshop-apps");
    expect(JSON.stringify(statements)).toContain(siteBucket?.[0]);
  });

  it("gives the deployer only its logs, object writes and deletes under apps/, listing under apps/, one distribution's invalidation, marker and build updates of listed attributes, and its queue", () => {
    const logGroupId = (fnEntry()?.[1].Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
    const statements = deployerStatements();
    expect(statements).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [logGroupId, "Arn"] } },
      { Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject"], Resource: { "Fn::Join": ["", [bucketArn(), "/apps/*"]] } },
      { Effect: "Allow", Action: "s3:ListBucket", Resource: bucketArn(), Condition: { StringLike: { "s3:prefix": ["apps/*"] } } },
      { Effect: "Allow", Action: "cloudfront:CreateInvalidation", Resource: `arn:aws:cloudfront::${ACCOUNT}:distribution/${DISTRIBUTION_ID}` },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: expect.anything(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "type", "nickname", "liveAt"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: expect.anything(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "status", "nickname", "pushedCommit", "updatedAt", "finishedAt", "deployedCommit", "failureReasons"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      },
      {
        Effect: "Allow",
        Action: ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        Resource: { "Fn::GetAtt": [queue(DEPLOY_QUEUE_NAME)?.[0], "Arn"] },
      },
    ]);
    // The table by name in this account and region, not across stacks.
    for (const st of statements.filter((st) => st.Action === "dynamodb:UpdateItem")) {
      expect(st.Resource).toEqual({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE_NAME}`]] });
    }
    expect(DISTRIBUTION_ID).toBe("E2TOZV0ERAXKZ9");
    // The live marker needs `liveAt` (the data API requires it); no other role may write it, and the deployer never writes app data.
    expect(DEPLOYER_LIVE_UPDATE_ATTRIBUTES).toContain("liveAt");
    expect(JSON.stringify(statements)).not.toContain("APPDATA#");
    expect(JSON.stringify(statements)).not.toMatch(/dynamodb:(PutItem|DeleteItem|GetItem|Query|Scan|BatchWriteItem)/);
  });

  it("names the function, role and log group ssd-workshop-apps-deployer; Node.js 22 arm64, 512 MB, 120 s; role on /ssd-workshop/ with the boundary; no route or invoke permission", () => {
    expect(DEPLOYER_FUNCTION_NAME).toBe("ssd-workshop-apps-deployer");
    expect(fnEntry()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: DEPLOYER_MEMORY_MB,
      Timeout: DEPLOYER_TIMEOUT_SECONDS,
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    expect([DEPLOYER_MEMORY_MB, DEPLOYER_TIMEOUT_SECONDS]).toEqual([512, 120]);
    const logGroupId = (fnEntry()?.[1].Properties?.LoggingConfig as { LogGroup?: { Ref?: string } }).LogGroup?.Ref;
    expect(appsResources().find(([id]) => id === logGroupId)?.[1].Properties).toMatchObject({ LogGroupName: DEPLOYER_FUNCTION_NAME, RetentionInDays: 14 });
    expect(roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(appsResources().filter(([, r]) => r.Type === "AWS::Lambda::Permission")).toEqual([]);
  });

  it("creates the FIFO queue ssd-workshop-deploys.fifo (deduplication by the sender's build id) and its FIFO dead-letter queue, encrypted, tagged, without a queue policy", () => {
    expect(DEPLOY_QUEUE_NAME).toBe("ssd-workshop-deploys.fifo");
    expect(DEPLOY_DLQ_NAME).toBe("ssd-workshop-deploys-dlq.fifo");
    expect(queue(DEPLOY_QUEUE_NAME)?.[1].Properties).toMatchObject({
      FifoQueue: true,
      ContentBasedDeduplication: false,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: DEPLOY_QUEUE_VISIBILITY_SECONDS,
      RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [queue(DEPLOY_DLQ_NAME)?.[0], "Arn"] }, maxReceiveCount: DEPLOY_QUEUE_MAX_RECEIVES },
    });
    expect(queue(DEPLOY_DLQ_NAME)?.[1].Properties).toMatchObject({ FifoQueue: true, SqsManagedSseEnabled: true });
    for (const name of [DEPLOY_QUEUE_NAME, DEPLOY_DLQ_NAME]) expect(tagsOf(queue(name)?.[1] as Resource).project).toBe("ssd-workshop");
    // SQS refuses a Lambda source whose visibility timeout is shorter than the function's timeout.
    expect(DEPLOY_QUEUE_VISIBILITY_SECONDS).toBeGreaterThan(DEPLOYER_TIMEOUT_SECONDS);
    expect(appsResources().filter(([, r]) => r.Type === "AWS::SQS::QueuePolicy")).toEqual([]);
  });

  it("feeds the deployer one message at a time, at most 5 at once, through a tagged event source mapping", () => {
    const mappings = appsResources().filter(([, r]) => r.Type === "AWS::Lambda::EventSourceMapping");
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.[1].Properties).toMatchObject({
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: DEPLOYER_MAX_CONCURRENCY },
      EventSourceArn: { "Fn::GetAtt": [queue(DEPLOY_QUEUE_NAME)?.[0], "Arn"] },
      FunctionName: { Ref: fnEntry()?.[0] },
      Tags: [{ Key: "project", Value: "ssd-workshop" }],
    });
  });

  it("keeps the platform's settings equal to the infrastructure's (bucket, distribution, queue, deliveries)", () => {
    expect(PLATFORM_APPS_BUCKET_NAME).toBe(APPS_BUCKET_NAME);
    expect(PLATFORM_DISTRIBUTION_ID).toBe(DISTRIBUTION_ID);
    expect(PLATFORM_DEPLOY_QUEUE_NAME).toBe(DEPLOY_QUEUE_NAME);
    expect(PLATFORM_DEPLOY_MAX_RECEIVES).toBe(DEPLOY_QUEUE_MAX_RECEIVES);
  });

  it("bundles the handler into a self-contained index.js that drops a malformed message without any AWS call", async () => {
    const key = (fnEntry()?.[1].Properties?.Code as { S3Key?: string } | undefined)?.S3Key;
    const manifest = JSON.parse(readFileSync(join(dir, `${STACK_NAMES.apps}.assets.json`), "utf8")) as {
      files: Record<string, { source: { path: string }; destinations: Record<string, { objectKey: string }> }>;
    };
    const asset = Object.values(manifest.files).find((f) => Object.values(f.destinations).some((d) => d.objectKey === key));
    expect(asset).toBeDefined();
    const bundle = createRequire(import.meta.url)(join(dir, asset?.source.path ?? "?", "index.js")) as {
      handler: (event: { Records: { body: string }[] }) => Promise<void>;
    };
    await expect(quietly(() => bundle.handler({ Records: [{ body: "not json" }] }))).resolves.toBeUndefined();
  });
});

describe("CloudFront /apps/* behaviour (ticket 2.5)", () => {
  const distributionConfig = (): Record<string, unknown> =>
    ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as Record<string, unknown>;
  const behaviour = () => (distributionConfig().CacheBehaviors as Record<string, unknown>[]).find((b) => b.PathPattern === "/apps/*");
  const policy = () =>
    ofType("AWS::CloudFront::ResponseHeadersPolicy").find(
      ([, , r]) => (r.Properties?.ResponseHeadersPolicyConfig as { Name?: string }).Name === APPS_HEADERS_POLICY_NAME,
    );
  const fn = () => ofType("AWS::CloudFront::Function")[0];

  it("serves /apps/* from the apps bucket through the ssd-workshop-apps origin access control: GET and HEAD, HTTPS (redirect), managed CachingOptimized", () => {
    expect(behaviour()).toMatchObject({
      AllowedMethods: ["GET", "HEAD"],
      ViewerProtocolPolicy: "redirect-to-https",
      CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
      ResponseHeadersPolicyId: { Ref: policy()?.[1] },
      FunctionAssociations: [{ EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": [fn()?.[1], "FunctionARN"] } }],
    });
    expect(behaviour()?.OriginRequestPolicyId).toBeUndefined();
    const origin = (distributionConfig().Origins as Record<string, unknown>[]).find((o) => o.Id === behaviour()?.TargetOriginId);
    expect(origin?.DomainName).toBe(APPS_BUCKET_REGIONAL_DOMAIN);
    expect(APPS_BUCKET_REGIONAL_DOMAIN).toBe(`${APPS_BUCKET_NAME}.s3.${REGION}.amazonaws.com`);
    const oac = ofType("AWS::CloudFront::OriginAccessControl").find(([, , r]) => (r.Properties?.OriginAccessControlConfig as { Name?: string }).Name === "ssd-workshop-apps");
    expect(origin?.OriginAccessControlId).toEqual({ "Fn::GetAtt": [oac?.[1], "Id"] });
    expect(oac?.[2].Properties?.OriginAccessControlConfig).toMatchObject({ OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" });
  });

  it("keeps the API behaviours first: /apps/* cannot match an /api/ path", () => {
    const patterns = (distributionConfig().CacheBehaviors as Record<string, unknown>[]).map((b) => b.PathPattern);
    expect(patterns).toEqual(["/api/apps/*", "/api/*", "/apps/*"]);
    const matches = (pattern: string, path: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path);
    expect(matches("/apps/*", "/api/apps/ada/data/k")).toBe(false);
    expect(matches("/apps/*", "/apps/ada/index.html")).toBe(true);
  });

  it("criterion 3: sends the sandbox CSP (overriding the origin), nosniff, HSTS one year and the referrer policy on every /apps/* answer", () => {
    const config = policy()?.[2].Properties?.ResponseHeadersPolicyConfig as Record<string, unknown>;
    expect(config.SecurityHeadersConfig).toEqual({
      ContentSecurityPolicy: { ContentSecurityPolicy: APPS_CONTENT_SECURITY_POLICY, Override: true },
      ContentTypeOptions: { Override: true },
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: true },
      ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
    });
    expect(APPS_CONTENT_SECURITY_POLICY).toBe(
      "sandbox allow-scripts allow-forms allow-modals allow-popups; default-src 'self'; connect-src 'self' https:; img-src 'self' data: https:; form-action 'self'",
    );
    // Ticket 2.14: data and images from any HTTPS address, never plain http:, and no script, style or font source beyond 'self'.
    expect(APPS_CONTENT_SECURITY_POLICY).not.toMatch(/http:|script-src|style-src|font-src|\*/);
    expect(APPS_CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
    expect(config.CorsConfig).toBeUndefined();
    expect(config.CustomHeadersConfig).toBeUndefined();
  });

  it("names the policy ssd-workshop-apps-v2 in the edge stack (ticket 2.14's CSP change), retained, versioned in its logical id", () => {
    const [stackName, id, resource] = policy() ?? [];
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(APPS_HEADERS_POLICY_NAME).toBe("ssd-workshop-apps-v2");
    expect(id).toMatch(/^AppsHeadersV2[0-9A-F]{8}$/);
    expect(resource).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("runs the function ssd-workshop-apps-index (cloudfront-js-2.0) with the tested code, published", () => {
    const [stackName, , resource] = fn() ?? [];
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(resource?.Properties).toMatchObject({
      Name: APPS_INDEX_FUNCTION_NAME,
      AutoPublish: true,
      FunctionConfig: { Runtime: "cloudfront-js-2.0" },
      FunctionCode: readFileSync(APPS_INDEX_FUNCTION_FILE, "utf8"),
    });
    expect(APPS_INDEX_FUNCTION_NAME).toBe("ssd-workshop-apps-index");
  });

  it("criterion 5: answers a missing address (S3's 403 behind the origin access control) with the plain /404.html page and status 404, cached 60 s", () => {
    expect(distributionConfig().CustomErrorResponses).toEqual([
      { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/404.html", ErrorCachingMinTTL: NOT_FOUND_CACHE_SECONDS },
    ]);
    expect(NOT_FOUND_CACHE_SECONDS).toBe(60);
    // /404.html matches no behaviour pattern, so it comes from the site bucket (default behaviour), where the site build puts it.
    const patterns = (distributionConfig().CacheBehaviors as Record<string, unknown>[]).map((b) => String(b.PathPattern));
    expect(patterns.some((p) => p === "/404.html" || p === "/*" || p === "*")).toBe(false);
    expect(readdirSync(join(dir, WEB_BUILD_FOLDER))).toContain("404.html");
  });
});
