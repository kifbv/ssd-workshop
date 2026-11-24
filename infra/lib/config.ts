/**
 * Fixed facts about the workshop's AWS home. They are constants, not lookups,
 * so `cdk synth` and the tests run in CI without AWS credentials.
 */
export const ACCOUNT = "360206963848";
/** Everything lives here, except what CloudFront needs in us-east-1. */
export const REGION = "eu-central-1";
/** CloudFront only accepts ACM certificates from us-east-1. */
export const EDGE_REGION = "us-east-1";

export const DOMAIN = "workshop.rankly.games";
export const HOSTED_ZONE_NAME = "rankly.games";
/** Public id of the rankly.games hosted zone (Route53). */
export const HOSTED_ZONE_ID = "Z0232668P02TE2FEZL28";

export const PREFIX = "ssd-workshop";
export const TAG_KEY = "project";
export const TAG_VALUE = "ssd-workshop";

/** Created by the access stack (infra/access/access-stack.yaml). */
export const BOUNDARY_NAME = "ssd-workshop-boundary";
export const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/${BOUNDARY_NAME}`;
/** IAM path of every role and instance profile: the deploy rights reach only `role/ssd-workshop/*`. */
export const IAM_PATH = `/${PREFIX}/`;

export const ASSETS_BUCKET_NAME = `${PREFIX}-cdk-assets-${ACCOUNT}`;
export const SITE_BUCKET_NAME = `${PREFIX}-site-${ACCOUNT}`;
/** Regional endpoint, so CloudFront reaches the eu-central-1 bucket directly. */
export const SITE_BUCKET_REGIONAL_DOMAIN = `${SITE_BUCKET_NAME}.s3.${REGION}.amazonaws.com`;

export const STACK_NAMES = {
  assets: `${PREFIX}-cdk-assets`,
  site: `${PREFIX}-site`,
  edge: `${PREFIX}-edge`,
  api: `${PREFIX}-api`,
  builds: `${PREFIX}-builds`,
  apps: `${PREFIX}-apps`,
} as const;

/**
 * Build network, cluster and image repository (ticket 2.1, stack `ssd-workshop-builds`).
 * Two public subnets and no NAT gateway: build tasks get a public IP to reach GitHub and Bedrock.
 */
export const BUILDS_VPC_NAME = `${PREFIX}-builds`;
export const BUILDS_VPC_CIDR = "10.42.0.0/16";
/**
 * The two zones of the build subnets. Constants, not a lookup: with an account in `env`, CDK would
 * ask AWS for the zones at synth time, and CI synthesizes without credentials.
 */
export const BUILDS_AVAILABILITY_ZONES = [`${REGION}a`, `${REGION}b`] as const;
/** Security group of the build tasks: outgoing HTTPS only, nothing incoming. */
export const BUILDS_SECURITY_GROUP_NAME = `${PREFIX}-builds`;
export const BUILDS_CLUSTER_NAME = `${PREFIX}-builds`;
/** Image repository of the builder container; keeps the newest BUILDER_IMAGES_KEPT images. */
export const BUILDER_REPOSITORY_NAME = `${PREFIX}-builder`;
export const BUILDER_IMAGES_KEPT = 5;
/**
 * The two build subnets, live since the first deploy of `ssd-workshop-builds` (2026-11-24):
 * `eu-central-1a` 10.42.0.0/24 and `eu-central-1b` 10.42.1.0/24. The access stack pins ECS services
 * to them (`ecs:subnet`, ticket 2.2) and the build launcher names them in `RunTask` (ticket 2.9).
 * If the stack is ever recreated, the subnets get new ids: update these and the access stack
 * (a test keeps the two in step).
 */
export const BUILDS_SUBNET_IDS = ["subnet-05229d71b1e0b41ff", "subnet-0965bcee41d455dba"] as const;
/**
 * Role of the build launcher Lambda (ticket 2.9), on the path IAM_PATH. The boundary lets only this
 * role start ECS tasks (`aws:PrincipalArn`, ticket 2.2), so it must keep exactly this name.
 */
