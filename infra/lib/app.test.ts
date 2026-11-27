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
  APP_MEDIA_DELETE_THROTTLE,
  APP_MEDIA_MEMORY_MB,
  APP_MEDIA_METHODS,
  APP_MEDIA_PATH,
  APP_AI_PATH,
  APP_AI_PREFLIGHT_THROTTLE,
  APP_AI_THROTTLE,
  APP_AI_TIMEOUT_SECONDS,
  APP_AI_MEMORY_MB,
  APP_AI_BEDROCK_INVOKE_RESOURCES,
  APP_AI_TRANSCRIPTION_JOBS,
  APP_MEDIA_PREFLIGHT_THROTTLE,
  APP_MEDIA_TIMEOUT_SECONDS,
  APP_MEDIA_UPLOAD_THROTTLE,
} from "./api-stack.js";
import { APP_DATA_ROUTES as APP_DATA_ROUTE_KEYS, PREFLIGHT_HEADERS } from "../../platform/api/app-data/data.js";
import { STALE_PENDING_SECONDS } from "../../platform/api/conversation/state.js";
import { readBearerToken } from "../../platform/api/app-token/token.js";
import { WRITE_RESERVE_MS } from "../../platform/api/handlers/ai-worker.js";
import { CONVERSATION_ROUTES as CONVERSATION_ROUTE_KEYS } from "../../platform/api/conversation/conversation.js";
import { buildApp } from "./app.js";
import {
  ACCOUNT,
  ADMIN_FUNCTION_NAME,
  BUILD_RETRIES_PARTITION,
  BY_TYPE_INDEX_ATTRIBUTES,
  BY_TYPE_INDEX_KEY,
  BY_TYPE_INDEX_NAME,
  FACILITATOR_BUILD_READ_ATTRIBUTES,
  FACILITATOR_FUNCTION_NAME,
  FACILITATOR_INDEX_READ_ATTRIBUTES,
  FACILITATOR_INDEX_TYPES,
  FACILITATOR_NICK_READ_ATTRIBUTES,
  FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES,
  RETRY_REQUEST_ATTRIBUTES,
  SETTINGS_PARTITION,
  SETTINGS_READ_ATTRIBUTES,
  SETTINGS_UPDATE_ATTRIBUTES,
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
  APP_MEDIA_BUCKET_NAME,
  APP_MEDIA_BUCKET_REGIONAL_DOMAIN,
  APP_MEDIA_CONTENT_SECURITY_POLICY,
  APP_MEDIA_FUNCTION_NAME,
  APP_AI_FUNCTION_NAME,
  APP_AI_FOUNDATION_MODEL_ID,
  APP_AI_MODEL_ID,
  APP_AI_ROLE_ARN,
  APP_AI_LEADING_KEYS,
  APP_AI_TRANSCRIPTS_PREFIX,
  WAF_AI_RATE_BODY,
  WAF_AI_RATE_BODY_KEY,
  WAF_AI_RATE_LIMIT,
  WAF_AI_RATE_METHODS,
  WAF_AI_RATE_RULE_NAME,
  APP_MEDIA_HEADERS_POLICY_NAME,
  APP_MEDIA_KEY_PREFIX,
  APP_MEDIA_PATH_PATTERN,
  APP_MEDIA_READ_ATTRIBUTES,
  APP_MEDIA_ROLE_ARN,
  APP_MEDIA_ROLE_ARN_WITHOUT_PATH,
  APP_MEDIA_WRITE_ATTRIBUTES,
  APP_LIVE_READ_ATTRIBUTES,
  APP_TOKEN_READ_ATTRIBUTES,
  APPS_CONTENT_SECURITY_POLICY,
  APPS_HEADERS_POLICY_NAME,
  APPS_INDEX_FUNCTION_NAME,
  SITE_INDEX_FUNCTION_NAME,
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
  ALERT_EMAIL_PARAMETER,
  ALERT_EMAIL_PARAMETER_VERSION,
  COST_ANOMALY_FREQUENCY,
  COST_ANOMALY_THRESHOLD_USD,
  COST_MONITOR_NAME,
  COST_SUBSCRIPTION_NAME,
  TAG_KEY,
  TAG_VALUE,
  WAF_API_PATH_PREFIX,
  WAF_API_RATE_LIMIT,
  WAF_API_RATE_RULE_NAME,
  WAF_BLOCK_BODY,
  WAF_BLOCK_BODY_KEY,
  WAF_BLOCK_STATUS,
  WAF_BEARER_PREFIX,
  WAF_MEDIA_AUTH_BODY,
  WAF_MEDIA_AUTH_BODY_KEY,
  WAF_MEDIA_AUTH_RULE_NAME,
  WAF_MEDIA_AUTH_STATUS,
  WAF_MEDIA_PATH_PREFIX,
  WAF_MEDIA_PATH_TRANSFORMATIONS,
  WAF_MEDIA_PREFLIGHT_RATE_LIMIT,
  WAF_MEDIA_PREFLIGHT_RATE_METHOD,
  WAF_MEDIA_PREFLIGHT_RATE_RULE_NAME,
  WAF_MEDIA_RATE_LIMIT,
  WAF_MEDIA_RATE_RULE_NAME,
  WAF_MEDIA_WRITE_RATE_BODY,
  WAF_MEDIA_WRITE_RATE_BODY_KEY,
  WAF_MEDIA_WRITE_RATE_LIMIT,
  WAF_MEDIA_WRITE_RATE_METHODS,
  WAF_MEDIA_WRITE_RATE_RULE_NAME,
  WAF_RATE_WINDOW_SECONDS,
  WEB_ACL_NAME,
} from "./config.js";
import { PARTICIPANT_ROUTES as PARTICIPANT_ROUTE_KEYS } from "../../platform/api/participant/participant.js";
import { ADMIN_ROUTES as ADMIN_ROUTE_KEYS } from "../../platform/api/admin/admin.js";
import { BUILD_RETRIES_PK, SETTINGS_PK } from "../../platform/api/keys.js";
import { FACILITATOR_ROUTES as FACILITATOR_ROUTE_KEYS } from "../../platform/api/facilitator/facilitator.js";
import { BY_TYPE_INDEX_KEY as PLATFORM_BY_TYPE_INDEX_KEY, BY_TYPE_INDEX_NAME as PLATFORM_BY_TYPE_INDEX_NAME, MODELS as PLATFORM_MODELS } from "../../platform/api/settings.js";
import { ANSWER_AFTER_MS } from "../../platform/api/sign-in/code-request.js";
import {
  APP_MEDIA_MESSAGES,
  APP_MEDIA_ROUTES as APP_MEDIA_ROUTE_KEYS,
  APP_MEDIA_TIMEOUT_SECONDS as PLATFORM_APP_MEDIA_TIMEOUT_SECONDS,
  MEDIA_CACHE_CONTROL,
  MEDIA_KEY_PREFIX,
  MEDIA_PREFLIGHT_HEADERS,
  mediaAddress,
} from "../../platform/api/app-media/media.js";
import { S3_TIMEOUTS } from "../../platform/api/handlers/app-media.js";
import { AI_PREFLIGHT_HEADERS, APP_AI_ROUTES as APP_AI_ROUTE_KEYS } from "../../platform/api/app-ai/ai.js";
import { WEB_BUILD_FOLDER, WEB_DIR } from "./site-stack.js";
import {
  APP_MEDIA_OBJECT_WRITE_ACTIONS,
  APPS_OBJECT_WRITE_ACTIONS,
  DATA_CLIENT_FILE,
  DEPLOY_QUEUE_MAX_RECEIVES,
  DEPLOY_QUEUE_VISIBILITY_SECONDS,
  DEPLOYER_MAX_CONCURRENCY,
  DEPLOYER_MEMORY_MB,
  DEPLOYER_TIMEOUT_SECONDS,
} from "./apps-stack.js";
import { APPS_INDEX_FUNCTION_FILE, NOT_FOUND_CACHE_SECONDS, SITE_INDEX_FUNCTION_FILE } from "./edge-stack.js";
import {
  BUILD_CHECK_SCHEDULE,
  BUILD_QUEUE_MAX_RECEIVES,
  BUILD_QUEUE_RETENTION_SECONDS,
  BUILD_QUEUE_VISIBILITY_SECONDS,
  LAUNCHER_MAX_CONCURRENCY,
  LAUNCHER_MEMORY_MB,
  LAUNCHER_TIMEOUT_SECONDS,
  TEMPLATE_DIR,
} from "./builds-stack.js";
import { LAUNCH_RESERVE_MS } from "../../platform/api/handlers/builds-launcher.js";
import {
  APPS_BUCKET_NAME as PLATFORM_APPS_BUCKET_NAME,
  APP_MEDIA_BUCKET_NAME as PLATFORM_APP_MEDIA_BUCKET_NAME,
  BUILD_QUEUE_NAME as PLATFORM_BUILD_QUEUE_NAME,
  DEPLOY_MAX_RECEIVES as PLATFORM_DEPLOY_MAX_RECEIVES,
  DEPLOY_QUEUE_NAME as PLATFORM_DEPLOY_QUEUE_NAME,
  DISTRIBUTION_ID as PLATFORM_DISTRIBUTION_ID,
  GITHUB_SECRET_NAME as PLATFORM_GITHUB_SECRET_NAME,
  HANDED_OVER_GRACE_MS,
  LAUNCH_WAIT_SECONDS,
  QUEUE_SEEN_MS,
  QUEUE_WAIT_MAX_MS,
  SITE_DOMAIN as PLATFORM_SITE_DOMAIN,
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

const STACKS = [STACK_NAMES.assets, STACK_NAMES.site, STACK_NAMES.edge, STACK_NAMES.api, STACK_NAMES.builds, STACK_NAMES.apps, STACK_NAMES.alerts];

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
  // Ticket 3.13: the web ACL (Tags) and the cost anomaly monitor and subscription (ResourceTags).
  "AWS::WAFv2::WebACL",
  "AWS::CE::AnomalyMonitor",
  "AWS::CE::AnomalySubscription",
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
  // Ticket 3.18 try 2: a WAF custom response's header name and the request header a rule inspects are HTTP header names.
  "AWS::WAFv2::WebACL": [/\.CustomResponse\.ResponseHeaders\[\d+\]\.Name$/, /\.FieldToMatch\.SingleHeader\.Name$/],
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

// Synthesizing the whole app takes over vitest's default 10 s on GitHub's runners (Deploy run on main): explicit timeout.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ssd-workshop-cdk-"));
  assembly = buildApp({ outdir: dir }).synth();
}, 120_000);

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
  // Cost Explorer's types call them ResourceTags (ticket 3.13).
  const tags = (r.Properties?.Tags ?? r.Properties?.ResourceTags) as { Key: string; Value: unknown }[] | Record<string, unknown> | undefined;
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
    // Ticket 3.13: Cost Explorer's API lives in us-east-1.
    expect(stack(STACK_NAMES.alerts).environment).toMatchObject({ account: ACCOUNT, region: EDGE_REGION });
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
    for (const name of [STACK_NAMES.assets, STACK_NAMES.edge, STACK_NAMES.alerts]) {
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

  it("names the Origin Access Controls ssd-workshop-site and, from ticket 2.5, ssd-workshop-apps (3.18: ssd-workshop-app-media)", () => {
    const oacs = ofType("AWS::CloudFront::OriginAccessControl");
    expect(oacs.map(([, , r]) => (r.Properties?.OriginAccessControlConfig as { Name?: string }).Name).sort()).toEqual(["ssd-workshop-app-media", "ssd-workshop-apps", "ssd-workshop-site"]);
  });

  it("retains the Origin Access Controls (the deploy rights cannot update or delete one)", () => {
    const oacs = ofType("AWS::CloudFront::OriginAccessControl");
    expect(oacs).toHaveLength(3);
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
  it("creates the assets bucket and the site bucket with their fixed names (2.5: apps; 3.18: app media)", () => {
    const names = ofType("AWS::S3::Bucket").map(([, , r]) => r.Properties?.BucketName);
    expect(names.sort()).toEqual([ASSETS_BUCKET_NAME, SITE_BUCKET_NAME, APPS_BUCKET_NAME, APP_MEDIA_BUCKET_NAME].sort());
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

  it("uploads the pages built at synth time: the page, its stylesheet, app.js and diagram.js (ticket 1.9), the 404 page (ticket 2.5), the facilitator dashboard (ticket 3.11), the hand-off page (ticket 3.24), no TypeScript or tests (ticket 1.6)", () => {
    // The built folder in the assembly, and the asset CDK staged from it (same content).
    const site = ["404.html", "app-sign-in", "app.js", "diagram.js", "facilitator", "index.html", "style.css"];
    const dashboard = ["dashboard.js", "index.html"];
    const handOff = ["app-sign-in.js", "index.html"];
    expect(readdirSync(join(dir, WEB_BUILD_FOLDER)).sort()).toEqual(site);
    expect(readdirSync(join(dir, WEB_BUILD_FOLDER, "facilitator")).sort()).toEqual(dashboard);
    expect(readdirSync(join(dir, WEB_BUILD_FOLDER, "app-sign-in")).sort()).toEqual(handOff);
    const staged = readdirSync(dir).filter((name) => name.startsWith("asset.") && existsSync(join(dir, name, "app.js")) && existsSync(join(dir, name, "style.css")));
    expect(staged).toHaveLength(1);
    expect(readdirSync(join(dir, staged[0] ?? "")).sort()).toEqual(site);
    expect(readdirSync(join(dir, staged[0] ?? "", "facilitator")).sort()).toEqual(dashboard);
    expect(readdirSync(join(dir, staged[0] ?? "", "app-sign-in")).sort()).toEqual(handOff);
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

    // Four origins: the site bucket (default), from ticket 1.2 the HTTP API, from ticket 2.5 the apps bucket, from
    // ticket 3.18 the media bucket.
    const origins = config.Origins as Record<string, unknown>[];
    expect(origins).toHaveLength(4);
    const siteOrigin = origins.find((o) => o.DomainName === SITE_BUCKET_REGIONAL_DOMAIN);
    expect(siteOrigin).toBeDefined();
    expect(siteOrigin?.OriginAccessControlId).toBeDefined();
    expect((config.DefaultCacheBehavior as Record<string, unknown>).TargetOriginId).toBe(siteOrigin?.Id);
    expect(ofType("AWS::CloudFront::OriginAccessControl")).toHaveLength(3);
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
    // /api/*, the data API's /api/apps/* (ticket 2.4), the apps' /apps/* (ticket 2.5) and the dashboard's /facilitator*
    // (ticket 3.11), the hand-off page's /app-sign-in* (ticket 3.24) and apps' media /app-media/* (ticket 3.18), in this order.
    expect(behaviours.map((b) => b.PathPattern)).toEqual(["/api/apps/*", "/api/*", "/apps/*", "/app-media/*", "/facilitator*", "/app-sign-in*"]);
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
    // The CloudFront Functions are the apps' (ticket 2.5), on /apps/* only, and the site's (ticket 3.11), on /facilitator* only.
    expect(ofType("AWS::CloudFront::Function").map(([, , r]) => r.Properties?.Name).sort()).toEqual([APPS_INDEX_FUNCTION_NAME, SITE_INDEX_FUNCTION_NAME].sort());
    // The pages' headers policy (ticket 1.6), the data API's (ticket 2.4), the apps' (ticket 2.5) and the media's (ticket
    // 3.18) are the only custom CloudFront policies, and /api/* keeps the managed SecurityHeadersPolicy (asserted above).
    const custom = ofType("AWS::CloudFront::ResponseHeadersPolicy");
    expect(custom.map(([, , r]) => (r.Properties?.ResponseHeadersPolicyConfig as { Name?: string }).Name).sort()).toEqual(
      [APP_DATA_HEADERS_POLICY_NAME, APPS_HEADERS_POLICY_NAME, PAGES_HEADERS_POLICY_NAME, APP_MEDIA_HEADERS_POLICY_NAME].sort(),
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
    expect((distributionConfig().Origins as unknown[]).length).toBe(4);
    expect(apiPolicy).toBe("67f7725c-6f97-4210-82d7-5512b31e9d03");
    expect(appsPolicy).toEqual({ Ref: policy()?.[1] });
  });

  it("names the policy ssd-workshop-app-data-v3 in the edge stack (v2 since ticket 3.24 allows `authorization`, v3 since 3.21 `POST`), retained, versioned in its logical id", () => {
    const [stackName, id, resource] = policy() ?? [];
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(APP_DATA_HEADERS_POLICY_NAME).toBe("ssd-workshop-app-data-v3");
    expect(id).toMatch(/^AppDataHeadersV3[0-9A-F]{8}$/);
    expect(resource?.DeletionPolicy).toBe("Retain");
    expect(resource?.UpdateReplacePolicy).toBe("Retain");
  });

  it("adds Access-Control-Allow-Origin: * to every answer, replacing the function's own (one header), never with credentials, like the function's preflight", () => {
    expect(config().CorsConfig).toEqual({
      AccessControlAllowOrigins: { Items: ["*"] },
      AccessControlAllowCredentials: false,
      // Ticket 3.21: POST for the AI tasks.
      AccessControlAllowMethods: { Items: ["GET", "PUT", "DELETE", "POST"] },
      // Ticket 3.24 criterion 6: `authorization` (app write tokens), and never credentials (below).
      AccessControlAllowHeaders: { Items: ["content-type", "accept", "authorization"] },
      AccessControlMaxAgeSec: 600,
      OriginOverride: true,
    });
    // Every method and header the functions under /api/apps/* allow in their preflights (data, media, AI), and the data API's max age.
    const methods = (config().CorsConfig?.AccessControlAllowMethods as { Items: string[] }).Items;
    for (const preflight of [PREFLIGHT_HEADERS, MEDIA_PREFLIGHT_HEADERS, AI_PREFLIGHT_HEADERS]) {
      for (const method of preflight["access-control-allow-methods"].split(", ")) expect(methods).toContain(method);
      expect(preflight["access-control-allow-headers"]).toBe(PREFLIGHT_HEADERS["access-control-allow-headers"]);
    }
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
      { AttributeName: "listType", AttributeType: "S" },
    ]);
    expect(table?.TimeToLiveSpecification).toEqual({ AttributeName: TTL_ATTRIBUTE, Enabled: true });
    expect(TTL_ATTRIBUTE).toBe("expiresAt");
    // No customer managed key (KMS costs and key policy rights): the AWS-owned default.
    expect(table?.SSESpecification).toEqual({ SSEEnabled: false });
    expect(ofType("AWS::KMS::Key")).toEqual([]);
  });
});

describe("api stack: the index by type (ticket 3.10)", () => {
  it("has one secondary index, ssd-workshop-by-type, keyed by listType (sparse), projecting only what a dashboard row needs (never an email address or a text)", () => {
    const table = ofType("AWS::DynamoDB::Table")[0]?.[2].Properties;
    expect(BY_TYPE_INDEX_NAME).toBe("ssd-workshop-by-type");
    expect(BY_TYPE_INDEX_NAME).toBe(PLATFORM_BY_TYPE_INDEX_NAME);
    expect(BY_TYPE_INDEX_KEY).toBe("listType");
    expect(BY_TYPE_INDEX_KEY).toBe(PLATFORM_BY_TYPE_INDEX_KEY);
    expect(table?.GlobalSecondaryIndexes).toEqual([
      {
        IndexName: BY_TYPE_INDEX_NAME,
        KeySchema: [{ AttributeName: BY_TYPE_INDEX_KEY, KeyType: "HASH" }],
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: [...BY_TYPE_INDEX_ATTRIBUTES] },
      },
    ]);
    expect(table?.LocalSecondaryIndexes).toBeUndefined();
    for (const name of ["email", "text", "allowRef", "prompt", "suggestion", "verdictReason", "failureReasons", "changeSpec"]) {
      expect(BY_TYPE_INDEX_ATTRIBUTES as readonly string[], name).not.toContain(name);
    }
  });

  it("WHEN the synthesized stacks are inspected THEN only the facilitator role may query the index, only for its four types, projected", () => {
    const readers: { role: string; statement: Record<string, unknown> }[] = [];
    for (const [, , policy] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (st.Effect !== "Allow" || !JSON.stringify(st.Action).includes("dynamodb")) continue;
        const resources = JSON.stringify(st.Resource);
        if (!resources.includes("/index/") && !resources.includes('"*"') && !resources.includes("table/*")) continue;
        readers.push({ role: JSON.stringify(policy.Properties?.Roles), statement: st });
      }
    }
    expect(readers).toHaveLength(1);
    expect(readers[0]?.role).toBe(JSON.stringify([{ Ref: apiFunction(FACILITATOR_FUNCTION_NAME).roleEntry()?.[0] }]));
    expect(readers[0]?.statement).toMatchObject({
      Action: "dynamodb:Query",
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["participant", "conversation", "usage", "build"], "dynamodb:Attributes": [...FACILITATOR_INDEX_READ_ATTRIBUTES] },
        Null: { "dynamodb:LeadingKeys": "false" },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(FACILITATOR_INDEX_TYPES as readonly string[]).not.toContain("allow");
    expect(FACILITATOR_INDEX_TYPES as readonly string[]).not.toContain("session");
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
      "POST /api/sign-out",
      "POST /api/app-tokens",
      "GET /api/admin/settings",
      "PUT /api/admin/settings",
      "POST /api/admin/stop",
      "POST /api/admin/resume",
      "PUT /api/admin/app-ai",
      "POST /api/conversation/messages",
      "GET /api/conversation/messages/{id}",
      "GET /api/conversation",
      "POST /api/conversation/step",
      "GET /api/conversation/spec",
      "POST /api/conversation/spec/approve",
      "GET /api/build",
      "GET /api/status",
      "POST /api/conversation/change/build",
      "POST /api/conversation/change/discard",
      "POST /api/conversation/change/rebuild",
      "POST /api/conversation/change/edit",
      ...FACILITATOR_ROUTE_KEYS,
      "GET /api/apps/{nickname}/data/{key}",
      "PUT /api/apps/{nickname}/data/{key}",
      "DELETE /api/apps/{nickname}/data/{key}",
      "OPTIONS /api/apps/{nickname}/data/{key}",
      "PUT /api/apps/{nickname}/media/{id}",
      "DELETE /api/apps/{nickname}/media/{id}",
      "OPTIONS /api/apps/{nickname}/media/{id}",
      ...APP_AI_ROUTE_KEYS,
    ]);
    const health = routes.find(([, , r]) => r.Properties?.RouteKey === "GET /api/health")?.[2];
    const integrationId = (health?.Properties?.Target as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1][1] as {
      Ref: string;
    };
    const integration = apiResources().find(([id]) => id === integrationId.Ref)?.[1];
    expect(ofType("AWS::ApiGatewayV2::Integration")).toHaveLength(10);
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
      ADMIN_FUNCTION_NAME,
      CONVERSATION_FUNCTION_NAME,
      AI_WORKER_FUNCTION_NAME,
      FACILITATOR_FUNCTION_NAME,
      APP_DATA_FUNCTION_NAME,
      APP_MEDIA_FUNCTION_NAME,
      APP_AI_FUNCTION_NAME,
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
            "dynamodb:Attributes": ["pk", "sk", "type", "listType", "id", "role", "group", "step", "createdAt"],
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
            // `allowRef` (ticket 3.1): the allow-list address sealed under the session token.
            "dynamodb:Attributes": ["pk", "sk", "type", "tokenHash", "participantId", "createdAt", "expiresAt", "allowRef"],
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

/**
 * The session check's rights (ticket 3.1), on the participant and conversation functions: the caller's allow-list
 * entry without its address (GetItem of role, group and participantId only, with a projection) and session deletes.
 */
function sessionCheckStatements(tableArn: unknown): unknown[] {
  return [
    {
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource: tableArn,
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EMAIL#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "role", "group", "participantId"] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    },
    {
      Effect: "Allow",
      Action: "dynamodb:DeleteItem",
      Resource: tableArn,
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*"] },
        // Try 2: the old session item never comes back.
        StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
      },
    },
  ];
}

describe("api stack: session check (ticket 3.1)", () => {
  it("lets only the participant, conversation (ticket 3.2) admin and (ticket 3.10) facilitator functions read allow-list entries without their address, and delete sessions", () => {
    const readers: string[] = [];
    for (const [, , policy] of ofType("AWS::IAM::Policy")) {
      const statements = (policy.Properties?.PolicyDocument as { Statement: { Action: unknown; Condition?: unknown }[] }).Statement;
      const roles = JSON.stringify(policy.Properties?.Roles);
      for (const st of statements) {
        const actions = ([] as unknown[]).concat(st.Action);
        const condition = JSON.stringify(st.Condition ?? {});
        if (actions.includes("dynamodb:DeleteItem") && condition.includes("SESSION#")) readers.push(`delete ${roles}`);
        if (actions.includes("dynamodb:GetItem") && condition.includes("EMAIL#")) {
          if (condition.includes('"participantId"')) {
            // Never the address: the attribute list holds no `email`, and a projection is required.
            expect(condition).not.toContain('"email"');
            expect(condition).toContain("SPECIFIC_ATTRIBUTES");
          }
          readers.push(`read ${roles}`);
        }
      }
    }
    const roleOf = (name: string) => JSON.stringify([{ Ref: apiFunction(name).roleEntry()?.[0] }]);
    const verify = roleOf(SIGN_IN_VERIFY_FUNCTION_NAME);
    expect(readers.sort()).toEqual(
      [
        `read ${roleOf(SIGN_IN_CODE_FUNCTION_NAME)}`,
        `read ${verify}`,
        `read ${roleOf(PARTICIPANT_FUNCTION_NAME)}`,
        `read ${roleOf(CONVERSATION_FUNCTION_NAME)}`,
        `delete ${roleOf(PARTICIPANT_FUNCTION_NAME)}`,
        `delete ${roleOf(CONVERSATION_FUNCTION_NAME)}`,
        `read ${roleOf(ADMIN_FUNCTION_NAME)}`,
        `delete ${roleOf(ADMIN_FUNCTION_NAME)}`,
        // Ticket 3.10: the facilitator routes run the same session check.
        `read ${roleOf(FACILITATOR_FUNCTION_NAME)}`,
        `delete ${roleOf(FACILITATOR_FUNCTION_NAME)}`,
      ].sort(),
    );
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

  it("routes GET /api/me, POST /api/me/nickname, GET /api/participants/{id}, POST /api/sign-out (ticket 3.1) and POST /api/app-tokens (ticket 3.24) to it, invoked only by this API", () => {
    expect([...PARTICIPANT_ROUTE_KEYS]).toEqual(["GET /api/me", "POST /api/me/nickname", "GET /api/participants/{id}", "POST /api/sign-out", "POST /api/app-tokens"]);
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

  it("allows only its logs, GetItem on sessions and profiles, nickname claim puts, profile updates of nickname, step and stepSince (ticket 3.2), and the session check's rights (ticket 3.1)", () => {
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
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "nickname", "step", "stepSince"] },
        },
      },
      ...sessionCheckStatements(f.tableArn()),
      // Ticket 3.24: app write tokens. The live marker's `liveAt` and the caller's token list, read with a projection.
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*"] },
          // Try 3: `pk` and `sk` too, like every other read list of the repository.
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "liveAt"] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TOKENS#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "tokens", "version"] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:PutItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPTOKEN#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "type", "app", "nickname", "createdAt", "expiresAt"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TOKENS#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "type", "tokens", "expiresAt", "version"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:DeleteItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPTOKEN#*"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      },
      // Ticket 3.24 try 2: no token once the session is gone. Only that the session item exists, nothing else of it
      // (try 3: `pk` and `sk`, as a transaction item's `dynamodb:Attributes` always lists the key, .claude/rules/infra.md).
      {
        Effect: "Allow",
        Action: "dynamodb:ConditionCheckItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk"] },
        },
      },
      // Ticket 3.24 try 3 (access review L1): no token once the person is removed from the allow-list (profile role).
      {
        Effect: "Allow",
        Action: "dynamodb:ConditionCheckItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "role"] },
        },
      },
    ]);
  });

  it("ticket 3.24: only the participant function writes app write tokens, and only it and the data function (3.18: and the media function) read them", () => {
    const like = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value);
    // The token partitions never overlap each other or the partitions other roles hold.
    for (const [pattern, key] of [
      ["APP#*", "APPTOKEN#ab"],
      ["APPDATA#*", "APPTOKEN#ab"],
      ["APPTOKEN#*", "TOKENS#p-1"],
      ["TOKENS#*", "APPTOKEN#ab"],
      ["APPTOKEN#*", "APP#ada"],
      ["PARTICIPANT#*", "TOKENS#p-1"],
    ] as const) {
      expect(like(pattern, key), `${pattern} ${key}`).toBe(false);
    }
    expect(like("APPTOKEN#*", "APPTOKEN#ab")).toBe(true);
    // Every DynamoDB right in every stack that reaches a token item or a token list, by role name and action.
    const roleNames = new Map(ofType("AWS::IAM::Role").map(([st, id, r]) => [`${st}/${id}`, String(r.Properties?.RoleName ?? id)]));
    const reach = (sampleKey: string): string[] => {
      const found: string[] = [];
      for (const [st, , policy] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
        const roles = ((policy.Properties?.Roles ?? []) as { Ref?: string }[]).map((r) => roleNames.get(`${st}/${r.Ref ?? ""}`) ?? JSON.stringify(r));
        for (const statement of (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
          const actions = ([] as unknown[]).concat(statement.Action).map(String).filter((a) => a.startsWith("dynamodb:") || a === "*");
          if (statement.Effect !== "Allow" || actions.length === 0) continue;
          const conditions = (statement.Condition ?? {}) as Record<string, Record<string, unknown>>;
          const patterns = Object.values(conditions).flatMap((c) => (c["dynamodb:LeadingKeys"] === undefined ? [] : ([] as unknown[]).concat(c["dynamodb:LeadingKeys"])));
          // Statements on the table's items (an index Query has its own test); no partition list means every partition.
          if (JSON.stringify(statement.Resource).includes("/index/")) continue;
          if (patterns.length > 0 && !patterns.some((p) => typeof p === "string" && actionCovers(p, sampleKey))) continue;
          for (const role of roles) for (const action of actions) found.push(`${role} ${action}`);
        }
      }
      return [...new Set(found)].sort();
    };
    expect(reach(`APPTOKEN#${"a".repeat(64)}`)).toEqual(
      [
        `${APP_DATA_FUNCTION_NAME} dynamodb:GetItem`,
        `${APP_MEDIA_FUNCTION_NAME} dynamodb:GetItem`,
        // Ticket 3.21: the AI tasks check the same token.
        `${APP_AI_FUNCTION_NAME} dynamodb:GetItem`,
        `${PARTICIPANT_FUNCTION_NAME} dynamodb:DeleteItem`,
        `${PARTICIPANT_FUNCTION_NAME} dynamodb:PutItem`,
      ].sort(),
    );
    expect(reach("TOKENS#p-1")).toEqual(
      [`${PARTICIPANT_FUNCTION_NAME} dynamodb:GetItem`, `${PARTICIPANT_FUNCTION_NAME} dynamodb:UpdateItem`].sort(),
    );
    expect(JSON.stringify(apiFunction(APP_DATA_FUNCTION_NAME).statements())).not.toContain("TOKENS#");
    expect(JSON.stringify(apiFunction(APP_MEDIA_FUNCTION_NAME).statements())).not.toContain("TOKENS#");
    expect(JSON.stringify(apiFunction(APP_AI_FUNCTION_NAME).statements())).not.toContain("TOKENS#");
  });

  it("bundles the handler into a self-contained index.js that answers a call without a session 401", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string }) => Promise<{ statusCode: number }> }>();
    await expect(quietly(() => bundle.handler({ routeKey: "GET /api/me" }))).resolves.toMatchObject({ statusCode: 401 });
  });
});

