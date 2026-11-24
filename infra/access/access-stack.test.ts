// Static checks of the access stack (infra/access/access-stack.yaml). The stack is applied
// by Franck only, so these tests read the template; what only AWS can prove is listed in
// infra/access/README.md.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, type Scalar, type ScalarTag, type CollectionTag, type YAMLSeq } from "yaml";
import {
  ACCOUNT,
  AI_WORKER_FUNCTION_NAME,
  ASSETS_BUCKET_NAME,
  BUILD_CHECK_QUEUE_NAME,
  BUILD_CHECK_SCHEDULE_NAME,
  BUILD_CHECK_SCHEDULER_ROLE_NAME,
  BUILD_DLQ_NAME,
  BUILD_LAUNCHER_FUNCTION_NAME,
  BUILD_LAUNCHER_ROLE_ARN,
  BUILD_QUEUE_NAME,
  BUILDER_EXECUTION_ROLE_NAME,
  BUILDER_TASK_FAMILY,
  BUILDER_TASK_ROLE_NAME,
  BUILDS_CLUSTER_NAME,
  BUILDS_SUBNET_IDS,
  DEPLOY_DLQ_NAME,
  DEPLOY_QUEUE_NAME,
  DEPLOYER_FUNCTION_NAME,
  IAM_PATH,
  REGION,
} from "../lib/config.js";

// CloudFormation short-form intrinsics, turned into their long form ({ "Fn::Sub": ... }).
function scalarIntrinsic(tag: string, key: string, split = false): ScalarTag {
  return {
    tag,
    resolve: (value: string) => ({ [key]: split ? value.split(".") : value }),
  };
}
function seqIntrinsic(tag: string, key: string): CollectionTag {
  return {
    tag,
    collection: "seq",
    resolve: (seq) => ({ [key]: (seq as YAMLSeq).toJSON() }) as unknown as Scalar,
  };
}
const cfnTags = [
  scalarIntrinsic("!Ref", "Ref"),
  scalarIntrinsic("!Sub", "Fn::Sub"),
  scalarIntrinsic("!GetAtt", "Fn::GetAtt", true),
  seqIntrinsic("!Equals", "Fn::Equals"),
];

type Value = string | { Ref: string } | { "Fn::Sub": string };
type Cond = Record<string, Record<string, unknown>>;
interface Statement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: Value | Value[];
  NotResource?: unknown;
  Condition?: Cond;
}
interface Resource {
  Type: string;
  Properties: Record<string, unknown>;
}
interface Template {
  Parameters: Record<string, { Default?: unknown }>;
  Resources: Record<string, Resource>;
}

const templatePath = new URL("./access-stack.yaml", import.meta.url);
const templateText = readFileSync(templatePath, "utf8");
function loadTemplate(text = templateText): Template {
  return parse(text, { customTags: cfnTags }) as Template;
}
// A copy of the template with one exact piece of text replaced (the old, loose pattern).
function withText(oldText: string, newText: string): Template {
  expect(templateText.split(oldText), `"${oldText}" must occur exactly once`).toHaveLength(2);
  return loadTemplate(templateText.replace(oldText, newText));
}

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: Value): string =>
  typeof v === "string" ? v : "Ref" in v ? `Ref:${v.Ref}` : v["Fn::Sub"];

function statements(t: Template, logicalId: string): Statement[] {
  const props = t.Resources[logicalId]?.Properties as
    | { PolicyDocument: { Statement: Statement[] } }
    | undefined;
  if (!props) throw new Error(`${logicalId} missing from the template`);
  return props.PolicyDocument.Statement;
}
const DEPLOY_POLICIES = ["DeployPolicy", "DeployPolicyEdge", "DeployPolicyEc2", "DeployPolicyRead"];
const ALL_POLICIES = ["BoundaryPolicy", ...DEPLOY_POLICIES];
const deployStatements = (t: Template) => DEPLOY_POLICIES.flatMap((id) => statements(t, id));
const boundaryStatements = (t: Template) => statements(t, "BoundaryPolicy");
// A copy of the template with every occurrence of a piece of text replaced.
function withAll(oldText: string, newText: string): Template {
  expect(templateText.includes(oldText), `"${oldText}" must occur`).toBe(true);
  return loadTemplate(templateText.split(oldText).join(newText));
}

// "Read" = the action name starts with Describe/List/Get/View/Validate, or apigateway:GET.
function isRead(action: string): boolean {
  if (action === "apigateway:GET") return true;
  const name = action.split(":")[1] ?? "";
  return /^(Describe|List|Get|View|Validate)/.test(name);
}

// IAM wildcard match (actions and ARNs), case-insensitive like IAM action names.
function matches(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(value);
}

// A resource ARN is scoped when its resource name STARTS with "ssd-workshop-" (or the IAM path
// or SSM path "ssd-workshop/"), after the resource type ("role/", "log-group:", ...). Pseudo
// parameters such as ${AWS::AccountId} hold "::", so they are replaced before the ARN is split
// on ':'. S3 ARNs have no type: the bucket name itself must start with "ssd-workshop-". The only
// prefixes allowed between type and name are the log group paths Lambda and ECS use, and the
// schedule group of a schedule.
const NAMED_RESOURCE =
  /^(?:schedule\/\*\/|log-group:(?:\/aws\/lambda\/|\/ecs\/)|[a-z][a-z-]*[/:])?ssd-workshop[-/]/i;
function isScopedArn(arn: string): boolean {
  const parts = arn.replace(/\$\{AWS::[A-Za-z]+\}/g, "PSEUDO").split(":");
  if (parts[0] !== "arn" || parts.length < 6) return false;
  const resource = parts.slice(5).join(":");
  return parts[2] === "s3" ? resource.startsWith("ssd-workshop-") : NAMED_RESOURCE.test(resource);
}

// Writes that AWS cannot scope to a name or tag, keyed "Sid/action" so moving one to another
// statement needs a reviewer to look again. One line of reason each. A tag-adding action scoped
// only by aws:RequestTag can never be excused here (see unscopedWrites).
const ACTION_ALLOW_LIST: Record<string, string> = {
  "ActionsWithoutResourceScope/ecr:GetAuthorizationToken": "account-wide registry login token; repositories stay scoped by ecr:* on ssd-workshop-*",
  "ActionsWithoutResourceScope/ecs:DeregisterTaskDefinition": "IAM supports only Resource * for this action; it marks a revision INACTIVE, running tasks and services keep it (owner-accepted risk)",
  "ActionsWithoutResourceScope/logs:CreateLogDelivery": "vended log deliveries (API Gateway, Step Functions) support only Resource *",
  "ActionsWithoutResourceScope/logs:DeleteLogDelivery": "vended log deliveries support only Resource * (owner-accepted risk)",
  "TagEventSourceMappings/lambda:TagResource": "mapping ids are generated; a tag on a mapping grants nothing, since every mapping change needs lambda:FunctionArn ssd-workshop-* (WorkshopEventSourceMappings)",
  "WorkshopServiceLinkedRoles/iam:CreateServiceLinkedRole": "limited by iam:AWSServiceName to ECS's service-linked role, whose name and rights AWS defines",
  "CloudFrontUntaggableParts/cloudfront:CreateOriginAccessControl": "generated id, no tags; create only, so existing controls of other distributions cannot be changed or deleted",
  "CloudFrontUntaggableParts/cloudfront:CreateCachePolicy": "generated id, no tags; create only",
  "CloudFrontUntaggableParts/cloudfront:CreateOriginRequestPolicy": "generated id, no tags; create only",
  "CloudFrontUntaggableParts/cloudfront:CreateResponseHeadersPolicy": "generated id, no tags; create only",
  "Ec2RunInstancesAmazonImages/ec2:RunInstances": "AMIs are read-only inputs, limited by ec2:Owner to images Amazon owns",
};
const DEPLOY_EXCEPTIONS: Record<string, string> = {
  ...ACTION_ALLOW_LIST,
  "Bedrock/bedrock:InvokeModel": "calls Anthropic models only; no resource is changed",
  "Bedrock/bedrock:InvokeModelWithResponseStream": "calls Anthropic models only; no resource is changed",
  "CertificatesThroughCloudFormation/acm:RequestCertificate": "authorizes no existing resource; only through CloudFormation, which tags it in the same create (TagOnCreateThroughCloudFormation); domains limited by acm:DomainNames (acmDomainGaps)",
  "SesForTesting/ses:SendEmail": "identities ssd-workshop@rankly.games and rankly.games and the ssd-workshop-email configuration set only, sender pinned by ses:FromAddress (sesScopeGaps)",
  "SesForTesting/ses:SendRawEmail": "identities ssd-workshop@rankly.games and rankly.games and the ssd-workshop-email configuration set only, sender pinned by ses:FromAddress (sesScopeGaps)",
};
// The boundary's own exceptions (same rules as the deploy policies).
const BOUNDARY_ALLOW_LIST: Record<string, string> = {
  "Bedrock/bedrock:InvokeModel": "calls Anthropic models only; no resource is changed",
  "Bedrock/bedrock:InvokeModelWithResponseStream": "calls Anthropic models only; no resource is changed",
  "SendCodes/ses:SendEmail": "identities ssd-workshop@rankly.games and rankly.games and the ssd-workshop-email configuration set only, sender pinned by ses:FromAddress (sesScopeGaps)",
  "SendCodes/ses:SendRawEmail": "identities ssd-workshop@rankly.games and rankly.games and the ssd-workshop-email configuration set only, sender pinned by ses:FromAddress (sesScopeGaps)",
  "AccountWideServiceCalls/ecr:GetAuthorizationToken": "account-wide registry login token; image pulls stay scoped to ssd-workshop-* repositories",
  "AccountWideServiceCalls/xray:PutTraceSegments": "X-Ray has no resource scope; writes trace data only",
  "WorkshopMetrics/cloudwatch:PutMetricData": "limited by cloudwatch:namespace to ssd-workshop",
  "K3sNodeChannels/ssmmessages:*": "Session Manager channels of the calling instance; no resource scope exists",
  "K3sNodeChannels/ec2messages:*": "Run Command channel of the calling instance; no resource scope exists",
};

// Creates allowed on Resource "*" with only aws:RequestTag. A request tag is true for every
// resource a call names, so this is safe only for actions that authorize no existing resource
// (AWS Service Authorization Reference). Keyed "Sid/action", one line of reason each.
const REQUEST_TAG_ON_ANY: Record<string, string> = {
  "CloudFrontTaggedCreate/cloudfront:CreateDistribution": "authorizes no existing resource; origins and policies are not authorized by it",
  "CertificatesTagged/acm:RequestCertificate": "authorizes no resource; domains limited by acm:DomainNames (acmDomainGaps)",
};

// Tag-adding actions. Wildcards count when they would match one of these names.
const TAG_ADDING = ["TagResource", "AddTagsToCertificate", "AddTagsToResource", "CreateTags", "TagRole", "TagUser", "TagPolicy"];
function addsTags(pattern: string): boolean {
  const service = pattern.split(":")[0] ?? "";
  return TAG_ADDING.some((name) => matches(pattern, `${service}:${name}`));
}

const condValues = (c: Cond | undefined, op: string, key: string) => list(c?.[op]?.[key] as unknown);
const projectTag = (c: Cond | undefined, key: string) => {
  const v = condValues(c, "StringEquals", key);
  return v.length === 1 && v[0] === "ssd-workshop";
};
const subText = (v: unknown) => (typeof v === "string" ? v : text(v as Value));

interface Scope {
  names: boolean;
  requestTag: boolean;
  resourceTag: boolean;
  createAction: boolean;
  dns: boolean;
  functionArn: boolean;
  tagOnCreate: boolean;
}

// EC2 create actions allowed only with the project tag in the request.
function taggedEc2Creates(t: Template): Set<string> {
  const creates = new Set<string>();
  for (const s of deployStatements(t)) {
    if (s.Effect !== "Allow" || !projectTag(s.Condition, "aws:RequestTag/project")) continue;
    for (const a of list(s.Action)) if (a.startsWith("ec2:") && !a.includes("*")) creates.add(a.slice(4));
  }
  return creates;
}

const DNS_NAMES = ["workshop.rankly.games", "*.workshop.rankly.games"];
const DNS_TYPES = ["A", "AAAA", "CNAME"];
// DNS scope: names under workshop.rankly.games, record types A/AAAA/CNAME, and a Null guard on
// both keys (ForAllValues is true when a key is missing).
function dnsScoped(c: Cond | undefined): boolean {
  const names = condValues(c, "ForAllValues:StringLike", "route53:ChangeResourceRecordSetsNormalizedRecordNames");
  const types = condValues(c, "ForAllValues:StringEquals", "route53:ChangeResourceRecordSetsRecordTypes");
  const guard = c?.Null ?? {};
  return (
    names.length > 0 && names.every((n) => DNS_NAMES.includes(String(n))) &&
    types.length > 0 && types.every((v) => DNS_TYPES.includes(String(v))) &&
    guard["route53:ChangeResourceRecordSetsNormalizedRecordNames"] === "false" &&
    guard["route53:ChangeResourceRecordSetsRecordTypes"] === "false"
  );
}

// Tagging a resource while CloudFormation creates it (CreateDistributionWithTags and
// RequestCertificate with tags also authorize TagResource / AddTagsToCertificate). Safe only with
// all three guards: the project tag in the request, no project tag on the resource yet, and the
// call made through CloudFormation (whose resource import is denied by NoResourceImport), so an
// existing resource of another project cannot be tagged and then taken over.
function tagOnCreateGuarded(c: Cond | undefined): boolean {
  return (
    projectTag(c, "aws:RequestTag/project") &&
    c?.Null?.["aws:ResourceTag/project"] === "true" &&
    condValues(c, "ForAnyValue:StringEquals", "aws:CalledVia").join() === "cloudformation.amazonaws.com"
  );
}
const TAG_ON_CREATE_ACTIONS = ["cloudfront:TagResource", "acm:AddTagsToCertificate"];

// CloudFormation's API Gateway v2 handler tags a new API or stage through the tags endpoint,
// whose resource has no resource-tag key (Service Authorization Reference), so the Null guard
// above cannot apply. Safe with the project tag in the request, the call made through
// CloudFormation (resource import denied) and nothing but the tags endpoint as resource.
const APIGW_TAGS_ARN = "arn:aws:apigateway:${AWS::Region}::/tags/*";
const APIGW_TAG_ACTIONS = ["apigateway:POST", "apigateway:PUT"];
function apigwTagOnCreate(s: Statement): boolean {
  const c = s.Condition;
  const resources = list(s.Resource).map(text);
  return (
    projectTag(c, "aws:RequestTag/project") &&
    condValues(c, "ForAnyValue:StringEquals", "aws:CalledVia").join() === "cloudformation.amazonaws.com" &&
    resources.length === 1 && resources[0] === APIGW_TAGS_ARN
  );
}

function scopeOf(s: Statement, t: Template): Scope {
  const c = s.Condition;
  const resources = list(s.Resource).map(text);
  const createValues = condValues(c, "StringEquals", "ec2:CreateAction");
  const creates = taggedEc2Creates(t);
  const fnArns = condValues(c, "ArnLike", "lambda:FunctionArn").map(subText);
  return {
    names: resources.length > 0 && resources.every(isScopedArn),
    requestTag: projectTag(c, "aws:RequestTag/project"),
    resourceTag: projectTag(c, "aws:ResourceTag/project"),
    // ec2:CreateAction counts only when every value is a create that itself needs the project tag.
    createAction: createValues.length > 0 && createValues.every((v) => creates.has(String(v))),
    dns: dnsScoped(c),
    functionArn: fnArns.length > 0 && fnArns.every(isScopedArn),
    tagOnCreate: tagOnCreateGuarded(c),
  };
}