export const BUILD_LAUNCHER_ROLE_NAME = `${PREFIX}-builds-launcher`;
export const BUILD_LAUNCHER_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role${IAM_PATH}${BUILD_LAUNCHER_ROLE_NAME}`;

/**
 * The platform's GitHub App credentials (ticket 2.6), in the builds stack: `{"appId": "<id>", "privateKey": "<PEM>"}`,
 * loaded by Franck (infra/README.md). CDK creates it with a random placeholder (CloudFormation cannot create a secret
 * without a value). No role may read it yet; the build launcher (ticket 2.9) will be the one reader.
 */
export const GITHUB_SECRET_NAME = `${PREFIX}-github`;

/** The single DynamoDB table (key scheme in platform/api/types.ts). */
export const TABLE_NAME = `${PREFIX}-data`;
/** The HTTP API; its routes all start with /api/ (CloudFront sends /api/* to it from ticket 1.2). */
export const API_NAME = `${PREFIX}-api`;
/**
 * Id of the live HTTP API (api stack, ticket 1.1). A constant because the edge
 * stack (us-east-1) cannot read it across regions: `crossRegionReferences` is
 * not allowed (see .claude/rules/infra.md). If the API stack is ever recreated,
 * the API gets a new id and this constant must be updated, or /api/* breaks.
 */
export const API_ID = "ut2mzqmbb4";
/** Origin of CloudFront's `/api/*` behaviour: the API's own execute-api address. */
export const API_ORIGIN_DOMAIN = `${API_ID}.execute-api.${REGION}.amazonaws.com`;
/**
 * Version of the pages' response headers policy (ticket 1.6). Custom policies have no tags, so the
 * deploy rights can create one but never update or delete it: it is retained, and any change to its
 * headers must bump this version. The version is in both the name and the logical id: a new name
 * alone would be an in-place update, a new logical id makes CloudFormation create a replacement.
 */
export const PAGES_HEADERS_POLICY_VERSION = 1;
export const PAGES_HEADERS_POLICY_NAME = `${PREFIX}-pages-v${PAGES_HEADERS_POLICY_VERSION}`;
/**
 * Version of the data API's response headers policy (ticket 2.4, CloudFront `/api/apps/*`): the managed
 * SecurityHeadersPolicy's headers plus `Access-Control-Allow-Origin: *`, so that answers API Gateway or
 * CloudFront make themselves (a throttle's 429) are readable by sandboxed apps too. Created, never
 * updated, like the pages' policy: a change bumps this version.
 */
export const APP_DATA_HEADERS_POLICY_VERSION = 1;
export const APP_DATA_HEADERS_POLICY_NAME = `${PREFIX}-app-data-v${APP_DATA_HEADERS_POLICY_VERSION}`;
/**
 * Content-Security-Policy of the pages: scripts, styles, connections and images from the site
 * itself only (no inline scripts or styles), no framing, no plugins.
 */
export const PAGES_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
/**
 * Content-Security-Policy of the participants' apps under `/apps/*` (Franck, 2026-11-23, "Apps
 * sandboxed"): scripts, forms, dialogs and new windows, but no `allow-same-origin`, so an app runs in
 * an opaque origin, never sees the platform's cookies and has no `localStorage`.
 * Ticket 2.3 adds loading limits (spec delta pending Franck's yes): the app loads and sends only to its
 * own server (`'self'` still means the served address under the sandbox, tested), images also from
 * `data:`, and no inline scripts or styles. This blocks the outside addresses that the deploy check
 * cannot see (built from parts at run time). Ticket 2.3's Playwright test serves the template with it;
 * ticket 2.5's headers policy sends it.
 */
export const APPS_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts allow-forms allow-modals allow-popups",
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
].join("; ");
/** Lambda function, role and log group of `GET /api/health`. */
export const HEALTH_FUNCTION_NAME = `${PREFIX}-api-health`;
/** Lambda function, role and log group of `POST /api/sign-in/code` (ticket 1.4). */
export const SIGN_IN_CODE_FUNCTION_NAME = `${PREFIX}-api-sign-in-code`;
/**
 * The only attribute names the sign-in code function may write (PutItem, `dynamodb:Attributes`):
 * those of the CODE and CODE_REQUESTS items. It cannot write an allow-list entry's `email`, which
 * the allow-list check requires.
 */
export const SIGN_IN_CODE_PUT_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  "codes",
  "attempts",
  "sentAt",
  "version",
  "expiresAt",
] as const;

