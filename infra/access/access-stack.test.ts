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
const DEPLOY_POLICIES = ["DeployPolicy", "DeployPolicyEdge"];
const deployStatements = (t: Template) => DEPLOY_POLICIES.flatMap((id) => statements(t, id));

// "Read" = the action name starts with Describe/List/Get/View/Validate, or apigateway:GET.
function isRead(action: string): boolean {
  if (action === "apigateway:GET") return true;
  const name = action.split(":")[1] ?? "";
  return /^(Describe|List|Get|View|Validate)/.test(name);
}

// IAM action wildcard match, case-insensitive like IAM.
function matches(pattern: string, action: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(action);
}

// A resource ARN is scoped when its resource name STARTS with ssd-workshop, after the resource
// type ("role/", "log-group:", ...). Pseudo parameters such as ${AWS::AccountId} hold "::", so
// they are replaced before the ARN is split on ':'. S3 ARNs have no type: the bucket name itself
// must start with ssd-workshop. The only prefixes allowed between type and name are the log group
// paths Lambda and ECS use, and the schedule group of a schedule.
const NAMED_RESOURCE =
  /^(?:schedule\/\*\/|log-group:(?:\/aws\/lambda\/|\/ecs\/)|[a-z][a-z-]*[/:])?ssd-workshop/i;
function isScopedArn(arn: string): boolean {
  const parts = arn.replace(/\$\{AWS::[A-Za-z]+\}/g, "PSEUDO").split(":");
  if (parts[0] !== "arn" || parts.length < 6) return false;
  const resource = parts.slice(5).join(":");
  return parts[2] === "s3" ? resource.startsWith("ssd-workshop") : NAMED_RESOURCE.test(resource);
}

// Writes that AWS cannot scope to a name or tag, keyed "Sid/action" so moving one to another
// statement needs a reviewer to look again. One line of reason each. A tag-adding action scoped
// only by aws:RequestTag can never be excused here (see unscopedWrites).
const ACTION_ALLOW_LIST: Record<string, string> = {
  "ActionsWithoutResourceScope/ecr:GetAuthorizationToken": "account-wide registry login token; repositories stay scoped by ecr:* on ssd-workshop*",
  "ActionsWithoutResourceScope/ecs:DeregisterTaskDefinition": "IAM supports only Resource * for this action; it marks a revision INACTIVE, running tasks and services keep it",
  "ActionsWithoutResourceScope/s3:ListAllMyBuckets": "account-wide listing that the S3 console and CDK need; read-only despite the name",
  "ActionsWithoutResourceScope/logs:CreateLogDelivery": "vended log deliveries (API Gateway, Step Functions) support only Resource *",
  "ActionsWithoutResourceScope/logs:DeleteLogDelivery": "vended log deliveries support only Resource *",
  "TagEventSourceMappings/lambda:TagResource": "mapping ids are generated; a tag on a mapping grants nothing, since every mapping change needs lambda:FunctionArn ssd-workshop-* (WorkshopEventSourceMappings)",
  "WorkshopServiceLinkedRoles/iam:CreateServiceLinkedRole": "limited by iam:AWSServiceName to ECS's service-linked role, whose name and rights AWS defines",
  "Bedrock/bedrock:InvokeModel": "calls Anthropic models only; no resource is changed",
  "Bedrock/bedrock:InvokeModelWithResponseStream": "calls Anthropic models only; no resource is changed",
  "SesForTesting/ses:SendEmail": "limited by condition to the sender ssd-workshop@rankly.games",
  "SesForTesting/ses:SendRawEmail": "limited by condition to the sender ssd-workshop@rankly.games",
  "CloudFrontUntaggableParts/cloudfront:*OriginAccessControl*": "origin access controls have generated ids and cannot be tagged",
  "CloudFrontUntaggableParts/cloudfront:*CachePolicy*": "cache policies have generated ids and cannot be tagged",
  "CloudFrontUntaggableParts/cloudfront:*OriginRequestPolicy*": "origin request policies have generated ids and cannot be tagged",
  "CloudFrontUntaggableParts/cloudfront:*ResponseHeadersPolicy*": "response headers policies have generated ids and cannot be tagged",
  "Ec2RunInstancesImageAndInterface/ec2:RunInstances": "AMIs are read-only inputs; the network interface RunInstances creates carries no tag, its subnet and security groups must carry the project tag (Ec2RunInstancesTaggedNetwork) and the instance itself too (Ec2CreateTagged)",
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

function scopeOf(s: Statement, t: Template): Scope {
  const c = s.Condition;
  const resources = list(s.Resource).map(text);
  const createValues = condValues(c, "StringEquals", "ec2:CreateAction");
  const creates = taggedEc2Creates(t);
  const dns = condValues(c, "ForAllValues:StringLike", "route53:ChangeResourceRecordSetsNormalizedRecordNames");
  const fnArns = condValues(c, "ArnLike", "lambda:FunctionArn").map(subText);
  return {
    names: resources.length > 0 && resources.every(isScopedArn),
    requestTag: projectTag(c, "aws:RequestTag/project"),
    resourceTag: projectTag(c, "aws:ResourceTag/project"),
    // ec2:CreateAction counts only when every value is a create that itself needs the project tag.
    createAction: createValues.length > 0 && createValues.every((v) => creates.has(String(v))),
    dns: dns.length > 0 && dns.every((n) => n === "workshop.rankly.games" || n === "*.workshop.rankly.games"),
    functionArn: fnArns.length > 0 && fnArns.every(isScopedArn),
  };
}

// Every unscoped write in the deploy policies, as "Sid/action" strings.
function unscopedWrites(t: Template): string[] {
  const found: string[] = [];
  for (const s of deployStatements(t)) {
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
      if (!(key in ACTION_ALLOW_LIST)) found.push(key);
    }
  }
  return found;
}