// Every unscoped write in a set of statements, as "Sid/action" strings.
function unscopedWrites(t: Template, stmts: Statement[], allowList: Record<string, string>): string[] {
  const found: string[] = [];
  for (const s of stmts) {
    if (s.Effect !== "Allow") continue;
    if (s.NotAction !== undefined || s.NotResource !== undefined) {
      found.push(`${s.Sid}/NotAction-or-NotResource`);
      continue;
    }
    const sc = scopeOf(s, t);
    const requestTagOnly = sc.requestTag && !sc.resourceTag && !sc.names;
    const wildcardResource = list(s.Resource).map(text).some((r) => r.includes("*"));
    for (const a of list(s.Action).filter((x) => !isRead(x))) {
      const key = `${s.Sid}/${a}`;
      if (sc.tagOnCreate && TAG_ON_CREATE_ACTIONS.includes(a)) continue;
      if (APIGW_TAG_ACTIONS.includes(a) && apigwTagOnCreate(s)) continue;
      if (requestTagOnly) {
        // A tag in the request says nothing about the resources the call names: with only
        // aws:RequestTag, the role could tag ANY existing resource and then change it through
        // the ResourceTag statements. Same for API Gateway writes under existing APIs, and for
        // any create on Resource "*" (it also covers the existing parents it names).
        const anyResource = list(s.Resource).map(text).includes("*");
        if (addsTags(a) || (a.startsWith("apigateway:") && wildcardResource)) found.push(key);
        else if (anyResource && !(key in REQUEST_TAG_ON_ANY)) found.push(key);
        continue;
      }
      if (sc.names || sc.resourceTag || sc.createAction || sc.dns || sc.functionArn) continue;
      if (!(key in allowList)) found.push(key);
    }
  }
  return found;
}
const deployGaps = (t: Template) => unscopedWrites(t, deployStatements(t), DEPLOY_EXCEPTIONS);
const boundaryGaps = (t: Template) => unscopedWrites(t, boundaryStatements(t), BOUNDARY_ALLOW_LIST);

// Reads whose answer holds secrets or another project's full configuration (environment
// variables, user data, stack outputs, API keys, IAM documents, secret and parameter values,
// origin headers, contact addresses, VPN pre-shared keys). None may be allowed account-wide unless an explicit deny
// keeps it to the project tag.
const SECRET_READS = [
  "lambda:ListFunctions", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
  "ecs:DescribeTaskDefinition", "apigateway:GET",
  "cloudformation:DescribeStacks", "cloudformation:GetTemplate", "cloudformation:ListExports",
  "ec2:DescribeInstanceAttribute", "ec2:DescribeLaunchTemplateVersions",
  "iam:GetAccountAuthorizationDetails", "iam:GetRole", "iam:GetRolePolicy", "iam:GetPolicyVersion",
  "secretsmanager:GetSecretValue", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
  "cloudfront:GetDistributionConfig", "ses:ListContacts", "ses:GetContact", "ses:GetAccount",
  "ec2:DescribeVpnConnections",
];
// Owner-accepted account-wide reads of that list, keyed "Sid/action" and named exactly (a wildcard
// that covers one is still a gap). Deploy policies only: the boundary gets none.
const ACCEPTED_SECRET_READS: Record<string, string> = {
  "ActionsWithoutResourceScope/ecs:DescribeTaskDefinition":
    "IAM supports only Resource * for it, and CloudFormation reads every task definition it manages with the caller's rights (accepted risk, Franck 2026-11-23)",
};
function secretReadGaps(t: Template, stmts: Statement[], accepted: Record<string, string> = {}): string[] {
  const covers = (s: Statement, a: string) => list(s.Action).some((p) => matches(p, a));
  return SECRET_READS.filter((a) => {
    const wide = stmts.some((s) => {
      if (s.Effect !== "Allow" || !covers(s, a)) return false;
      if (list(s.Action).includes(a) && `${s.Sid}/${a}` in accepted) return false;
      const sc = scopeOf(s, t);
      return !(sc.names || sc.resourceTag || sc.functionArn);
    });
    const deniedOutsideTag = stmts.some(
      (s) =>
        s.Effect === "Deny" && covers(s, a) && list(s.Resource).map(text).includes("*") &&
        (s.Condition === undefined ||
          (Object.keys(s.Condition).length === 1 &&
            condValues(s.Condition, "StringNotEquals", "aws:ResourceTag/project")[0] === "ssd-workshop")),
    );
    return wide && !deniedOutsideTag;
  });
}

// ec2:RunInstances: images only with ec2:Owner amazon; network interfaces only with the project
// resource tag (a request tag would also hold for another project's existing interface).
const SAMPLE_IMAGE = "arn:aws:ec2:eu-central-1::image/ami-0abc";
const SAMPLE_ENI = "arn:aws:ec2:eu-central-1:${AWS::AccountId}:network-interface/eni-0abc";
function runInstancesGaps(t: Template): string[] {
  const gaps: string[] = [];
  for (const s of deployStatements(t)) {
    if (s.Effect !== "Allow" || !list(s.Action).some((p) => matches(p, "ec2:RunInstances"))) continue;
    const res = list(s.Resource).map(text);
    const owner = condValues(s.Condition, "StringEquals", "ec2:Owner");
    if (res.some((r) => matches(r, SAMPLE_IMAGE)) && !(owner.length === 1 && owner[0] === "amazon")) gaps.push(`${s.Sid}/image`);
    const sc = scopeOf(s, t);
    if (res.some((r) => matches(r, SAMPLE_ENI)) && !sc.resourceTag) gaps.push(`${s.Sid}/network-interface`);
  }
  return gaps;
}

// The access stack's own identities: no deploy right may change them.
const PROTECTED_IDENTITIES = [
  "role/ssd-workshop-deploy",
  "user/ssd-workshop-claude",
  "policy/ssd-workshop-boundary",
  "policy/ssd-workshop-deploy",
  "policy/ssd-workshop-deploy-edge",
  "policy/ssd-workshop-deploy-ec2",
  "policy/ssd-workshop-deploy-read",
].map((p) => `arn:aws:iam::\${AWS::AccountId}:${p}`);
const IAM_WRITES = [
  "iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
  "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:UpdateRole", "iam:TagRole",
  "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:AttachUserPolicy",
  "iam:PutUserPolicy", "iam:CreateAccessKey", "iam:UpdateAccessKey", "iam:CreateLoginProfile",
  "iam:AddUserToGroup", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion",
  "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:TagPolicy",
];
const unconditionalDenies = (stmts: Statement[]) => stmts.filter((s) => s.Effect === "Deny" && s.Condition === undefined);
function denied(stmts: Statement[], arn: string, action: string): boolean {
  return unconditionalDenies(stmts).some((s) => {
    const res = list(s.Resource).map(text);
    if (!res.includes(arn) && !res.includes("*")) return false;
    return s.Action !== undefined
      ? list(s.Action).some((p) => matches(p, action))
      : !list(s.NotAction).some((p) => matches(p, action));
  });
}
function identityGaps(stmts: Statement[]): string[] {
  return PROTECTED_IDENTITIES.flatMap((arn) => IAM_WRITES.filter((a) => !denied(stmts, arn, a)).map((a) => `${arn}/${a}`));
}

// IAM writes that an Allow statement grants on the deploy role (path "/"), structurally.
const DEPLOY_ROLE_ARN = "arn:aws:iam::${AWS::AccountId}:role/ssd-workshop-deploy";
function deployRoleWrites(stmts: Statement[]): string[] {
  return stmts
    .filter((s) => s.Effect === "Allow" && list(s.Resource).map(text).some((r) => matches(r, DEPLOY_ROLE_ARN)))
    .flatMap((s) => list(s.Action).filter((a) => a.startsWith("iam:") && !isRead(a)).map((a) => `${s.Sid}/${a}`));
}

// Services a workshop role may be handed to (see docs/decisions.md).
const PASSED_TO = ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com", "ec2.amazonaws.com", "states.amazonaws.com", "scheduler.amazonaws.com", "events.amazonaws.com"];
function passRoleGaps(stmts: Statement[], services = PASSED_TO): string[] {
  return stmts
    .filter((s) => s.Effect === "Allow" && list(s.Action).some((p) => matches(p, "iam:PassRole")))
    .filter((s) => {
      const passed = condValues(s.Condition, "StringEquals", "iam:PassedToService");
      const paths = list(s.Resource).map(text).every((r) => r.endsWith(":role/ssd-workshop/*"));
      return !paths || passed.length === 0 || !passed.every((v) => services.includes(String(v)));
    })
    .map((s) => s.Sid);
}

// S3 bucket names are global: every grant on ssd-workshop-* buckets must also require this account.
function s3AccountGaps(stmts: Statement[]): string[] {
  return stmts
    .filter((s) => s.Effect === "Allow" && list(s.Resource).map(text).some((r) => r.startsWith("arn:aws:s3:::")))
    .filter((s) => JSON.stringify(s.Condition?.StringEquals?.["aws:ResourceAccount"]) !== JSON.stringify({ Ref: "AWS::AccountId" }))
    .map((s) => s.Sid);
}

// Resource policies and exports that would share workshop data outside the account.
const SHARING = [
  "s3:PutBucketAcl", "s3:PutObjectAcl", "s3:PutObjectVersionAcl", "secretsmanager:PutResourcePolicy",
  "ecr:SetRepositoryPolicy", "lambda:CreateFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig",
  "lambda:AddLayerVersionPermission", "sqs:AddPermission", "sns:AddPermission",
  "dynamodb:PutResourcePolicy", "dynamodb:ExportTableToPointInTime", "ssm:PutResourcePolicy",
  "logs:PutResourcePolicy", "logs:PutSubscriptionFilter", "logs:CreateExportTask",
  "s3:PutBucketLogging", "s3:PutInventoryConfiguration", "s3:PutAnalyticsConfiguration",
  "s3:PutReplicationConfiguration", "s3:PutBucketNotification",
];
// CDK's bucket notifications handler (a workshop role) calls PutBucketNotificationConfiguration,
// so the boundary cannot deny it (accepted risk in the README).
const BOUNDARY_SHARING = SHARING.filter((a) => a !== "s3:PutBucketNotification");
const conditionalDeny = (stmts: Statement[], action: string, op: string, key: string) =>
  stmts.find((s) => s.Effect === "Deny" && list(s.Action).includes(action) && condValues(s.Condition, op, key).length > 0);

// Policy size as IAM counts it: minified JSON with the Sub values filled in.
const SAMPLE: Record<string, string> = {
  "AWS::AccountId": "123456789012",
  "AWS::Region": "eu-central-1",
  HostedZoneId: "Z".repeat(32),
  GitHubRepo: "kifbv@7999713/ssd-workshop@1467373954",
};
function resolve(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolve);
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.Ref === "string") {
    return o.Ref === "BoundaryPolicy" ? `arn:aws:iam::${SAMPLE["AWS::AccountId"]}:policy/ssd-workshop-boundary` : SAMPLE[o.Ref];
  }
  if (typeof o["Fn::Sub"] === "string") return o["Fn::Sub"].replace(/\$\{([^}]+)\}/g, (_, k: string) => SAMPLE[k] ?? k);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
}
// The resource part of an IAM ARN IAM accepts in a policy's Resource: "*", root, or one of its resource types.
const IAM_RESOURCE_PREFIXES = ["user/", "federated-user/", "role/", "group/", "policy/", "instance-profile/", "mfa/", "sms-mfa/", "server-certificate/", "saml-provider/", "oidc-provider/", "access-report/"];
function invalidIamResources(t: Template): string[] {
  return ALL_POLICIES.flatMap((id) =>
    statements(t, id).flatMap((s) =>
      [...list(s.Resource), ...list(s.NotResource as Value | Value[] | undefined)]
        .map((r) => live(r))
        .filter((arn) => {
          const m = /^arn:aws:iam::[^:]*:(.*)$/.exec(arn);
          if (!m) return false;
          const part = m[1] ?? "";
          return !(part === "*" || part === "root" || IAM_RESOURCE_PREFIXES.some((p) => part.startsWith(p)));
        })
        .map((arn) => `${id}/${s.Sid}: ${arn}`),
    ),
  );
}
const policySize = (t: Template, id: string) =>
  JSON.stringify(resolve((t.Resources[id]?.Properties as { PolicyDocument: unknown }).PolicyDocument)).length;

// EC2 resource types each create action authorizes besides the one it creates, from the AWS
// Service Authorization Reference (servicereference.us-east-1.amazonaws.com/v1/ec2/ec2.json,
// read 2026-11-22). These are existing parents: a request tag in the call is true for them too.
const EC2_PARENTS: Record<string, string[]> = {
  CreateVpc: ["ipam-pool", "ipv6pool-ec2"],
  CreateInternetGateway: [],
  AllocateAddress: ["ipam-pool", "ipv4pool-ec2"],
  CreateLaunchTemplate: [],
  CreateVolume: ["snapshot"],
  CreateNetworkInterface: ["security-group", "subnet"],
  CreateSubnet: ["ipam-pool", "vpc"],
  CreateSecurityGroup: ["vpc"],
  CreateRouteTable: ["vpc"],
  CreateNatGateway: ["elastic-ip", "subnet", "vpc"],
  CreateVpcEndpoint: ["route-table", "security-group", "subnet", "vpc"],
  RunInstances: [
    "capacity-reservation", "image", "key-pair", "launch-template", "network-interface",
    "placement-group", "security-group", "snapshot", "subnet",
  ],
};
const sampleEc2Arn = (type: string) =>
  ["image", "snapshot"].includes(type)
    ? `arn:aws:ec2:eu-central-1::${type}/x-0abc`
    : `arn:aws:ec2:eu-central-1:\${AWS::AccountId}:${type}/x-0abc`;
// Every EC2 action in a request-tag-only statement must list no ARN that matches one of its
// parents; an EC2 action missing from EC2_PARENTS fails, so the table is kept up to date.
function ec2ParentGaps(t: Template): string[] {
  const gaps: string[] = [];
  for (const s of deployStatements(t)) {
    const sc = scopeOf(s, t);
    if (s.Effect !== "Allow" || !sc.requestTag || sc.resourceTag) continue;
    const res = list(s.Resource).map(text);
    for (const a of list(s.Action).filter((x) => x.startsWith("ec2:"))) {
      const names = Object.keys(EC2_PARENTS).filter((n) => matches(a, `ec2:${n}`));
      if (names.length === 0) gaps.push(`${s.Sid}/${a}/not-in-EC2_PARENTS`);
      for (const n of names) {
        for (const p of EC2_PARENTS[n] ?? []) if (res.some((r) => matches(r, sampleEc2Arn(p)))) gaps.push(`${s.Sid}/${n}/${p}`);
      }
    }
  }
  return gaps;
}

// A deny on Resource "*" of an action, with a condition, found by operator and key.
const denyWith = (stmts: Statement[], action: string, op: string, key: string) =>
  stmts.filter(
    (s) => s.Effect === "Deny" && list(s.Action).some((p) => matches(p, action)) &&
      list(s.Resource).map(text).includes("*") && condValues(s.Condition, op, key).length > 0,
  );

