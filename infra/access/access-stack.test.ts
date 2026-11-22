// Static checks of the access stack (infra/access/access-stack.yaml). The stack is applied
// by Franck only, so these tests read the template; what only AWS can prove is listed in
// infra/access/README.md.
import { readFileSync } from "node:fs";
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
const DEPLOY_POLICIES = ["DeployPolicy", "DeployPolicyEdge", "DeployPolicyRead"];
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
  "SesForTesting/ses:SendEmail": "limited by condition to the sender ssd-workshop@rankly.games",
  "SesForTesting/ses:SendRawEmail": "limited by condition to the sender ssd-workshop@rankly.games",
};
// The boundary's own exceptions (same rules as the deploy policies).
const BOUNDARY_ALLOW_LIST: Record<string, string> = {
  "Bedrock/bedrock:InvokeModel": "calls Anthropic models only; no resource is changed",
  "Bedrock/bedrock:InvokeModelWithResponseStream": "calls Anthropic models only; no resource is changed",
  "SendCodes/ses:SendEmail": "limited by condition to the sender ssd-workshop@rankly.games",
  "SendCodes/ses:SendRawEmail": "limited by condition to the sender ssd-workshop@rankly.games",
  "AccountWideServiceCalls/ecr:GetAuthorizationToken": "account-wide registry login token; image pulls stay scoped to ssd-workshop-* repositories",
  "AccountWideServiceCalls/xray:PutTraceSegments": "X-Ray has no resource scope; writes trace data only",
  "WorkshopMetrics/cloudwatch:PutMetricData": "limited by cloudwatch:namespace to ssd-workshop",
  "K3sNodeChannels/ssmmessages:*": "Session Manager channels of the calling instance; no resource scope exists",
  "K3sNodeChannels/ec2messages:*": "Run Command channel of the calling instance; no resource scope exists",
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
      if (requestTagOnly) {
        // A tag in the request says nothing about the resource being tagged: with only
        // aws:RequestTag, the role could tag ANY existing resource and then change it through
        // the ResourceTag statements. Same for API Gateway writes under existing APIs.
        if (addsTags(a) || (a.startsWith("apigateway:") && wildcardResource)) found.push(key);
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
// origin headers, contact addresses). None may be allowed account-wide unless an explicit deny
// keeps it to the project tag.
const SECRET_READS = [
  "lambda:ListFunctions", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
  "ecs:DescribeTaskDefinition", "apigateway:GET",
  "cloudformation:DescribeStacks", "cloudformation:GetTemplate", "cloudformation:ListExports",
  "ec2:DescribeInstanceAttribute", "ec2:DescribeLaunchTemplateVersions",
  "iam:GetAccountAuthorizationDetails", "iam:GetRole", "iam:GetRolePolicy", "iam:GetPolicyVersion",
  "secretsmanager:GetSecretValue", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
  "cloudfront:GetDistributionConfig", "ses:ListContacts", "ses:GetContact",
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

// ec2:RunInstances: images only with ec2:Owner amazon; network interfaces only new with the
// project request tag or existing with the project resource tag.
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
    if (res.some((r) => matches(r, SAMPLE_ENI)) && !(sc.requestTag || sc.resourceTag)) gaps.push(`${s.Sid}/network-interface`);
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
  "logs:PutResourcePolicy", "logs:PutSubscriptionFilter",
];
const conditionalDeny = (stmts: Statement[], action: string, op: string, key: string) =>
  stmts.find((s) => s.Effect === "Deny" && list(s.Action).includes(action) && condValues(s.Condition, op, key).length > 0);

// Policy size as IAM counts it: minified JSON with the Sub values filled in.
const SAMPLE: Record<string, string> = {
  "AWS::AccountId": "123456789012",
  "AWS::Region": "eu-central-1",
  HostedZoneId: "Z".repeat(32),
  GitHubRepo: "kifbv/ssd-workshop",
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

const template = loadTemplate();

describe("access stack: deploy policies (criterion 2)", () => {
  it("limits every write to ssd-workshop-* names, the project tag, workshop DNS, or a listed exception", () => {
    expect(deployGaps(template)).toEqual([]);
  });

  it("keeps every allow-list entry in use, so the lists cannot hide stale exceptions", () => {
    const used = (stmts: Statement[]) => stmts.flatMap((s) => list(s.Action).map((a) => `${s.Sid}/${a}`));
    expect(Object.keys(DEPLOY_EXCEPTIONS).filter((k) => !used(deployStatements(template)).includes(k))).toEqual([]);
    expect(Object.keys(BOUNDARY_ALLOW_LIST).filter((k) => !used(boundaryStatements(template)).includes(k))).toEqual([]);
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
    expect(deployGaps(ec2)).toContain("Ec2CreateTagged/ec2:CreateTags");
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

describe("access stack: EC2 instances (H3)", () => {
  it("starts instances only from Amazon-owned images and with project network interfaces", () => {
    expect(runInstancesGaps(template)).toEqual([]);
    const anyImage = withText("              StringEquals: {ec2:Owner: amazon}\n", "              StringEquals: {ec2:Owner: aws-marketplace}\n");
    expect(runInstancesGaps(anyImage)).toEqual(["Ec2RunInstancesAmazonImages/image"]);
    // Old pattern: RunInstances on "*" with only a request tag, and image/interface unconditioned.
    const old = withText("Action: [ec2:CreateVpc,", "Action: [ec2:RunInstances, ec2:CreateVpc,");
    expect(runInstancesGaps(old)).toEqual(["Ec2CreateTagged/image"]);
    const oldInterface = withText(
      "            Resource: arn:aws:ec2:*::image/*\n            Condition:\n              StringEquals: {ec2:Owner: amazon}\n",
      "            Resource:\n              - arn:aws:ec2:*::image/*\n              - !Sub arn:aws:ec2:*:${AWS::AccountId}:network-interface/*\n",
    );
    expect(runInstancesGaps(oldInterface)).toEqual(["Ec2RunInstancesAmazonImages/image", "Ec2RunInstancesAmazonImages/network-interface"]);
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

  it("attaches the same three deploy policies to the deploy role and the Claude user", () => {
    expect(statements(template, "DeployPolicy")).toContain(deny);
    for (const id of ["DeployRole", "ClaudeUser"]) {
      expect(template.Resources[id]?.Properties.ManagedPolicyArns, id).toEqual(DEPLOY_POLICIES.map((p) => ({ Ref: p })));
    }
    expect(DEPLOY_POLICIES.map((id) => template.Resources[id]?.Properties.ManagedPolicyName)).toEqual([
      "ssd-workshop-deploy", "ssd-workshop-deploy-edge", "ssd-workshop-deploy-read",
    ]);
  });

  it("explicitly denies IAM writes on the deploy role, the Claude user and the four managed policies", () => {
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
    expect(template.Parameters.GitHubRepo?.Default).toBe("kifbv/ssd-workshop");
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
    expect(Object.keys(sizes)).toHaveLength(4);
  });
});