// The access stack's own identities: no deploy right may change them.
const PROTECTED_IDENTITIES = [
  "role/ssd-workshop-deploy",
  "user/ssd-workshop-claude",
  "policy/ssd-workshop-boundary",
  "policy/ssd-workshop-deploy",
  "policy/ssd-workshop-deploy-edge",
].map((p) => `arn:aws:iam::\${AWS::AccountId}:${p}`);
const IAM_WRITES = [
  "iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
  "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:UpdateRole", "iam:TagRole",
  "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:AttachUserPolicy",
  "iam:PutUserPolicy", "iam:CreateAccessKey", "iam:UpdateAccessKey", "iam:CreateLoginProfile",
  "iam:AddUserToGroup", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion",
  "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:TagPolicy",
];
function identityGaps(stmts: Statement[]): string[] {
  const denies = stmts.filter((s) => s.Effect === "Deny" && s.Condition === undefined);
  const denied = (arn: string, action: string) =>
    denies.some((s) => {
      const res = list(s.Resource).map(text);
      if (!res.includes(arn) && !res.includes("*")) return false;
      return s.Action !== undefined
        ? list(s.Action).some((p) => matches(p, action))
        : !list(s.NotAction).some((p) => matches(p, action));
    });
  return PROTECTED_IDENTITIES.flatMap((arn) => IAM_WRITES.filter((a) => !denied(arn, a)).map((a) => `${arn}/${a}`));
}

