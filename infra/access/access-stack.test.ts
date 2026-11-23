// Static checks of the access stack (infra/access/access-stack.yaml). The stack is applied
// by Franck only, so these tests read the template; what only AWS can prove is listed in
// infra/access/README.md.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, type Scalar, type ScalarTag, type CollectionTag, type YAMLSeq } from "yaml";

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
function secretReadGaps(t: Template, stmts: Statement[]): string[] {
  const covers = (s: Statement, a: string) => list(s.Action).some((p) => matches(p, a));
  return SECRET_READS.filter((a) => {
    const wide = stmts.some((s) => {
      if (s.Effect !== "Allow" || !covers(s, a)) return false;
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
// holds the cluster name (service/ssd-workshop-*/*).
function ecsClusterGaps(stmts: Statement[]): string[] {
  return ["ecs:RunTask", "ecs:StartTask"].filter(
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
});

describe("access stack: reads (H1)", () => {
  it("allows no read that returns secrets or full configuration on every resource", () => {
    expect(secretReadGaps(template, deployStatements(template))).toEqual([]);
    expect(secretReadGaps(template, boundaryStatements(template))).toEqual([]);
  });

  it("fails on the old account-wide reads", () => {
    const lambda = withText("              - ecs:List*\n", "              - ecs:List*\n              - lambda:List*\n");
    expect(secretReadGaps(lambda, deployStatements(lambda))).toEqual(["lambda:ListFunctions"]);
    const ecs = withText("              - ecs:List*\n", "              - ecs:Describe*\n");
    expect(secretReadGaps(ecs, deployStatements(ecs))).toContain("ecs:DescribeTaskDefinition");
    const old = withText(
      "              - cloudformation:ListStacks\n",
      "              - cloudformation:Describe*\n              - cloudformation:List*\n              - apigateway:GET\n              - iam:Get*\n              - cloudfront:Get*\n              - ses:List*\n",
    );
    expect(secretReadGaps(old, deployStatements(old))).toEqual([
      "apigateway:GET", "cloudformation:DescribeStacks", "cloudformation:ListExports",
      "iam:GetAccountAuthorizationDetails", "iam:GetRole", "iam:GetRolePolicy", "iam:GetPolicyVersion",
      "cloudfront:GetDistributionConfig", "ses:ListContacts",
    ]);
    // ec2:Describe* stays account-wide only because user data is denied outside the project tag.
    const noDeny = withText("          - Sid: NoUserDataReads\n            Effect: Deny\n", "          - Sid: NoUserDataReads\n            Effect: Allow\n");
    expect(secretReadGaps(noDeny, deployStatements(noDeny))).toEqual(["ec2:DescribeInstanceAttribute", "ec2:DescribeLaunchTemplateVersions"]);
    // VPN connections carry pre-shared keys; the SES account carries contact addresses.
    const vpn = withText("          - Sid: NoVpnKeyReads\n            Effect: Deny\n", "          - Sid: NoVpnKeyReads\n            Effect: Allow\n");
    expect(secretReadGaps(vpn, deployStatements(vpn))).toEqual(["ec2:DescribeVpnConnections"]);
    const account = withText("              - ses:GetSendQuota\n", "              - ses:GetAccount\n              - ses:GetSendQuota\n");
    expect(secretReadGaps(account, deployStatements(account))).toEqual(["ses:GetAccount"]);
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
    expect(ecsClusterGaps(deployStatements(template).filter((s) => s.Sid !== "TasksOnWorkshopClustersOnly"))).toEqual(["ecs:RunTask", "ecs:StartTask"]);
    const anyCluster = withText('ArnNotLike: {ecs:cluster: !Sub "arn:aws:ecs:*:${AWS::AccountId}:cluster/ssd-workshop-*"}', 'ArnNotLike: {ecs:cluster: !Sub "arn:aws:ecs:*:${AWS::AccountId}:cluster/*"}');
    expect(ecsClusterGaps(deployStatements(anyCluster))).toEqual(["ecs:RunTask", "ecs:StartTask"]);
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