// ECS: a workshop task definition may run only on ssd-workshop-* clusters (ecs:cluster), for
// every principal that has ecs:* on task definitions. Services are scoped by their ARN, which
// holds the cluster name (service/ssd-workshop-*/*). StartTask is denied outright (ecsPlacement).
function ecsClusterGaps(stmts: Statement[]): string[] {
  return ["ecs:RunTask"].filter(
    (a) => !denyWith(stmts, a, "ArnNotLike", "ecs:cluster").some((s) =>
      condValues(s.Condition, "ArnNotLike", "ecs:cluster").map(subText).every(isScopedArn)),
  );
}

// EventBridge: a rule may only match events whose source is ssd-workshop.*, and must name a
// source (a pattern without one, or a schedule, could match other projects' events).
function eventRuleGaps(stmts: Statement[]): string[] {
  const gaps: string[] = [];
  const sources = denyWith(stmts, "events:PutRule", "ForAnyValue:StringNotLike", "events:source");
  if (!sources.some((s) => condValues(s.Condition, "ForAnyValue:StringNotLike", "events:source").every((v) => /^ssd-workshop\.[^*]*\*?$/.test(String(v)))))
    gaps.push("events:source");
  const missing = denyWith(stmts, "events:PutRule", "Null", "events:source");
  if (!missing.some((s) => s.Condition?.Null?.["events:source"] === "true" && Object.keys(s.Condition).length === 1)) gaps.push("events:source-missing");
  return gaps;
}

// ACM: every grant of RequestCertificate needs workshop domain names and a Null guard.
function acmDomainGaps(stmts: Statement[]): string[] {
  return stmts
    .filter((s) => s.Effect === "Allow" && list(s.Action).some((p) => matches(p, "acm:RequestCertificate")))
    .filter((s) => {
      const names = condValues(s.Condition, "ForAllValues:StringLike", "acm:DomainNames");
      const ok = names.length > 0 && names.every((n) => DNS_NAMES.includes(String(n)));
      return !ok || s.Condition?.Null?.["acm:DomainNames"] !== "false";
    })
    .map((s) => s.Sid);
}

// SES: sends only through the workshop sender's identities and the ssd-workshop-email configuration set, with ses:FromAddress pinned.
const SES_IDENTITIES = [
  "arn:aws:ses:*:${AWS::AccountId}:identity/ssd-workshop@rankly.games",
  "arn:aws:ses:*:${AWS::AccountId}:identity/rankly.games",
  "arn:aws:ses:${AWS::Region}:${AWS::AccountId}:configuration-set/ssd-workshop-email",
];
function sesScopeGaps(stmts: Statement[]): string[] {
  return stmts
    .filter((s) => s.Effect === "Allow" && list(s.Action).some((p) => p.startsWith("ses:Send")))
    .filter((s) => {
      const res = list(s.Resource).map(text);
      const from = condValues(s.Condition, "StringEquals", "ses:FromAddress");
      return !(res.length > 0 && res.every((r) => SES_IDENTITIES.includes(r)) && from.length === 1 && from[0] === "ssd-workshop@rankly.games");
    })
    .map((s) => s.Sid);
}

// GitHub OIDC: the role trusts refs/heads/main, which also matches pull_request_target,
// workflow_run, issue_comment and schedule jobs on main. Only deploy.yml may ask for an OIDC
// token, and it may run only on push to main.
function oidcWorkflowGaps(files: Record<string, string>): string[] {
  const gaps: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    const asksToken = /id-token:\s*write|write-all/.test(body);
    if (name !== "deploy.yml") {
      if (asksToken) gaps.push(`${name}/id-token`);
      continue;
    }
    const on = (parse(body) as { on?: unknown }).on;
    const triggers = typeof on === "object" && on !== null ? Object.keys(on) : list(on as string | string[] | undefined);
    const branches = list((on as { push?: { branches?: string[] } } | undefined)?.push?.branches);
    if (triggers.join() !== "push" || branches.join() !== "main") gaps.push(`${name}/triggers`);
  }
  return gaps;
}
const workflowsDir = new URL("../../.github/workflows/", import.meta.url);
const workflowFiles = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(new URL(f, workflowsDir), "utf8")]),
  );

// A small IAM evaluator for the ECS placement checks (ticket 2.2): an action on one resource with
// the given condition keys is allowed when an Allow statement matches and no Deny statement does.
// Sub values are filled in with the workshop's real account and region. Operators it does not
// know make it throw, so a new condition is never silently read as true or false.
type Ctx = Record<string, string | string[]>;
const LIVE: Record<string, string> = { "AWS::AccountId": ACCOUNT, "AWS::Region": REGION };
const live = (v: unknown): string =>
  typeof v === "string" ? v : text(v as Value).replace(/\$\{([^}]+)\}/g, (_, k: string) => LIVE[k] ?? k);
function conditionHolds(c: Cond | undefined, ctx: Ctx): boolean {
  return Object.entries(c ?? {}).every(([op, keys]) =>
    Object.entries(keys).every(([key, raw]) => {
      const want = list(raw as unknown).map(live);
      const got = key in ctx ? list(ctx[key]) : undefined;
      const base = op.replace(/^ForAnyValue:|^ForAllValues:/, "");
      const one = (v: string): boolean => {
        switch (base) {
          case "StringEquals": case "ArnEquals": return want.includes(v);
          case "StringLike": case "ArnLike": return want.some((w) => matches(w, v));
          case "StringNotEquals": case "ArnNotEquals": return !want.includes(v);
          case "StringNotLike": case "ArnNotLike": return !want.some((w) => matches(w, v));
          default: throw new Error(`operator ${op} not known to the test evaluator`);
        }
      };
      if (op === "Null") return want[0] === "true" ? got === undefined : got !== undefined;
      if (op.startsWith("ForAnyValue:")) return got !== undefined && got.some(one);
      if (op.startsWith("ForAllValues:")) return got === undefined || got.every(one);
      // Single-valued: a missing key fails a positive operator and passes a negated one.
      if (got === undefined) return /Not/.test(base);
      return got.length === 1 && one(got[0] as string);
    }),
  );
}
function statementApplies(s: Statement, action: string, resource: string, ctx: Ctx): boolean {
  const acts = s.Action !== undefined ? list(s.Action).some((p) => matches(p, action)) : !list(s.NotAction).some((p) => matches(p, action));
  return acts && list(s.Resource).map(live).some((r) => matches(r, resource)) && conditionHolds(s.Condition, ctx);
}
function allowedBy(stmts: Statement[], action: string, resource: string, ctx: Ctx = {}): boolean {
  const hits = stmts.filter((s) => statementApplies(s, action, resource, ctx));
  return hits.some((s) => s.Effect === "Allow") && !hits.some((s) => s.Effect === "Deny");
}
const ECS_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}`;
const WORKSHOP_CLUSTER = `${ECS_ARN}:cluster/ssd-workshop-builds`;
const OTHER_CLUSTER = `${ECS_ARN}:cluster/letters`;
const BUILDER_TASK_DEFINITION = `${ECS_ARN}:task-definition/ssd-workshop-builder:3`;
const WORKSHOP_SERVICE = `${ECS_ARN}:service/ssd-workshop-builds/ssd-workshop-app`;
const OTHER_SUBNET = "subnet-0aaaaaaaaaaaaaaaa";
const WORKLOAD_ROLE = `arn:aws:iam::${ACCOUNT}:role/ssd-workshop/ssd-workshop-builder-task`;
const SERVICE_DENY_SUBNET_LIST = "[subnet-05229d71b1e0b41ff, subnet-0965bcee41d455dba]";
// Every ECS action that carries ecs:subnet, per servicereference ecs.json
// (servicereference.us-east-1.amazonaws.com/v1/ecs/ecs.json), read 2026-11-24. RunTask and
// StartTask carry none. A new action with the key must be added here and to both denies.
const ECS_SUBNET_ACTIONS = [
  "ecs:CreateService", "ecs:UpdateService",
  "ecs:CreateExpressGatewayService", "ecs:UpdateExpressGatewayService",
];

const template = loadTemplate();

describe("access stack: deploy policies (criterion 2)", () => {
  it("limits every write to ssd-workshop-* names, the project tag, workshop DNS, or a listed exception", () => {
    expect(deployGaps(template)).toEqual([]);
  });

  it("keeps every allow-list entry in use, so the lists cannot hide stale exceptions", () => {
    const used = (stmts: Statement[]) => stmts.flatMap((s) => list(s.Action).map((a) => `${s.Sid}/${a}`));
    expect(Object.keys(DEPLOY_EXCEPTIONS).filter((k) => !used(deployStatements(template)).includes(k))).toEqual([]);
    expect(Object.keys(BOUNDARY_ALLOW_LIST).filter((k) => !used(boundaryStatements(template)).includes(k))).toEqual([]);
    expect(Object.keys(REQUEST_TAG_ON_ANY).filter((k) => !used(deployStatements(template)).includes(k))).toEqual([]);
    expect(Object.keys(ACCEPTED_SECRET_READS).filter((k) => !used(deployStatements(template)).includes(k))).toEqual([]);
  });

  it("fails when a write is loosened to Resource *", () => {
    const loose = withText(
      "Action: [dynamodb:*, lambda:*",
      'Action: [dynamodb:*]\n            Resource: "*"\n          - Sid: Rest\n            Effect: Allow\n            Action: [lambda:*',
    );
    expect(deployGaps(loose)).toContain("NamedWorkshopResources/dynamodb:*");
  });

  it("fails on a tag-adding action scoped only by aws:RequestTag (tag takeover)", () => {
    const cloudfront = withText("Action: cloudfront:CreateDistribution\n", "Action: [cloudfront:CreateDistribution, cloudfront:TagResource]\n");
    expect(deployGaps(cloudfront)).toContain("CloudFrontTaggedCreate/cloudfront:TagResource");
    const acm = withText("Action: acm:RequestCertificate\n", "Action: [acm:RequestCertificate, acm:AddTagsToCertificate]\n");
    expect(deployGaps(acm)).toContain("CertificatesTagged/acm:AddTagsToCertificate");
    // A wildcard counts when it could match a tag-adding name (here cloudfront:CreateTags).
    const wildcard = withText("Action: cloudfront:CreateDistribution\n", "Action: cloudfront:Create*\n");
    expect(deployGaps(wildcard)).toContain("CloudFrontTaggedCreate/cloudfront:Create*");
    const ec2 = withText("Action: [ec2:CreateVpc,", "Action: [ec2:CreateTags, ec2:CreateVpc,");
    expect(deployGaps(ec2)).toContain("Ec2NewTopLevel/ec2:CreateTags");
  });

  it("tags new distributions and certificates only while CloudFormation creates them (tag on create)", () => {
    // CreateDistributionWithTags and RequestCertificate with tags also authorize the tagging action.
    expect(deployGaps(template)).toEqual([]);
    const sid = "TagOnCreateThroughCloudFormation";
    // Each guard is needed: without it, an existing untagged resource of another project could
    // be tagged and then changed through the ResourceTag statements.
    const noCalledVia = withText(
      '              "Null": {aws:ResourceTag/project: "true"}\n              ForAnyValue:StringEquals: {aws:CalledVia: cloudformation.amazonaws.com}\n',
      '              "Null": {aws:ResourceTag/project: "true"}\n',
    );
    expect(deployGaps(noCalledVia)).toContain(`${sid}/cloudfront:TagResource`);
    const noNull = withText('              "Null": {aws:ResourceTag/project: "true"}\n              ForAnyValue', "              ForAnyValue");
    expect(deployGaps(noNull)).toContain(`${sid}/acm:AddTagsToCertificate`);
    const otherAction = withText("Action: [cloudfront:TagResource, acm:AddTagsToCertificate]", "Action: [cloudfront:TagResource, acm:AddTagsToCertificate, ec2:CreateTags]");
    expect(deployGaps(otherAction)).toContain(`${sid}/ec2:CreateTags`);
  });

  it("tags new APIs and stages through the API Gateway tags endpoint only via CloudFormation (live: first API deploy)", () => {
    expect(deployGaps(template)).toEqual([]);
    const sid = "ApiGatewayTagOnCreateThroughCloudFormation";
    const statement = deployStatements(template).find((st) => st.Sid === sid);
    expect(list(statement?.Action)).toEqual(APIGW_TAG_ACTIONS);
    // Without the call path, the role could tag another project's API and then change it
    // through ApiGatewayTaggedChange.
    const noCalledVia = withText(
      "              StringEquals: {aws:RequestTag/project: ssd-workshop}\n              ForAnyValue:StringEquals: {aws:CalledVia: cloudformation.amazonaws.com}\n          # Creating a tagged stage",
      "              StringEquals: {aws:RequestTag/project: ssd-workshop}\n          # Creating a tagged stage",
    );
    expect(deployGaps(noCalledVia)).toContain(`${sid}/apigateway:POST`);
    // Any resource other than the tags endpoint (here every API) is refused.
    const wider = withText("Resource: !Sub arn:aws:apigateway:${AWS::Region}::/tags/*", "Resource: !Sub arn:aws:apigateway:${AWS::Region}::/*");
    expect(deployGaps(wider)).toContain(`${sid}/apigateway:PUT`);
  });

  it("tags a new stage only on a project API and only via CloudFormation (live: second API deploy)", () => {
    const sid = "ApiGatewayTagStagesOnCreate";
    const statement = deployStatements(template).find((st) => st.Sid === sid);
    expect(list(statement?.Action)).toEqual(["apigateway:TagResource"]);
    expect(list(statement?.Resource).map(text)).toEqual(["arn:aws:apigateway:${AWS::Region}::/apis/*"]);
    expect(projectTag(statement?.Condition, "aws:RequestTag/project")).toBe(true);
    expect(projectTag(statement?.Condition, "aws:ResourceTag/project")).toBe(true);
    expect(condValues(statement?.Condition, "ForAnyValue:StringEquals", "aws:CalledVia")).toEqual(["cloudformation.amazonaws.com"]);
    // Without the API's own tag, the role could tag (and then take over) any API.
    const noResourceTag = withText(
      "StringEquals: {aws:RequestTag/project: ssd-workshop, aws:ResourceTag/project: ssd-workshop}",
      "StringEquals: {aws:RequestTag/project: ssd-workshop}",
    );
    expect(deployGaps(noResourceTag)).toContain(`${sid}/apigateway:TagResource`);
  });

  it("denies CloudFormation resource import, so CloudFormation cannot adopt and tag another project's resource", () => {
    const deny = deployStatements(template).find((s) => s.Sid === "NoResourceImport");
    expect(deny?.Effect).toBe("Deny");
    expect(list(deny?.Action)).toContain("cloudformation:CreateChangeSet");
    expect(text(deny?.Resource as Value)).toBe("*");
    expect(deny?.Condition?.Null?.["cloudformation:ImportResourceTypes"]).toBe("false");
  });

  it("fails on API Gateway writes that reach every API in the region", () => {
    const region = withText(
      "            Action: [apigateway:POST, apigateway:PUT, apigateway:PATCH, apigateway:DELETE]\n            Resource:\n              - !Sub arn:aws:apigateway:${AWS::Region}::/restapis/*\n              - !Sub arn:aws:apigateway:${AWS::Region}::/apis/*\n            Condition:\n              StringEquals: {aws:ResourceTag/project: ssd-workshop}\n",
      "            Action: [apigateway:POST, apigateway:PUT, apigateway:PATCH, apigateway:DELETE]\n            Resource: !Sub arn:aws:apigateway:${AWS::Region}::/*\n",
    );
    expect(deployGaps(region)).toContain("ApiGatewayTaggedChange/apigateway:PATCH");
    // A request tag on a write under /restapis/* would let the role add stages to any API.
    const children = withText(
      "              - !Sub arn:aws:apigateway:${AWS::Region}::/restapis\n",
      "              - !Sub arn:aws:apigateway:${AWS::Region}::/restapis/*\n",
    );
    expect(deployGaps(children)).toContain("ApiGatewayTaggedCreate/apigateway:POST");
  });

  it("fails on event source mapping writes that are not tied to ssd-workshop-* functions", () => {
    const loose = withText(
      '            Condition:\n              ArnLike: {lambda:FunctionArn: !Sub "arn:aws:lambda:*:${AWS::AccountId}:function:ssd-workshop-*"}\n',
      "",
    );
    expect(deployGaps(loose)).toContain("WorkshopEventSourceMappings/lambda:DeleteEventSourceMapping");
    const otherFunctions = withText("function:ssd-workshop-*\"}", "function:*\"}");
    expect(deployGaps(otherFunctions)).toContain("WorkshopEventSourceMappings/lambda:CreateEventSourceMapping");
  });

  it("counts ec2:CreateAction as scope only for creates that need the project tag", () => {
    const loose = withText("{ec2:CreateAction: [RunInstances,", "{ec2:CreateAction: [CreateKeyPair, RunInstances,");
    expect(deployGaps(loose)).toContain("Ec2TagOnCreate/ec2:CreateTags");
  });

  it("fails on a change set resource of any stack", () => {
    const loose = withText(
      "            Resource: !Sub arn:aws:cloudformation:*:${AWS::AccountId}:stack/ssd-workshop-*/*\n",
      "            Resource:\n              - !Sub arn:aws:cloudformation:*:${AWS::AccountId}:stack/ssd-workshop-*/*\n              - !Sub arn:aws:cloudformation:*:${AWS::AccountId}:changeSet/*\n",
    );
    expect(deployGaps(loose)).toContain("WorkshopStacks/cloudformation:*");
  });

  it("limits service-linked roles to the services the workshop uses", () => {
    const slr = deployStatements(template).find((s) => s.Sid === "WorkshopServiceLinkedRoles");
    expect(slr?.Condition).toEqual({ StringEquals: { "iam:AWSServiceName": "ecs.amazonaws.com" } });
  });

  it("accepts only ARNs whose resource name starts with ssd-workshop- (with the dash)", () => {
    const account = "${AWS::AccountId}";
    for (const arn of [
      `arn:aws:iam::${account}:role/ssd-workshop/*`,
      "arn:aws:s3:::ssd-workshop-*",
      `arn:aws:logs:*:${account}:log-group:ssd-workshop-*`,
      `arn:aws:logs:*:${account}:log-group:/aws/lambda/ssd-workshop-*`,
      `arn:aws:logs:*:${account}:log-group:/ecs/ssd-workshop-*`,
      `arn:aws:scheduler:*:${account}:schedule/*/ssd-workshop-*`,
      `arn:aws:ecs:*:${account}:task-definition/ssd-workshop-*:*`,
      `arn:aws:cloudformation:*:${account}:stack/ssd-workshop-*/*`,
      `arn:aws:ssm:*:${account}:parameter/ssd-workshop/*`,
    ]) expect(isScopedArn(arn), arn).toBe(true);
    for (const arn of [
      `arn:aws:iam::${account}:role/*ssd-workshop*`,
      "arn:aws:s3:::bucket*ssd-workshop*",
      "arn:aws:s3:::other-bucket/ssd-workshop-*",
      "arn:aws:s3:::ssd-workshop*",
      `arn:aws:ecr:*:${account}:repository/ssd-workshop*`,
      `arn:aws:ecs:*:${account}:cluster/ssd-workshop*`,
      `arn:aws:logs:*:${account}:log-group:*ssd-workshop*`,
      `arn:aws:logs:*:${account}:log-group:/other/ssd-workshop-*`,
      `arn:aws:iam::${account}:role/*/ssd-workshop-*`,
      `arn:aws:cloudformation:*:${account}:changeSet/*`,
      "*",
    ]) expect(isScopedArn(arn), arn).toBe(false);
  });

  it("never writes a name pattern without the dash (ssd-workshop*)", () => {
    expect(templateText.match(/ssd-workshop\*/g) ?? []).toEqual([]);
    const old = withText("ecr:*:${AWS::AccountId}:repository/ssd-workshop-*", "ecr:*:${AWS::AccountId}:repository/ssd-workshop*");
    expect(deployGaps(old)).toContain("NamedWorkshopResources/ecr:*");
  });

  it("classifies reads", () => {
    expect(isRead("ec2:Describe*")).toBe(true);
    expect(isRead("apigateway:GET")).toBe(true);
    expect(isRead("cloudformation:*")).toBe(false);
    expect(isRead("s3:ListAllMyBuckets")).toBe(true);
  });

  it("keeps each managed policy under IAM's 6,144-character limit", () => {
    for (const id of ALL_POLICIES) expect(policySize(template, id), id).toBeLessThanOrEqual(6144);
  });

  // IAM validates a Resource/NotResource ARN on create and update; cfn-lint does not. The stack update after ticket
  // 2.9 failed on "IAM resource path must either be "*", root, or start with user/, ..." for role*/<name>, which
  // works only in a condition value (ArnNotLike aws:PrincipalArn).
  it("gives every IAM ARN in a Resource or NotResource a resource part IAM accepts (no role*/)", () => {
    expect(invalidIamResources(template)).toEqual([]);
    const broken = withText(
      "- !Sub arn:aws:iam::${AWS::AccountId}:role/ssd-workshop/ssd-workshop-builder\n",
      "- !Sub arn:aws:iam::${AWS::AccountId}:role*/ssd-workshop-builder\n",
    );
    expect(invalidIamResources(broken)).toEqual([`DeployPolicyRead/NoLauncherForSessions: arn:aws:iam::${ACCOUNT}:role*/ssd-workshop-builder`]);
    // Conditions are not path-validated: the boundary's role*/<name> values stay.
    expect(templateText).toContain(":role*/ssd-workshop-builds-launcher");
  });
});

