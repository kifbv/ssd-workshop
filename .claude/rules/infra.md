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
  cluster name, so services are limited the same way. `ecs:subnet` exists only on CreateService,
  UpdateService, CreateExpressGatewayService and UpdateExpressGatewayService; all four are pinned to
  `BUILDS_SUBNET_IDS`, and the test's `ECS_SUBNET_ACTIONS` must list every action with the key.
  `RunTask` and `StartTask` have no subnet key, so IAM cannot pin a task to subnets: the launcher
  must name the two subnets itself. `StartTask` is denied, and under the boundary only the role
  `ssd-workshop-builds-launcher` may `RunTask` (`aws:PrincipalArn`). Before relying on a condition
  key, check that the action lists it in
  `servicereference.us-east-1.amazonaws.com/v1/<service>/<service>.json`: a negated operator on a
  key the action never carries denies every call, a `ForAnyValue` one denies none.
- EventBridge rules must name an event source `ssd-workshop.*` (deny on `events:source`, and on
  a pattern without a source). Schedules use EventBridge Scheduler (`scheduler:*` on
  `ssd-workshop-*`), not schedule rules; AWS service events such as ECS task state changes are
  not available as rules. Tasks are started only by the launcher Lambda's role and watched by
  polling `DescribeTasks` (a Step Functions or Scheduler role starting tasks would be refused).
- Tagging during create: CloudFront distributions and ACM certificates are tagged by CloudFormation in the create call (`TagOnCreateThroughCloudFormation`, requires `aws:CalledVia` CloudFormation and no project tag yet). Create them only through CloudFormation, never with a direct SDK call. CloudFormation resource import is denied.
- ACM certificates only for `workshop.rankly.games` and `*.workshop.rankly.games`
  (`acm:DomainNames`). CloudFormation calls `RequestCertificate` without tags and adds them with
  `AddTagsToCertificate` afterwards, so a request-tag condition alone refuses it
  (`CertificatesThroughCloudFormation`).
- SES sends only through the identities `ssd-workshop@rankly.games` and `rankly.games`, from
  `ssd-workshop@rankly.games`, and every send names the configuration set `ssd-workshop-email`
  (`ConfigurationSetName`): without it SES uses the domain's default set `rankly-dev` (another
  project's), which is refused.
- IAM roles on a path: before CreateRole, CloudFormation calls `iam:GetRole` by name, and for a
  role that does not exist yet IAM checks `role/<name>` without the path. The access stack
  therefore allows `iam:GetRole` (read only) on `role/ssd-workshop-*` as well as `role/ssd-workshop/*`.
- GitHub OIDC: GitHub sends this repository's subject in the ID form
  `repo:kifbv@7999713/ssd-workshop@1467373954:ref:refs/heads/main`, not `repo:kifbv/ssd-workshop:...`;
  check CloudTrail's `AssumeRoleWithWebIdentity` `userName` when a trust condition fails.
  The role trusts `refs/heads/main`, which also matches `pull_request_target`,
  `workflow_run`, `issue_comment` and `schedule` jobs on `main`. Only `.github/workflows/deploy.yml`
  may request `id-token: write` (never `write-all`), and it runs only on `push` to `main`
  (tested). Follow-up: a custom OIDC subject with `job_workflow_ref`.
- The access stack has five managed policies (the boundary and the deploy policies
  `ssd-workshop-deploy`, `-edge`, `-ec2`, `-read`), each at most 6,144 characters minified
  (tested). A new deploy policy must be attached to both the deploy role and the Claude user and
  listed in `ProtectAccessIdentities`.
- A secret only Franck and one workload role may read (the GitHub App's key, ticket 2.6): deny the deploy principals
  everything on it but create/describe/tag with a `NotAction` list (`NoGitHubKey`, new AWS actions denied too), AND
  deny its read in the boundary to every role but that one (`GitHubKeyForTheLauncherOnly`), and deny the Claude user
  every write to (and invoke of) that role, its function and the CDK assets bucket (`NoLauncherForSessions`), and deny
  every workload role everything but reads on the assets bucket and its objects (`NoDeployAssetWrites`): otherwise a session creates or borrows the reader
  role, or plants its code directly or through a role it creates. Deploys from `main` stay trusted. Load the value only
  after Franck applied all four.
  `ssd-workshop-deploy` is too close to the 6,144-character limit: new denies go in another deploy policy both
  principals carry.
- `ec2:DescribeLaunchTemplateVersions` is not available: the first ticket that deploys an EC2 launch
  template brings this to Franck before building. `ecs:DescribeTaskDefinition` (Resource `*` only) is
  granted to the deploy principals since ticket 2.2 (accepted risk 15), never in the boundary.
- EC2: only Amazon-owned AMIs (`ec2:Owner` `amazon`, e.g. Amazon Linux 2023); tag specifications
  cover the instance and its volumes.
- Custom CloudWatch metrics use the namespace `ssd-workshop`.
- Reads of other projects' configuration are not granted (Lambda environments, other stacks' outputs,
  other APIs and distributions; task definitions are the one accepted exception, risk 15): name the
  workshop resource when reading.
