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
interface Statement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: unknown;
  Resource?: Value | Value[];
  NotResource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
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
function loadTemplate(text = readFileSync(templatePath, "utf8")): Template {
  return parse(text, { customTags: cfnTags }) as Template;
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

// A resource ARN is scoped when its resource part (after the fifth ':') names ssd-workshop.
const isScopedArn = (arn: string) => /ssd-workshop/.test(arn.split(":").slice(5).join(":"));

// Resources that are not ssd-workshop-* names but are safe for the listed reason.
const RESOURCE_EXCEPTIONS: Record<string, string> = {
  "WorkshopStacks/arn:aws:cloudformation:*:${AWS::AccountId}:changeSet/*":
    "change set actions (Create/Execute/Delete/Describe) authorize against the stack ARN, so this only reaches change sets of ssd-workshop-* stacks",
};

// Writes that AWS cannot scope to a name or tag, keyed "Sid/action" so moving one to another
// statement needs a reviewer to look again. One line of reason each.
const ACTION_ALLOW_LIST: Record<string, string> = {
  "ActionsWithoutResourceScope/ecr:GetAuthorizationToken": "account-wide registry login token; repositories stay scoped by ecr:* on ssd-workshop*",
  "ActionsWithoutResourceScope/ecs:RegisterTaskDefinition": "IAM supports only Resource * for this action",
  "ActionsWithoutResourceScope/ecs:DeregisterTaskDefinition": "IAM supports only Resource * for this action",
  "ActionsWithoutResourceScope/ecs:CreateCluster": "no resource-level scope on create; every later cluster change is scoped to cluster/ssd-workshop*",
  "ActionsWithoutResourceScope/lambda:CreateEventSourceMapping": "event source mappings have generated ids; the function and queue are ssd-workshop-*",
  "ActionsWithoutResourceScope/lambda:DeleteEventSourceMapping": "event source mappings have generated ids, not names",
  "ActionsWithoutResourceScope/lambda:UpdateEventSourceMapping": "event source mappings have generated ids, not names",
  "ActionsWithoutResourceScope/lambda:TagResource": "CloudFormation tags event source mappings, which have generated ids",
  "ActionsWithoutResourceScope/s3:ListAllMyBuckets": "account-wide listing that the S3 console and CDK need; read-only despite the name",
  "ActionsWithoutResourceScope/logs:CreateLogDelivery": "vended log deliveries (API Gateway, Step Functions) support only Resource *",
  "ActionsWithoutResourceScope/logs:DeleteLogDelivery": "vended log deliveries support only Resource *",
  "ActionsWithoutResourceScope/scheduler:CreateScheduleGroup": "schedules are scoped to ssd-workshop-* names; the group create has no name scope here",
  "ApiGatewayInRegion/apigateway:POST": "API Gateway ids are generated; limited to eu-central-1",
  "ApiGatewayInRegion/apigateway:PUT": "API Gateway ids are generated; limited to eu-central-1",
  "ApiGatewayInRegion/apigateway:PATCH": "API Gateway ids are generated; limited to eu-central-1",
  "ApiGatewayInRegion/apigateway:DELETE": "API Gateway ids are generated; limited to eu-central-1",
  "WorkshopServiceLinkedRoles/iam:CreateServiceLinkedRole": "service-linked roles have AWS-defined names and AWS-defined rights; creating one only enables a service",
  "Bedrock/bedrock:InvokeModel": "calls Anthropic models only; no resource is changed",
  "Bedrock/bedrock:InvokeModelWithResponseStream": "calls Anthropic models only; no resource is changed",
  "SesForTesting/ses:SendEmail": "limited by condition to the sender ssd-workshop@rankly.games",
  "SesForTesting/ses:SendRawEmail": "limited by condition to the sender ssd-workshop@rankly.games",
  "CloudFrontUntaggableParts/cloudfront:*OriginAccessControl*": "origin access controls have generated ids and cannot be tagged",
  "CloudFrontUntaggableParts/cloudfront:*CachePolicy*": "cache policies have generated ids and cannot be tagged",
  "CloudFrontUntaggableParts/cloudfront:*OriginRequestPolicy*": "origin request policies have generated ids and cannot be tagged",
  "CloudFrontUntaggableParts/cloudfront:*ResponseHeadersPolicy*": "response headers policies have generated ids and cannot be tagged",
  "Ec2RunInstancesSupportingResources/ec2:RunInstances": "RunInstances also authorizes the AMI, subnet, ENI, security group, key pair and launch template it uses; the instance itself needs the project tag (Ec2CreateTagged)",
};

type Cond = Record<string, Record<string, unknown>>;
const condValues = (c: Cond | undefined, op: string, key: string) => list(c?.[op]?.[key] as unknown);

// The statement's condition limits it to the workshop: project tag, tag-on-create, or DNS names.
function scopedByCondition(c: Cond | undefined): boolean {
  const tag = ["aws:RequestTag/project", "aws:ResourceTag/project"].some((k) => {
    const v = condValues(c, "StringEquals", k);
    return v.length === 1 && v[0] === "ssd-workshop";
  });
  const createAction = condValues(c, "StringEquals", "ec2:CreateAction").length > 0;
  const dns = condValues(c, "ForAllValues:StringLike", "route53:ChangeResourceRecordSetsNormalizedRecordNames");
  const dnsOk = dns.length > 0 && dns.every((n) => n === "workshop.rankly.games" || n === "*.workshop.rankly.games");
  return tag || createAction || dnsOk;
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
    const writes = list(s.Action).filter((a) => !isRead(a));
    if (writes.length === 0 || scopedByCondition(s.Condition)) continue;
    const resourcesScoped = list(s.Resource)
      .map(text)
      .every((r) => isScopedArn(r) || `${s.Sid}/${r}` in RESOURCE_EXCEPTIONS);
    if (resourcesScoped) continue;
    for (const a of writes) if (!(`${s.Sid}/${a}` in ACTION_ALLOW_LIST)) found.push(`${s.Sid}/${a}`);
  }
  return found;
}

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
    const loose = readFileSync(templatePath, "utf8").replace(
      "Action: [s3:*, dynamodb:*",
      'Action: [s3:*]\n            Resource: "*"\n          - Sid: Rest\n            Effect: Allow\n            Action: [dynamodb:*',
    );
    expect(unscopedWrites(loadTemplate(loose))).toContain("NamedWorkshopResources/s3:*");
  });

  it("classifies reads", () => {
    expect(isRead("ec2:Describe*")).toBe(true);
    expect(isRead("apigateway:GET")).toBe(true);
    expect(isRead("cloudformation:*")).toBe(false);
    expect(isRead("s3:ListAllMyBuckets")).toBe(true);
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
        : !list(deny?.NotAction as string | string[]).some((p) => matches(p, action));
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
      const hit = denies.find((s) => list(s.Action).some((p) => matches(p, a)));
      expect(hit && list(hit.Resource).map(text), a).toEqual(["*"]);
    }
  });
});

describe("access stack: deploy role trust", () => {
  it("trusts only GitHub Actions of kifbv/ssd-workshop on main or a GitHub environment", () => {
    expect(template.Parameters.GitHubRepo?.Default).toBe("kifbv/ssd-workshop");
    const trust = template.Resources.DeployRole?.Properties.AssumeRolePolicyDocument as { Statement: Statement[] };
    expect(trust.Statement).toHaveLength(1);
    const [s] = trust.Statement;
    expect(s).toMatchObject({ Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity" });
    expect(s?.Condition).toEqual({
      StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      StringLike: {
        "token.actions.githubusercontent.com:sub": [
          { "Fn::Sub": "repo:${GitHubRepo}:ref:refs/heads/main" },
          { "Fn::Sub": "repo:${GitHubRepo}:environment:*" },
        ],
      },
    });
  });
});