// Services a workshop role may be handed to (see docs/decisions.md).
const PASSED_TO = ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com", "ec2.amazonaws.com", "states.amazonaws.com", "scheduler.amazonaws.com", "events.amazonaws.com"];
function passRoleGaps(stmts: Statement[]): string[] {
  return stmts
    .filter((s) => s.Effect === "Allow" && list(s.Action).some((p) => matches(p, "iam:PassRole")))
    .filter((s) => {
      const services = condValues(s.Condition, "StringEquals", "iam:PassedToService");
      return services.length === 0 || !services.every((v) => PASSED_TO.includes(String(v)));
    })
    .map((s) => s.Sid);
}

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
    expect(unscopedWrites(template)).toEqual([]);
  });

  it("keeps every allow-list entry in use, so the list cannot hide stale exceptions", () => {
    const used = deployStatements(template).flatMap((s) => list(s.Action).map((a) => `${s.Sid}/${a}`));
    expect(Object.keys(ACTION_ALLOW_LIST).filter((k) => !used.includes(k))).toEqual([]);
  });

  it("fails when a write is loosened to Resource *", () => {
    const loose = withText(
      "Action: [s3:*, dynamodb:*",
      'Action: [s3:*]\n            Resource: "*"\n          - Sid: Rest\n            Effect: Allow\n            Action: [dynamodb:*',
    );
    expect(unscopedWrites(loose)).toContain("NamedWorkshopResources/s3:*");
  });

  it("fails on a tag-adding action scoped only by aws:RequestTag (tag takeover)", () => {
    const cloudfront = withText("Action: cloudfront:CreateDistribution\n", "Action: [cloudfront:CreateDistribution, cloudfront:TagResource]\n");
    expect(unscopedWrites(cloudfront)).toContain("CloudFrontTaggedCreate/cloudfront:TagResource");
    const acm = withText("Action: acm:RequestCertificate\n", "Action: [acm:RequestCertificate, acm:AddTagsToCertificate]\n");
    expect(unscopedWrites(acm)).toContain("CertificatesTagged/acm:AddTagsToCertificate");
    // A wildcard counts when it could match a tag-adding name (here cloudfront:CreateTags).
    const wildcard = withText("Action: cloudfront:CreateDistribution\n", "Action: cloudfront:Create*\n");
    expect(unscopedWrites(wildcard)).toContain("CloudFrontTaggedCreate/cloudfront:Create*");
    const ec2 = withText("Action: [ec2:RunInstances, ec2:CreateVpc,", "Action: [ec2:RunInstances, ec2:CreateTags, ec2:CreateVpc,");
    expect(unscopedWrites(ec2)).toContain("Ec2CreateTagged/ec2:CreateTags");
  });

  it("fails on API Gateway writes that reach every API in the region", () => {
    const region = withText(
      "            Resource:\n              - !Sub arn:aws:apigateway:${AWS::Region}::/restapis/*\n              - !Sub arn:aws:apigateway:${AWS::Region}::/apis/*\n            Condition:\n              StringEquals: {aws:ResourceTag/project: ssd-workshop}\n",
      "            Resource: !Sub arn:aws:apigateway:${AWS::Region}::/*\n",
    );
    expect(unscopedWrites(region)).toContain("ApiGatewayTaggedChange/apigateway:PATCH");
    // A request tag on a write under /restapis/* would let the role add stages to any API.
    const children = withText(
      "              - !Sub arn:aws:apigateway:${AWS::Region}::/restapis\n",
      "              - !Sub arn:aws:apigateway:${AWS::Region}::/restapis/*\n",
    );
    expect(unscopedWrites(children)).toContain("ApiGatewayTaggedCreate/apigateway:POST");
  });

  it("fails on event source mapping writes that are not tied to ssd-workshop-* functions", () => {
    const loose = withText(
      '            Condition:\n              ArnLike: {lambda:FunctionArn: !Sub "arn:aws:lambda:*:${AWS::AccountId}:function:ssd-workshop-*"}\n',
      "",
    );
    expect(unscopedWrites(loose)).toContain("WorkshopEventSourceMappings/lambda:DeleteEventSourceMapping");
    const otherFunctions = withText("function:ssd-workshop-*\"}", "function:*\"}");
    expect(unscopedWrites(otherFunctions)).toContain("WorkshopEventSourceMappings/lambda:CreateEventSourceMapping");
  });

  it("counts ec2:CreateAction as scope only for creates that need the project tag", () => {
    const loose = withText("{ec2:CreateAction: [RunInstances,", "{ec2:CreateAction: [CreateKeyPair, RunInstances,");
    expect(unscopedWrites(loose)).toContain("Ec2TagOnCreate/ec2:CreateTags");
  });

  it("fails on a change set resource of any stack", () => {
    const loose = withText(
      "            Resource: !Sub arn:aws:cloudformation:*:${AWS::AccountId}:stack/ssd-workshop-*/*\n",
      "            Resource:\n              - !Sub arn:aws:cloudformation:*:${AWS::AccountId}:stack/ssd-workshop-*/*\n              - !Sub arn:aws:cloudformation:*:${AWS::AccountId}:changeSet/*\n",
    );
    expect(unscopedWrites(loose)).toContain("WorkshopStacks/cloudformation:*");
  });

  it("limits service-linked roles to the services the workshop uses", () => {
    const slr = deployStatements(template).find((s) => s.Sid === "WorkshopServiceLinkedRoles");
    expect(slr?.Condition).toEqual({ StringEquals: { "iam:AWSServiceName": "ecs.amazonaws.com" } });
  });

  it("accepts only ARNs whose resource name starts with ssd-workshop", () => {
    const account = "${AWS::AccountId}";
    for (const arn of [
      `arn:aws:iam::${account}:role/ssd-workshop-*`,
      "arn:aws:s3:::ssd-workshop-*",
      `arn:aws:logs:*:${account}:log-group:ssd-workshop-*`,
      `arn:aws:logs:*:${account}:log-group:/aws/lambda/ssd-workshop-*`,
      `arn:aws:logs:*:${account}:log-group:/ecs/ssd-workshop-*`,
      `arn:aws:scheduler:*:${account}:schedule/*/ssd-workshop-*`,
      `arn:aws:ecs:*:${account}:task-definition/ssd-workshop*:*`,
      `arn:aws:cloudformation:*:${account}:stack/ssd-workshop-*/*`,
    ]) expect(isScopedArn(arn), arn).toBe(true);
    for (const arn of [
      `arn:aws:iam::${account}:role/*ssd-workshop*`,
      "arn:aws:s3:::bucket*ssd-workshop*",
      "arn:aws:s3:::other-bucket/ssd-workshop-*",
      `arn:aws:logs:*:${account}:log-group:*ssd-workshop*`,
      `arn:aws:logs:*:${account}:log-group:/other/ssd-workshop-*`,
      `arn:aws:iam::${account}:role/*/ssd-workshop-*`,
      `arn:aws:cloudformation:*:${account}:changeSet/*`,
      "*",
    ]) expect(isScopedArn(arn), arn).toBe(false);
  });

  it("classifies reads", () => {
    expect(isRead("ec2:Describe*")).toBe(true);
    expect(isRead("apigateway:GET")).toBe(true);
    expect(isRead("cloudformation:*")).toBe(false);
    expect(isRead("s3:ListAllMyBuckets")).toBe(true);
  });

  it("keeps each managed policy under IAM's 6,144-character limit", () => {
    for (const id of ["BoundaryPolicy", ...DEPLOY_POLICIES]) expect(policySize(template, id), id).toBeLessThanOrEqual(6144);
  });
});