/** Lambda function, role and log group of `POST /api/sign-in/verify` (ticket 1.5). */
export const SIGN_IN_VERIFY_FUNCTION_NAME = `${PREFIX}-api-sign-in-verify`;
/**
 * The attribute names the code check may update in `EMAIL#*` partitions (UpdateItem,
 * `dynamodb:Attributes`): the codes item's wrong tries and version, and the allow-list entry's
 * link to its participant. Never `email`, `role` or `group`: it cannot list anyone or change rights.
 */
export const SIGN_IN_VERIFY_EMAIL_UPDATE_ATTRIBUTES = ["pk", "sk", "attempts", "version", "participantId"] as const;
/** The profile attribute names the code check may update in `PARTICIPANT#*` (never `nickname`). */
export const SIGN_IN_VERIFY_PROFILE_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  "id",
  "role",
  "group",
  "step",
  "createdAt",
] as const;
/** The session attribute names the code check may put in `SESSION#*`. */
export const SIGN_IN_VERIFY_SESSION_PUT_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  "tokenHash",
  "participantId",
  "createdAt",
  "expiresAt",
] as const;
/** Lambda function, role and log group of the protected participant routes (ticket 1.5). */
export const PARTICIPANT_FUNCTION_NAME = `${PREFIX}-api-participant`;
/** The nickname claim's attribute names the participant function may put in `NICK#*`. */
export const PARTICIPANT_NICK_PUT_ATTRIBUTES = ["pk", "sk", "type", "nickname", "participantId", "createdAt"] as const;
/** The profile attribute names the participant function may update in `PARTICIPANT#*`. */
export const PARTICIPANT_PROFILE_UPDATE_ATTRIBUTES = ["pk", "sk", "nickname", "step"] as const;

/** Lambda function, role and log group of the data API for apps (ticket 2.4). */
export const APP_DATA_FUNCTION_NAME = `${PREFIX}-api-app-data`;
/**
 * The only attribute names the data API may write (PutItem, UpdateItem and DeleteItem, in `APPDATA#*`
 * partitions only): a value item's and the totals item's (with the daily write count, `writeDay` and
 * `writtenBytes`, and each key's size, the map `sizes`: IAM's `dynamodb:Attributes` holds only
 * top-level names, so `sizes.<key>` counts as `sizes`). Never `liveAt` or `nickname` (the live
 * marker's, in `APP#*`, which only the deployer writes).
 */
export const APP_DATA_WRITE_ATTRIBUTES = ["pk", "sk", "type", "value", "bytes", "keys", "updatedAt", "writeDay", "writtenBytes", "sizes"] as const;

/**
 * Apps hosting and the deployer (ticket 2.5, stack `ssd-workshop-apps`). The bucket name holds the account,
 * like the site's (S3 names are global); every app's files live under `apps/<lower-cased nickname>/`.
 */
export const APPS_BUCKET_NAME = `${PREFIX}-apps-${ACCOUNT}`;
/** Regional endpoint, so CloudFront reaches the eu-central-1 bucket directly. */
export const APPS_BUCKET_REGIONAL_DOMAIN = `${APPS_BUCKET_NAME}.s3.${REGION}.amazonaws.com`;
/** Lambda function, role and log group of the deployer. */
export const DEPLOYER_FUNCTION_NAME = `${PREFIX}-apps-deployer`;
export const DEPLOYER_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role${IAM_PATH}${DEPLOYER_FUNCTION_NAME}`;
/**
 * The same role as IAM may also name it without its path: role names are unique in an account whatever
 * the path, so this still names only the deployer's role. The apps bucket's policy accepts both forms in
 * `aws:PrincipalArn` (decision 2.2: unverified whether the key carries the path).
 */
export const DEPLOYER_ROLE_ARN_WITHOUT_PATH = `arn:aws:iam::${ACCOUNT}:role/${DEPLOYER_FUNCTION_NAME}`;
/** The deploy queue (FIFO, one message group per app, so an app's deploys run one at a time and in order) and its dead-letter queue. */
export const DEPLOY_QUEUE_NAME = `${PREFIX}-deploys.fifo`;
export const DEPLOY_DLQ_NAME = `${PREFIX}-deploys-dlq.fifo`;
/**
 * Id of the live CloudFront distribution of workshop.rankly.games (edge stack, us-east-1). A constant like
 * API_ID: the deployer (eu-central-1) invalidates `/apps/<nickname>/*` on it and its role may invalidate this
 * distribution only. If the edge stack is ever recreated, the distribution gets a new id and this constant
 * (and platform/api/settings.ts DISTRIBUTION_ID, kept equal by a test) must be updated.
 */