- CDK generates names for some resources that take no name by default (e.g. the Origin Access
  Control of `S3BucketOrigin.withOriginAccessControl`): pass an explicitly named construct. The
  names test checks every `*Name` key at any depth.
- `RemovalPolicy.RETAIN` also applies when a failed first create rolls back: the retained resource
  (bucket, origin access control) stays, and the retry fails on its fixed name until it is deleted
  or renamed.
- The deploy workflow must never use `environment:`: it changes the OIDC subject to
  `repo:<owner>/<repo>:environment:<name>`, which the deploy role does not trust.
- The deploy workflow reads the role ARN and region from `infra/lib/config.ts` (through
  `infra/bin/print-deploy-settings.ts`); never hard-code the account id in a workflow.
- Only `deploy.yml` may ask for `id-token: write`; `ci.yml` runs on pull requests and gets no
  AWS access (tested).
- Lambda code: `NodejsFunction` bundles locally with esbuild (an `infra` dev dependency; no
  Docker) from `platform/api/handlers/`. Give each function its own named role and named log
  group (`logGroup` prop), and put the stack on `assetsBucketSynthesizer()`. API Gateway v2
  (`AWS::ApiGatewayV2::Api`, `::Stage`) takes `Tags` as a JSON map, not a list.
- API Gateway v2 through CloudFormation also calls the tags endpoint (`apigateway:POST` on
  `/tags/<url-encoded ARN>`) when it creates a tagged API or stage; the access stack allows it only
  via CloudFormation (`ApiGatewayTagOnCreateThroughCloudFormation`). A new service whose
  CloudFormation handler tags in a separate call needs the same check before its first deploy.
  A tagged stage is also checked as `apigateway:TagResource` (an action missing from the Service
  Authorization Reference) on `/apis/<id>/stages` (`ApiGatewayTagStagesOnCreate`): AWS error
  messages, not the reference, are the source of truth for tag-on-create actions.
- CloudFront behaviours that take writes (`/api/*`): viewer protocol `HTTPS_ONLY`, never
  `REDIRECT_TO_HTTPS` (a redirect turns POST into GET). A value from another region's stack
  (the API id for the us-east-1 edge stack) is a constant in `config.ts`; recreating that
  resource means updating the constant.
- `NodejsFunction` on Node 18+ runtimes leaves `@aws-sdk/*` out of the bundle by default (the runtime's
  copy is used): set `bundling.externalModules: []` so the function runs the tested SDK version and the
  synth test can `require` the bundle on its own.
- IAM cannot condition on a DynamoDB sort key: a role limited to a partition (`dynamodb:LeadingKeys`) can still
  write any item in it. Limit PutItem's attribute names (`dynamodb:Attributes`) and make readers require an
  attribute that role cannot write. A PutItem still replaces a whole item, so such a role can overwrite another
  item of the partition with only the allowed attributes (sign-in: an `ALLOW` entry, taking that person off the
  list, a denial of service, never added rights); when that matters, give the role its own partition (`CODE#`).
- `HttpLambdaIntegration` writes a route's path into the Lambda permission's source ARN as is, so a path
  parameter route (`/api/participants/{id}`) gets a literal `{id}`. Unverified until a deployed request
  proves it: whether API Gateway's invoke ARN for such a route matches that literal `{id}` (and works) or
  not. Until then, for a function behind such a route use `scopePermissionToRoute: false` (one permission,
  `<api id>/*/*/*`, still this API only), which works either way.
- DynamoDB `TransactWriteItems` has no IAM action of its own: each item is authorized as `PutItem`,
  `UpdateItem`, `DeleteItem` or `ConditionCheckItem`, with its own `LeadingKeys`/`Attributes` conditions.
  Under a `dynamodb:Attributes` list, return only `UPDATED_NEW`/`UPDATED_OLD`/`NONE` (`ALL_NEW` could
  return attributes outside it; enforce it with `StringEqualsIfExists` `dynamodb:ReturnValues`
  [`ATTRIBUTE_LIMITED_RETURN_VALUES`], ticket 2.5), and list `pk`/`sk` plus every name an expression uses, conditions included.