describe("api stack: admin function (ticket 3.2)", () => {
  const f = apiFunction(ADMIN_FUNCTION_NAME);

  it("names the function, role and log group ssd-workshop-api-admin; Node.js 22 arm64, 256 MB, 10 s", () => {
    expect(ADMIN_FUNCTION_NAME).toBe("ssd-workshop-api-admin");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 256,
      Timeout: 10,
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({ LogGroupName: ADMIN_FUNCTION_NAME, RetentionInDays: 14 });
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
  });

  it("routes GET and PUT /api/admin/settings and (ticket 3.5) POST /api/admin/stop and /api/admin/resume to it, invoked only by this API", () => {
    expect([...ADMIN_ROUTE_KEYS]).toEqual(["GET /api/admin/settings", "PUT /api/admin/settings", "POST /api/admin/stop", "POST /api/admin/resume", "PUT /api/admin/app-ai"]);
    for (const routeKey of ADMIN_ROUTE_KEYS) {
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

  it("allows only its logs, GetItem on sessions, profiles and SETTINGS, updates of the settings' listed attributes returning nothing, and the session check's rights", () => {
    expect(SETTINGS_PK).toBe(SETTINGS_PARTITION);
    expect(f.statements()).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] } },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "PARTICIPANT#*", "SETTINGS"] } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["SETTINGS"],
            "dynamodb:Attributes": ["pk", "sk", "type", "aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce", "updatedAt", "stopped", "stoppedAt", "resumedAt", "appAiEnabled", "appAiChangedAt"],
          },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      },
      ...sessionCheckStatements(f.tableArn()),
    ]);
  });

  it("bundles the handler into a self-contained index.js that answers a call without a session 401", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string }) => Promise<{ statusCode: number }> }>();
    await expect(quietly(() => bundle.handler({ routeKey: "GET /api/admin/settings" }))).resolves.toMatchObject({ statusCode: 401 });
  });
});