export const DISTRIBUTION_ID = "E2TOZV0ERAXKZ9";
export const DISTRIBUTION_ARN = `arn:aws:cloudfront::${ACCOUNT}:distribution/${DISTRIBUTION_ID}`;
/**
 * The attribute names the deployer may name in `BUILD#*` (UpdateItem only, on existing builds). IAM's
 * `dynamodb:Attributes` counts the names a condition uses too: `nickname` and `pushedCommit` (ticket 2.8: the commit
 * the builder pushed must equal the message's) are only compared, never written.
 */
export const DEPLOYER_BUILD_UPDATE_ATTRIBUTES = ["pk", "sk", "status", "nickname", "pushedCommit", "updatedAt", "finishedAt", "deployedCommit", "failureReasons"] as const;
/** What an UpdateItem under a `dynamodb:Attributes` list may return (`ALL_NEW`/`ALL_OLD` could return other attributes). */
export const ATTRIBUTE_LIMITED_RETURN_VALUES = ["NONE", "UPDATED_OLD", "UPDATED_NEW"] as const;
/** The live marker's attribute names, which the deployer may update in `APP#*` (UpdateItem only). */
export const DEPLOYER_LIVE_UPDATE_ATTRIBUTES = ["pk", "sk", "type", "nickname", "liveAt"] as const;
/**
 * Version of the apps' response headers policy (CloudFront `/apps/*`): the sandbox CSP, nosniff, HSTS and
 * referrer policy. Created, never updated, like the pages' policy: a change bumps this version.
 */
export const APPS_HEADERS_POLICY_VERSION = 1;
export const APPS_HEADERS_POLICY_NAME = `${PREFIX}-apps-v${APPS_HEADERS_POLICY_VERSION}`;
/** The CloudFront Function on `/apps/*` (viewer request): trailing slash and lower-case redirects, `index.html` for folders. */
export const APPS_INDEX_FUNCTION_NAME = `${PREFIX}-apps-index`;

/** Lambda function, role and log group of the conversation routes (ticket 1.7). */
export const CONVERSATION_FUNCTION_NAME = `${PREFIX}-api-conversation`;
/**
 * The attribute names the conversation function may update in `PARTICIPANT#*` (UpdateItem only, so
 * it can never replace or empty an item): a new message, the conversation's state and message in
 * flight, the failure reply when the queue refuses a message, and the profile's `step` from clarify to
 * spec (Write my spec, ticket 1.8). Ticket 1.9: the approval, `approvedSpecVersion` on the conversation,
 * `approvedAt` on the spec version and the step to approved (the condition names `latestSpecVersion`).
 * Never `role`, `group`, `nickname`, `id`, `approvedTextHash` or `specVersion` (readers of a spec version
 * require it, so this role cannot make one). Ticket 2.7: `buildId`, only compared (asking for the readiness check
 * again needs no build yet); `GET /api/build` answers only a build whose own `participantId` is the caller.
 */
export const CONVERSATION_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  "author",
  "step",
  "text",
  "status",
  "createdAt",
  "pendingSince",
  "state",
  "pendingId",
  "updatedAt",
  "kind",
  "replyTo",
  "approvedSpecVersion",
  "latestSpecVersion",
  "approvedAt",
  "buildId",
] as const;
/** Lambda function, role and log group of the AI worker (ticket 1.7). */
export const AI_WORKER_FUNCTION_NAME = `${PREFIX}-api-ai-worker`;
/**
 * The attribute names the AI worker may update in `PARTICIPANT#*` (UpdateItem only): a message's
 * status and guardrail result, the reply with its prompt, tokens, cost and `offersSpec` (ticket 1.8), the conversation's state
 * and the usage totals. Never `step`, `role`, `group`, `nickname`, `id` or `approvedTextHash` (only a
 * facilitator's approval sets it, and it skips the guardrail check for that exact text). Ticket 1.9: a
 * new spec version (`specVersion`, `messageId`) and the conversation's `latestSpecVersion`; never
 * `approvedSpecVersion` or `approvedAt` (only the participant's Approve spec sets them).
 * Ticket 2.7: the readiness check's outcome moves the profile's `step` (approved to building, or back to spec),
 * writes the conversation's `buildId`, and on a failed check removes `approvedSpecVersion` (so the participant can
 * approve again); every such write is conditional on the step being `approved` and that version being approved
 * with the readiness message in flight. Still never `approvedAt`, `role`, `group`, `nickname`, `id` or
 * `approvedTextHash`.
 */