describe("access stack: reads (H1)", () => {
  it("allows no read that returns secrets or full configuration on every resource", () => {
    expect(secretReadGaps(template, deployStatements(template), ACCEPTED_SECRET_READS)).toEqual([]);
    expect(secretReadGaps(template, boundaryStatements(template))).toEqual([]);
    // Without the owner's acceptance, the DescribeTaskDefinition grant is a gap.
    expect(secretReadGaps(template, deployStatements(template))).toEqual(["ecs:DescribeTaskDefinition"]);
  });

  it("fails on the old account-wide reads", () => {
    const lambda = withText("              - ecs:List*\n", "              - ecs:List*\n              - lambda:List*\n");
    expect(secretReadGaps(lambda, deployStatements(lambda), ACCEPTED_SECRET_READS)).toEqual(["lambda:ListFunctions"]);
    // The acceptance names one statement and the exact action: a wildcard elsewhere is still a gap.
    const ecs = withText("              - ecs:List*\n", "              - ecs:Describe*\n");
    expect(secretReadGaps(ecs, deployStatements(ecs), ACCEPTED_SECRET_READS)).toContain("ecs:DescribeTaskDefinition");
    const old = withText(
      "              - cloudformation:ListStacks\n",
      "              - cloudformation:Describe*\n              - cloudformation:List*\n              - apigateway:GET\n              - iam:Get*\n              - cloudfront:Get*\n              - ses:List*\n",
    );
    expect(secretReadGaps(old, deployStatements(old), ACCEPTED_SECRET_READS)).toEqual([
      "apigateway:GET", "cloudformation:DescribeStacks", "cloudformation:ListExports",
      "iam:GetAccountAuthorizationDetails", "iam:GetRole", "iam:GetRolePolicy", "iam:GetPolicyVersion",
      "cloudfront:GetDistributionConfig", "ses:ListContacts",
    ]);
    // ec2:Describe* stays account-wide only because user data is denied outside the project tag.
    const noDeny = withText("          - Sid: NoUserDataReads\n            Effect: Deny\n", "          - Sid: NoUserDataReads\n            Effect: Allow\n");
    expect(secretReadGaps(noDeny, deployStatements(noDeny), ACCEPTED_SECRET_READS)).toEqual(["ec2:DescribeInstanceAttribute", "ec2:DescribeLaunchTemplateVersions"]);
    // VPN connections carry pre-shared keys; the SES account carries contact addresses.
    const vpn = withText("          - Sid: NoVpnKeyReads\n            Effect: Deny\n", "          - Sid: NoVpnKeyReads\n            Effect: Allow\n");
    expect(secretReadGaps(vpn, deployStatements(vpn), ACCEPTED_SECRET_READS)).toEqual(["ec2:DescribeVpnConnections"]);
    const account = withText("              - ses:GetSendQuota\n", "              - ses:GetAccount\n              - ses:GetSendQuota\n");
    expect(secretReadGaps(account, deployStatements(account), ACCEPTED_SECRET_READS)).toEqual(["ses:GetAccount"]);
  });

  it("explicitly denies reading API keys", () => {
    const deny = deployStatements(template).find((s) => s.Sid === "NoApiKeyReads");
    expect(deny).toMatchObject({ Effect: "Deny", Action: "apigateway:GET", Resource: "arn:aws:apigateway:*::/apikeys*" });
    expect(deny?.Condition).toBeUndefined();
    for (const key of ["/apikeys", "/apikeys/abc123"]) expect(matches(text(deny?.Resource as Value), `arn:aws:apigateway:eu-central-1::${key}`)).toBe(true);
  });
});

describe("access stack: CloudFront parts without tags (H2)", () => {
  it("allows only creating them on Resource *, never update or delete", () => {
    const parts = deployStatements(template).find((s) => s.Sid === "CloudFrontUntaggableParts");
    const writes = list(parts?.Action).filter((a) => !isRead(a));
    expect(writes.every((a) => /^cloudfront:Create[A-Za-z]+$/.test(a)), writes.join()).toBe(true);
    for (const old of ["cloudfront:*CachePolicy*", "cloudfront:UpdateCachePolicy", "cloudfront:DeleteOriginAccessControl"]) {
      const loose = withText("              - cloudfront:CreateCachePolicy\n", `              - ${old}\n`);
      expect(deployGaps(loose), old).toContain(`CloudFrontUntaggableParts/${old}`);
    }
  });
});

// The try 3 statements: creates on Resource "*" and RunInstances interfaces with a request tag.
const OLD_EC2_CREATE =
  "          - Sid: Ec2CreateTagged\n            Effect: Allow\n" +
  "            Action: [ec2:CreateVpc, ec2:CreateSubnet, ec2:CreateSecurityGroup, ec2:CreateInternetGateway, ec2:CreateRouteTable, ec2:AllocateAddress, ec2:CreateLaunchTemplate, ec2:CreateVolume, ec2:CreateNatGateway, ec2:CreateVpcEndpoint]\n" +
  '            Resource: "*"\n            Condition:\n              StringEquals: {aws:RequestTag/project: ssd-workshop}\n';
const OLD_EC2_RUN =
  "          - Sid: Ec2RunInstancesNewResources\n            Effect: Allow\n            Action: ec2:RunInstances\n            Resource:\n" +
  "              - !Sub arn:aws:ec2:*:${AWS::AccountId}:instance/*\n              - !Sub arn:aws:ec2:*:${AWS::AccountId}:network-interface/*\n" +
  "            Condition:\n              StringEquals: {aws:RequestTag/project: ssd-workshop}\n";
const withOldEc2 = (old: string) => withText("          - Sid: Ec2NewTopLevel\n", `${old}          - Sid: Ec2NewTopLevel\n`);

describe("access stack: EC2 instances (H3)", () => {
  it("starts instances only from Amazon-owned images and with project network interfaces", () => {
    expect(runInstancesGaps(template)).toEqual([]);
    const anyImage = withText("              StringEquals: {ec2:Owner: amazon}\n", "              StringEquals: {ec2:Owner: aws-marketplace}\n");
    expect(runInstancesGaps(anyImage)).toEqual(["Ec2RunInstancesAmazonImages/image"]);
    // RunInstances on "*" with only a request tag: image and interfaces unconditioned.
    const onAny = withText("Action: [ec2:CreateVpc,", "Action: [ec2:RunInstances, ec2:CreateVpc,");
    expect(runInstancesGaps(onAny)).toEqual(["Ec2NewTopLevel/network-interface"]);
    expect(ec2ParentGaps(onAny)).toContain("Ec2NewTopLevel/RunInstances/network-interface");
    const anyAll = withOldEc2(OLD_EC2_CREATE.replace("Action: [ec2:CreateVpc,", "Action: [ec2:RunInstances, ec2:CreateVpc,"));
    expect(runInstancesGaps(anyAll)).toEqual(["Ec2CreateTagged/image", "Ec2CreateTagged/network-interface"]);
    // Try 3: new network interfaces with only the request tag (also true for existing ones).
    expect(runInstancesGaps(withOldEc2(OLD_EC2_RUN))).toEqual(["Ec2RunInstancesNewResources/network-interface"]);
  });
});

describe("access stack: EC2 parents (try 4)", () => {
  it("never covers a parent ARN of a create with only the request tag", () => {
    expect(ec2ParentGaps(template)).toEqual([]);
    expect(ec2ParentGaps(withOldEc2(OLD_EC2_CREATE))).toEqual([
      "Ec2CreateTagged/CreateVpc/ipam-pool", "Ec2CreateTagged/CreateVpc/ipv6pool-ec2",
      "Ec2CreateTagged/CreateSubnet/ipam-pool", "Ec2CreateTagged/CreateSubnet/vpc",
      "Ec2CreateTagged/CreateSecurityGroup/vpc", "Ec2CreateTagged/CreateRouteTable/vpc",
      "Ec2CreateTagged/AllocateAddress/ipam-pool", "Ec2CreateTagged/AllocateAddress/ipv4pool-ec2",
      "Ec2CreateTagged/CreateVolume/snapshot",
      "Ec2CreateTagged/CreateNatGateway/elastic-ip", "Ec2CreateTagged/CreateNatGateway/subnet", "Ec2CreateTagged/CreateNatGateway/vpc",
      "Ec2CreateTagged/CreateVpcEndpoint/route-table", "Ec2CreateTagged/CreateVpcEndpoint/security-group",
      "Ec2CreateTagged/CreateVpcEndpoint/subnet", "Ec2CreateTagged/CreateVpcEndpoint/vpc",
    ]);
    expect(ec2ParentGaps(withOldEc2(OLD_EC2_RUN))).toEqual(["Ec2RunInstancesNewResources/RunInstances/network-interface"]);
    // A subnet in another project's VPC: CreateSubnet next to vpc/* under a request tag.
    const subnet = withText("Action: [ec2:CreateVpc,", "Action: [ec2:CreateSubnet, ec2:CreateVpc,");
    expect(ec2ParentGaps(subnet)).toEqual(["Ec2NewTopLevel/CreateSubnet/vpc"]);
    // The general scope test also refuses a create on Resource "*" with only a request tag.
    expect(deployGaps(withOldEc2(OLD_EC2_CREATE))).toContain("Ec2CreateTagged/ec2:CreateSubnet");
  });

  it("requires the project tag on every parent and refuses volumes from snapshots", () => {
    const parents = deployStatements(template).find((s) => s.Sid === "Ec2ParentsTagged");
    expect(scopeOf(parents as Statement, template).resourceTag).toBe(true);
    const types = new Set(Object.values(EC2_PARENTS).flat());
    const listed = list(parents?.Resource).map(text);
    for (const p of ["vpc", "subnet", "security-group", "route-table", "elastic-ip", "network-interface", "launch-template"]) {
      expect(types.has(p), p).toBe(true);
      expect(listed.some((r) => matches(r, sampleEc2Arn(p))), p).toBe(true);
    }
    expect(denied(deployStatements(template), "arn:aws:ec2:*::snapshot/*", "ec2:CreateVolume")).toBe(true);
    const noDeny = deployStatements(template).filter((s) => s.Sid !== "Ec2NoVolumesFromSnapshots");
    expect(denied(noDeny, "arn:aws:ec2:*::snapshot/*", "ec2:CreateVolume")).toBe(false);
  });
});