describe("api stack: facilitator function (ticket 3.10)", () => {
  const f = apiFunction(FACILITATOR_FUNCTION_NAME);

  it("names the function, role and log group ssd-workshop-api-facilitator; Node.js 22 arm64, 256 MB, 10 s", () => {
    expect(FACILITATOR_FUNCTION_NAME).toBe("ssd-workshop-api-facilitator");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({ Runtime: "nodejs22.x", Architectures: ["arm64"], MemorySize: 256, Timeout: 10, Code: { S3Bucket: ASSETS_BUCKET_NAME } });
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({ LogGroupName: FACILITATOR_FUNCTION_NAME, RetentionInDays: 14 });
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
  });

  it("routes the list, the conversation log and the six actions to it, invoked only by this API (one permission)", () => {
    expect(FACILITATOR_ROUTE_KEYS).toHaveLength(8);
    for (const routeKey of FACILITATOR_ROUTE_KEYS) {
      expect(f.integrationOf(routeKey), routeKey).toMatchObject({ IntegrationType: "AWS_PROXY", PayloadFormatVersion: "2.0", IntegrationUri: { "Fn::GetAtt": [f.fnEntry()?.[0], "Arn"] } });
    }
    expect(f.permissions()).toHaveLength(1);
    const source = JSON.stringify(f.permissions()[0]?.[2].Properties?.SourceArn);
    expect(source).toContain(`:execute-api:${REGION}:${ACCOUNT}:`);
    expect(source).toContain('"/*/*/*"');
  });

  it("criterion 7: WHEN the synthesized stack is inspected THEN the facilitator role reads participants, builds and flags (projected where it can be) and writes only the attributes the actions need", () => {
    expect(BUILD_RETRIES_PK).toBe(BUILD_RETRIES_PARTITION);
    const queueId = ofType("AWS::SQS::Queue").find(([, , r]) => r.Properties?.QueueName === AI_QUEUE_NAME)?.[1];
    const indexArn = { "Fn::Join": ["", [f.tableArn(), `/index/${BY_TYPE_INDEX_NAME}`]] };
    const projected = (prefix: string, names: readonly string[]) => ({
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource: f.tableArn(),
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [prefix] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...names] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect([...FACILITATOR_NICK_READ_ATTRIBUTES]).toEqual(["pk", "sk", "participantId"]);
    expect([...FACILITATOR_BUILD_READ_ATTRIBUTES]).toEqual(["pk", "sk", "participantId", "status", "launchedAt"]);
    expect([...RETRY_REQUEST_ATTRIBUTES]).toEqual(["pk", "sk", "type", "buildId", "requestedAt"]);
    expect(f.statements()).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] } },
      // Profiles, conversations and messages (a flag's text, the conversation log): the participants' own partitions.
      { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: f.tableArn(), Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] } } },
      { Effect: "Allow", Action: "dynamodb:GetItem", Resource: f.tableArn(), Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*"] } } },
      projected("NICK#*", FACILITATOR_NICK_READ_ATTRIBUTES),
      projected("BUILD#*", FACILITATOR_BUILD_READ_ATTRIBUTES),
      {
        Effect: "Allow",
        Action: "dynamodb:Query",
        Resource: indexArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["participant", "conversation", "usage", "build"], "dynamodb:Attributes": [...FACILITATOR_INDEX_READ_ATTRIBUTES] },
          Null: { "dynamodb:LeadingKeys": "false" },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:Query",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_RETRIES"], "dynamodb:Attributes": [...RETRY_REQUEST_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:PutItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_RETRIES"], "dynamodb:Attributes": [...RETRY_REQUEST_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      },
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: { "Fn::GetAtt": [queueId, "Arn"] } },
      settingsReadStatement(f.tableArn()),
      ...sessionCheckStatements(f.tableArn()),
    ]);
    // No ECS, no launch queue, no allow-list read beyond the session check's projection, no Scan.
    const text = JSON.stringify(f.statements());
    for (const forbidden of ["ecs:", "Scan", "ssd-workshop-builds", "secretsmanager", "PartiQL", "BatchGetItem"]) expect(text, forbidden).not.toContain(forbidden);
  });

  it("bundles the handler into a self-contained index.js that answers a call without a session 401", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string }) => Promise<{ statusCode: number }> }>();
    await expect(quietly(() => bundle.handler({ routeKey: "GET /api/facilitator/participants" }))).resolves.toMatchObject({ statusCode: 401 });
  });
});

/** The DynamoDB actions that write items (TransactWriteItems is authorized item by item as these). */
const DYNAMODB_WRITE_ACTIONS = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:PartiQLInsert", "dynamodb:PartiQLUpdate", "dynamodb:PartiQLDelete"];

/** Ticket 3.3: a projected read of the settings' caps and Stop, nothing else of `SETTINGS`. */
function settingsReadStatement(tableArn: unknown) {
  return {
    Effect: "Allow",
    Action: "dynamodb:GetItem",
    Resource: tableArn,
    Condition: {
      "ForAllValues:StringEquals": {
        "dynamodb:LeadingKeys": ["SETTINGS"],
        "dynamodb:Attributes": ["pk", "sk", "aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce", "stopped", "resumedAt", "appAiEnabled"],
      },
      StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
    },
  };
}

/**
 * Ticket 3.4: what every writer that ends a build may do to free its slot: check the build's `status` (a transaction's
 * ConditionCheck), delete its holder and count the counter down in `BUILD_SLOTS`, nothing else.
 */
function slotReleaseExpected(tableArn: unknown) {
  return [
    {
      Effect: "Allow",
      Action: "dynamodb:ConditionCheckItem",
      Resource: tableArn,
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "status"] },
      },
    },
    {
      Effect: "Allow",
      Action: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      Resource: tableArn,
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_SLOTS"], "dynamodb:Attributes": ["pk", "sk", "running", "version"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
      },
    },
  ];
}

describe("SETTINGS readers (ticket 3.3)", () => {
  it("WHEN the synthesized stack is inspected THEN the AI worker and the conversation function read SETTINGS only projected to the listed attributes, and the participant function not at all", () => {
    // Ticket 3.21: and the switch "Apps may use AI".
    expect([...SETTINGS_READ_ATTRIBUTES]).toEqual(["pk", "sk", "aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce", "stopped", "resumedAt", "appAiEnabled"]);
    for (const name of [AI_WORKER_FUNCTION_NAME, CONVERSATION_FUNCTION_NAME]) {
      const reads = apiFunction(name).statements().filter((st) => JSON.stringify(st).includes('"SETTINGS"'));
      expect(reads, name).toEqual([settingsReadStatement(apiFunction(name).tableArn())]);
    }
    expect(JSON.stringify(apiFunction(PARTICIPANT_FUNCTION_NAME).statements())).not.toContain("SETTINGS");
  });
});

