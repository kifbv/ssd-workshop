---
paths:
  - "infra/**"
---

# Infrastructure rules

- Never deploy from a session: no `cdk deploy`, `cdk destroy`, `cdk bootstrap` or CloudFormation
  writes. Workshop stacks deploy only from `main` (ticket 0.5).
- `infra/access/access-stack.yaml` is applied by Franck only, never by CI or a session.
- Every resource is named `ssd-workshop-*` (with the dash: `ssd-workshop*` is never used, in
  names or in policies) and tagged `project=ssd-workshop`.
- Every IAM role and instance profile uses the path `/ssd-workshop/` (CDK `path: "/ssd-workshop/"`
  on `Role` and `InstanceProfile`) and every role carries the `ssd-workshop-boundary` permissions
  boundary: the deploy rights reach only `role/ssd-workshop/*`, which keeps the deploy role (path
  `/`) out of reach. Roles that CDK constructs create for you (`BucketDeployment`, custom-resource
  providers, which emit a raw `AWS::IAM::Role`) default to path `/`: set `Path` and
  `PermissionsBoundary` on every `AWS::IAM::Role` with an Aspect, and test it on the synth output.
- Region `eu-central-1`; only CloudFront certificates live in `us-east-1`.
- DNS: only the `workshop.rankly.games` record and its certificate validation records may change.
- No account-wide CDK bootstrap: use `CliCredentialsStackSynthesizer` with the
  `ssd-workshop-cdk-assets-*` bucket.
- A new paid AWS service or a cost estimate above $50/month is a Stop-and-ask case.
- `cdk synth` fails with "This app contains no stacks" on an empty app; keep at least one stack.
- aws-cdk-lib types break `exactOptionalPropertyTypes` (e.g. passing a synthesizer): assert to the
  CDK interface at the call site (`as IStackSynthesizer`); never turn the flag off.
- Give every named resource an explicit name starting `ssd-workshop-` (CloudFront functions, ECS
  clusters and task definition families, schedule groups, ...): CDK's generated names drop the
  dashes (`ssdworkshopsite...`), which the access policy refuses.
- CDK `crossRegionReferences` writes SSM parameters under `/cdk/exports/...`, outside the allowed
  `/ssd-workshop/*`: pass the us-east-1 certificate another way (e.g. a fixed parameter under
  `/ssd-workshop/`).
- API Gateway: CDK's `RestApi` creates an account-wide CloudWatch role (`PATCH /account`) unless
  `cloudWatchRole: false`; the access policy refuses it. The deploy job uses no GitHub environment
  (the role trusts only `refs/heads/main`).
- CloudFront: use AWS-managed cache and response-headers policies (`CachePolicy.CACHING_OPTIMIZED`,
  `ResponseHeadersPolicy.SECURITY_HEADERS`, ...). Origin access controls and custom policies have no
  tags, so the deploy rights can only create them: give them `RemovalPolicy.RETAIN`, and changing
  or deleting one needs Franck (or a replacement under a new name).
- The access stack denies, for both principals: S3 ACLs (keep `BucketOwnerEnforced`, no legacy
  CloudFront logging bucket), Lambda function URLs, resource policies on secrets, repositories,
  tables, parameters and log groups, DynamoDB exports, log subscription filters, SNS subscriptions
  other than workshop Lambda functions and queues, EventBridge targets outside the account, and
  Lambda invoke permissions for principals other than API Gateway, EventBridge, SNS and S3.
- `ecs:DescribeTaskDefinition` (Resource `*` only) and `ec2:DescribeLaunchTemplateVersions` are not
  available: the first ticket that deploys an ECS task definition or an EC2 launch template brings
  this to Franck before building.
- EC2: only Amazon-owned AMIs (`ec2:Owner` `amazon`, e.g. Amazon Linux 2023); tag specifications
  cover the instance, its volumes and its network interfaces.
- Custom CloudWatch metrics use the namespace `ssd-workshop`.
- Reads of other projects' configuration are not granted (Lambda environments, task definitions,
  other stacks' outputs, other APIs and distributions): name the workshop resource when reading.