export const AI_WORKER_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  "author",
  "text",
  "status",
  "kind",
  "replyTo",
  "offersSpec",
  "createdAt",
  "prompt",
  "modelId",
  "promptVersion",
  "historyCount",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "verdict",
  "verdictReason",
  "suggestion",
  "guardrailInputTokens",
  "guardrailOutputTokens",
  "guardrailCostUsd",
  "state",
  "pendingId",
  "pendingSince",
  "updatedAt",
  "participantId",
  "specVersion",
  "messageId",
  "latestSpecVersion",
  "step",
  "buildId",
  "approvedSpecVersion",
] as const;
/**
 * The attribute names the AI worker may name in `BUILD#*` (UpdateItem only; ticket 2.7): a new build record, created
 * only if absent (`attribute_not_exists(pk)`), queued. Never `deployedCommit`, `failureReasons`, `finishedAt` (the
 * deployer's) or `pushedCommit` (the builder's, ticket 2.8).
 */
export const AI_WORKER_BUILD_UPDATE_ATTRIBUTES = ["pk", "sk", "type", "buildId", "nickname", "participantId", "status", "createdAt", "updatedAt"] as const;
/**
 * The attribute names the builder (ticket 2.8, its task role from ticket 2.9) may name in `BUILD#*`, split by call for
 * 2.9's `dynamodb:Attributes` conditions (tested against the requests in platform/builder/aws.test.ts):
 *
 * - BUILDER_BUILD_READ_ATTRIBUTES: GetItem, its keys and projection (`nickname`, `participantId`, `status`);
 * - BUILDER_BUILD_UPDATE_ATTRIBUTES: UpdateItem (claim, feed, hand-over, failure), every name in its update and
 *   condition expressions. `nickname` and `attemptId` (the launch the task belongs to, ticket 2.9 try 2) are only
 *   compared, never set. Never `participantId` (only
 *   read), `deployedCommit` or `liveAt` (the deployer's), `type`, `buildId` or `createdAt` (the AI worker's).
 */
export const BUILDER_BUILD_READ_ATTRIBUTES = ["pk", "sk", "nickname", "participantId", "status"] as const;
export const BUILDER_BUILD_UPDATE_ATTRIBUTES = ["pk", "sk", "status", "nickname", "attemptId", "pushedCommit", "feed", "updatedAt", "finishedAt", "failureReasons"] as const;
/** The attribute names the builder may name in `PARTICIPANT#*` (UpdateItem of the `USAGE` item only): the build's tokens and cost. */
export const BUILDER_USAGE_UPDATE_ATTRIBUTES = ["pk", "sk", "type", "participantId", "updatedAt", "inputTokens", "outputTokens", "costUsd"] as const;
/**
 * The launch queue from the AI worker (after a passed readiness check, ticket 2.7) to the build launcher (ticket 2.9),
 * and its dead-letter queue, in the builds stack. FIFO: deduplication id the build id, message group the participant id.
 * The AI worker is its only sender (tested); its body is `{"buildId": "<id>"}`.
 */
export const BUILD_QUEUE_NAME = `${PREFIX}-builds.fifo`;
export const BUILD_DLQ_NAME = `${PREFIX}-builds-dlq.fifo`;
/** The queue from the conversation function to the AI worker, and its dead-letter queue (ticket 1.7). */
export const AI_QUEUE_NAME = `${PREFIX}-ai-messages`;
export const AI_DLQ_NAME = `${PREFIX}-ai-messages-dlq`;
/** The model of the AI worker (Franck, 2026-11-23); must equal platform/api/settings.ts MODEL_ID. */
export const MODEL_ID = "eu.anthropic.claude-sonnet-4-6";
/** The foundation model behind MODEL_ID (an EU profile routes to it in several EU regions). */
export const FOUNDATION_MODEL_ID = "anthropic.claude-sonnet-4-6";