describe("SETTINGS item (ticket 3.2 criterion 5)", () => {
  it("WHEN the synthesized stacks are inspected THEN only the admin function's role may write SETTINGS, and only the attributes named in config.ts", () => {
    const writers: { roles: string; actions: string[]; attributes: unknown }[] = [];
    const policies = [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")];
    for (const [, , policy] of policies) {
      const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement;
      for (const st of statements) {
        if (st.Effect !== "Allow") continue;
        assertNoExclusions(JSON.stringify(policy.Properties?.Roles), st);
        const actions = DYNAMODB_WRITE_ACTIONS.filter((a) => ([] as unknown[]).concat(st.Action).some((g) => typeof g === "string" && actionCovers(g, a)));
        if (actions.length === 0) continue;
        // The partitions the statement allows: every `dynamodb:LeadingKeys` list under any operator; none means all.
        const conditions = (st.Condition ?? {}) as Record<string, Record<string, unknown>>;
        const patterns = Object.values(conditions).flatMap((c) => (c["dynamodb:LeadingKeys"] === undefined ? [] : ([] as unknown[]).concat(c["dynamodb:LeadingKeys"])));
        const reaches = patterns.length === 0 || patterns.some((p) => typeof p === "string" && actionCovers(p, SETTINGS_PARTITION));
        if (!reaches) continue;
        const attributes = Object.values(conditions).find((c) => c["dynamodb:Attributes"] !== undefined)?.["dynamodb:Attributes"];
        writers.push({ roles: JSON.stringify(policy.Properties?.Roles), actions, attributes });
      }
    }
    const admin = apiFunction(ADMIN_FUNCTION_NAME).roleEntry()?.[0];
    expect(admin).toBeDefined();
    expect(writers).toEqual([{ roles: JSON.stringify([{ Ref: admin }]), actions: ["dynamodb:UpdateItem"], attributes: [...SETTINGS_UPDATE_ATTRIBUTES] }]);
    // Ticket 3.5: the global Stop is written by the admin function only (its Stop and Resume routes); 3.21: and the switch.
    expect([...SETTINGS_UPDATE_ATTRIBUTES]).toEqual(["pk", "sk", "type", "aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce", "updatedAt", "stopped", "stoppedAt", "resumedAt", "appAiEnabled", "appAiChangedAt"]);
  });

  it("counts a partition pattern that matches SETTINGS, wildcards included, as reaching it", () => {
    expect(actionCovers("SETTINGS", SETTINGS_PARTITION)).toBe(true);
    expect(actionCovers("SETTINGS*", SETTINGS_PARTITION)).toBe(true);
    expect(actionCovers("SESSION#*", SETTINGS_PARTITION)).toBe(false);
    expect(actionCovers("S*", SETTINGS_PARTITION)).toBe(true);
  });
});

describe("budget attributes (ticket 3.3)", () => {
  /** Every DynamoDB write statement in every stack that can reach PARTICIPANT# items, by role name, with its attribute list ("*" when none). */
  function participantWriters(sampleKey = "PARTICIPANT#p-1"): { role: string; attributes: string[]; actions: string[] }[] {
    const roleNames = new Map(ofType("AWS::IAM::Role").map(([s, id, r]) => [`${s}/${id}`, String(r.Properties?.RoleName ?? id)]));
    const writers: { role: string; attributes: string[]; actions: string[] }[] = [];
    const documents: { roles: string[]; statements: Record<string, unknown>[] }[] = [];
    for (const [s, id, policy] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      const roles = ((policy.Properties?.Roles ?? []) as unknown[]).map((r) => {
        const ref = (r as { Ref?: unknown }).Ref;
        return typeof ref === "string" ? (roleNames.get(`${s}/${ref}`) ?? ref) : JSON.stringify(r);
      });
      if (roles.length === 0) roles.push(`${s}/${id}`);
      documents.push({ roles, statements: (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement });
    }
    // Inline policies on the roles themselves count too.
    for (const [s, id, role] of ofType("AWS::IAM::Role")) {
      for (const inline of (role.Properties?.Policies ?? []) as { PolicyDocument: { Statement: Record<string, unknown>[] } }[]) {
        documents.push({ roles: [roleNames.get(`${s}/${id}`) ?? id], statements: inline.PolicyDocument.Statement });
      }
    }
    for (const { roles, statements } of documents) {
      for (const st of statements) {
        if (st.Effect !== "Allow") continue;
        assertNoExclusions(JSON.stringify(roles), st);
        if (!DYNAMODB_WRITE_ACTIONS.some((a) => ([] as unknown[]).concat(st.Action).some((g) => typeof g === "string" && actionCovers(g, a)))) continue;
        const conditions = (st.Condition ?? {}) as Record<string, Record<string, unknown>>;
        const patterns = Object.values(conditions).flatMap((c) => (c["dynamodb:LeadingKeys"] === undefined ? [] : ([] as unknown[]).concat(c["dynamodb:LeadingKeys"])));
        if (patterns.length > 0 && !patterns.some((p) => typeof p === "string" && actionCovers(p, sampleKey))) continue;
        const attributes = Object.values(conditions).find((c) => c["dynamodb:Attributes"] !== undefined)?.["dynamodb:Attributes"];
        const actions = ([] as unknown[]).concat(st.Action).map(String);
        for (const role of roles) writers.push({ role, attributes: attributes === undefined ? ["*"] : ([] as unknown[]).concat(attributes).map(String), actions });
      }
    }
    return writers;
  }

  it("WHEN the synthesized stacks are inspected THEN only the facilitator role may write extraBudget (ticket 3.10), and only the AI worker and the builder task may write costUsd", () => {
    const writers = participantWriters();
    expect(writers.length).toBeGreaterThan(3);
    // No write statement on participant items may leave its attributes open (that would cover both names).
    for (const w of writers) expect(w.attributes, w.role).not.toContain("*");
    expect([...new Set(writers.filter((w) => w.attributes.includes("extraBudget")).map((w) => w.role))]).toEqual([FACILITATOR_FUNCTION_NAME]);
    const costWriters = [...new Set(writers.filter((w) => w.attributes.includes("costUsd")).map((w) => w.role))].sort();
    expect(costWriters).toEqual([AI_WORKER_FUNCTION_NAME, BUILDER_TASK_ROLE_NAME].sort());
  });

  it("ticket 3.10 (sparse index): WHEN the synthesized stacks are inspected THEN only the four listed kinds' writers may write listType, and no role may write it outside PARTICIPANT# and BUILD#", () => {
    // A delete writes no attribute; every other write statement counts when it names listType or has no attribute list.
    const listTypeWriters = (sampleKey: string) =>
      [
        ...new Set(
          participantWriters(sampleKey)
            .filter((w) => w.actions.some((a) => a !== "dynamodb:DeleteItem"))
            .filter((w) => w.attributes.includes(BY_TYPE_INDEX_KEY) || w.attributes.includes("*"))
            .map((w) => w.role),
        ),
      ].sort();
    // Profiles (sign-in verify), conversations (conversation function), usage totals and builds (AI worker).
    expect(listTypeWriters("PARTICIPANT#p-1")).toEqual([AI_WORKER_FUNCTION_NAME, CONVERSATION_FUNCTION_NAME, SIGN_IN_VERIFY_FUNCTION_NAME].sort());
    expect(listTypeWriters("BUILD#b-1")).toEqual([AI_WORKER_FUNCTION_NAME]);
    // The allow-list, codes and code requests (EMAIL#), sessions, nickname claims and every platform partition: no writer
    // may name listType (nor write without an attribute list), so none of their items can enter the index.
    for (const key of ["EMAIL#ada@example.org", "SESSION#x", "NICK#ada", "SETTINGS", "BUILD_QUEUE", "BUILD_SLOTS", "BUILD_RETRIES", "APP#ada", "APPDATA#ada", "SPEC#1"]) {
      expect(listTypeWriters(key), key).toEqual([]);
    }
  });

  it("WHEN the synthesized stacks are inspected THEN only the AI worker may write changeRequestsUsed (the change count) and whatChanges (ticket 3.6)", () => {
    const writers = participantWriters();
    for (const w of writers) expect(w.attributes, w.role).not.toContain("*");
    const countWriters = [...new Set(writers.filter((w) => w.attributes.includes("changeRequestsUsed")).map((w) => w.role))];
    expect(countWriters).toEqual([AI_WORKER_FUNCTION_NAME]);
    const listWriters = [...new Set(writers.filter((w) => w.attributes.includes("whatChanges")).map((w) => w.role))];
    expect(listWriters).toEqual([AI_WORKER_FUNCTION_NAME]);
  });

  it("WHEN the synthesized stacks are inspected THEN only the launcher may write what it read of SPEC.md (repositoryRead, repositorySpec, repositoryName; ticket 3.9), and only the GitHub key's reader", () => {
    const writers = participantWriters();
    for (const name of ["repositoryRead", "repositorySpec", "repositoryName"]) {
      expect([...new Set(writers.filter((w) => w.attributes.includes(name)).map((w) => w.role))], name).toEqual([BUILD_LAUNCHER_FUNCTION_NAME]);
    }
    // The launcher's participant writes name nothing else (never a step, a count, a spec version or a message's text).
    const launcherNames = [...new Set(writers.filter((w) => w.role === BUILD_LAUNCHER_FUNCTION_NAME).flatMap((w) => w.attributes))].sort();
    expect(launcherNames).toEqual(["pk", "repositoryName", "repositoryRead", "repositorySpec", "sk"]);
    // Try 2: an approval by Rebuild from my repository is its own name, only the AI worker's, and approvedAt is only the
    // conversation function's: the launcher tells them apart and builds the first only as the text it read itself.
    const approvers = (name: string) => [...new Set(writers.filter((w) => w.attributes.includes(name)).map((w) => w.role))];
    expect(approvers("rebuildApprovedAt")).toEqual([AI_WORKER_FUNCTION_NAME]);
    expect(approvers("approvedAt")).toEqual([CONVERSATION_FUNCTION_NAME]);
    // The launcher reads (projected GetItem only) what it needs for that: the request's stored text and repository, the
    // version's approval and request id, and the in-flight check's names.
    for (const name of ["repositorySpec", "repositoryName", "rebuildApprovedAt", "messageId", "pendingId", "pendingSince"]) {
      expect(LAUNCHER_READ_ATTRIBUTES as readonly string[], name).toContain(name);
    }
  });

  it("ticket 3.15: WHEN the synthesized stacks are inspected THEN only the conversation function may write a request's edited spec (editedSpec), and the launcher may read it", () => {
    const writers = participantWriters();
    expect([...new Set(writers.filter((w) => w.attributes.includes("editedSpec")).map((w) => w.role))]).toEqual([CONVERSATION_FUNCTION_NAME]);
    // The AI worker approves a version only as rebuildApprovedAt, which the launcher builds only as that exact text.
    expect([...new Set(writers.filter((w) => w.attributes.includes("rebuildApprovedAt")).map((w) => w.role))]).toEqual([AI_WORKER_FUNCTION_NAME]);
    expect(LAUNCHER_READ_ATTRIBUTES as readonly string[]).toContain("editedSpec");
  });

  it("criterion 7 (ticket 3.10): WHEN the synthesized stacks are inspected THEN only the facilitator role may write paused (Pause) and approvedTextHash (Approve), and it writes nothing else that decides a participant's limits or identity", () => {
    const writers = participantWriters();
    for (const name of ["paused", "approvedTextHash", "extraBudget"]) {
      expect([...new Set(writers.filter((w) => w.attributes.includes(name)).map((w) => w.role))], name).toEqual([FACILITATOR_FUNCTION_NAME]);
    }
    const names = [...new Set(writers.filter((w) => w.role === FACILITATOR_FUNCTION_NAME).flatMap((w) => w.attributes))].sort();
    expect(names).toEqual([...FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES].sort());
    for (const forbidden of ["step", "stepSince", "role", "group", "nickname", "id", "costUsd", "changeRequestsUsed", "approvedAt", "rebuildApprovedAt", "specVersion", "email"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it("WHEN the synthesized stacks are inspected THEN only the conversation function, the AI worker, (ticket 3.9) the launcher and (ticket 3.10, an approved flag) the facilitator role may send to the AI worker's queue", () => {
    const queueId = ofType("AWS::SQS::Queue").find(([, , r]) => r.Properties?.QueueName === AI_QUEUE_NAME)?.[1];
    const queueArn = `arn:aws:sqs:${REGION}:${ACCOUNT}:${AI_QUEUE_NAME}`;
    const reaches = (resource: unknown): boolean => resourceReaches(resource, [queueArn], [must(queueId)], [AI_QUEUE_NAME]);
    expect(reaches(queueArn)).toBe(true);
    const roleIds = [CONVERSATION_FUNCTION_NAME, AI_WORKER_FUNCTION_NAME, FACILITATOR_FUNCTION_NAME].map((name) => apiFunction(name).roleEntry()?.[0]);
    const launcherRoleId = ofType("AWS::IAM::Role").find(([, , r]) => r.Properties?.RoleName === BUILD_LAUNCHER_FUNCTION_NAME)?.[1];
    expect(launcherRoleId).toBeDefined();
    const senders = new Set<string>();
    for (const [, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (st.Effect !== "Allow") continue;
        if (!([st.Action].flat() as string[]).some((g) => actionCovers(g, "sqs:SendMessage"))) continue;
        if (![st.Resource].flat().some(reaches)) continue;
        const roles = JSON.stringify(r.Properties?.Roles);
        expect([...roleIds, launcherRoleId].map((role) => JSON.stringify([{ Ref: role }])), id).toContain(roles);
        senders.add(roles);
      }
    }
    expect(senders.size).toBe(4);
  });

  it("WHEN the synthesized stacks are inspected THEN only the launcher may write a change build's input (changeSpec, changeList) and the builder task may read it (ticket 3.7)", () => {
    const writers = participantWriters("BUILD#2026-11-24T10-00-00-000Z-0101010101010101");
    expect(writers.length).toBeGreaterThan(2);
    for (const w of writers) expect(w.attributes, w.role).not.toContain("*");
    for (const name of ["changeSpec", "changeList"]) {
      expect([...new Set(writers.filter((w) => w.attributes.includes(name)).map((w) => w.role))], name).toEqual([BUILD_LAUNCHER_FUNCTION_NAME]);
      expect([...BUILDER_BUILD_READ_ATTRIBUTES], name).toContain(name);
      expect([...BUILDER_BUILD_UPDATE_ATTRIBUTES], name).not.toContain(name);
    }
    // The builder task reads nothing outside BUILD#* (no spec version, no message text): its statements are checked whole below.
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

  it("allows only its logs, GetItem in APP# and APPDATA#, writes in APPDATA# of the data items' attributes only (never the live marker), and (ticket 3.24) a projected GetItem of app write tokens", () => {
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
          // Ticket 3.24: `updatedBy`, the writer's nickname on each value.
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "type", "value", "bytes", "keys", "updatedAt", "updatedBy", "writeDay", "writtenBytes", "sizes"] },
        },
      },
      // Ticket 3.24: the write check reads a token's app, nickname and expiry only, never the rest of APPTOKEN#, never TOKENS#.
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPTOKEN#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "app", "nickname", "expiresAt"] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
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
    // Every route setting of the stage, exactly: the sign-in routes', the data API's, (ticket 3.18) the media API's and
    // (ticket 3.21) the AI tasks'.
    expect(stage?.Properties?.RouteSettings).toEqual({
      [`POST ${APP_AI_PATH}`]: { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      [`OPTIONS ${APP_AI_PATH}`]: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      [`PUT ${APP_MEDIA_PATH}`]: { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 10 },
      [`DELETE ${APP_MEDIA_PATH}`]: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      [`OPTIONS ${APP_MEDIA_PATH}`]: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
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
      "GET /api/status",
      "POST /api/conversation/change/build",
      "POST /api/conversation/change/discard",
      "POST /api/conversation/change/rebuild",
      "POST /api/conversation/change/edit",
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
      // Ticket 3.4: `GET /api/build` counts the builds ahead in the waiting line (a COUNT query, no item read).
      {
        Effect: "Allow",
        Action: "dynamodb:Query",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_QUEUE"], "dynamodb:Attributes": ["pk", "sk", "lastSeenAt"] },
          StringEquals: { "dynamodb:Select": "COUNT" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": [
              "pk", "sk", "type", "listType", "author", "step", "text", "status", "createdAt", "pendingSince", "state", "pendingId", "updatedAt", "kind", "replyTo",
              "approvedSpecVersion", "latestSpecVersion", "approvedAt", "buildId", "stepSince",
              // Ticket 3.6.
              "proposedSpecVersion", "request", "suggestions", "suggestionsRequestedAt",
              // Ticket 3.15.
              "editedSpec",
            ],
          },
        },
      },
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: queueArn() },
      settingsReadStatement(f.tableArn()),
      ...sessionCheckStatements(f.tableArn()),
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

  it("allows only its logs, reads and updates of listed attributes in participants, new builds of listed attributes, the one model, sending to the launch queue and (ticket 3.5) to its own queue, and consuming its queue", () => {
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
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": ["pk", "sk", "type", "listType", "buildId", "nickname", "participantId", "status", "createdAt", "updatedAt", "kind", "changeNumber", "specVersion"],
          },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      },
      // Ticket 3.6: the change build's check that the build it follows is live or failed (status only).
      {
        Effect: "Allow",
        Action: "dynamodb:ConditionCheckItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "status"] },
        },
      },
      settingsReadStatement(f.tableArn()),
      {
        Effect: "Allow",
        Action: "bedrock:InvokeModel",
        Resource: [
          `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/eu.anthropic.claude-sonnet-4-6`,
          "arn:aws:bedrock:eu-*::foundation-model/anthropic.claude-sonnet-4-6",
        ],
      },
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: `arn:aws:sqs:${REGION}:${ACCOUNT}:ssd-workshop-builds.fifo` },
      // Ticket 3.5: a job held by the global Stop goes back on its own queue.
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: queueArn },
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
    // Ticket 3.9 (try 2): the worker never sets approvedAt; the version Rebuild from my repository creates carries its
    // own rebuildApprovedAt, which the launcher builds only as the text it read from the repository itself.
    expect(workerNames).not.toContain("approvedAt");
    expect(workerNames).toContain("rebuildApprovedAt");
    expect(conversationNames).toContain("approvedAt");
    expect(conversationNames).not.toContain("rebuildApprovedAt");
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
      MessageRetentionPeriod: BUILD_QUEUE_RETENTION_SECONDS,
      VisibilityTimeout: BUILD_QUEUE_VISIBILITY_SECONDS,
      RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [byName(BUILD_DLQ_NAME)?.[0], "Arn"] }, maxReceiveCount: BUILD_QUEUE_MAX_RECEIVES },
    });
    // Ticket 3.4: a build waiting for a slot gets its message back every LAUNCH_WAIT_SECONDS, each a new delivery: SQS's
    // maximum lets it wait over 8 hours, and a message that keeps failing (one visibility timeout each) still reaches
    // the dead-letter queue before the queue would drop it.
    expect(BUILD_QUEUE_MAX_RECEIVES).toBe(1000);
    expect(BUILD_QUEUE_RETENTION_SECONDS).toBe(172_800);
    expect(BUILD_QUEUE_MAX_RECEIVES * LAUNCH_WAIT_SECONDS).toBeGreaterThan(8 * 60 * 60);
    expect(BUILD_QUEUE_MAX_RECEIVES * BUILD_QUEUE_VISIBILITY_SECONDS).toBeLessThan(BUILD_QUEUE_RETENTION_SECONDS);
    // Try 2: a waiting entry stays "ahead" longer than a message can stay away (the visibility timeout, when setting its
    // 30 s failed or a launcher was busy), and the check fails a build waiting longer than QUEUE_WAIT_MAX_MS well before a
    // waiting message's deliveries run out.
    expect(QUEUE_SEEN_MS).toBeGreaterThan(BUILD_QUEUE_VISIBILITY_SECONDS * 1000);
    expect(QUEUE_WAIT_MAX_MS).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000);
    expect(QUEUE_WAIT_MAX_MS).toBeLessThan(BUILD_QUEUE_MAX_RECEIVES * LAUNCH_WAIT_SECONDS * 1000);
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
    // Ticket 3.4 try 2: no right on the build slots or the waiting line (the task runs next to the AI agent).
    for (const partition of ["BUILD_SLOTS", "BUILD_QUEUE"]) expect(JSON.stringify(statementsOf(BUILDER_TASK_ROLE_NAME))).not.toContain(partition);
    expect(JSON.stringify(statementsOf(BUILDER_TASK_ROLE_NAME))).not.toContain("dynamodb:ConditionCheckItem");
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

  it("the launcher's rights: the secret, reads and writes by attribute list, RunTask of the builder on the builds cluster only, the dead-letter queues; (ticket 3.9) sends only to the AI worker's queue", () => {
    const tasks = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${BUILDS_CLUSTER_NAME}/*`;
    const limited = [...ATTRIBUTE_LIMITED_RETURN_VALUES];
    const slotNames = ["pk", "sk", "type", "buildId", "heldSince", "running", "version", "repairMisses"];
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
        // Ticket 3.4: ConditionCheckItem for the slot release's check that the build has ended.
        Action: ["dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["BUILD#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAUNCHER_BUILD_UPDATE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": limited },
        },
      },
      // Ticket 3.9: what it read of a participant's SPEC.md, on their request (two names only), then the job back to the AI worker.
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTICIPANT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "repositoryRead", "repositorySpec", "repositoryName"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": limited },
        },
      },
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: `arn:aws:sqs:${REGION}:${ACCOUNT}:${AI_QUEUE_NAME}` },
      // Ticket 3.4: the cap (SETTINGS, read only and projected), the slots (counter and holders) and the waiting line.
      settingsReadStatement(tableArn),
      // Reads projected (try 2: StringEquals on Select, so a read of whole items is refused), writes in their own statements.
      {
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_SLOTS"], "dynamodb:Attributes": [...slotNames] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_SLOTS"], "dynamodb:Attributes": [...slotNames] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": limited },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:Query",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_QUEUE"], "dynamodb:Attributes": ["pk", "sk", "type", "buildId", "lastSeenAt"] },
          StringEquals: { "dynamodb:Select": ["SPECIFIC_ATTRIBUTES", "COUNT"] },
        },
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_QUEUE"], "dynamodb:Attributes": ["pk", "sk", "type", "buildId", "lastSeenAt"] },
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
      // Ticket 3.10: a facilitator's Retry requests, read projected and deleted once acted on.
      {
        Effect: "Allow",
        Action: "dynamodb:Query",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [BUILD_RETRIES_PARTITION], "dynamodb:Attributes": [...RETRY_REQUEST_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:DeleteItem",
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [BUILD_RETRIES_PARTITION], "dynamodb:Attributes": [...RETRY_REQUEST_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE"] },
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
      // Ticket 3.14: listing the builds cluster's tasks (Resource `*` limited to that cluster).
      { Effect: "Allow", Action: "ecs:ListTasks", Resource: "*", Condition: { ArnEquals: { "ecs:cluster": arnOf(idOf("AWS::ECS::Cluster", "ClusterName", BUILDS_CLUSTER_NAME)) } } },
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
    // Ticket 3.4: the build's own update attributes include the waiting place it sets at first sight.
    expect([...LAUNCHER_BUILD_UPDATE_ATTRIBUTES]).toContain("queueKey");
    // Ticket 3.5: and the feed, which a build put back in the queue by the global Stop loses.
    expect([...LAUNCHER_BUILD_UPDATE_ATTRIBUTES]).toContain("feed");
  });

  it("ticket 3.4: only the launcher writes the waiting line; only the launcher and the deployer write the slots, the deployer only to free one (try 2: never the builder task)", () => {
    const writers: Record<string, string[]> = { BUILD_SLOTS: [], BUILD_QUEUE: [] };
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (st.Effect !== "Allow") continue;
        const actions = [st.Action].flat() as string[];
        if (!actions.some((g) => DYNAMODB_WRITE_ACTIONS.some((a) => actionCovers(g, a)))) continue;
        const keys = JSON.stringify(st.Condition ?? {});
        for (const partition of Object.keys(writers)) {
          // A write statement without a partition condition would reach every partition.
          if (!keys.includes("dynamodb:LeadingKeys") || keys.includes(`"${partition}"`)) writers[partition]?.push(`${s}/${id}`);
          if (keys.includes(`"${partition}"`) && !actions.includes("dynamodb:PutItem") && partition === "BUILD_SLOTS") {
            expect(st.Condition).toMatchObject({ "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "running", "version"] } });
          }
        }
      }
    }
    const launcherPolicy = (id: string): boolean => id.includes("Launcher");
    expect(writers.BUILD_QUEUE?.length).toBeGreaterThan(0);
    for (const id of writers.BUILD_QUEUE ?? []) expect(launcherPolicy(id), id).toBe(true);
    expect(writers.BUILD_SLOTS?.some(launcherPolicy)).toBe(true);
    expect(writers.BUILD_SLOTS?.some((id) => id.startsWith(STACK_NAMES.apps))).toBe(true);
    expect(writers.BUILD_SLOTS?.some((id) => id.includes("BuilderTask"))).toBe(false);
    // One policy each: the launcher's and the deployer's.
    expect(new Set(writers.BUILD_SLOTS).size).toBe(2);
  });

  it("ticket 3.4 try 2: every Query or GetItem statement on BUILD_SLOTS or BUILD_QUEUE forces a projection or a count (StringEquals dynamodb:Select)", () => {
    let seen = 0;
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (st.Effect !== "Allow") continue;
        const actions = [st.Action].flat() as string[];
        if (!actions.some((g) => ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:BatchGetItem"].some((a) => actionCovers(g, a)))) continue;
        const keys = JSON.stringify(st.Condition ?? {});
        const reaches = (partition: string): boolean => !keys.includes("dynamodb:LeadingKeys") || keys.includes(`"${partition}"`);
        for (const partition of ["BUILD_SLOTS", "BUILD_QUEUE"]) {
          if (!reaches(partition)) continue;
          seen += 1;
          const select = [(st.Condition as { StringEquals?: Record<string, unknown> } | undefined)?.StringEquals?.["dynamodb:Select"]].flat();
          expect(select.length, `${s}/${id} ${partition}`).toBeGreaterThan(0);
          for (const value of select) expect(["SPECIFIC_ATTRIBUTES", "COUNT"], `${s}/${id} ${partition}`).toContain(value);
          // The slots are never only counted (no need), and never read whole.
          if (partition === "BUILD_SLOTS") expect(select, `${s}/${id}`).toEqual(["SPECIFIC_ATTRIBUTES"]);
        }
      }
    }
    // The launcher's two reads and the conversation function's count.
    expect(seen).toBe(3);
  });

  it("ticket 3.14 criterion 3: WHEN the synthesized stack is inspected THEN only the launcher may list tasks, of the builds cluster only, and it may describe and stop only tasks there", () => {
    const launcherRole = roleEntry(BUILD_LAUNCHER_FUNCTION_NAME)[0];
    const cluster = idOf("AWS::ECS::Cluster", "ClusterName", BUILDS_CLUSTER_NAME);
    const tasks = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${BUILDS_CLUSTER_NAME}/*`;
    const listing: Record<string, unknown>[] = [];
    const watching: Record<string, unknown>[] = [];
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (st.Effect !== "Allow") continue;
        const actions = [st.Action].flat() as string[];
        const lists = actions.some((g) => actionCovers(g, "ecs:ListTasks"));
        const watches = actions.some((g) => ["ecs:DescribeTasks", "ecs:StopTask"].some((a) => actionCovers(g, a)));
        if (!lists && !watches) continue;
        // No other role (a task role, another function) may list, describe or stop build tasks.
        expect(s, `${s}/${id}`).toBe(STACK_NAMES.builds);
        expect(JSON.stringify(r.Properties?.Roles), `${s}/${id}`).toBe(JSON.stringify([{ Ref: launcherRole }]));
        if (lists) listing.push(st);
        if (watches) watching.push(st);
      }
    }
    // ListTasks alone in its statement, Resource `*` only under the builds cluster's ARN (no other cluster, no IfExists).
    expect(listing).toEqual([{ Effect: "Allow", Action: "ecs:ListTasks", Resource: "*", Condition: { ArnEquals: { "ecs:cluster": arnOf(cluster) } } }]);
    expect(buildsOfType("AWS::ECS::Cluster")).toHaveLength(1);
    expect(buildsOfType("AWS::ECS::Cluster")[0]?.[1].Properties?.ClusterName).toBe(BUILDS_CLUSTER_NAME);
    // DescribeTasks and StopTask stay on the builds cluster's tasks.
    expect(watching).toEqual([{ Effect: "Allow", Action: ["ecs:DescribeTasks", "ecs:StopTask"], Resource: tasks }]);
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
        // Ticket 3.4: a waiting build is answered as a batch item failure (its message comes back), not by throwing.
        expect.objectContaining({
          EventSourceArn: queueArn(BUILD_QUEUE_NAME),
          BatchSize: 1,
          ScalingConfig: { MaximumConcurrency: LAUNCHER_MAX_CONCURRENCY },
          FunctionResponseTypes: ["ReportBatchItemFailures"],
        }),
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
  const deployerAsset = (): string => {
    const key = (fnEntry()?.[1].Properties?.Code as { S3Key?: string }).S3Key;
    const manifest = JSON.parse(readFileSync(join(dir, `${STACK_NAMES.apps}.assets.json`), "utf8")) as {
      files: Record<string, { source: { path: string }; destinations: Record<string, { objectKey: string }> }>;
    };
    const asset = Object.values(manifest.files).find((f) => Object.values(f.destinations).some((d) => d.objectKey === key));
    return join(dir, asset?.source.path ?? "missing");
  };

  it("ticket 3.25: bundles the deployer with the platform's templates/basic/workshop-data.js next to its code, byte for byte", () => {
    expect(DATA_CLIENT_FILE.endsWith(join("templates", "basic", "workshop-data.js"))).toBe(true);
    expect(existsSync(join(deployerAsset(), "index.js"))).toBe(true);
    expect(readFileSync(join(deployerAsset(), "workshop-data.js")).equals(readFileSync(DATA_CLIENT_FILE))).toBe(true);
  });

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
      // Ticket 3.4: a build that goes live or fails frees its slot.
      ...slotReleaseExpected(expect.anything()),
      {
        Effect: "Allow",
        Action: ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        Resource: { "Fn::GetAtt": [queue(DEPLOY_QUEUE_NAME)?.[0], "Arn"] },
      },
    ]);
    // The table by name in this account and region, not across stacks.
    for (const st of statements.filter((st) => JSON.stringify(st.Action).includes("dynamodb:"))) {
      expect(st.Resource).toEqual({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE_NAME}`]] });
    }
    expect(DISTRIBUTION_ID).toBe("E2TOZV0ERAXKZ9");
    // The live marker needs `liveAt` (the data API requires it); no other role may write it, and the deployer never writes app data.
    expect(DEPLOYER_LIVE_UPDATE_ATTRIBUTES).toContain("liveAt");
    expect(JSON.stringify(statements)).not.toContain("APPDATA#");
    expect(JSON.stringify(statements)).not.toMatch(/dynamodb:(PutItem|GetItem|Query|Scan|BatchWriteItem)/);
    // Its only delete is a slot holder's (ticket 3.4), in BUILD_SLOTS.
    for (const st of statements.filter((st) => JSON.stringify(st.Action).includes("dynamodb:DeleteItem"))) {
      expect(st.Condition).toMatchObject({ "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BUILD_SLOTS"] } });
    }
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
    expect(PLATFORM_SITE_DOMAIN).toBe(DOMAIN);
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
    // Ticket 3.25: the handler reads the platform's workshop-data.js next to its code, as the Lambda runtime names it.
    const root = process.env.LAMBDA_TASK_ROOT;
    process.env.LAMBDA_TASK_ROOT = join(dir, asset?.source.path ?? "?");
    try {
      await expect(quietly(() => bundle.handler({ Records: [{ body: "not json" }] }))).resolves.toBeUndefined();
    } finally {
      if (root === undefined) delete process.env.LAMBDA_TASK_ROOT;
      else process.env.LAMBDA_TASK_ROOT = root;
    }
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
  const fn = () => ofType("AWS::CloudFront::Function").find(([, , r]) => r.Properties?.Name === APPS_INDEX_FUNCTION_NAME);

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
    expect(patterns).toEqual(["/api/apps/*", "/api/*", "/apps/*", "/app-media/*", "/facilitator*", "/app-sign-in*"]);
    const matches = (pattern: string, path: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path);
    expect(matches("/apps/*", "/api/apps/ada/data/k")).toBe(false);
    // Ticket 3.18: the media path never matches an API or app path, nor the reverse.
    expect(matches("/app-media/*", "/api/apps/ada/media/x")).toBe(false);
    expect(matches("/apps/*", "/app-media/ada/x")).toBe(false);
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
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox; default-src 'self'; connect-src 'self' https:; img-src 'self' data: https:; form-action 'self'",
    );
    // Ticket 2.14: data and images from any HTTPS address, never plain http:, and no script, style or font source beyond 'self'.
    expect(APPS_CONTENT_SECURITY_POLICY).not.toMatch(/http:|script-src|style-src|font-src|\*/);
    expect(APPS_CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
    expect(config.CorsConfig).toBeUndefined();
    expect(config.CustomHeadersConfig).toBeUndefined();
  });

  it("names the policy ssd-workshop-apps-v3 in the edge stack (ticket 3.24's popups escaping the sandbox), retained, versioned in its logical id", () => {
    const [stackName, id, resource] = policy() ?? [];
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(APPS_HEADERS_POLICY_NAME).toBe("ssd-workshop-apps-v3");
    expect(id).toMatch(/^AppsHeadersV3[0-9A-F]{8}$/);
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

describe("CloudFront /facilitator* behaviour: the facilitator dashboard at /facilitator/ (ticket 3.11)", () => {
  const distributionConfig = (): Record<string, unknown> =>
    ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as Record<string, unknown>;
  const behaviour = () => (distributionConfig().CacheBehaviors as Record<string, unknown>[]).find((b) => b.PathPattern === "/facilitator*");
  const fn = () => ofType("AWS::CloudFront::Function").find(([, , r]) => r.Properties?.Name === SITE_INDEX_FUNCTION_NAME);

  it("serves /facilitator* exactly like the pages (site bucket, CachingOptimized, the pages' CSP), plus the site-index function", () => {
    const defaults = distributionConfig().DefaultCacheBehavior as Record<string, unknown>;
    const { PathPattern, FunctionAssociations, ...rest } = behaviour() ?? {};
    expect(PathPattern).toBe("/facilitator*");
    expect(rest).toEqual(defaults);
    expect(defaults.FunctionAssociations).toBeUndefined();
    expect(FunctionAssociations).toEqual([{ EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": [fn()?.[1], "FunctionARN"] } }]);
    // One site origin for both (no second origin, no second origin access control): site, API, apps, media.
    expect((distributionConfig().Origins as unknown[]).length).toBe(4);
  });

  it("cannot match an /api/ or /apps/ path, and the dashboard's files are under it", () => {
    const matches = (pattern: string, path: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path);
    for (const path of ["/api/facilitator/participants", "/apps/facilitator/", "/", "/app.js", "/style.css"]) expect(matches("/facilitator*", path), path).toBe(false);
    for (const path of ["/facilitator", "/facilitator/", "/facilitator/dashboard.js"]) expect(matches("/facilitator*", path), path).toBe(true);
  });

  it("runs the function ssd-workshop-site-index (cloudfront-js-2.0) with the tested code, published, in the edge stack", () => {
    const [stackName, , resource] = fn() ?? [];
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(resource?.Properties).toMatchObject({
      Name: SITE_INDEX_FUNCTION_NAME,
      AutoPublish: true,
      FunctionConfig: { Runtime: "cloudfront-js-2.0" },
      FunctionCode: readFileSync(SITE_INDEX_FUNCTION_FILE, "utf8"),
    });
    expect(SITE_INDEX_FUNCTION_NAME).toBe("ssd-workshop-site-index");
  });
});

describe("WAF web ACL on the distribution (ticket 3.13 criterion 1)", () => {
  const acls = () => ofType("AWS::WAFv2::WebACL");
  const acl = () => must(acls()[0]);

  it("creates one web ACL, ssd-workshop-edge, scope CLOUDFRONT, in the us-east-1 edge stack, tagged project=ssd-workshop", () => {
    expect(acls()).toHaveLength(1);
    const [stackName, , resource] = acl();
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(stack(STACK_NAMES.edge).environment.region).toBe("us-east-1");
    expect(resource.Properties).toMatchObject({ Name: WEB_ACL_NAME, Scope: "CLOUDFRONT", DefaultAction: { Allow: {} } });
    expect(WEB_ACL_NAME).toBe("ssd-workshop-edge");
    expect(tagsOf(resource)[TAG_KEY]).toBe(TAG_VALUE);
    expect(resource.Properties?.VisibilityConfig).toEqual({ CloudWatchMetricsEnabled: true, MetricName: WEB_ACL_NAME, SampledRequestsEnabled: true });
    // WAF's own pattern for a description (no ";": try 2's first wording failed cdk's validation).
    expect(resource.Properties?.Description).toMatch(/^[a-zA-Z0-9=:#@/\-,.][a-zA-Z0-9+=:#@/\-,.\s]+[a-zA-Z0-9+=:#@/\-,.]{1,256}$/);
  });

  it("has exactly six rules: per address, at most the limit of requests to /api/* (3.18: and apart, to /app-media/*) in 5 minutes, then blocked (429); 3.18 try 2: media writes without a Bearer token answered 401; try 3: at most 150 uploads and deletes per address in 5 minutes; after its access review: at most 300 media preflights per address in 5 minutes; 3.21: at most 150 AI requests per address in 5 minutes", () => {
    const rules = acl()[2].Properties?.Rules as Record<string, unknown>[];
    expect(rules).toEqual([
      {
        Name: WAF_API_RATE_RULE_NAME,
        Priority: 0,
        Action: { Block: { CustomResponse: { ResponseCode: WAF_BLOCK_STATUS, CustomResponseBodyKey: WAF_BLOCK_BODY_KEY } } },
        Statement: {
          RateBasedStatement: {
            Limit: WAF_API_RATE_LIMIT,
            EvaluationWindowSec: WAF_RATE_WINDOW_SECONDS,
            AggregateKeyType: "IP",
            ScopeDownStatement: {
              ByteMatchStatement: {
                FieldToMatch: { UriPath: {} },
                PositionalConstraint: "STARTS_WITH",
                SearchString: WAF_API_PATH_PREFIX,
                TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }],
              },
            },
          },
        },
        VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: WAF_API_RATE_RULE_NAME, SampledRequestsEnabled: true },
      },
      {
        Name: WAF_MEDIA_RATE_RULE_NAME,
        Priority: 1,
        Action: { Block: { CustomResponse: { ResponseCode: WAF_BLOCK_STATUS, CustomResponseBodyKey: WAF_BLOCK_BODY_KEY } } },
        Statement: {
          RateBasedStatement: {
            Limit: WAF_MEDIA_RATE_LIMIT,
            EvaluationWindowSec: WAF_RATE_WINDOW_SECONDS,
            AggregateKeyType: "IP",
            ScopeDownStatement: {
              ByteMatchStatement: {
                FieldToMatch: { UriPath: {} },
                PositionalConstraint: "STARTS_WITH",
                SearchString: WAF_MEDIA_PATH_PREFIX,
                TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }],
              },
            },
          },
        },
        VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: WAF_MEDIA_RATE_RULE_NAME, SampledRequestsEnabled: true },
      },
      {
        Name: WAF_MEDIA_AUTH_RULE_NAME,
        Priority: 2,
        Action: {
          Block: {
            CustomResponse: { ResponseCode: 401, CustomResponseBodyKey: WAF_MEDIA_AUTH_BODY_KEY, ResponseHeaders: [{ Name: "access-control-allow-origin", Value: "*" }] },
          },
        },
        Statement: {
          AndStatement: {
            Statements: [
              {
                OrStatement: {
                  Statements: ["PUT", "DELETE"].map((method) => ({
                    ByteMatchStatement: { FieldToMatch: { Method: {} }, PositionalConstraint: "EXACTLY", SearchString: method, TextTransformations: [{ Priority: 0, Type: "NONE" }] },
                  })),
                },
              },
              {
                ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "STARTS_WITH", SearchString: "/api/apps/", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
              },
              {
                ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "CONTAINS", SearchString: "/media/", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
              },
              {
                NotStatement: {
                  Statement: {
                    // Try 3: lower-cased first, so `bearer x` and `BEARER x` pass on as checkAppWrite accepts them.
                    ByteMatchStatement: {
                      FieldToMatch: { SingleHeader: { Name: "authorization" } },
                      PositionalConstraint: "STARTS_WITH",
                      SearchString: "bearer ",
                      TextTransformations: [{ Priority: 0, Type: "LOWERCASE" }],
                    },
                  },
                },
              },
            ],
          },
        },
        VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: WAF_MEDIA_AUTH_RULE_NAME, SampledRequestsEnabled: true },
      },
      {
        Name: WAF_MEDIA_WRITE_RATE_RULE_NAME,
        Priority: 3,
        Action: {
          Block: {
            CustomResponse: { ResponseCode: 429, CustomResponseBodyKey: WAF_MEDIA_WRITE_RATE_BODY_KEY, ResponseHeaders: [{ Name: "access-control-allow-origin", Value: "*" }] },
          },
        },
        Statement: {
          RateBasedStatement: {
            Limit: 150,
            EvaluationWindowSec: 300,
            AggregateKeyType: "IP",
            ScopeDownStatement: {
              AndStatement: {
                Statements: [
                  {
                    OrStatement: {
                      Statements: ["PUT", "DELETE"].map((method) => ({
                        ByteMatchStatement: { FieldToMatch: { Method: {} }, PositionalConstraint: "EXACTLY", SearchString: method, TextTransformations: [{ Priority: 0, Type: "NONE" }] },
                      })),
                    },
                  },
                  {
                    ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "STARTS_WITH", SearchString: "/api/apps/", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
                  },
                  {
                    ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "CONTAINS", SearchString: "/media/", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
                  },
                ],
              },
            },
          },
        },
        VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: WAF_MEDIA_WRITE_RATE_RULE_NAME, SampledRequestsEnabled: true },
      },
      {
        Name: WAF_MEDIA_PREFLIGHT_RATE_RULE_NAME,
        Priority: 4,
        Action: {
          Block: {
            CustomResponse: { ResponseCode: 429, CustomResponseBodyKey: WAF_MEDIA_WRITE_RATE_BODY_KEY, ResponseHeaders: [{ Name: "access-control-allow-origin", Value: "*" }] },
          },
        },
        Statement: {
          RateBasedStatement: {
            Limit: 300,
            EvaluationWindowSec: 300,
            AggregateKeyType: "IP",
            ScopeDownStatement: {
              AndStatement: {
                Statements: [
                  { ByteMatchStatement: { FieldToMatch: { Method: {} }, PositionalConstraint: "EXACTLY", SearchString: "OPTIONS", TextTransformations: [{ Priority: 0, Type: "NONE" }] } },
                  {
                    ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "STARTS_WITH", SearchString: "/api/apps/", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
                  },
                  {
                    ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "CONTAINS", SearchString: "/media/", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
                  },
                ],
              },
            },
          },
        },
        VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: WAF_MEDIA_PREFLIGHT_RATE_RULE_NAME, SampledRequestsEnabled: true },
      },
      {
        Name: WAF_AI_RATE_RULE_NAME,
        Priority: 5,
        Action: {
          Block: {
            CustomResponse: { ResponseCode: 429, CustomResponseBodyKey: WAF_AI_RATE_BODY_KEY, ResponseHeaders: [{ Name: "access-control-allow-origin", Value: "*" }] },
          },
        },
        Statement: {
          RateBasedStatement: {
            Limit: 150,
            EvaluationWindowSec: 300,
            AggregateKeyType: "IP",
            ScopeDownStatement: {
              AndStatement: {
                Statements: [
                  {
                    OrStatement: {
                      Statements: ["POST", "OPTIONS"].map((method) => ({
                        ByteMatchStatement: { FieldToMatch: { Method: {} }, PositionalConstraint: "EXACTLY", SearchString: method, TextTransformations: [{ Priority: 0, Type: "NONE" }] },
                      })),
                    },
                  },
                  {
                    ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "STARTS_WITH", SearchString: "/api/apps/", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
                  },
                  {
                    ByteMatchStatement: { FieldToMatch: { UriPath: {} }, PositionalConstraint: "ENDS_WITH", SearchString: "/ai", TextTransformations: [{ Priority: 0, Type: "URL_DECODE" }, { Priority: 1, Type: "NORMALIZE_PATH" }] },
                  },
                ],
              },
            },
          },
        },
        VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: WAF_AI_RATE_RULE_NAME, SampledRequestsEnabled: true },
      },
    ]);
    // Ticket 3.21: the AI route's shared throttles (POST 5/s, OPTIONS 20/s) take at least 3 addresses to fill (10 and 40).
    expect(WAF_AI_RATE_RULE_NAME).toBe("ssd-workshop-ai-rate");
    expect(WAF_AI_RATE_LIMIT).toBe(150);
    expect([...WAF_AI_RATE_METHODS]).toEqual(["POST", "OPTIONS"]);
    for (const throttle of [APP_AI_THROTTLE, APP_AI_PREFLIGHT_THROTTLE]) expect(WAF_AI_RATE_LIMIT / WAF_RATE_WINDOW_SECONDS).toBeLessThan(throttle.rateLimit / 3);
    expect(JSON.parse(WAF_AI_RATE_BODY)).toEqual({ message: "Too many AI requests from this address. Please wait a few minutes and try again." });
    // Try 3: one address (a made-up `Bearer x` passes the junk filter) can no longer hold the shared 2/s upload
    // throttle at 429 for every app: 150 per 5 minutes is 0.5/s, so filling the throttle takes at least 4 addresses.
    expect(WAF_MEDIA_WRITE_RATE_RULE_NAME).toBe("ssd-workshop-media-write-rate");
    expect(WAF_MEDIA_WRITE_RATE_LIMIT).toBe(150);
    expect(WAF_MEDIA_WRITE_RATE_LIMIT / WAF_RATE_WINDOW_SECONDS).toBeLessThan(APP_MEDIA_UPLOAD_THROTTLE.rateLimit / 3);
    // After the access review of try 3: preflights get their own per-address rule (300 per 5 minutes, 1/s), and the
    // preflight throttle stays 20/s (a higher throttle would raise the cost at the cap).
    expect(WAF_MEDIA_PREFLIGHT_RATE_RULE_NAME).toBe("ssd-workshop-media-preflight-rate");
    expect(WAF_MEDIA_PREFLIGHT_RATE_LIMIT).toBe(300);
    expect(WAF_MEDIA_PREFLIGHT_RATE_METHOD).toBe("OPTIONS");
    expect(WAF_MEDIA_WRITE_RATE_METHODS).toEqual(["PUT", "DELETE"]);
    expect(WAF_MEDIA_PATH_TRANSFORMATIONS).toEqual([{ priority: 0, type: "URL_DECODE" }, { priority: 1, type: "NORMALIZE_PATH" }]);
    // A room behind one venue address sends one preflight per upload: at most rule 3's 150 in the window, far below 300.
    expect(WAF_MEDIA_PREFLIGHT_RATE_LIMIT).toBeGreaterThanOrEqual(2 * WAF_MEDIA_WRITE_RATE_LIMIT);
    // Every shared media route throttle (upload, delete, preflight) takes at least 3 addresses to fill: the per-address
    // WAF limit covering that method, per second, is below a third of the throttle's rate.
    const perAddressLimit = (method: string): number => {
      const limits = [
        ...((WAF_MEDIA_WRITE_RATE_METHODS as readonly string[]).includes(method) ? [WAF_MEDIA_WRITE_RATE_LIMIT] : []),
        ...(method === WAF_MEDIA_PREFLIGHT_RATE_METHOD ? [WAF_MEDIA_PREFLIGHT_RATE_LIMIT] : []),
      ];
      expect(limits, method).not.toHaveLength(0);
      return Math.min(...limits);
    };
    for (const [method, throttle] of [
      ["PUT", APP_MEDIA_UPLOAD_THROTTLE],
      ["DELETE", APP_MEDIA_DELETE_THROTTLE],
      ["OPTIONS", APP_MEDIA_PREFLIGHT_THROTTLE],
    ] as const) {
      expect(perAddressLimit(method) / WAF_RATE_WINDOW_SECONDS, method).toBeLessThan(throttle.rateLimit / 3);
    }
    expect(JSON.parse(WAF_MEDIA_WRITE_RATE_BODY)).toEqual({ message: "Too many uploads from this address. Please wait a few minutes and try again." });
    expect(WAF_MEDIA_AUTH_RULE_NAME).toBe("ssd-workshop-media-auth");
    // The same answer as the media API's own 401 (workshop-data.js shows `message`).
    expect(JSON.parse(WAF_MEDIA_AUTH_BODY)).toEqual({ message: APP_MEDIA_MESSAGES.signInToSave });
    expect(WAF_MEDIA_AUTH_STATUS).toBe(401);
    // checkAppWrite (3.24) reads `Bearer <token>` in any case (`/^Bearer .../i`): the filter compares lower-cased (try 3).
    expect(WAF_BEARER_PREFIX).toBe("bearer ");
    for (const scheme of ["Bearer", "bearer", "BEARER"]) expect(readBearerToken({ headers: { authorization: `${scheme} ${"a".repeat(43)}` } } as never), scheme).toBe("a".repeat(43));
    expect(WAF_MEDIA_RATE_RULE_NAME).toBe("ssd-workshop-media-rate");
    expect(WAF_MEDIA_PATH_PREFIX).toBe("/app-media/");
    // Try 2 (cost, accepted by Franck 2026-11-26): 3,000. A room behind one venue address, each person opening ~60
    // files once in 5 minutes (browsers keep them a day).
    expect(WAF_MEDIA_RATE_LIMIT).toBe(3_000);
    expect(WAF_MEDIA_RATE_LIMIT).toBeGreaterThanOrEqual(45 * 60);
    expect(WAF_API_PATH_PREFIX).toBe("/api/");
    expect(WAF_RATE_WINDOW_SECONDS).toBe(300);
    // API Gateway's throttle answer, so pages and apps read a block as "too many requests".
    expect(acl()[2].Properties?.CustomResponseBodies).toEqual({
      [WAF_BLOCK_BODY_KEY]: { ContentType: "APPLICATION_JSON", Content: WAF_BLOCK_BODY },
      [WAF_MEDIA_AUTH_BODY_KEY]: { ContentType: "APPLICATION_JSON", Content: WAF_MEDIA_AUTH_BODY },
      [WAF_MEDIA_WRITE_RATE_BODY_KEY]: { ContentType: "APPLICATION_JSON", Content: WAF_MEDIA_WRITE_RATE_BODY },
      [WAF_AI_RATE_BODY_KEY]: { ContentType: "APPLICATION_JSON", Content: WAF_AI_RATE_BODY },
    });
    expect(JSON.parse(WAF_BLOCK_BODY)).toEqual({ message: "Too Many Requests" });
    // A room behind one venue address must never reach it: ~45 people polling every 2 s (150 requests per 5 minutes
    // each), their apps' data calls and three dashboards are at most ~9,400 (docs/decisions.md "(3.13) Rate limit").
    expect(WAF_API_RATE_LIMIT).toBeGreaterThanOrEqual(45 * 150 + 2_000 + 3 * 60);
  });

  it("covers every /api/ behaviour of the distribution and nothing else", () => {
    const config = ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as { CacheBehaviors: { PathPattern: string }[] };
    const patterns = config.CacheBehaviors.map((b) => b.PathPattern);
    for (const pattern of patterns.filter((p) => p.startsWith("/api"))) expect(pattern.startsWith(WAF_API_PATH_PREFIX), pattern).toBe(true);
    expect(patterns).toEqual(expect.arrayContaining(["/api/*", "/api/apps/*"]));
  });

  it("answers a block with 429, never 403: the distribution turns every 403 into the 404 page (ticket 2.5)", () => {
    const config = ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as { CustomErrorResponses: { ErrorCode: number }[] };
    const remapped = config.CustomErrorResponses.map((r) => r.ErrorCode);
    expect(remapped).toContain(403);
    expect(WAF_BLOCK_STATUS).toBe(429);
    expect(remapped).not.toContain(WAF_BLOCK_STATUS);
  });

  it("is the distribution's web ACL (WebACLId is the ACL's ARN, same stack, no cross-region reference)", () => {
    const distributions = ofType("AWS::CloudFront::Distribution");
    expect(distributions).toHaveLength(1);
    const [distStack, , distribution] = must(distributions[0]);
    expect(distStack).toBe(STACK_NAMES.edge);
    const config = distribution.Properties?.DistributionConfig as { WebACLId?: unknown };
    expect(config.WebACLId).toEqual({ "Fn::GetAtt": [acl()[1], "Arn"] });
  });
});

