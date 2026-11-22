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
  `ssd-workshop-cdk-assets-*` bucket for stacks with file assets. It also uploads the template
  there, so asset-free stacks in another region (or the one creating the bucket) use
  `LegacyStackSynthesizer` (inline template) and must keep no file assets.
- Never use `crossRegionReferences`: it writes SSM `/cdk/exports/*` through a Lambda the boundary
  forbids. Look resources up by fixed name instead.
- CDK constructs that bring their own Lambda (BucketDeployment, custom resources) need explicit
  `ssd-workshop-*` names on the function, role and layer (escape hatch): CloudFormation names a
  layer after its logical id, outside the deploy policy.
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
  CloudFront logging bucket), S3 server access logging, inventory, analytics export, replication
  and (deploy principals only) bucket notifications, Lambda function URLs, resource policies on
  secrets, repositories, tables, parameters and log groups, DynamoDB exports, log subscription
  filters and log export tasks, SNS subscriptions other than workshop Lambda functions and queues,
  EventBridge targets outside the account, and Lambda invoke permissions for principals other than
  API Gateway, EventBridge, SNS and S3. The boundary carries the same sharing denies (except bucket
  notifications, which CDK's notifications handler needs), so workload roles cannot share either.
- Lambda permissions for a service principal: always set `sourceArn` (or at least
  `sourceAccount`) in CDK (`addPermission`, `grantInvoke`); IAM cannot require it, and without it
  another account's API, rule, topic or bucket could invoke the function.
- An `aws:RequestTag` condition is true for every resource a call names, also the existing ones it
  only refers to. Never put a parent ARN type (or `Resource "*"`) next to a create under a
  request tag alone: list per action only the ARN types it creates (AWS Service Authorization
  Reference, machine-readable at
  `servicereference.us-east-1.amazonaws.com/v1/<service>/<service>.json`), and require
  `aws:ResourceTag/project` on the parents (VPC, subnet, security group, route table, Elastic IP,
  network interface, launch template). The test's `EC2_PARENTS` table must name every EC2 create.
- EC2: `RunInstances` takes only project-tagged network interfaces, and a network interface that
  `RunInstances` creates itself has no resource tag yet: create the k3s node's interface first
  (`CfnNetworkInterface` with the project tag) and pass its id in the launch template. Volumes
  from snapshots are denied. k3s nodes use IMDSv2 with hop limit 1, so pods cannot reach the node
  role.
- ECS tasks run only on `ssd-workshop-*` clusters (`ecs:cluster` deny); service ARNs hold the
  cluster name, so services are limited the same way.
- EventBridge rules must name an event source `ssd-workshop.*` (deny on `events:source`, and on
  a pattern without a source). Schedules use EventBridge Scheduler (`scheduler:*` on
  `ssd-workshop-*`), not schedule rules; AWS service events such as ECS task state changes are
  not available as rules (poll `DescribeTasks` or use Step Functions `.sync` instead).
- Tagging during create: CloudFront distributions and ACM certificates are tagged by CloudFormation in the create call (`TagOnCreateThroughCloudFormation`, requires `aws:CalledVia` CloudFormation and no project tag yet). Create them only through CloudFormation, never with a direct SDK call. CloudFormation resource import is denied.
- ACM certificates only for `workshop.rankly.games` and `*.workshop.rankly.games`
  (`acm:DomainNames`).
- SES sends only through the identities `ssd-workshop@rankly.games` and `rankly.games`, from
  `ssd-workshop@rankly.games`.
- GitHub OIDC: the role trusts `refs/heads/main`, which also matches `pull_request_target`,
  `workflow_run`, `issue_comment` and `schedule` jobs on `main`. Only `.github/workflows/deploy.yml`
  may request `id-token: write` (never `write-all`), and it runs only on `push` to `main`
  (tested). Follow-up: a custom OIDC subject with `job_workflow_ref`.
- The access stack has five managed policies (the boundary and the deploy policies
  `ssd-workshop-deploy`, `-edge`, `-ec2`, `-read`), each at most 6,144 characters minified
  (tested). A new deploy policy must be attached to both the deploy role and the Claude user and
  listed in `ProtectAccessIdentities`.
- `ecs:DescribeTaskDefinition` (Resource `*` only) and `ec2:DescribeLaunchTemplateVersions` are not
  available: the first ticket that deploys an ECS task definition or an EC2 launch template brings
  this to Franck before building.
- EC2: only Amazon-owned AMIs (`ec2:Owner` `amazon`, e.g. Amazon Linux 2023); tag specifications
  cover the instance and its volumes.
- Custom CloudWatch metrics use the namespace `ssd-workshop`.
- Reads of other projects' configuration are not granted (Lambda environments, task definitions,
  other stacks' outputs, other APIs and distributions): name the workshop resource when reading.
- CDK generates names for some resources that take no name by default (e.g. the Origin Access
  Control of `S3BucketOrigin.withOriginAccessControl`): pass an explicitly named construct. The
  names test checks every `*Name` key at any depth.
- `RemovalPolicy.RETAIN` also applies when a failed first create rolls back: the retained resource
  (bucket, origin access control) stays, and the retry fails on its fixed name until it is deleted
  or renamed.