- A custom CloudFront policy (the pages' `ssd-workshop-pages-v1` response headers policy, ticket 1.6) can be created but
  never updated: a change to any of its settings must bump `PAGES_HEADERS_POLICY_VERSION`, which changes the name
  and the logical id (a new name alone is an in-place update), or the deploy fails on `UpdateResponseHeadersPolicy`.
- The site stack builds the pages (`buildWeb`, esbuild) at synth time into `cdk.out/ssd-workshop-web` and uploads that
  folder, not `platform/web`: a new static file must be added to `STATIC_FILES` in `platform/web/build.ts`.
- A Lambda function cannot invoke another (the boundary has no `lambda:InvokeFunction`, and invoke permissions
  are only for API Gateway, EventBridge, SNS and S3): hand work off through an `ssd-workshop-*` SQS queue and an
  event source mapping (ticket 1.7), with identity-based rights only (no queue policy: `sqs:AddPermission` is denied).
- An SQS-fed Lambda (batch size 1) gets a visibility timeout just above its timeout, and the last redelivery
  (`(maxReceiveCount - 1) x visibility + timeout`) must end before any "stale" cutoff the code uses, or retries find
  the work stale and the dead-letter queue never fills (ticket 1.7, tested in `app.test.ts`). Cap workers that call
  Bedrock with `maxConcurrency` on the event source.
- In tests, `expect.not.arrayContaining([a, b])` passes unless all of `a` and `b` are present: check each forbidden
  name with its own `not.toContain`.
- A `Vpc` in a stack with an account in `env` asks AWS for the account's zones at synth time, even with
  `availabilityZones` given (it validates them against `Stack.availabilityZones`): override the stack's
  `availabilityZones` getter with the fixed zones from `config.ts` (ticket 2.1); the app test checks the
  assembly lists no missing context. Set `restrictDefaultSecurityGroup: false` (the default group is untagged,
  and the restriction is a custom-resource Lambda).
- A role that must not touch a marker item (the data API and an app's `LIVE` marker, ticket 2.4) gets no write in the
  marker's partition at all: put the role's items under another prefix (`APPDATA#` beside `APP#`) and check that the
  `StringLike` patterns cannot overlap (`APP#*` never matches `APPDATA#...`, since the `#` comes right after `APP`).
- An HTTP API route that must answer a CORS preflight itself (the data API, ticket 2.4) gets an explicit `OPTIONS`
  route to the function, and the API keeps no `corsPreflight`: with one, API Gateway answers `OPTIONS` itself.
- API Gateway's own answers (a route throttle's 429) carry no CORS headers, so a sandboxed app cannot read them: the
  data API's CloudFront behaviour `/api/apps/*` (before `/api/*`) adds `Access-Control-Allow-Origin: *` with a custom
  response headers policy (`ssd-workshop-app-data-v1`, CORS `originOverride: true` so the function's own header is
  replaced, not doubled), which keeps the managed SecurityHeadersPolicy's headers (ticket 2.4).
- S3 behind an origin access control answers a missing key with 403 (CloudFront may not list the bucket): the
  distribution's custom error response 403 -> `/404.html` (status 404) gives the plain page, for every behaviour
  (ticket 2.5). Never map 404 there: the API's own JSON 404s would become the page.
- A bucket only one role may write (the apps bucket, ticket 2.5): a bucket policy `Deny` of the object-changing actions
  for `AnyPrincipal` with `ArnNotEquals` `aws:PrincipalArn` [role ARN with path, same without] keeps even the deploy
  role and the Claude user out; bucket-level actions stay allowed so deploys can still manage the bucket (a deny there
  could lock CloudFormation out). The boundary allows workload roles `s3:*` on `ssd-workshop-*`, so the synth test must
  fail when any role is granted the bucket's policy, lifecycle, website, CORS or deletion actions on it. Limit the
  CloudFront read to the workshop distribution's exact ARN (`DISTRIBUTION_ARN`), not `distribution/*`.
- A queue that makes a worker publish (the deploy queue, ticket 2.5) gets its senders checked on the synth output: a test
  fails when any IAM policy may `sqs:SendMessage` to it (by name, ARN, logical id or wildcard) other than the one
  allowed sender (since ticket 2.9: the builder task role `ssd-workshop-builder`, the deploy queue's only sender; the
  GitHub secret's only reader is the launcher role; both tested on the synth output).
- CloudFront Function code lives in a plain `.js` file (`FunctionCode.fromFile`, inlined in the template, no asset) that
  a test evaluates (`new Function(code + "return handler;")`); `AWS::CloudFront::Function` takes `Tags`.
- A role whose `GetItem` is limited by `dynamodb:Attributes` also needs `StringEquals` `dynamodb:Select` =
  `SPECIFIC_ATTRIBUTES`: a GetItem without a `ProjectionExpression` returns the whole item, and the attribute list alone
  may let it through (ticket 2.8, for 2.9's builder role).
- A schedule that must run a Lambda (the stuck-build check, ticket 2.9) goes EventBridge Scheduler → an
  `ssd-workshop-*` SQS queue → event source mapping: the boundary has no `lambda:InvokeFunction` for a scheduler role.
  `AWS::Scheduler::Schedule` takes no tags (it is in `NOT_TAGGABLE`).
- ECS task log groups are named `/ecs/ssd-workshop-*` (the access stack's log rights name that prefix); the names test
  strips `/ecs/` before checking the `ssd-workshop-` start. A container's `Name` inside a task definition is not a
  resource name (`NOT_NAME_PATHS`).
- A container image is pinned by digest (`ContainerImage.fromEcrRepository(repo, "sha256:...")`, context
  `builderImageDigest`, passed by the deploy workflow after its push), so pushing a tag cannot change what tasks run.
  CI's synth uses a placeholder digest.
- `NodejsFunction` bundles are CommonJS: code that a Lambda bundles must not use `import.meta` at load (esbuild
  warns "import.meta is not available" and it is `{}` at run time); keep path helpers that need it in functions not
  called by the handler, or in a separate module (`platform/api/github/template-files.ts`, ticket 2.9). Files the
  function needs next to it are copied in `commandHooks.afterBundling`, and a synth test compares them with the source.
- Docker Hub rate-limits anonymous pulls (429 in sessions and CI): base images come from the ECR Public mirror
  `public.ecr.aws/docker/library/<image>:<exact version>`. ECR Public also rate-limits anonymous pulls from GitHub's
  shared runners (429 on the first deploy after 2.9): the deploy workflow logs in first (`aws ecr-public
  get-login-password --region us-east-1`, as the deploy role: `ecr-public:GetAuthorizationToken` and
  `sts:GetServiceBearerToken` WITHOUT an `sts:AWSServiceName` condition: with `ecr-public.amazonaws.com` the live
  login was denied) and retries the build 3 times. Unit tests of a condition cannot prove the real request carries it:
  check a new login or token right live (as the Claude user, printing no token) before handing the template over.
- In a session, `docker build` cannot reach npm through the agent proxy's TLS (SELF_SIGNED_CERT_IN_CHAIN): build a
  local copy of the Dockerfile that mounts the proxy CA (`--build-context`, `NODE_EXTRA_CA_CERTS`); never commit it.
- A deny "for every role but X" in the boundary (ticket 2.9 try 2): `ArnNotLike` `aws:PrincipalArn`
  `arn:aws:iam::<account>:role*/<name>` covers X with and without its path in one value (a role name is unique in
  an account), half the size of listing both forms; test look-alikes (`x-<name>`, `<name>x`, `<name>-execution`). The
  boundary is close to 6,144 characters (5,978 after 2.9's access review; `-deploy-read` 5,155 and `-ec2` 4,405 after the 2.9 follow-up): check the size test
  before adding to it. Every role such a deny lets through by name is then a target to borrow: deny the Claude user everything but reads on it (and on the
  functions that run as it) in `NoLauncherForSessions` (ticket 2.9 try 3), or a
  session passes it to its own task or function. `role*/<name>` works only in a condition: IAM rejects it in a
  `Resource` ("IAM resource path must either be "*", root, or start with user/, ..."; the access stack update after
  2.9 rolled back) and cfn-lint does not catch it. Name the role with its path (`role/ssd-workshop/<name>`) there;
  a test checks every IAM ARN in a `Resource`/`NotResource`.
- Lambda has no condition key for an event source mapping's queue, and calls by mapping UUID may carry no
  `lambda:FunctionArn`: keep sessions off a queue's consumers with an unconditional deny of
  `lambda:Create/Update/DeleteEventSourceMapping` for the Claude user (`NoEventSourcesForSessions`, ticket 2.9 try 3).
- An ECS task's container overrides are readable by anyone with `ecs:DescribeTasks` on it (and in CloudTrail's RunTask
  `requestParameters`): a secret passed there (2.9's builder token) needs `DescribeTasks` denied to sessions and, in the
  boundary, to every role but the one that must watch the task; and the action that would turn the secret into an
  effect (the deploy message) denied too, so a leak alone changes nothing live.
- Validate CDK context (`builderImageDigest`) at the top of `buildApp`, before any stack: a stack's constructor runs
  after every earlier stack has bundled its Lambdas, so a refusal test that waits for it times out on CI's runner. One
  helper in `config.ts` holds the rule for both places.