describe("Cost Anomaly Detection (ticket 3.13 criterion 3)", () => {
  const monitors = () => ofType("AWS::CE::AnomalyMonitor");
  const subscriptions = () => ofType("AWS::CE::AnomalySubscription");

  it("lives in its own stack ssd-workshop-alerts in us-east-1, inline template, nothing else in it", () => {
    expect(STACK_NAMES.alerts).toBe("ssd-workshop-alerts");
    expect(stack(STACK_NAMES.alerts).environment.region).toBe("us-east-1");
    const types = resources(STACK_NAMES.alerts).map(([, r]) => r.Type).filter((t) => t !== "AWS::CDK::Metadata").sort();
    expect(types).toEqual(["AWS::CE::AnomalyMonitor", "AWS::CE::AnomalySubscription"]);
  });

  it("monitors the cost allocation tag project=ssd-workshop (custom monitor), tagged project=ssd-workshop", () => {
    expect(monitors()).toHaveLength(1);
    const [stackName, , monitor] = must(monitors()[0]);
    expect(stackName).toBe(STACK_NAMES.alerts);
    expect(monitor.Properties).toMatchObject({ MonitorName: COST_MONITOR_NAME, MonitorType: "CUSTOM" });
    expect(monitor.Properties?.MonitorDimension).toBeUndefined();
    expect(JSON.parse(monitor.Properties?.MonitorSpecification as string)).toEqual({
      Tags: { Key: "project", Values: ["ssd-workshop"], MatchOptions: ["EQUALS"] },
    });
    expect(tagsOf(monitor)[TAG_KEY]).toBe(TAG_VALUE);
  });

  it("emails Franck's alert address daily for anomalies of $10 or more, the address read from SSM at deploy time", () => {
    expect(subscriptions()).toHaveLength(1);
    const [stackName, , subscription] = must(subscriptions()[0]);
    expect(stackName).toBe(STACK_NAMES.alerts);
    const monitorId = must(monitors()[0])[1];
    expect(subscription.Properties).toMatchObject({
      SubscriptionName: COST_SUBSCRIPTION_NAME,
      MonitorArnList: [{ Ref: monitorId }],
      Frequency: COST_ANOMALY_FREQUENCY,
    });
    expect(COST_ANOMALY_FREQUENCY).toBe("DAILY");
    expect(JSON.parse(subscription.Properties?.ThresholdExpression as string)).toEqual({
      Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: [String(COST_ANOMALY_THRESHOLD_USD)] },
    });
    expect(subscription.Properties?.Threshold).toBeUndefined();
    const reference = `{{resolve:ssm:${ALERT_EMAIL_PARAMETER}:${ALERT_EMAIL_PARAMETER_VERSION}}}`;
    expect(subscription.Properties?.Subscribers).toEqual([{ Type: "EMAIL", Address: reference }]);
    expect(ALERT_EMAIL_PARAMETER).toBe("/ssd-workshop/alert-email");
    expect(tagsOf(subscription)[TAG_KEY]).toBe(TAG_VALUE);
  });

  it("holds no email address in any template but the workshop's SES sender (the alert address is a deploy setting in SSM)", () => {
    for (const name of STACKS) {
      const found = JSON.stringify(stack(name).template).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g) ?? [];
      expect(found.filter((address) => address !== SENDER_ADDRESS), name).toEqual([]);
    }
    expect(JSON.stringify(stack(STACK_NAMES.alerts).template.Parameters ?? {})).toBe("{}");
  });
});