describe("access stack: ECS, EventBridge, ACM and SES (try 4)", () => {
  it("runs workshop task definitions only on ssd-workshop-* clusters", () => {
    expect(ecsClusterGaps(deployStatements(template))).toEqual([]);
    expect(ecsClusterGaps(deployStatements(template).filter((s) => s.Sid !== "TasksOnWorkshopClustersOnly"))).toEqual(["ecs:RunTask"]);
    const anyCluster = withText('ArnNotLike: {ecs:cluster: !Sub "arn:aws:ecs:*:${AWS::AccountId}:cluster/ssd-workshop-*"}', 'ArnNotLike: {ecs:cluster: !Sub "arn:aws:ecs:*:${AWS::AccountId}:cluster/*"}');
    expect(ecsClusterGaps(deployStatements(anyCluster))).toEqual(["ecs:RunTask"]);
    // Services: the ARN holds the cluster name.
    const named = deployStatements(template).find((s) => s.Sid === "NamedWorkshopResources");
    expect(list(named?.Resource).map(text)).toContain("arn:aws:ecs:*:${AWS::AccountId}:service/ssd-workshop-*/*");
  });

  it("lets EventBridge rules match only ssd-workshop.* sources", () => {
    expect(eventRuleGaps(deployStatements(template))).toEqual([]);
    const without = deployStatements(template).filter((s) => !s.Sid.startsWith("Rules"));
    expect(eventRuleGaps(without)).toEqual(["events:source", "events:source-missing"]);
    const awsSources = withText("{events:source: ssd-workshop.*}", '{events:source: ["ssd-workshop.*", "aws.*"]}');
    expect(eventRuleGaps(deployStatements(awsSources))).toEqual(["events:source"]);
  });

  it("requests certificates only for workshop.rankly.games names", () => {
    expect(acmDomainGaps(deployStatements(template))).toEqual([]);
    const anyDomain = withAll(
      '              ForAllValues:StringLike:\n                acm:DomainNames: [workshop.rankly.games, "*.workshop.rankly.games"]\n              "Null": {acm:DomainNames: "false"}\n',
      "",
    );
    expect(acmDomainGaps(deployStatements(anyDomain))).toEqual(["CertificatesTagged", "CertificatesThroughCloudFormation"]);
    const noGuard = withAll('              "Null": {acm:DomainNames: "false"}\n', "");
    expect(acmDomainGaps(deployStatements(noGuard))).toEqual(["CertificatesTagged", "CertificatesThroughCloudFormation"]);
  });

  it("lets CloudFormation request a certificate without tags, then tag it (live: it sends no tags)", () => {
    // CloudFormation calls RequestCertificate without Tags and adds them with AddTagsToCertificate
    // (TagOnCreateThroughCloudFormation), so a request-tag condition alone refuses it.
    const viaCfn = (t: Template) =>
      deployStatements(t).filter(
        (s) =>
          s.Effect === "Allow" &&
          list(s.Action).some((a) => matches(a, "acm:RequestCertificate")) &&
          condValues(s.Condition, "StringEquals", "aws:RequestTag/project").length === 0,
      );
    const [s] = viaCfn(template);
    expect(s?.Sid).toBe("CertificatesThroughCloudFormation");
    expect(condValues(s?.Condition, "ForAnyValue:StringEquals", "aws:CalledVia")).toEqual(["cloudformation.amazonaws.com"]);
    expect(viaCfn(withText("ForAnyValue:StringEquals: {aws:CalledVia: [cloudformation.amazonaws.com]}", "StringEquals: {aws:RequestTag/project: ssd-workshop}"))).toEqual([]);
  });

  it("sends mail only through the workshop sender's identities", () => {
    expect(sesScopeGaps(deployStatements(template))).toEqual([]);
    expect(sesScopeGaps(boundaryStatements(template))).toEqual([]);
    const old = withAll("              - !Sub arn:aws:ses:*:${AWS::AccountId}:identity/rankly.games\n", '              - "*"\n');
    expect(sesScopeGaps(deployStatements(old))).toEqual(["SesForTesting"]);
    expect(sesScopeGaps(boundaryStatements(old))).toEqual(["SendCodes"]);
  });

  it("creates the tagged ssd-workshop-email configuration set, so sends never fall back to another project's default set", () => {
    const sets = Object.values(template.Resources).filter((r) => r.Type === "AWS::SES::ConfigurationSet");
    expect(sets.map((r) => r.Properties.Name)).toEqual(["ssd-workshop-email"]);
    expect(sets.map((r) => r.Properties.Tags)).toEqual([[{ Key: "project", Value: "ssd-workshop" }]]);
    const otherSet = withAll(
      "              - !Sub arn:aws:ses:${AWS::Region}:${AWS::AccountId}:configuration-set/ssd-workshop-email\n",
      "              - !Sub arn:aws:ses:${AWS::Region}:${AWS::AccountId}:configuration-set/*\n",
    );
    expect(sesScopeGaps(deployStatements(otherSet))).toEqual(["SesForTesting"]);
    expect(sesScopeGaps(boundaryStatements(otherSet))).toEqual(["SendCodes"]);
  });
});