/** The only address the workshop sends from (SES identity; it receives no mail). */
export const SENDER_ADDRESS = "ssd-workshop@rankly.games";
/** SES configuration set created by the access stack; every send names it. */
export const SES_CONFIGURATION_SET = `${PREFIX}-email`;
/** The SES resources a send names: the sender's identity, its domain identity and the configuration set. */
export const SES_SEND_RESOURCES = [
  `arn:aws:ses:${REGION}:${ACCOUNT}:identity/${SENDER_ADDRESS}`,
  `arn:aws:ses:${REGION}:${ACCOUNT}:identity/${HOSTED_ZONE_NAME}`,
  `arn:aws:ses:${REGION}:${ACCOUNT}:configuration-set/${SES_CONFIGURATION_SET}`,
] as const;

/**
 * Created by the access stack; GitHub Actions assumes it through OIDC, from `main` only.
 * The deploy workflow reads it from here (infra/bin/print-deploy-settings.ts).
 */
export const DEPLOY_ROLE_NAME = `${PREFIX}-deploy`;
export const DEPLOY_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${DEPLOY_ROLE_NAME}`;

/**
 * The builder's task (ticket 2.9): the Fargate task definition family, its container, size and log group, its task
 * role (the runner's AWS rights) and execution role (image pull and logs). The image is the deploy workflow's push to
 * BUILDER_REPOSITORY_NAME, named by digest (context `builderImageDigest`), so a later push to a tag never changes what
 * runs.
 */
export const BUILDER_TASK_FAMILY = `${PREFIX}-builder`;
export const BUILDER_CONTAINER_NAME = "builder";
export const BUILDER_TASK_ROLE_NAME = `${PREFIX}-builder`;
export const BUILDER_EXECUTION_ROLE_NAME = `${PREFIX}-builder-execution`;
export const BUILDER_LOG_GROUP_NAME = `/ecs/${PREFIX}-builder`;
/** 1 vCPU and 2 GB (the brief). */
export const BUILDER_CPU = 1024;
export const BUILDER_MEMORY_MB = 2048;
/** CDK context key the deploy workflow sets to the pushed image's digest (`sha256:<64 hex>`). */
export const BUILDER_IMAGE_DIGEST_CONTEXT = "builderImageDigest";
/** Used by `cdk synth` without that context (CI): a digest no image has, so a deploy that forgets it cannot start builds. */
export const BUILDER_IMAGE_DIGEST_UNSET = `sha256:${"0".repeat(64)}`;
/** The launcher's Lambda function (and its role, BUILD_LAUNCHER_ROLE_NAME, and its log group). */
export const BUILD_LAUNCHER_FUNCTION_NAME = BUILD_LAUNCHER_ROLE_NAME;
/** The queue EventBridge Scheduler fills every minute for the launcher's stuck-build check, the schedule and its role. */
export const BUILD_CHECK_QUEUE_NAME = `${PREFIX}-builds-check`;
export const BUILD_CHECK_SCHEDULE_NAME = `${PREFIX}-builds-check`;
export const BUILD_CHECK_SCHEDULER_ROLE_NAME = `${PREFIX}-builds-check-scheduler`;
/**
 * The attribute names the launcher may read (GetItem with a projection, `dynamodb:Select` SPECIFIC_ATTRIBUTES) in
 * `BUILD#*` and `PARTICIPANT#*`: the build's nickname, participant and status, the profile's nickname, the
 * conversation's build and approved version, and the approved spec version's text.
 */
export const LAUNCHER_READ_ATTRIBUTES = ["pk", "sk", "nickname", "participantId", "status", "buildId", "approvedSpecVersion", "specVersion", "text", "approvedAt"] as const;
/**
 * The attribute names the launcher may name in `BUILD#*` (UpdateItem, also inside its claim transaction): the move from
 * `queued` to `building` under a new launch (`attemptId`, ticket 2.9 try 2), the started task, and failure. `nickname`, `participantId` and `pushedCommit` are only
 * compared (IAM counts condition names).
 */
export const LAUNCHER_BUILD_UPDATE_ATTRIBUTES = ["pk", "sk", "status", "nickname", "participantId", "pushedCommit", "attemptId", "taskArn", "launchedAt", "updatedAt", "failureReasons", "finishedAt"] as const;
/** The watch list's attribute names (`LAUNCHES` partition: PutItem, UpdateItem, DeleteItem, Query). */
export const LAUNCHER_LAUNCH_ATTRIBUTES = ["pk", "sk", "type", "buildId", "taskArn", "claimedAt"] as const;
/** The watch list's partition key (platform/api/keys.ts LAUNCHES_PK). */
export const LAUNCHES_PARTITION = "LAUNCHES";