describe("ticket 3.18: the media bucket, the media function and /app-media/*", () => {
  const appsResources = () => resources(STACK_NAMES.apps);
  const bucketEntry = () => appsResources().find(([, r]) => r.Type === "AWS::S3::Bucket" && r.Properties?.BucketName === APP_MEDIA_BUCKET_NAME);
  const bucketStatements = () =>
    (
      appsResources().find(([, r]) => r.Type === "AWS::S3::BucketPolicy" && JSON.stringify(r.Properties?.Bucket) === JSON.stringify({ Ref: bucketEntry()?.[0] }))?.[1]
        .Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }
    ).Statement;
  const bucketArn = () => ({ "Fn::GetAtt": [bucketEntry()?.[0], "Arn"] });
  const MEDIA_BUCKET_ARNS = [`arn:aws:s3:::${APP_MEDIA_BUCKET_NAME}`, `arn:aws:s3:::${APP_MEDIA_BUCKET_NAME}/app-media/ada/x`];
  const reachesMedia = (resource: unknown): boolean =>
    resourceReaches(resource, MEDIA_BUCKET_ARNS, bucketEntry() === undefined ? [] : [bucketEntry()?.[0] ?? "?"], [APP_MEDIA_BUCKET_NAME, "ssd-workshop-app-media"]);
  const f = apiFunction(APP_MEDIA_FUNCTION_NAME);
  const distributionConfig = (): Record<string, unknown> =>
    ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as Record<string, unknown>;
  const behaviour = () => (distributionConfig().CacheBehaviors as Record<string, unknown>[]).find((b) => b.PathPattern === "/app-media/*");
  const headersPolicy = () =>
    ofType("AWS::CloudFront::ResponseHeadersPolicy").find(
      ([, , r]) => (r.Properties?.ResponseHeadersPolicyConfig as { Name?: string }).Name === APP_MEDIA_HEADERS_POLICY_NAME,
    );

  it("criterion 9: creates the private bucket ssd-workshop-app-media-<account> in the apps stack: tagged, no public access, ACLs off, encrypted, retained", () => {
    expect(APP_MEDIA_BUCKET_NAME).toBe(`ssd-workshop-app-media-${ACCOUNT}`);
    expect(PLATFORM_APP_MEDIA_BUCKET_NAME).toBe(APP_MEDIA_BUCKET_NAME);
    const [, resource] = must(bucketEntry());
    expect(resource).toMatchObject({
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        BucketName: APP_MEDIA_BUCKET_NAME,
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      },
    });
    expect(tagsOf(resource)[TAG_KEY]).toBe(TAG_VALUE);
    // No website, CORS, logging or notification settings (3.21: its one lifecycle rule expires transcripts/, tested below).
    for (const prop of ["WebsiteConfiguration", "CorsConfiguration", "LoggingConfiguration", "NotificationConfiguration", "ReplicationConfiguration"]) {
      expect(resource.Properties?.[prop], prop).toBeUndefined();
    }
  });

  it("criteria 7 and 9: only the workshop's distribution (its exact ARN) may read, only over TLS (enforceSSL), and nobody lists the bucket", () => {
    const allows = bucketStatements().filter((st) => st.Effect === "Allow");
    expect(allows).toEqual([
      {
        Sid: "CloudFrontReadOnly",
        Effect: "Allow",
        Action: "s3:GetObject",
        Principal: { Service: "cloudfront.amazonaws.com" },
        // Ticket 3.21: the served files only, never Transcribe's results under `transcripts/`.
        Resource: { "Fn::Join": ["", [bucketArn(), "/app-media/*"]] },
        Condition: { StringEquals: { "AWS:SourceAccount": ACCOUNT, "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/${DISTRIBUTION_ID}` } },
      },
    ]);
    expect(bucketStatements()).toContainEqual(
      expect.objectContaining({ Effect: "Deny", Action: "s3:*", Principal: { AWS: "*" }, Condition: { Bool: { "aws:SecureTransport": "false" } } }),
    );
    expect(JSON.stringify(bucketStatements())).not.toContain("distribution/*");
    expect(JSON.stringify(bucketStatements())).not.toContain("s3:ListBucket");
  });

  it("criterion 9: the bucket policy refuses every object write to any principal but the media function's role (with and without its path)", () => {
    expect(bucketStatements().find((st) => st.Sid === "OnlyTheMediaFunctionWrites")).toEqual({
      Sid: "OnlyTheMediaFunctionWrites",
      Effect: "Deny",
      Action: [...APP_MEDIA_OBJECT_WRITE_ACTIONS],
      Principal: { AWS: "*" },
      // Ticket 3.21: everything but `transcripts/` (never served), where Amazon Transcribe writes for the AI function.
      NotResource: { "Fn::Join": ["", [bucketArn(), "/transcripts/*"]] },
      Condition: { ArnNotEquals: { "aws:PrincipalArn": [APP_MEDIA_ROLE_ARN, APP_MEDIA_ROLE_ARN_WITHOUT_PATH] } },
    });
    for (const action of ["s3:PutObject", "s3:PutObjectAcl", "s3:PutObjectTagging", "s3:RestoreObject", "s3:ReplicateObject"]) {
      expect(APP_MEDIA_OBJECT_WRITE_ACTIONS, action).toContain(action);
    }
    expect(APP_MEDIA_ROLE_ARN).toBe(`arn:aws:iam::${ACCOUNT}:role/ssd-workshop/ssd-workshop-api-app-media`);
    expect(APP_MEDIA_ROLE_ARN_WITHOUT_PATH).toBe(`arn:aws:iam::${ACCOUNT}:role/ssd-workshop-api-app-media`);
    // The media function's role is that ARN: its name, its path and the boundary.
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ RoleName: APP_MEDIA_FUNCTION_NAME, Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
  });

  it("criterion 9: no IAM policy in any stack, other than the media function's (3.21: and the AI function's under transcripts/ only), may write or delete in the media bucket", () => {
    const writes = (action: string): boolean => action === "*" || /^s3:(\*|Put|Delete|Restore|Replicate|Abort|Object)/i.test(action) || /^s3:.*\*/.test(action);
    for (const pattern of ["*", "arn:aws:s3:::ssd-*", "arn:aws:s3:::*/app-media/*", "arn:aws:s3:::ssd-workshop-app-?edia-*/*"]) expect(reachesMedia(pattern), pattern).toBe(true);
    expect(reachesMedia(`arn:aws:s3:::${APPS_BUCKET_NAME}/apps/*`)).toBe(false);
    const mediaRole = f.roleEntry()?.[0];
    const aiRole = apiFunction(APP_AI_FUNCTION_NAME).roleEntry()?.[0];
    const transcripts = `arn:aws:s3:::${APP_MEDIA_BUCKET_NAME}/transcripts/*`;
    let checked = 0;
    let own = 0;
    let ai = 0;
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      const forMedia = s === STACK_NAMES.api && JSON.stringify(r.Properties?.Roles) === JSON.stringify([{ Ref: mediaRole }]);
      const forAi = s === STACK_NAMES.api && JSON.stringify(r.Properties?.Roles) === JSON.stringify([{ Ref: aiRole }]);
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        assertNoExclusions(`${s}/${id}`, st);
        if (st.Effect !== "Allow") continue;
        if (!([st.Action].flat() as string[]).some(writes)) continue;
        checked += 1;
        if (forMedia) {
          own += 1;
          continue;
        }
        if (forAi && JSON.stringify([st.Resource].flat()) === JSON.stringify([transcripts])) {
          expect(st.Action).toEqual(["s3:PutObject", "s3:DeleteObject"]);
          ai += 1;
          continue;
        }
        for (const resource of [st.Resource].flat()) expect(reachesMedia(resource), `${s}/${id}: ${JSON.stringify(st)}`).toBe(false);
      }
    }
    expect(own).toBe(1);
    expect(ai).toBe(1);
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("criterion 9: no IAM policy, the media function's included, may change the media bucket's policy, lifecycle, website, CORS or delete it", () => {
    const bucketActions = ["s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutLifecycleConfiguration", "s3:PutBucketWebsite", "s3:PutBucketCORS", "s3:DeleteBucket", "s3:PutBucketPublicAccessBlock"];
    for (const [s, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (st.Effect !== "Allow") continue;
        const granted = [st.Action].flat() as string[];
        const covered = bucketActions.filter((action) => granted.some((g) => actionCovers(g, action)));
        if (covered.length === 0) continue;
        for (const resource of [st.Resource].flat()) expect(reachesMedia(resource), `${s}/${id} ${covered.join(",")}: ${JSON.stringify(st)}`).toBe(false);
      }
    }
  });

  it("names the function, role and log group ssd-workshop-api-app-media; Node.js 22 arm64, 512 MB, 25 s (two S3 attempts fit, under API Gateway's 30 s), tagged", () => {
    expect(APP_MEDIA_FUNCTION_NAME).toBe("ssd-workshop-api-app-media");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: APP_MEDIA_MEMORY_MB,
      Timeout: APP_MEDIA_TIMEOUT_SECONDS,
      Code: { S3Bucket: ASSETS_BUCKET_NAME },
    });
    expect(APP_MEDIA_MEMORY_MB).toBe(512);
    expect(2 * (S3_TIMEOUTS.connectionTimeout + S3_TIMEOUTS.requestTimeout) + 5000).toBeLessThanOrEqual(APP_MEDIA_TIMEOUT_SECONDS * 1000);
    expect(APP_MEDIA_TIMEOUT_SECONDS).toBeLessThan(30);
    // The reset's last media pass waits longer than this timeout (platform's copy, ticket 3.18 try 2).
    expect(APP_MEDIA_TIMEOUT_SECONDS).toBe(PLATFORM_APP_MEDIA_TIMEOUT_SECONDS);
    expect(tagsOf(f.fnEntry()?.[1] as Resource)[TAG_KEY]).toBe(TAG_VALUE);
    expect(f.apiResources().find(([id]) => id === f.logGroupId())?.[1].Properties).toMatchObject({ LogGroupName: APP_MEDIA_FUNCTION_NAME, RetentionInDays: 14 });
    expect(f.roleEntry()?.[1].Properties?.ManagedPolicyArns).toBeUndefined();
  });

  it("routes PUT, DELETE and OPTIONS /api/apps/{nickname}/media/{id} to it (the platform's routes), invoked only by this API, throttled after the routes exist", () => {
    const keys = APP_MEDIA_METHODS.map((method) => `${method} ${APP_MEDIA_PATH}`);
    expect(keys).toEqual([...APP_MEDIA_ROUTE_KEYS]);
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
    // Try 2 (cost, accepted by Franck 2026-11-26): 2/s, burst 10.
    expect(APP_MEDIA_UPLOAD_THROTTLE).toEqual({ rateLimit: 2, burstLimit: 10 });
    expect(APP_MEDIA_DELETE_THROTTLE).toEqual({ rateLimit: 10, burstLimit: 20 });
    // Not raised (a higher throttle raises the cost at the cap): WAF's per-address preflight rule keeps one address
    // from holding it at 429 (the WAF test checks the ratio).
    expect(APP_MEDIA_PREFLIGHT_THROTTLE).toEqual({ rateLimit: 20, burstLimit: 40 });
    const [, stage] = f.apiResources().find(([, r]) => r.Type === "AWS::ApiGatewayV2::Stage") ?? [];
    for (const routeKey of keys) {
      const routeId = f.apiResources().find(([, r]) => r.Type === "AWS::ApiGatewayV2::Route" && r.Properties?.RouteKey === routeKey)?.[0];
      expect(routeId, routeKey).toBeDefined();
      expect([stage?.DependsOn].flat(), routeKey).toContain(routeId);
      expect((stage?.Properties?.RouteSettings as Record<string, unknown>)[routeKey], routeKey).toBeDefined();
    }
  });

  it("allows only its logs, projected reads of the live marker, app write tokens and its own items, the live marker's ConditionCheck, writes in APPMEDIA# of the media attributes only, and S3 put/delete under app-media/ of the media bucket", () => {
    const projected = (prefix: string, attributes: readonly string[]) => ({
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource: f.tableArn(),
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [prefix] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...attributes] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(f.statements()).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] } },
      projected("APP#*", APP_LIVE_READ_ATTRIBUTES),
      projected("APPTOKEN#*", APP_TOKEN_READ_ATTRIBUTES),
      projected("APPMEDIA#*", APP_MEDIA_READ_ATTRIBUTES),
      {
        Effect: "Allow",
        Action: "dynamodb:ConditionCheckItem",
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_LIVE_READ_ATTRIBUTES] },
        },
      },
      {
        Effect: "Allow",
        // Try 3: no DeleteItem. A failed upload and a DELETE both leave a tombstone, so the function never deletes a
        // record (only the reset, with Franck's credentials, does), and an id can never be freed for other bytes.
        Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        Resource: f.tableArn(),
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPMEDIA#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...APP_MEDIA_WRITE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": [...ATTRIBUTE_LIMITED_RETURN_VALUES] },
        },
      },
      { Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject"], Resource: `arn:aws:s3:::${APP_MEDIA_BUCKET_NAME}/app-media/*` },
    ]);
    // pk and sk are in every list; the live marker's `liveAt` is never writable; `APPMEDIA#*` never matches `APP#` or `APPDATA#` keys.
    for (const list of [APP_MEDIA_WRITE_ATTRIBUTES, APP_MEDIA_READ_ATTRIBUTES, APP_LIVE_READ_ATTRIBUTES]) expect(list).toEqual(expect.arrayContaining(["pk", "sk"]));
    expect(APP_MEDIA_WRITE_ATTRIBUTES).not.toContain("liveAt");
    for (const key of ["APP#ada", "APPDATA#ada", "APPTOKEN#ab"]) expect(actionCovers("APPMEDIA#*", key), key).toBe(false);
    expect(actionCovers("APP#*", "APPMEDIA#ada")).toBe(false);
    expect(actionCovers("APPDATA#*", "APPMEDIA#ada")).toBe(false);
  });

  it("criterion 1: the platform stores under app-media/<nickname>/ and answers https://workshop.rankly.games/app-media/<nickname>/<id>, which the behaviour serves", () => {
    expect(MEDIA_KEY_PREFIX).toBe(APP_MEDIA_KEY_PREFIX);
    expect(`/${MEDIA_KEY_PREFIX}*`).toBe(APP_MEDIA_PATH_PATTERN);
    expect(mediaAddress("Ada", "A".repeat(22))).toBe(`https://${DOMAIN}/app-media/ada/${"A".repeat(22)}`);
    expect(behaviour()).toBeDefined();
  });

  it("criterion 7: serves /app-media/* from the media bucket through the ssd-workshop-app-media origin access control: GET and HEAD, HTTPS (redirect), managed CachingOptimized (follows the stored Cache-Control)", () => {
    expect(behaviour()).toMatchObject({
      AllowedMethods: ["GET", "HEAD"],
      ViewerProtocolPolicy: "redirect-to-https",
      CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
      ResponseHeadersPolicyId: { Ref: headersPolicy()?.[1] },
    });
    expect(behaviour()?.FunctionAssociations).toBeUndefined();
    expect(behaviour()?.OriginRequestPolicyId).toBeUndefined();
    const origin = (distributionConfig().Origins as Record<string, unknown>[]).find((o) => o.Id === behaviour()?.TargetOriginId);
    expect(origin?.DomainName).toBe(APP_MEDIA_BUCKET_REGIONAL_DOMAIN);
    expect(APP_MEDIA_BUCKET_REGIONAL_DOMAIN).toBe(`${APP_MEDIA_BUCKET_NAME}.s3.${REGION}.amazonaws.com`);
    const oac = ofType("AWS::CloudFront::OriginAccessControl").find(([, , r]) => (r.Properties?.OriginAccessControlConfig as { Name?: string }).Name === "ssd-workshop-app-media");
    expect(origin?.OriginAccessControlId).toEqual({ "Fn::GetAtt": [oac?.[1], "Id"] });
    expect(oac?.[2].Properties?.OriginAccessControlConfig).toMatchObject({ OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" });
    // Try 2: a day in browsers (no `immutable`), an hour in CloudFront, so a deleted file leaves the CDN within an hour.
    expect(MEDIA_CACHE_CONTROL).toBe("public, max-age=86400, s-maxage=3600");
  });

  it("criterion 7: answers every file with nosniff, HSTS, the referrer policy and an inert sandbox CSP, no CORS; the policy is ssd-workshop-app-media-v1, retained, versioned in its logical id", () => {
    const [stackName, id, resource] = must(headersPolicy());
    expect(stackName).toBe(STACK_NAMES.edge);
    expect(APP_MEDIA_HEADERS_POLICY_NAME).toBe("ssd-workshop-app-media-v1");
    expect(id).toMatch(/^AppMediaHeadersV1[0-9A-F]{8}$/);
    expect(resource).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    const config = resource.Properties?.ResponseHeadersPolicyConfig as Record<string, unknown>;
    expect(config.SecurityHeadersConfig).toEqual({
      ContentSecurityPolicy: { ContentSecurityPolicy: APP_MEDIA_CONTENT_SECURITY_POLICY, Override: true },
      ContentTypeOptions: { Override: true },
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: true },
      ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
    });
    expect(APP_MEDIA_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; sandbox");
    expect(config.CorsConfig).toBeUndefined();
    expect(config.CustomHeadersConfig).toBeUndefined();
  });

  it("the /api/apps/* CloudFront CORS policy covers the media API's preflight (methods and headers)", () => {
    const policy = ofType("AWS::CloudFront::ResponseHeadersPolicy").find(([, , r]) => (r.Properties?.ResponseHeadersPolicyConfig as { Name?: string }).Name === APP_DATA_HEADERS_POLICY_NAME);
    const cors = (policy?.[2].Properties?.ResponseHeadersPolicyConfig as { CorsConfig: { AccessControlAllowMethods: { Items: string[] }; AccessControlAllowHeaders: { Items: string[] } } }).CorsConfig;
    for (const method of MEDIA_PREFLIGHT_HEADERS["access-control-allow-methods"].split(", ")) expect(cors.AccessControlAllowMethods.Items, method).toContain(method);
    expect(cors.AccessControlAllowHeaders.Items.join(", ")).toBe(MEDIA_PREFLIGHT_HEADERS["access-control-allow-headers"]);
    expect(MEDIA_PREFLIGHT_HEADERS["access-control-allow-origin"]).toBe("*");
  });

  it("bundles the handler into a self-contained index.js that answers the preflight with CORS, without the table or the bucket", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string }) => Promise<{ statusCode: number; headers?: Record<string, string> }> }>();
    const answer = await quietly(() => bundle.handler({ routeKey: `OPTIONS ${APP_MEDIA_PATH}` }));
    expect(answer.statusCode).toBe(204);
    expect(answer.headers?.["access-control-allow-origin"]).toBe("*");
  });
});