describe("access stack: self-protection (criterion 3)", () => {
  const deny = deployStatements(template).find((s) => s.Sid === "ProtectThisStack");

  it("explicitly denies stack updates, deletes and change sets on ssd-workshop-access", () => {
    expect(deny?.Effect).toBe("Deny");
    expect(list(deny?.Resource).map(text)).toEqual([
      "arn:aws:cloudformation:*:${AWS::AccountId}:stack/ssd-workshop-access/*",
    ]);
    const denied = (action: string) =>
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
      expect(denied(a), a).toBe(true);
    }
  });

  it("puts the deny in a policy that both the deploy role and the Claude user carry", () => {
    expect(statements(template, "DeployPolicy")).toContain(deny);
    for (const id of ["DeployRole", "ClaudeUser"]) {
      expect(template.Resources[id]?.Properties.ManagedPolicyArns, id).toEqual([
        { Ref: "DeployPolicy" },
        { Ref: "DeployPolicyEdge" },
      ]);
    }
  });

  it("explicitly denies IAM writes on the deploy role, the Claude user and the three managed policies", () => {
    expect(identityGaps(deployStatements(template))).toEqual([]);
    // Old pattern: without the deny, role/ssd-workshop-* housekeeping reached the deploy role.
    const without = deployStatements(template).filter((s) => s.Sid !== "ProtectAccessIdentities");
    expect(identityGaps(without)).toContain("arn:aws:iam::${AWS::AccountId}:role/ssd-workshop-deploy/iam:UpdateAssumeRolePolicy");
    expect(identityGaps(without)).toContain("arn:aws:iam::${AWS::AccountId}:role/ssd-workshop-deploy/iam:PassRole");
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
    const denies = deployStatements(template).filter((s) => s.Effect === "Deny" && s.Condition === undefined);
    for (const a of ["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary"]) {
      const hit = denies.find((s) => s.Action !== undefined && list(s.Action).some((p) => matches(p, a)));
      expect(hit && list(hit.Resource).map(text), a).toEqual(["*"]);
    }
  });

  it("names every boundary resource with an ssd-workshop prefix", () => {
    const loose = statements(template, "BoundaryPolicy")
      .filter((s) => s.Sid === "WorkshopData")
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
    const sizes = Object.fromEntries(["BoundaryPolicy", ...DEPLOY_POLICIES].map((id) => [id, policySize(template, id)]));
    console.log(`policy sizes (limit 6144): ${JSON.stringify(sizes)}`);
    expect(Object.keys(sizes)).toHaveLength(3);
  });
});