describe("access stack: ECS network placement (ticket 2.2)", () => {
  const deploy = deployStatements(template);
  const boundary = boundaryStatements(template);
  const [subnetA, subnetB] = BUILDS_SUBNET_IDS;

  it("denies StartTask in the deploy policies and the boundary, also on a workshop cluster", () => {
    for (const [name, stmts] of [["deploy", deploy], ["boundary", boundary]] as const) {
      expect(denied(stmts, "*", "ecs:StartTask"), name).toBe(true);
      expect(allowedBy(stmts, "ecs:StartTask", BUILDER_TASK_DEFINITION, { "ecs:cluster": WORKSHOP_CLUSTER, "aws:PrincipalArn": BUILD_LAUNCHER_ROLE_ARN }), name).toBe(false);
    }
    // Old pattern: StartTask only under the cluster deny, so a deploy principal could start one.
    const old = deploy.filter((s) => s.Sid !== "NoStartTask");
    expect(allowedBy(old, "ecs:StartTask", BUILDER_TASK_DEFINITION, { "ecs:cluster": WORKSHOP_CLUSTER })).toBe(true);
  });

  it("denies every action carrying ecs:subnet with a subnet outside the two workshop subnets", () => {
    for (const [name, stmts] of [["deploy", deploy], ["boundary", boundary]] as const) {
      const deny = stmts.find((s) => s.Sid === "ServicesInWorkshopSubnetsOnly");
      expect(deny?.Effect, name).toBe("Deny");
      // Exactly the actions that carry the key: no more (a key an action lacks is never
      // there, so the deny would be dead), no less (an action left out runs anywhere).
      expect([...list(deny?.Action)].sort(), name).toEqual([...ECS_SUBNET_ACTIONS].sort());
      for (const action of ECS_SUBNET_ACTIONS) {
        expect(statementApplies(deny as Statement, action, WORKSHOP_SERVICE, { "ecs:subnet": [OTHER_SUBNET] }), `${name} ${action}`).toBe(true);
        expect(statementApplies(deny as Statement, action, WORKSHOP_SERVICE, { "ecs:subnet": [subnetA as string, OTHER_SUBNET] }), `${name} ${action} mixed`).toBe(true);
        expect(statementApplies(deny as Statement, action, WORKSHOP_SERVICE, { "ecs:subnet": [...BUILDS_SUBNET_IDS] }), `${name} ${action} workshop`).toBe(false);
        // ForAnyValue: an update that does not touch the network carries no subnet.
        expect(statementApplies(deny as Statement, action, WORKSHOP_SERVICE, {}), `${name} ${action} no key`).toBe(false);
      }
    }
    // End to end for the deploy principals, who hold ecs:* on workshop services.
    for (const action of ECS_SUBNET_ACTIONS) {
      expect(allowedBy(deploy, action, WORKSHOP_SERVICE, { "ecs:subnet": [subnetA as string, subnetB as string] }), action).toBe(true);
      expect(allowedBy(deploy, action, WORKSHOP_SERVICE, { "ecs:subnet": [OTHER_SUBNET] }), action).toBe(false);
      expect(allowedBy(deploy, action, WORKSHOP_SERVICE, { "ecs:subnet": [subnetB as string, OTHER_SUBNET] }), action).toBe(false);
      expect(allowedBy(deploy, action, WORKSHOP_SERVICE, {}), action).toBe(true);
    }
    // Old pattern: without the deny, a service could run in another project's subnet.
    const old = deploy.filter((s) => s.Sid !== "ServicesInWorkshopSubnetsOnly");
    expect(allowedBy(old, "ecs:CreateService", WORKSHOP_SERVICE, { "ecs:subnet": [OTHER_SUBNET] })).toBe(true);
    // Try 1's pattern: only CreateService/UpdateService, so an Express Gateway service ran anywhere.
    const tryOne = withAll(
      "Action: [ecs:CreateService, ecs:UpdateService, ecs:CreateExpressGatewayService, ecs:UpdateExpressGatewayService]",
      "Action: [ecs:CreateService, ecs:UpdateService]",
    );
    expect(allowedBy(deployStatements(tryOne), "ecs:CreateExpressGatewayService", WORKSHOP_SERVICE, { "ecs:subnet": [OTHER_SUBNET] })).toBe(true);
    expect(allowedBy(deployStatements(tryOne), "ecs:UpdateExpressGatewayService", WORKSHOP_SERVICE, { "ecs:subnet": [OTHER_SUBNET] })).toBe(true);
  });

  it("writes no deny on a subnet key for RunTask or StartTask (they carry no ecs:subnet key)", () => {
    // ecs:subnet exists on CreateService/UpdateService and CreateExpressGatewayService/
    // UpdateExpressGatewayService; never on RunTask/StartTask. A negated operator on the missing
    // key would deny every RunTask; a ForAnyValue one would deny none.
    expect(ECS_SUBNET_ACTIONS).not.toContain("ecs:RunTask");
    expect(ECS_SUBNET_ACTIONS).not.toContain("ecs:StartTask");
    for (const s of [...deploy, ...boundary]) {
      if (!JSON.stringify(s.Condition ?? {}).includes("ecs:subnet")) continue;
      expect([...list(s.Action)].sort(), s.Sid).toEqual([...ECS_SUBNET_ACTIONS].sort());
    }
  });

  it("lets only the build launcher role start tasks under the boundary, on workshop clusters", () => {
    const launcher = { "ecs:cluster": WORKSHOP_CLUSTER, "aws:PrincipalArn": BUILD_LAUNCHER_ROLE_ARN };
    expect(allowedBy(boundary, "ecs:RunTask", BUILDER_TASK_DEFINITION, launcher)).toBe(true);
    expect(allowedBy(boundary, "ecs:RunTask", BUILDER_TASK_DEFINITION, { ...launcher, "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(false);
    expect(allowedBy(boundary, "ecs:RunTask", BUILDER_TASK_DEFINITION, { ...launcher, "ecs:cluster": OTHER_CLUSTER })).toBe(false);
    expect(allowedBy(boundary, "ecs:RunTask", `${ECS_ARN}:task-definition/letters:1`, launcher)).toBe(false);
    // Tagging the new task: only the launcher, only as part of RunTask.
    const task = `${ECS_ARN}:task/ssd-workshop-builds/0123456789abcdef`;
    expect(allowedBy(boundary, "ecs:TagResource", task, { "ecs:CreateAction": "RunTask", "aws:PrincipalArn": BUILD_LAUNCHER_ROLE_ARN })).toBe(true);
    expect(allowedBy(boundary, "ecs:TagResource", task, { "aws:PrincipalArn": BUILD_LAUNCHER_ROLE_ARN })).toBe(false);
    expect(allowedBy(boundary, "ecs:TagResource", task, { "ecs:CreateAction": "RunTask", "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(false);
    // Old pattern: without the principal pin, every workload role (participant code) could start tasks.
    const oldRun = boundary.map((s) => (s.Sid === "RunBuilds" ? { ...s, Condition: { ArnLike: s.Condition?.ArnLike ?? {} } } : s));
    expect(allowedBy(oldRun, "ecs:RunTask", BUILDER_TASK_DEFINITION, { ...launcher, "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(true);
  });

  it("lets the deploy principals run tasks only on workshop clusters", () => {
    expect(allowedBy(deploy, "ecs:RunTask", BUILDER_TASK_DEFINITION, { "ecs:cluster": WORKSHOP_CLUSTER })).toBe(true);
    expect(allowedBy(deploy, "ecs:RunTask", BUILDER_TASK_DEFINITION, { "ecs:cluster": OTHER_CLUSTER })).toBe(false);
  });

  it("allows DescribeTaskDefinition (Resource * only) to the deploy principals, never in the boundary", () => {
    expect(allowedBy(deploy, "ecs:DescribeTaskDefinition", "*")).toBe(true);
    // AWS authorizes it only on Resource "*", so only a grant on "*" counts.
    const grants = deploy.filter((s) => s.Effect === "Allow" && list(s.Resource).map(text).includes("*") && list(s.Action).some((p) => matches(p, "ecs:DescribeTaskDefinition")));
    expect(grants.map((s) => s.Sid)).toEqual(["ActionsWithoutResourceScope"]);
    expect(boundary.filter((s) => s.Effect === "Allow" && list(s.Action).some((p) => matches(p, "ecs:DescribeTaskDefinition")))).toEqual([]);
    expect(allowedBy(boundary, "ecs:DescribeTaskDefinition", "*")).toBe(false);
  });

  it("uses exactly the subnet ids and launcher role of infra/lib/config.ts", () => {
    expect([...new Set(templateText.match(/subnet-[0-9a-f]+/g))].sort()).toEqual([...BUILDS_SUBNET_IDS].sort());
    // The README's CloudTrail check names them too.
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    expect([...new Set(readme.match(/subnet-[0-9a-f]{17}/g))].sort()).toEqual([...BUILDS_SUBNET_IDS].sort());
    for (const stmts of [deploy, boundary]) {
      const deny = stmts.find((s) => s.Sid === "ServicesInWorkshopSubnetsOnly");
      expect(condValues(deny?.Condition, "ForAnyValue:StringNotEquals", "ecs:subnet")).toEqual([...BUILDS_SUBNET_IDS]);
    }
    expect(templateText.split(SERVICE_DENY_SUBNET_LIST)).toHaveLength(3);
    const pinned = boundary.filter((s) => s.Condition?.ArnEquals?.["aws:PrincipalArn"] !== undefined);
    expect(pinned.map((s) => s.Sid)).toEqual(["RunBuilds", "TagBuildsOnStart"]);
    for (const s of pinned) expect(condValues(s.Condition, "ArnEquals", "aws:PrincipalArn").map(live), s.Sid).toEqual([BUILD_LAUNCHER_ROLE_ARN]);
  });
});

describe("access stack: GitHub OIDC (try 4)", () => {
  it("lets only deploy.yml, on push to main, request an OIDC token", () => {
    expect(oidcWorkflowGaps(workflowFiles())).toEqual([]);
    expect(oidcWorkflowGaps({ "ci.yml": "permissions:\n  id-token: write\n" })).toEqual(["ci.yml/id-token"]);
    expect(oidcWorkflowGaps({ "x.yml": "permissions: write-all\n" })).toEqual(["x.yml/id-token"]);
    expect(oidcWorkflowGaps({ "deploy.yml": "on:\n  push:\n    branches: [main]\npermissions:\n  id-token: write\n" })).toEqual([]);
    expect(oidcWorkflowGaps({ "deploy.yml": "on:\n  push:\n    branches: [main]\n  pull_request_target:\n" })).toEqual(["deploy.yml/triggers"]);
    expect(oidcWorkflowGaps({ "deploy.yml": "on: [push, workflow_run]\n" })).toEqual(["deploy.yml/triggers"]);
  });
});

describe("access stack: Route53 (L6)", () => {
  it("needs record names, A/AAAA/CNAME types and a Null guard on both keys", () => {
    const noGuard = withText('              "Null":\n                route53:ChangeResourceRecordSetsNormalizedRecordNames: "false"\n', '              "Null":\n');
    expect(deployGaps(noGuard)).toContain("DnsOnlyWorkshopSubdomain/route53:ChangeResourceRecordSets");
    const txt = withText("RecordTypes: [A, AAAA, CNAME]", "RecordTypes: [A, AAAA, CNAME, NS]");
    expect(deployGaps(txt)).toContain("DnsOnlyWorkshopSubdomain/route53:ChangeResourceRecordSets");
  });
});

describe("access stack: S3 in this account only (L1)", () => {
  it("adds aws:ResourceAccount to every bucket grant (bucket names are global)", () => {
    expect(s3AccountGaps(deployStatements(template))).toEqual([]);
    expect(s3AccountGaps(boundaryStatements(template))).toEqual([]);
    const old = withAll("              StringEquals: {aws:ResourceAccount: !Ref AWS::AccountId}\n", "              StringEquals: {aws:ResourceAccount: \"*\"}\n");
    expect(s3AccountGaps(deployStatements(old))).toEqual(["WorkshopBuckets"]);
    expect(s3AccountGaps(boundaryStatements(old))).toEqual(["WorkshopBuckets"]);
  });
});

describe("access stack: sharing outside the account", () => {
  const stmts = deployStatements(template);

  it("denies resource policies, ACLs, function URLs and exports that CDK does not need", () => {
    expect(SHARING.filter((a) => !denied(stmts, "*", a))).toEqual([]);
    const without = stmts.filter((s) => s.Sid !== "NoExternalSharing");
    expect(SHARING.filter((a) => !denied(without, "*", a))).toEqual(SHARING);
  });

  it("carries the same denies in the boundary, for workload roles (try 4)", () => {
    const boundary = boundaryStatements(template);
    expect(BOUNDARY_SHARING.filter((a) => !denied(boundary, "*", a))).toEqual([]);
    expect(denied(boundary, "*", "s3:PutBucketNotification")).toBe(false);
    const without = boundary.filter((s) => s.Sid !== "NoExternalSharing");
    expect(BOUNDARY_SHARING.filter((a) => !denied(without, "*", a))).toEqual(BOUNDARY_SHARING);
  });

  it("denies workload roles setting queue attributes (a queue Policy), deleting or purging queues (access review)", () => {
    const boundary = boundaryStatements(template);
    const QUEUE_WRITES = ["sqs:SetQueueAttributes", "sqs:DeleteQueue", "sqs:PurgeQueue"];
    for (const name of ["ssd-workshop-deploys", "ssd-workshop-builds", "ssd-workshop-other"]) {
      const queue = `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`;
      for (const a of QUEUE_WRITES) expect(allowedBy(boundary, a, queue, { "aws:PrincipalArn": WORKLOAD_ROLE }), `${a} ${name}`).toBe(false);
    }
    const without = boundary.filter((s) => s.Sid !== "NoExternalSharing");
    for (const a of QUEUE_WRITES) expect(denied(without, "*", a), a).toBe(false);
    // The deploy policies keep them: CloudFormation (the deploy role, no boundary) manages the queues.
    for (const a of QUEUE_WRITES) expect(denied(deployStatements(template), "*", a), a).toBe(false);
  });

  it("denies invoke permissions, event targets and subscriptions that leave the workshop", () => {
    expect(conditionalDeny(stmts, "lambda:AddPermission", "StringNotEquals", "lambda:Principal")?.Resource).toBe("*");
    const targets = conditionalDeny(stmts, "events:PutTargets", "ForAnyValue:ArnNotLike", "events:TargetArn");
    expect(condValues(targets?.Condition, "ForAnyValue:ArnNotLike", "events:TargetArn").map(subText)).toEqual(["arn:aws:*:*:${AWS::AccountId}:*"]);
    const subs = conditionalDeny(stmts, "sns:Subscribe", "StringNotLike", "sns:Endpoint");
    expect(condValues(subs?.Condition, "StringNotLike", "sns:Endpoint").map(subText).every(isScopedArn)).toBe(true);
  });

  it("grants no budget change (M5)", () => {
    const budgetWrites = [...stmts, ...boundaryStatements(template)].filter(
      (s) => s.Effect === "Allow" && list(s.Action).some((a) => a.startsWith("budgets:") && !isRead(a)),
    );
    expect(budgetWrites.map((s) => s.Sid)).toEqual([]);
  });
});

describe("access stack: self-protection (criterion 3)", () => {
  const deny = deployStatements(template).find((s) => s.Sid === "ProtectThisStack");

  it("explicitly denies stack updates, deletes and change sets on ssd-workshop-access", () => {
    expect(deny?.Effect).toBe("Deny");
    expect(list(deny?.Resource).map(text)).toEqual([
      "arn:aws:cloudformation:*:${AWS::AccountId}:stack/ssd-workshop-access/*",
    ]);
    const deniedHere = (action: string) =>
      deny?.Action !== undefined
        ? list(deny.Action).some((p) => matches(p, action))
        : !list(deny?.NotAction).some((p) => matches(p, action));
    for (const a of [
      "cloudformation:UpdateStack",
      "cloudformation:UpdateTerminationProtection",
      "cloudformation:DeleteStack",
      "cloudformation:CreateChangeSet",
      "cloudformation:ExecuteChangeSet",
      "cloudformation:CancelUpdateStack",
      "cloudformation:RollbackStack",
      "cloudformation:ContinueUpdateRollback",
      "cloudformation:SetStackPolicy",
    ]) {
      expect(deniedHere(a), a).toBe(true);
    }
  });

  it("attaches the same four deploy policies to the deploy role and the Claude user", () => {
    expect(statements(template, "DeployPolicy")).toContain(deny);
    for (const id of ["DeployRole", "ClaudeUser"]) {
      expect(template.Resources[id]?.Properties.ManagedPolicyArns, id).toEqual(DEPLOY_POLICIES.map((p) => ({ Ref: p })));
    }
    expect(DEPLOY_POLICIES.map((id) => template.Resources[id]?.Properties.ManagedPolicyName)).toEqual([
      "ssd-workshop-deploy", "ssd-workshop-deploy-edge", "ssd-workshop-deploy-ec2", "ssd-workshop-deploy-read",
    ]);
  });

  it("explicitly denies IAM writes on the deploy role, the Claude user and the five managed policies", () => {
    expect(identityGaps(deployStatements(template))).toEqual([]);
    // Old pattern: without the deny, role/ssd-workshop-* housekeeping reached the deploy role.
    const without = deployStatements(template).filter((s) => s.Sid !== "ProtectAccessIdentities");
    expect(identityGaps(without)).toContain("arn:aws:iam::${AWS::AccountId}:role/ssd-workshop-deploy/iam:UpdateAssumeRolePolicy");
    const noRead = withText("              - !Sub arn:aws:iam::${AWS::AccountId}:policy/ssd-workshop-deploy-read\n", "");
    expect(identityGaps(deployStatements(noRead))).toContain("arn:aws:iam::${AWS::AccountId}:policy/ssd-workshop-deploy-read/iam:DeletePolicy");
  });

  it("keeps every role right on the /ssd-workshop/ path, so no Allow reaches the deploy role (H4)", () => {
    expect(deployRoleWrites(deployStatements(template))).toEqual([]);
    const old = withAll(":role/ssd-workshop/*", ":role/ssd-workshop-*");
    expect(deployRoleWrites(deployStatements(old))).toContain("WorkshopRolesHousekeeping/iam:UpdateAssumeRolePolicy");
    expect(deployRoleWrites(deployStatements(old))).toContain("PassWorkshopRolesToWorkshopServices/iam:PassRole");
  });

  it("lets CloudFormation check that a workshop role does not exist yet (iam:GetRole without the path)", () => {
    // Before CreateRole, CloudFormation calls GetRole by name. For a role that does not exist yet,
    // IAM checks role/<name> without the path, so role/ssd-workshop/* does not match it.
    const allowsGetRole = (t: Template) =>
      deployStatements(t).some(
        (s) =>
          s.Effect === "Allow" &&
          list(s.Action).some((a) => matches(a, "iam:GetRole")) &&
          list(s.Resource).map(text).some((r) => matches(r, "arn:aws:iam::${AWS::AccountId}:role/ssd-workshop-site-deploy")),
      );
    expect(allowsGetRole(template)).toBe(true);
    expect(allowsGetRole(withText(":role/ssd-workshop-*\n", ":role/ssd-workshop/*\n"))).toBe(false);
  });

  it("denies assuming other roles, session tags and source identities (H4)", () => {
    for (const a of ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"]) {
      expect(denied(deployStatements(template), "*", a), a).toBe(true);
      expect(denied(deployStatements(template).filter((s) => s.Sid !== "NoSelfAssume"), "*", a), a).toBe(false);
    }
  });

  it("lets iam:PassRole hand workshop roles only to the services the workshop uses", () => {
    expect(passRoleGaps(deployStatements(template))).toEqual([]);
    const old = withText("iam:UpdateAssumeRolePolicy, iam:CreateInstanceProfile", "iam:UpdateAssumeRolePolicy, iam:PassRole, iam:CreateInstanceProfile");
    expect(passRoleGaps(deployStatements(old))).toEqual(["WorkshopRolesHousekeeping"]);
  });
});

describe("access stack: permissions boundary (criterion 4)", () => {
  const boundaryActions = ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"];

  it("allows role creation and role policy changes only with the ssd-workshop-boundary boundary", () => {
    const granting = deployStatements(template).filter(
      (s) => s.Effect === "Allow" && list(s.Action).some((p) => boundaryActions.some((a) => matches(p, a))),
    );
    expect(granting.map((s) => s.Sid)).toEqual(["WorkshopRolesWithBoundaryOnly"]);
    for (const s of granting) {
      expect(s.Condition).toEqual({ StringEquals: { "iam:PermissionsBoundary": { Ref: "BoundaryPolicy" } } });
    }
    expect(template.Resources.BoundaryPolicy?.Properties.ManagedPolicyName).toBe("ssd-workshop-boundary");
  });

  it("explicitly denies removing or replacing a boundary", () => {
    for (const a of ["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary"]) {
      const hit = unconditionalDenies(deployStatements(template)).find((s) => s.Action !== undefined && list(s.Action).some((p) => matches(p, a)));
      expect(hit && list(hit.Resource).map(text), a).toEqual(["*"]);
    }
  });

  it("scopes every boundary write like the deploy policies, with its own exception list (M1)", () => {
    expect(boundaryGaps(template)).toEqual([]);
    const metrics = boundaryStatements(template).find((s) => s.Sid === "WorkshopMetrics");
    expect(metrics?.Condition).toEqual({ StringEquals: { "cloudwatch:namespace": "ssd-workshop" } });
    // Old pattern: build, image and invalidation rights on Resource *.
    const old = withText(
      "            Action: ecs:RunTask\n            Resource: !Sub arn:aws:ecs:${AWS::Region}:${AWS::AccountId}:task-definition/ssd-workshop-*:*\n",
      '            Action: [ecs:RunTask, cloudfront:CreateInvalidation]\n            Resource: "*"\n',
    );
    expect(boundaryGaps(old)).toEqual(["RunBuilds/ecs:RunTask", "RunBuilds/cloudfront:CreateInvalidation"]);
    const heartbeat = withText(
      "            Action: ssm:UpdateInstanceInformation\n            Resource: !Sub arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/*\n            Condition:\n              StringEquals: {aws:ResourceTag/project: ssd-workshop}\n",
      '            Action: ssm:UpdateInstanceInformation\n            Resource: "*"\n',
    );
    expect(boundaryGaps(heartbeat)).toEqual(["K3sNodeHeartbeat/ssm:UpdateInstanceInformation"]);
  });

  it("lets a workload role pass only /ssd-workshop/ roles, and only to ECS tasks (M4)", () => {
    expect(passRoleGaps(boundaryStatements(template), ["ecs-tasks.amazonaws.com"])).toEqual([]);
    const old = withText("              StringEquals: {iam:PassedToService: ecs-tasks.amazonaws.com}\n", "");
    expect(passRoleGaps(boundaryStatements(old), ["ecs-tasks.amazonaws.com"])).toEqual(["PassWorkshopRoles"]);
  });

  it("names every boundary data resource with an ssd-workshop- prefix", () => {
    const loose = boundaryStatements(template)
      .filter((s) => s.Sid === "WorkshopData" || s.Sid === "WorkshopBuckets")
      .flatMap((s) => list(s.Resource).map(text))
      .filter((r) => !isScopedArn(r));
    expect(loose).toEqual([]);
  });
});

describe("access stack: deploy role trust", () => {
  it("trusts only GitHub Actions of kifbv/ssd-workshop on main (no GitHub environments)", () => {
    // GitHub sends this repository's subject in the ID form owner@ownerId/repo@repoId.
    expect(template.Parameters.GitHubRepo?.Default).toBe("kifbv@7999713/ssd-workshop@1467373954");
    const trust = template.Resources.DeployRole?.Properties.AssumeRolePolicyDocument as { Statement: Statement[] };
    expect(trust.Statement).toHaveLength(1);
    const [s] = trust.Statement;
    expect(s).toMatchObject({ Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity" });
    expect(s?.Condition).toEqual({
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": { "Fn::Sub": "repo:${GitHubRepo}:ref:refs/heads/main" },
      },
    });
  });
});

describe("policy sizes", () => {
  it("prints the size of each managed policy", () => {
    const sizes = Object.fromEntries(ALL_POLICIES.map((id) => [id, policySize(template, id)]));
    console.log(`policy sizes (limit 6144): ${JSON.stringify(sizes)}`);
    expect(Object.keys(sizes)).toHaveLength(5);
  });
});

describe("access stack: the GitHub App's key (ticket 2.6)", () => {
  const deploy = deployStatements(template);
  const boundary = boundaryStatements(template);
  const SECRET = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:ssd-workshop-github-AbCdEf`;
  const OTHER = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:ssd-workshop-other-AbCdEf`;
  const LAUNCHER_WITHOUT_PATH = `arn:aws:iam::${ACCOUNT}:role/${BUILD_LAUNCHER_FUNCTION_NAME}`;
  // Every Secrets Manager action, per servicereference secretsmanager.json v1.5
  // (servicereference.us-east-1.amazonaws.com/v1/secretsmanager/secretsmanager.json), read 2026-11-24.
  const SECRETSMANAGER_ACTIONS = [
    "AcceptCrossAccountReplication", "AssociateCrossAccountReplica", "BatchGetSecretValue", "CancelRotateSecret",
    "CreateSecret", "DeleteResourcePolicy", "DeleteSecret", "DescribeSecret", "DisassociateCrossAccountReplica",
    "GetRandomPassword", "GetResourcePolicy", "GetSecretValue", "ListResourcePolicies", "ListSecretVersionIds",
    "ListSecrets", "PutResourcePolicy", "PutSecretValue", "RemoveRegionsFromReplication", "ReplicateSecretToRegions",
    "RestoreSecret", "RotateSecret", "StopReplicationToReplica", "TagResource", "UntagResource", "UpdateSecret",
    "UpdateSecretVersionStage", "ValidateResourcePolicy",
  ].map((a) => `secretsmanager:${a}`);
  // What CloudFormation needs to create, describe and tag the secret, plus reads that hold no value.
  // GetRandomPassword and ListSecrets name no secret, so a deny on the secret never reaches them.
  const STILL_ALLOWED = [
    "CreateSecret", "DescribeSecret", "TagResource", "UntagResource", "GetResourcePolicy", "ListSecretVersionIds",
    "ValidateResourcePolicy",
  ].map((a) => `secretsmanager:${a}`);
  const NO_RESOURCE = ["secretsmanager:GetRandomPassword", "secretsmanager:ListSecrets"];

  it("denies the deploy principals every other action on the key, new AWS actions included", () => {
    const deny = deploy.find((s) => s.Sid === "NoGitHubKey");
    expect(deny?.Effect).toBe("Deny");
    expect(deny?.Action, "a NotAction list, so actions AWS adds later are denied too").toBeUndefined();
    for (const action of SECRETSMANAGER_ACTIONS.filter((a) => !STILL_ALLOWED.includes(a) && !NO_RESOURCE.includes(a))) {
      expect(statementApplies(deny as Statement, action, SECRET, {}), action).toBe(true);
      expect(allowedBy(deploy, action, SECRET), action).toBe(false);
    }
    expect(statementApplies(deny as Statement, "secretsmanager:SomeFutureAction", SECRET, {})).toBe(true);
    // Without the deny they could (secretsmanager:* on ssd-workshop-*).
    const old = deploy.filter((s) => s.Sid !== "NoGitHubKey");
    expect(allowedBy(old, "secretsmanager:GetSecretValue", SECRET)).toBe(true);
  });

  it("still lets CloudFormation create, describe and tag it, and leaves other workshop secrets as they were", () => {
    for (const action of ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:TagResource"]) {
      expect(allowedBy(deploy, action, SECRET), action).toBe(true);
    }
    expect(allowedBy(deploy, "secretsmanager:GetSecretValue", OTHER)).toBe(true);
  });

  it("lets no workload role read the key but the build launcher (with or without its path)", () => {
    const read = "secretsmanager:GetSecretValue";
    expect(allowedBy(boundary, read, SECRET, { "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(false);
    expect(allowedBy(boundary, read, SECRET, { "aws:PrincipalArn": BUILD_LAUNCHER_ROLE_ARN })).toBe(true);
    expect(allowedBy(boundary, read, SECRET, { "aws:PrincipalArn": LAUNCHER_WITHOUT_PATH })).toBe(true);
    expect(allowedBy(boundary, read, OTHER, { "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(true);
    const old = boundary.filter((s) => s.Sid !== "GitHubKeyForTheLauncherOnly");
    expect(allowedBy(old, read, SECRET, { "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(true);
  });

  describe("Claude sessions cannot reach the key through the launcher (Franck, 2026-11-24)", () => {
    // Request context the allows check (the test reads a `!Ref X` value as "Ref:X"): the account of the resource
    // (S3), the boundary named on a role write and the service a role is passed to.
    const REQUEST = { "aws:ResourceAccount": "Ref:AWS::AccountId", "iam:PermissionsBoundary": "Ref:BoundaryPolicy", "iam:PassedToService": "lambda.amazonaws.com" };
    const CLAUDE = { ...REQUEST, "aws:PrincipalArn": `arn:aws:iam::${ACCOUNT}:user/ssd-workshop-claude` };
    const DEPLOY = { ...REQUEST, "aws:PrincipalArn": `arn:aws:iam::${ACCOUNT}:role/ssd-workshop-deploy` };
    const ROLES = [BUILD_LAUNCHER_ROLE_ARN, `arn:aws:iam::${ACCOUNT}:role/${BUILD_LAUNCHER_FUNCTION_NAME}`];
    const FUNCTIONS = [
      `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${BUILD_LAUNCHER_FUNCTION_NAME}`,
      `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${BUILD_LAUNCHER_FUNCTION_NAME}:live`,
    ];
    const ASSET = `arn:aws:s3:::${ASSETS_BUCKET_NAME}/abc123.zip`;
    const ROLE_WRITES = [
      "iam:CreateRole", "iam:PassRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:AttachRolePolicy",
      "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:UpdateRole", "iam:TagRole", "iam:DeleteRole",
    ];
    const FUNCTION_WRITES = [
      "lambda:CreateFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:PublishVersion",
      "lambda:CreateAlias", "lambda:UpdateAlias", "lambda:DeleteFunction",
    ];

    it("denies the Claude user creating, passing or changing the launcher's role (both ARN forms)", () => {
      for (const role of ROLES) {
        for (const action of ROLE_WRITES) expect(allowedBy(deploy, action, role, CLAUDE), `${action} ${role}`).toBe(false);
        expect(allowedBy(deploy, "iam:GetRole", role, CLAUDE)).toBe(true);
      }
    });

    it("denies the Claude user changing or invoking the launcher's function, but not reading it", () => {
      for (const fn of FUNCTIONS) {
        for (const action of FUNCTION_WRITES) expect(allowedBy(deploy, action, fn, CLAUDE), `${action} ${fn}`).toBe(false);
      }
      expect(allowedBy(deploy, "lambda:GetFunction", FUNCTIONS[0] ?? "", CLAUDE)).toBe(true);
      // Invoking runs the key holder's code on input a session chose: denied too.
      expect(allowedBy(deploy, "lambda:InvokeFunction", FUNCTIONS[0] ?? "", CLAUDE)).toBe(false);
    });

    it("denies the Claude user writing deploy assets or the assets bucket's settings (a planted asset would become the launcher's code)", () => {
      for (const action of ["s3:PutObject", "s3:DeleteObject"]) expect(allowedBy(deploy, action, ASSET, CLAUDE), action).toBe(false);
      expect(allowedBy(deploy, "s3:GetObject", ASSET, CLAUDE)).toBe(true);
      for (const action of ["s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutBucketPublicAccessBlock", "s3:PutBucketOwnershipControls", "s3:PutBucketVersioning"]) {
        expect(allowedBy(deploy, action, `arn:aws:s3:::${ASSETS_BUCKET_NAME}`, CLAUDE), action).toBe(false);
      }
    });

    it("denies every workload role writing deploy assets (a role a session creates could plant one otherwise)", () => {
      const role = { ...REQUEST, "aws:PrincipalArn": WORKLOAD_ROLE };
      for (const action of ["s3:PutObject", "s3:DeleteObject", "s3:PutObjectAcl"]) expect(allowedBy(boundary, action, ASSET, role), action).toBe(false);
      expect(allowedBy(boundary, "s3:GetObject", ASSET, role)).toBe(true);
      // Nor its settings (a bucket policy could open object writes to anyone).
      const bucket = `arn:aws:s3:::${ASSETS_BUCKET_NAME}`;
      for (const action of ["s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutBucketPublicAccessBlock", "s3:PutBucketOwnershipControls", "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration", "s3:DeleteBucket"]) {
        expect(allowedBy(boundary, action, bucket, role), action).toBe(false);
      }
      for (const action of ["s3:GetBucketLocation", "s3:ListBucket"]) expect(allowedBy(boundary, action, bucket, role), action).toBe(true);
      expect(allowedBy(boundary, "s3:PutObject", `arn:aws:s3:::ssd-workshop-apps-${ACCOUNT}/apps/x/index.html`, role)).toBe(true);
    });

    it("names exactly the launcher's role from config (both forms)", () => {
      const deny = deploy.find((s) => s.Sid === "NoLauncherForSessions");
      const resources = list(deny?.Resource).map(live);
      for (const role of ROLES) expect(resources).toContain(role);
      expect(ROLES[0]).toBe(BUILD_LAUNCHER_ROLE_ARN);
    });

    it("denies the Claude user sending to, reading from, changing, purging or deleting the builds queues (Franck, 2026-11-24, ticket 2.9)", () => {
      const queues = [BUILD_QUEUE_NAME, BUILD_DLQ_NAME, BUILD_CHECK_QUEUE_NAME].map((name) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`);
      for (const queue of queues) {
        for (const action of ["sqs:SendMessage", "sqs:SetQueueAttributes", "sqs:PurgeQueue", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:DeleteQueue"]) {
          expect(allowedBy(deploy, action, queue, CLAUDE), `${action} ${queue}`).toBe(false);
          // Deploys from main still manage them.
          expect(allowedBy(deploy, action, queue, DEPLOY), `${action} ${queue}`).toBe(true);
        }
        expect(allowedBy(deploy, "sqs:GetQueueAttributes", queue, CLAUDE), queue).toBe(true);
      }
      // Other workshop queues stay open to sessions (the AI queue).
      expect(allowedBy(deploy, "sqs:SendMessage", `arn:aws:sqs:${REGION}:${ACCOUNT}:ssd-workshop-ai-messages`, CLAUDE)).toBe(true);
      const deny = deploy.find((s) => s.Sid === "NoBuildQueueForSessions");
      expect(deny?.Effect).toBe("Deny");
    });

    // Ticket 2.9 try 2, access review HIGH 1 (Franck's yes, 2026-11-24): a session could read a running build's token from
    // its task (DescribeTasks shows the override), push with it, write pushedCommit and send a deploy message.
    const BUILD_TASK = `${ECS_ARN}:task/${BUILDS_CLUSTER_NAME}/0123456789abcdef0123456789abcdef`;
    const BUILDER_DEFINITION = `${ECS_ARN}:task-definition/${BUILDER_TASK_FAMILY}:7`;
    const DEPLOY_QUEUES = [DEPLOY_QUEUE_NAME, DEPLOY_DLQ_NAME].map((name) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`);

    it("denies the Claude user reading, starting or stopping build tasks (the token is in the task's override)", () => {
      // ExecuteCommand too: a shell in the task would show its environment (the launcher never enables it; belt and braces).
      for (const action of ["ecs:DescribeTasks", "ecs:StopTask", "ecs:ExecuteCommand"]) {
        expect(allowedBy(deploy, action, BUILD_TASK, CLAUDE), action).toBe(false);
        expect(allowedBy(deploy, action, BUILD_TASK, DEPLOY), action).toBe(true);
        // Without the deny a session could (ecs:* on task/ssd-workshop-*/*).
        expect(allowedBy(deploy.filter((s) => s.Sid !== "NoBuildTasksForSessions"), action, BUILD_TASK, CLAUDE), action).toBe(true);
      }
      const run = { ...CLAUDE, "ecs:cluster": WORKSHOP_CLUSTER };
      expect(allowedBy(deploy, "ecs:RunTask", BUILDER_DEFINITION, run)).toBe(false);
      expect(allowedBy(deploy, "ecs:RunTask", BUILDER_DEFINITION, { ...run, "aws:PrincipalArn": DEPLOY["aws:PrincipalArn"] })).toBe(true);
      // Tasks of other workshop clusters (none yet) stay readable.
      expect(allowedBy(deploy, "ecs:DescribeTasks", `${ECS_ARN}:task/ssd-workshop-apps/0123`, CLAUDE)).toBe(true);
    });

    it("denies the Claude user sending to the deploy queue (a deploy message publishes pushedCommit)", () => {
      for (const queue of DEPLOY_QUEUES) {
        expect(allowedBy(deploy, "sqs:SendMessage", queue, CLAUDE), queue).toBe(false);
        expect(allowedBy(deploy, "sqs:SendMessage", queue, DEPLOY), queue).toBe(true);
        expect(allowedBy(deploy, "sqs:GetQueueAttributes", queue, CLAUDE), queue).toBe(true);
      }
    });

    // Ticket 2.9 try 3 (access review LOW 2 and 3): no condition key names a mapping's queue (Service Authorization
    // Reference, lambda.json, read 2026-11-24: CreateEventSourceMapping carries only tags and lambda:FunctionArn), and
    // a call by mapping UUID may carry no function ARN: sessions get no mapping writes at all.
    it("denies the Claude user adding, changing or removing any event source mapping, with or without a function ARN", () => {
      const mapping = `arn:aws:lambda:${REGION}:${ACCOUNT}:event-source-mapping:0123-4567`;
      const own = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:ssd-workshop-session-own`;
      for (const action of ["lambda:CreateEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping"]) {
        const resource = action === "lambda:CreateEventSourceMapping" ? "*" : mapping;
        for (const fn of [...FUNCTIONS, own, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:ssd-workshop-apps-deployer`]) {
          expect(allowedBy(deploy, action, resource, { ...CLAUDE, "lambda:FunctionArn": fn }), `${action} ${fn}`).toBe(false);
          // Deploys from main still manage mappings.
          expect(allowedBy(deploy, action, resource, { ...DEPLOY, "lambda:FunctionArn": fn }), `${action} ${fn}`).toBe(true);
          // Without the deny a session could (WorkshopEventSourceMappings).
          expect(allowedBy(deploy.filter((s) => s.Sid !== "NoEventSourcesForSessions"), action, resource, { ...CLAUDE, "lambda:FunctionArn": fn }), `${action} ${fn}`).toBe(true);
        }
        // A deny that needed lambda:FunctionArn would not apply to a call without it; this one does not need it.
        expect(statementApplies(deploy.find((s) => s.Sid === "NoEventSourcesForSessions") as Statement, action, resource, CLAUDE), action).toBe(true);
      }
      expect(allowedBy(deploy, "lambda:GetEventSourceMapping", mapping, { ...CLAUDE, "lambda:FunctionArn": FUNCTIONS[0] ?? "" })).toBe(true);
    });

    // Ticket 2.9 try 3 (access review HIGH): roles the boundary's denies let through by name, and the apps deployer
    // (the apps bucket's only writer), cannot be borrowed by a session: no PassRole to its own task or function, no
    // change to their policies or trust, and no change to the code that runs as them.
    const role = (name: string, withPath = true) => `arn:aws:iam::${ACCOUNT}:role${withPath ? IAM_PATH : "/"}${name}`;
    const EXCEPTION_ROLES = [BUILDER_TASK_ROLE_NAME, BUILDER_EXECUTION_ROLE_NAME, AI_WORKER_FUNCTION_NAME, BUILD_CHECK_SCHEDULER_ROLE_NAME, DEPLOYER_FUNCTION_NAME];
    const PASSES = ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com", "scheduler.amazonaws.com"];

    // The deny names each role with its path (IAM rejects role*/<name> in a Resource); the path-less form has no
    // allow at all, since sessions create, pass and change roles only under role/ssd-workshop/.
    it("denies the Claude user passing, changing or deleting the exception roles (both ARN forms), but not reading them", () => {
      for (const name of EXCEPTION_ROLES) {
        for (const arn of [role(name), role(name, false)]) {
          for (const action of ROLE_WRITES) expect(allowedBy(deploy, action, arn, CLAUDE), `${action} ${arn}`).toBe(false);
          for (const service of PASSES) {
            expect(allowedBy(deploy, "iam:PassRole", arn, { ...CLAUDE, "iam:PassedToService": service }), `PassRole ${arn} ${service}`).toBe(false);
          }
          expect(allowedBy(deploy, "iam:GetRole", arn, CLAUDE), arn).toBe(true);
        }
        // Reads of the real role (with its path) stay allowed.
        for (const action of ["iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"]) {
          expect(allowedBy(deploy, action, role(name), CLAUDE), `${action} ${name}`).toBe(true);
        }
        // Deploys from main still create, pass and change them.
        for (const action of ["iam:CreateRole", "iam:PassRole", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy"]) {
          expect(allowedBy(deploy, action, role(name), DEPLOY), `${action} ${name}`).toBe(true);
        }
        // Without the new resources a session could pass them.
        const old = deploy.map((s) => (s.Sid === "NoLauncherForSessions" ? { ...s, Resource: list(s.Resource).filter((r) => live(r) !== role(name)) } : s));
        expect(allowedBy(old, "iam:PassRole", role(name), CLAUDE), name).toBe(true);
      }
      // Other workshop roles (one a session creates for its own function) stay passable.
      for (const other of [role("ssd-workshop-session-own"), role(`x-${BUILDER_TASK_ROLE_NAME}`), role(`${BUILDER_TASK_ROLE_NAME}-task`)]) {
        expect(allowedBy(deploy, "iam:PassRole", other, CLAUDE), other).toBe(true);
      }
    });

    it("denies the Claude user changing or invoking the AI worker's and the deployer's code, but not reading it", () => {
      for (const name of [AI_WORKER_FUNCTION_NAME, DEPLOYER_FUNCTION_NAME]) {
        const fns = [`arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}:live`];
        for (const fn of fns) {
          for (const action of [...FUNCTION_WRITES, "lambda:InvokeFunction", "lambda:AddPermission", "lambda:PutFunctionConcurrency"]) {
            expect(allowedBy(deploy, action, fn, CLAUDE), `${action} ${fn}`).toBe(false);
          }
          for (const action of ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:ListVersionsByFunction"]) {
            expect(allowedBy(deploy, action, fn, CLAUDE), `${action} ${fn}`).toBe(true);
          }
        }
        for (const action of ["lambda:CreateFunction", "lambda:UpdateFunctionCode"]) expect(allowedBy(deploy, action, fns[0] ?? "", DEPLOY), `${action} ${name}`).toBe(true);
      }
      // A session's own workshop function is untouched.
      expect(allowedBy(deploy, "lambda:UpdateFunctionCode", `arn:aws:lambda:${REGION}:${ACCOUNT}:function:ssd-workshop-session-own`, CLAUDE)).toBe(true);
    });

    it("names the exception roles and functions of infra/lib/config.ts", () => {
      const resources = list(deploy.find((s) => s.Sid === "NoLauncherForSessions")?.Resource).map(live);
      for (const name of EXCEPTION_ROLES) expect(resources).toContain(role(name));
      for (const r of resources) expect(r, r).not.toContain("role*/");
      for (const name of [AI_WORKER_FUNCTION_NAME, DEPLOYER_FUNCTION_NAME]) {
        expect(resources).toContain(`arn:aws:lambda:*:${ACCOUNT}:function:${name}`);
        expect(resources).toContain(`arn:aws:lambda:*:${ACCOUNT}:function:${name}:*`);
      }
      // The builder's roles and the scheduler role of config.ts are the ones the builds stack creates (app.test.ts).
      expect([BUILDER_TASK_ROLE_NAME, BUILDER_EXECUTION_ROLE_NAME, BUILD_CHECK_SCHEDULER_ROLE_NAME, DEPLOYER_FUNCTION_NAME]).toEqual([
        "ssd-workshop-builder", "ssd-workshop-builder-execution", "ssd-workshop-builds-check-scheduler", "ssd-workshop-apps-deployer",
      ]);
    });

    it("denies the Claude user creating, changing or deleting the stuck-build check's schedule (any group)", () => {
      const schedule = (group: string, name = BUILD_CHECK_SCHEDULE_NAME) => `arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/${group}/${name}`;
      for (const action of ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"]) {
        for (const target of [schedule("default"), schedule("ssd-workshop-x")]) {
          expect(allowedBy(deploy, action, target, CLAUDE), `${action} ${target}`).toBe(false);
          expect(allowedBy(deploy.filter((s) => s.Sid !== "NoBuildCheckScheduleForSessions"), action, target, CLAUDE), `${action} ${target}`).toBe(true);
        }
        expect(allowedBy(deploy, action, schedule("default"), DEPLOY), action).toBe(true);
        expect(allowedBy(deploy, action, schedule("default", "ssd-workshop-other"), CLAUDE), action).toBe(true);
      }
      expect(allowedBy(deploy, "scheduler:GetSchedule", schedule("default"), CLAUDE)).toBe(true);
    });

    it("denies the Claude user running any task on the builds cluster, whatever its task definition", () => {
      const own = `${ECS_ARN}:task-definition/ssd-workshop-session-own:1`;
      expect(allowedBy(deploy, "ecs:RunTask", own, { ...CLAUDE, "ecs:cluster": WORKSHOP_CLUSTER })).toBe(false);
      expect(allowedBy(deploy.filter((s) => s.Sid !== "NoBuildsClusterTasksForSessions"), "ecs:RunTask", own, { ...CLAUDE, "ecs:cluster": WORKSHOP_CLUSTER })).toBe(true);
      expect(allowedBy(deploy, "ecs:RunTask", own, { ...DEPLOY, "ecs:cluster": WORKSHOP_CLUSTER })).toBe(true);
      expect(allowedBy(deploy, "ecs:RunTask", own, { ...CLAUDE, "ecs:cluster": `${ECS_ARN}:cluster/ssd-workshop-other` })).toBe(true);
    });

    it("denies the Claude user creating or updating a service or task set on the builds cluster (access review)", () => {
      const service = (cluster: string) => `${ECS_ARN}:service/${cluster}/ssd-workshop-session-own`;
      const taskSet = (cluster: string) => `${ECS_ARN}:task-set/${cluster}/ssd-workshop-session-own/ecs-svc-0123`;
      const withoutDeny = deploy.filter((s) => s.Sid !== "NoBuildsClusterServicesForSessions");
      for (const action of ["ecs:CreateService", "ecs:UpdateService"]) {
        expect(allowedBy(deploy, action, service("ssd-workshop-builds"), CLAUDE), action).toBe(false);
        expect(allowedBy(withoutDeny, action, service("ssd-workshop-builds"), CLAUDE), action).toBe(true);
        expect(allowedBy(deploy, action, service("ssd-workshop-builds"), DEPLOY), action).toBe(true);
        expect(allowedBy(deploy, action, service("ssd-workshop-other"), CLAUDE), action).toBe(true);
      }
      // No deploy policy grants task sets today; the deny keeps the builds cluster's closed if one ever does.
      expect(allowedBy(deploy, "ecs:CreateTaskSet", taskSet("ssd-workshop-builds"), CLAUDE)).toBe(false);
      const deny = deploy.find((s) => s.Sid === "NoBuildsClusterServicesForSessions");
      expect(deny && statementApplies(deny, "ecs:CreateTaskSet", taskSet("ssd-workshop-builds"), CLAUDE)).toBe(true);
      expect(deny && statementApplies(deny, "ecs:CreateTaskSet", taskSet("ssd-workshop-other"), CLAUDE)).toBe(false);
      expect(deny && statementApplies(deny, "ecs:CreateService", service("ssd-workshop-builds"), DEPLOY)).toBe(false);
    });

    it("leaves the deploy role able to create, pass and update the launcher and upload assets (2.9 deploys it)", () => {
      for (const action of ["iam:CreateRole", "iam:PassRole", "iam:PutRolePolicy"]) expect(allowedBy(deploy, action, BUILD_LAUNCHER_ROLE_ARN, DEPLOY), action).toBe(true);
      for (const action of ["lambda:CreateFunction", "lambda:UpdateFunctionCode"]) expect(allowedBy(deploy, action, FUNCTIONS[0] ?? "", DEPLOY), action).toBe(true);
      expect(allowedBy(deploy, "s3:PutObject", ASSET, DEPLOY)).toBe(true);
    });
  });

  describe("workload roles reach build tasks and the build and deploy queues only in their own role (ticket 2.9 try 2, access review MEDIUM 4)", () => {
    const role = (name: string, withPath = true) => `arn:aws:iam::${ACCOUNT}:role${withPath ? IAM_PATH : "/"}${name}`;
    const BUILD_TASK = `${ECS_ARN}:task/${BUILDS_CLUSTER_NAME}/0123456789abcdef0123456789abcdef`;
    const queue = (name: string) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`;
    // A role a session could create: the path and a name that ends like an allowed one.
    const LOOKALIKES = [WORKLOAD_ROLE, role(`x-${BUILDER_TASK_ROLE_NAME}`), role(`${BUILDER_TASK_ROLE_NAME}x`), role(BUILDER_EXECUTION_ROLE_NAME), role(`x-${BUILD_LAUNCHER_FUNCTION_NAME}`)];

    it("lets only the launcher read or stop build tasks (with or without its path)", () => {
      for (const action of ["ecs:DescribeTasks", "ecs:StopTask"]) {
        for (const ok of [role(BUILD_LAUNCHER_FUNCTION_NAME), role(BUILD_LAUNCHER_FUNCTION_NAME, false)]) {
          expect(allowedBy(boundary, action, BUILD_TASK, { "aws:PrincipalArn": ok }), `${action} ${ok}`).toBe(true);
        }
        for (const other of [...LOOKALIKES, role(BUILDER_TASK_ROLE_NAME), role(AI_WORKER_FUNCTION_NAME)]) {
          expect(allowedBy(boundary, action, BUILD_TASK, { "aws:PrincipalArn": other }), `${action} ${other}`).toBe(false);
        }
        // Without the deny any workload role could (WatchBuilds).
        expect(allowedBy(boundary.filter((s) => s.Sid !== "WatchBuildsLauncherOnly"), action, BUILD_TASK, { "aws:PrincipalArn": WORKLOAD_ROLE }), action).toBe(true);
      }
    });

    it("lets only the builder's task role send to the deploy queue", () => {
      for (const target of [queue(DEPLOY_QUEUE_NAME), queue(DEPLOY_DLQ_NAME)]) {
        for (const ok of [role(BUILDER_TASK_ROLE_NAME), role(BUILDER_TASK_ROLE_NAME, false)]) {
          expect(allowedBy(boundary, "sqs:SendMessage", target, { "aws:PrincipalArn": ok }), ok).toBe(true);
        }
        for (const other of [...LOOKALIKES, role(BUILD_LAUNCHER_FUNCTION_NAME), role(AI_WORKER_FUNCTION_NAME)]) {
          expect(allowedBy(boundary, "sqs:SendMessage", target, { "aws:PrincipalArn": other }), other).toBe(false);
        }
      }
      expect(allowedBy(boundary.filter((s) => s.Sid !== "DeploysFromTheBuilderOnly"), "sqs:SendMessage", queue(DEPLOY_QUEUE_NAME), { "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(true);
    });

    it("lets only the AI worker and the check's scheduler role send to the builds queues", () => {
      for (const target of [queue(BUILD_QUEUE_NAME), queue(BUILD_DLQ_NAME), queue(BUILD_CHECK_QUEUE_NAME)]) {
        for (const ok of [AI_WORKER_FUNCTION_NAME, BUILD_CHECK_SCHEDULER_ROLE_NAME].flatMap((name) => [role(name), role(name, false)])) {
          expect(allowedBy(boundary, "sqs:SendMessage", target, { "aws:PrincipalArn": ok }), ok).toBe(true);
        }
        for (const other of [...LOOKALIKES, role(BUILDER_TASK_ROLE_NAME), role(BUILD_LAUNCHER_FUNCTION_NAME)]) {
          expect(allowedBy(boundary, "sqs:SendMessage", target, { "aws:PrincipalArn": other }), other).toBe(false);
        }
      }
      // Other workshop queues are untouched (the AI queue's sender is the conversation function).
      expect(allowedBy(boundary, "sqs:SendMessage", queue("ssd-workshop-ai-messages"), { "aws:PrincipalArn": WORKLOAD_ROLE })).toBe(true);
    });

    it("names the roles of infra/lib/config.ts", () => {
      const names = (sid: string) => condValues(boundary.find((s) => s.Sid === sid)?.Condition, "ArnNotLike", "aws:PrincipalArn").map(live);
      const either = (name: string) => `arn:aws:iam::${ACCOUNT}:role*/${name}`;
      expect(names("WatchBuildsLauncherOnly")).toEqual([either(BUILD_LAUNCHER_FUNCTION_NAME)]);
      expect(names("DeploysFromTheBuilderOnly")).toEqual([either(BUILDER_TASK_ROLE_NAME)]);
      expect(names("BuildsFromTheirSendersOnly")).toEqual([either(AI_WORKER_FUNCTION_NAME), either(BUILD_CHECK_SCHEDULER_ROLE_NAME)]);
    });

  });
});

// Ticket 2.9 follow-up: the deploy workflow logs in to ECR Public before building the builder image (anonymous pulls
// from GitHub's runners got 429). Actions and condition key from the Service Authorization Reference
// (servicereference.us-east-1.amazonaws.com/v1/ecr-public/ecr-public.json and sts.json, read 2026-11-24): neither action
// takes a resource, and sts:GetServiceBearerToken carries sts:AWSServiceName.
describe("access stack: ECR Public login for the deploy workflow (ticket 2.9 follow-up)", () => {
  const deploy = deployStatements(template);
  const boundary = boundaryStatements(template);
  const DEPLOY_ROLE = { "aws:PrincipalArn": `arn:aws:iam::${ACCOUNT}:role/ssd-workshop-deploy` };
  const ECR_PUBLIC = { "sts:AWSServiceName": "ecr-public.amazonaws.com" };

  it("lets the deploy principals get an ECR Public login token and its bearer token", () => {
    expect(allowedBy(deploy, "ecr-public:GetAuthorizationToken", "*", DEPLOY_ROLE)).toBe(true);
    expect(allowedBy(deploy, "sts:GetServiceBearerToken", "*", { ...DEPLOY_ROLE, ...ECR_PUBLIC })).toBe(true);
  });

  it("limits the bearer token to ECR Public and grants nothing else in ECR Public", () => {
    for (const service of ["codeartifact.amazonaws.com", "ecr.amazonaws.com"]) {
      expect(allowedBy(deploy, "sts:GetServiceBearerToken", "*", { ...DEPLOY_ROLE, "sts:AWSServiceName": service }), service).toBe(false);
    }
    expect(allowedBy(deploy, "sts:GetServiceBearerToken", "*", DEPLOY_ROLE)).toBe(false);
    for (const action of ["ecr-public:PutImage", "ecr-public:CreateRepository", "ecr-public:InitiateLayerUpload"]) {
      expect(allowedBy(deploy, action, `arn:aws:ecr-public::${ACCOUNT}:repository/ssd-workshop-x`, DEPLOY_ROLE), action).toBe(false);
    }
  });

  it("puts both in the -deploy-ec2 policy (attached to both principals) and not in the boundary", () => {
    const sids = statements(template, "DeployPolicyEc2").map((s) => s.Sid);
    expect(sids).toContain("EcrPublicLogin");
    expect(sids).toContain("EcrPublicBearerToken");
    for (const action of ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"]) {
      expect(boundary.some((s) => s.Effect === "Allow" && list(s.Action).some((p) => matches(p, action))), action).toBe(false);
    }
    for (const id of ["DeployRole", "ClaudeUser"]) {
      expect(JSON.stringify(template.Resources[id]?.Properties.ManagedPolicyArns), id).toContain("DeployPolicyEc2");
    }
  });
});