describe("ticket 3.21: the AI tasks for apps (function, role, routes, transcripts)", () => {
  const f = apiFunction(APP_AI_FUNCTION_NAME);
  const mediaBucket = () => resources(STACK_NAMES.apps).find(([, r]) => r.Type === "AWS::S3::Bucket" && r.Properties?.BucketName === APP_MEDIA_BUCKET_NAME);

  it("names the function, role and log group ssd-workshop-api-app-ai; Node.js 22 arm64, 512 MB, 28 s (under API Gateway's 30 s); role on the path with the boundary", () => {
    expect(APP_AI_FUNCTION_NAME).toBe("ssd-workshop-api-app-ai");
    expect(f.fnEntry()?.[1].Properties).toMatchObject({ Runtime: "nodejs22.x", Architectures: ["arm64"], MemorySize: APP_AI_MEMORY_MB, Timeout: APP_AI_TIMEOUT_SECONDS, Code: { S3Bucket: ASSETS_BUCKET_NAME } });
    expect(APP_AI_TIMEOUT_SECONDS).toBeLessThan(30);
    expect(f.roleEntry()?.[1].Properties).toMatchObject({ RoleName: APP_AI_FUNCTION_NAME, Path: IAM_PATH, PermissionsBoundary: BOUNDARY_ARN });
    expect(APP_AI_ROLE_ARN).toBe(`arn:aws:iam::${ACCOUNT}:role/ssd-workshop/ssd-workshop-api-app-ai`);
    expect(f.logGroupId()).toBeDefined();
  });

  it("criterion 9: WHEN npm run synth runs THEN the role may invoke only the Haiku 4.5 EU profile (and its foundation models), read only ssd-workshop-app-media, run only its own Transcribe jobs and update only its three day counters (app, writer, all apps)", () => {
    const table = f.tableArn();
    const media = (suffix: string) => `arn:aws:s3:::${APP_MEDIA_BUCKET_NAME}/${suffix}`;
    expect(f.statements()).toEqual([
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [f.logGroupId(), "Arn"] } },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: table,
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APP#*"] }, "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "liveAt"] }, StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" } },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: table,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPTOKEN#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "app", "nickname", "expiresAt"] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      settingsReadStatement(table),
      {
        Effect: "Allow",
        Action: "dynamodb:GetItem",
        Resource: table,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPAI#*", "APPAI_WRITER#*", "APPAI_TOTAL"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "day", "costUsd"] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      },
      {
        Effect: "Allow",
        Action: "dynamodb:UpdateItem",
        Resource: table,
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["APPAI#*", "APPAI_WRITER#*", "APPAI_TOTAL"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "type", "day", "costUsd", "updatedAt"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      },
      {
        Effect: "Allow",
        Action: "bedrock:InvokeModel",
        Resource: [
          `arn:aws:bedrock:eu-central-1:${ACCOUNT}:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`,
          "arn:aws:bedrock:eu-*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        ],
      },
      { Effect: "Allow", Action: "s3:GetObject", Resource: [media("app-media/*"), media("transcripts/*")] },
      { Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject"], Resource: media("transcripts/*") },
      {
        Effect: "Allow",
        Action: "transcribe:StartTranscriptionJob",
        Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": "eu-central-1", "transcribe:OutputBucketName": APP_MEDIA_BUCKET_NAME }, StringLike: { "transcribe:OutputKey": "transcripts/*" } },
      },
      {
        Effect: "Allow",
        Action: ["transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"],
        Resource: `arn:aws:transcribe:eu-central-1:${ACCOUNT}:transcription-job/ssd-workshop-app-ai-*`,
      },
    ]);
    expect([...APP_AI_BEDROCK_INVOKE_RESOURCES].join(" ")).toContain(APP_AI_MODEL_ID);
    expect(APP_AI_MODEL_ID).toBe(PLATFORM_MODELS.appAi.modelId);
    expect(APP_AI_FOUNDATION_MODEL_ID).toBe(APP_AI_MODEL_ID.replace(/^eu\./, ""));
    expect(APP_AI_TRANSCRIPTION_JOBS.endsWith("transcription-job/ssd-workshop-app-ai-*")).toBe(true);
    // Every S3 resource it names is in the media bucket; no other bucket and no bucket-level action.
    const s3 = f.statements().filter((st) => JSON.stringify(st.Action).includes("s3:"));
    for (const st of s3) for (const resource of [st.Resource].flat()) expect(String(resource).startsWith(`arn:aws:s3:::${APP_MEDIA_BUCKET_NAME}/`), String(resource)).toBe(true);
    // The counters' partitions cannot overlap the live marker's, the data's, the media's or the tokens'.
    for (const other of ["APP#ada", "APPDATA#ada", "APPMEDIA#ada", "APPTOKEN#x", "SETTINGS"]) for (const pattern of APP_AI_LEADING_KEYS) expect(actionCovers(pattern, other), `${pattern} ${other}`).toBe(false);
    // Nor each other (try 2): the app's, the writer's and the all-apps counter are told apart by their patterns.
    const examples: Record<string, string> = { "APPAI#*": "APPAI#ada", "APPAI_WRITER#*": "APPAI_WRITER#bob", APPAI_TOTAL: "APPAI_TOTAL" };
    for (const pattern of APP_AI_LEADING_KEYS) for (const [owner, key] of Object.entries(examples)) expect(actionCovers(pattern, key), `${pattern} ${key}`).toBe(owner === pattern);
  });

  it("WHEN the synthesized stacks are inspected THEN no IAM policy but the AI role's names a transcribe: action (the boundary allows Transcribe on * to every bounded role)", () => {
    const aiRole = JSON.stringify([{ Ref: f.roleEntry()?.[0] }]);
    const samples = ["StartTranscriptionJob", "GetTranscriptionJob", "DeleteTranscriptionJob", "ListTranscriptionJobs", "StartStreamTranscription", "TagResource", "CreateVocabulary"].map((a) => `transcribe:${a}`);
    const namesTranscribe = (st: Record<string, unknown>): boolean => {
      if (st.Effect !== "Allow") return false;
      if (st.NotAction !== undefined) return !([st.NotAction].flat() as string[]).some((g) => actionCovers(g, "transcribe:StartTranscriptionJob"));
      return ([st.Action].flat() as string[]).some((g) => g.toLowerCase().startsWith("transcribe:") || samples.some((action) => actionCovers(g, action)));
    };
    const holders: string[] = [];
    for (const [stack, id, r] of [...ofType("AWS::IAM::Policy"), ...ofType("AWS::IAM::ManagedPolicy")]) {
      for (const st of (r.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement) {
        if (!namesTranscribe(st)) continue;
        holders.push(`${stack}/${id}`);
        expect(JSON.stringify(r.Properties?.Roles), `${stack}/${id}`).toBe(aiRole);
        expect(r.Properties?.Users ?? r.Properties?.Groups, `${stack}/${id}`).toBeUndefined();
      }
    }
    for (const [stack, id, role] of ofType("AWS::IAM::Role")) {
      for (const inline of (role.Properties?.Policies ?? []) as { PolicyDocument: { Statement: Record<string, unknown>[] } }[]) {
        expect(inline.PolicyDocument.Statement.some(namesTranscribe), `${stack}/${id}`).toBe(false);
      }
    }
    expect(holders.length).toBeGreaterThan(0);
    // The check itself: wildcards that would reach Transcribe are caught.
    for (const action of ["*", "transcribe:*", "Transcribe:Get*", "t*:Start*"]) expect(namesTranscribe({ Effect: "Allow", Action: action }), action).toBe(true);
    expect(namesTranscribe({ Effect: "Allow", NotAction: "s3:*" })).toBe(true);
    expect(namesTranscribe({ Effect: "Allow", Action: ["s3:GetObject", "bedrock:InvokeModel"] })).toBe(false);
  });

  it("routes POST and OPTIONS /api/apps/{nickname}/ai to it (one permission for this API) and throttles them, after the routes exist", () => {
    for (const routeKey of APP_AI_ROUTE_KEYS) {
      const integration = f.integrationOf(routeKey);
      expect(integration, routeKey).toBeDefined();
      expect(JSON.stringify(integration?.IntegrationUri)).toContain(f.fnEntry()?.[0] ?? "?");
    }
    expect(f.permissions()).toHaveLength(1);
    expect(APP_AI_THROTTLE).toEqual({ rateLimit: 5, burstLimit: 10 });
    expect(APP_AI_PREFLIGHT_THROTTLE).toEqual({ rateLimit: 20, burstLimit: 40 });
    const [, stage] = f.apiResources().find(([, r]) => r.Type === "AWS::ApiGatewayV2::Stage") ?? [];
    for (const method of ["POST", "OPTIONS"]) {
      const routeId = f.apiResources().find(([, r]) => r.Type === "AWS::ApiGatewayV2::Route" && r.Properties?.RouteKey === `${method} ${APP_AI_PATH}`)?.[0];
      expect([stage?.DependsOn].flat(), method).toContain(routeId);
    }
  });

  it("keeps Transcribe's results apart: written only under transcripts/, never served, expired after a day", () => {
    expect(APP_AI_TRANSCRIPTS_PREFIX).toBe("transcripts/");
    expect(mediaBucket()?.[1].Properties?.LifecycleConfiguration).toEqual({ Rules: [{ Id: "ssd-workshop-transcripts-expiry", Prefix: "transcripts/", ExpirationInDays: 1, Status: "Enabled" }] });
    const config = ofType("AWS::CloudFront::Distribution")[0]?.[2].Properties?.DistributionConfig as { CacheBehaviors: { PathPattern: string }[] };
    expect(config.CacheBehaviors.map((b) => b.PathPattern).filter((p) => p.includes("transcripts"))).toEqual([]);
  });

  it("bundles the handler into a self-contained index.js that answers the preflight with CORS for POST, without the table, Bedrock or Transcribe", async () => {
    const bundle = f.bundle<{ handler: (event: { routeKey: string }) => Promise<{ statusCode: number; headers?: Record<string, string> }> }>();
    const answer = await quietly(() => bundle.handler({ routeKey: `OPTIONS ${APP_AI_PATH}` }));
    expect(answer.statusCode).toBe(204);
    expect(answer.headers).toEqual({ ...AI_PREFLIGHT_HEADERS });
  });
});
