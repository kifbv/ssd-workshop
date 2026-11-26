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
 * Ticket 2.14 (spec delta approved by Franck 2026-11-25): an app may also read data (`connect-src`) and show
 * images (`img-src`) from any `https:` address, so it can use free keyless services (Wikipedia, Open-Meteo,
 * ...). Scripts, styles and fonts still come only from its own files (`default-src 'self'`), forms still post
 * only to itself, and `http:` stays blocked. Tested in Chromium in `platform/api/build/template.test.ts`.
 */
export const APPS_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts allow-forms allow-modals allow-popups",
  "default-src 'self'",
  "connect-src 'self' https:",
  "img-src 'self' data: https:",
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
  // Ticket 3.10: the dashboard index's key (BY_TYPE_INDEX_KEY), `participant`, set at every sign-in.
  "listType",
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
  "allowRef",
] as const;
/**
 * What the session check (ticket 3.1, participant and conversation functions) may read of an allow-list entry
 * (GetItem in `EMAIL#*` with a projection, `dynamodb:Select` SPECIFIC_ATTRIBUTES): never `email`.
 */
export const SESSION_ALLOW_READ_ATTRIBUTES = ["pk", "sk", "role", "group", "participantId"] as const;
/** Lambda function, role and log group of the protected participant routes (ticket 1.5). */
export const PARTICIPANT_FUNCTION_NAME = `${PREFIX}-api-participant`;
/** The nickname claim's attribute names the participant function may put in `NICK#*`. */
export const PARTICIPANT_NICK_PUT_ATTRIBUTES = ["pk", "sk", "type", "nickname", "participantId", "createdAt"] as const;
/** The profile attribute names the participant function may update in `PARTICIPANT#*` (`stepSince` with the step, ticket 3.2). */
export const PARTICIPANT_PROFILE_UPDATE_ATTRIBUTES = ["pk", "sk", "nickname", "step", "stepSince"] as const;

/**
 * Lambda function, role and log group of the admin routes (ticket 3.2: `GET` and `PUT /api/admin/settings`; ticket 3.5:
 * `POST /api/admin/stop` and `POST /api/admin/resume`).
 */
export const ADMIN_FUNCTION_NAME = `${PREFIX}-api-admin`;
/** Partition key of the one workshop settings item (platform/api/keys.ts SETTINGS_PK). */
export const SETTINGS_PARTITION = "SETTINGS";
/**
 * The attribute names the admin function may update in the `SETTINGS` partition (UpdateItem only; ticket 3.2): the
 * three caps. No other role may write `SETTINGS` (synth test). Ticket 3.5: the global Stop (`stopped`) and when it was last
 * pressed (`stoppedAt`) and released (`resumedAt`).
 */
export const SETTINGS_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  "aiBudgetUsd",
  "changeRequestsPerPerson",
  "buildsAtOnce",
  "updatedAt",
  "stopped",
  "stoppedAt",
  "resumedAt",
] as const;

/**
 * The attribute names the AI worker and the conversation function may read from the `SETTINGS` item (GetItem with a
 * projection, `dynamodb:Select` `SPECIFIC_ATTRIBUTES`; ticket 3.3 reads the budget, ticket 3.5 `stopped` and, for the
 * launcher's queued time limit, `resumedAt`). `readSettings` in platform/api/workshop/store.ts projects exactly these
 * (tested).
 */
export const SETTINGS_READ_ATTRIBUTES = ["pk", "sk", "aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce", "stopped", "resumedAt"] as const;

/**
 * Ticket 3.10: Lambda function, role and log group of the facilitator routes (`/api/facilitator/...`: the dashboard's
 * list and its actions), for facilitators and the admin. Its own function, so its writes (pause, extra budget, flag
 * decisions, retry requests) are on a role no participant route runs as.
 */
export const FACILITATOR_FUNCTION_NAME = `${PREFIX}-api-facilitator`;
/**
 * Ticket 3.10: the table's one global secondary index (platform/api/settings.ts BY_TYPE_INDEX_NAME). The dashboard lists
 * profiles, conversations, usage totals and builds with a Query per kind, never a Scan (a Scan's keys would include the
 * allow-list's `EMAIL#<address>`). It is keyed by BY_TYPE_INDEX_KEY, an attribute only those four kinds of item carry
 * (written by their own writers: the sign-in verify function, the conversation function and the AI worker), so the
 * index is sparse: the allow-list, codes, sessions and every other item are never in it. Only the facilitator role may
 * query it, for these four values only (`dynamodb:LeadingKeys`, kept as a second guard).
 */
export const BY_TYPE_INDEX_NAME = `${PREFIX}-by-type`;
/** Ticket 3.10: the partition key of BY_TYPE_INDEX_NAME (same value as the item's `type`, on the four listed kinds only). */
export const BY_TYPE_INDEX_KEY = "listType";
/** Ticket 3.10: the item types the facilitator role may query in BY_TYPE_INDEX_NAME. */
export const FACILITATOR_INDEX_TYPES = ["participant", "conversation", "usage", "build"] as const;
/**
 * Ticket 3.10: the non-key attributes BY_TYPE_INDEX_NAME projects (INCLUDE): what one dashboard row needs from a profile
 * (`id`, `nickname`, `role`, `group`, `step`, `stepSince`, `createdAt`, `paused`, `extraBudget`, `changeRequestsUsed`),
 * a conversation (`buildId`, `state`, `pendingId`), a usage total (`participantId`, `costUsd`) and a build (`buildId`,
 * `participantId`, `status`, `launchedAt`, `kind`, `changeNumber`). Never `email`, a message's `text` or a spec.
 */
export const BY_TYPE_INDEX_ATTRIBUTES = [
  "id",
  "nickname",
  "role",
  "group",
  "step",
  "stepSince",
  "createdAt",
  "paused",
  "extraBudget",
  "changeRequestsUsed",
  "participantId",
  "costUsd",
  "buildId",
  "state",
  "pendingId",
  "status",
  "launchedAt",
  "kind",
  "changeNumber",
] as const;
/** Ticket 3.10: what the facilitator role may name in a Query of BY_TYPE_INDEX_NAME (projected, `SPECIFIC_ATTRIBUTES`). */
export const FACILITATOR_INDEX_READ_ATTRIBUTES = ["pk", "sk", BY_TYPE_INDEX_KEY, ...BY_TYPE_INDEX_ATTRIBUTES] as const;
/**
 * Ticket 3.10: the names the facilitator role may name in `PARTICIPANT#*` (UpdateItem, also in transactions): Pause and
 * Resume (`paused`), Add budget (`extraBudget`, the server's $2 step), Retry's note on the conversation (`updatedAt`),
 * and a flag's decision exactly as `npm run flags` makes it: Approve (the message back to `pending` with
 * `approvedTextHash` and `pendingSince`; the conversation `open` with it in flight) and Reject (the decline: the message's
 * `status`, the reply message's `type`, `author`, `text`, `kind`, `replyTo`, `createdAt`, the conversation's `state`,
 * `updatedAt`, `pendingId` and `pendingSince` removed). Only this role may write `approvedTextHash`, `paused` and
 * `extraBudget` (synth test). Never `step`, `role`, `group`, `nickname`, `id`, `costUsd` or `changeRequestsUsed`.
 */
export const FACILITATOR_PARTICIPANT_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "paused",
  "extraBudget",
  "updatedAt",
  "status",
  "approvedTextHash",
  "pendingSince",
  "state",
  "pendingId",
  "type",
  "author",
  "text",
  "kind",
  "replyTo",
  "createdAt",
] as const;
/**
 * Ticket 3.10: Retry's requests (`BUILD_RETRIES` / `BUILD#<id>`, platform/api/keys.ts retryRequestKey): the facilitator
 * role puts one (PutItem of these names only); the launcher's minute check reads them, puts the build back in the queue,
 * stops a stuck task (only the launcher may StopTask) and launches it, then deletes the request.
 */
/** Ticket 3.10: what the facilitator role may read of a nickname claim (`NICK#*`, projected): the participant id only. */
export const FACILITATOR_NICK_READ_ATTRIBUTES = ["pk", "sk", "participantId"] as const;
/** Ticket 3.10: what the facilitator role may read of a build (`BUILD#*`, projected) before it asks for a Retry. */
export const FACILITATOR_BUILD_READ_ATTRIBUTES = ["pk", "sk", "participantId", "status", "launchedAt"] as const;
export const BUILD_RETRIES_PARTITION = "BUILD_RETRIES";
export const RETRY_REQUEST_ATTRIBUTES = ["pk", "sk", "type", "buildId", "requestedAt"] as const;

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
 * Version 2 (ticket 2.14): `https:` added to `connect-src` and `img-src`; `ssd-workshop-apps-v1` stays
 * (retained) for Franck to delete once v2 is live.
 */
export const APPS_HEADERS_POLICY_VERSION = 2;
export const APPS_HEADERS_POLICY_NAME = `${PREFIX}-apps-v${APPS_HEADERS_POLICY_VERSION}`;
/** The CloudFront Function on `/apps/*` (viewer request): trailing slash and lower-case redirects, `index.html` for folders. */
export const APPS_INDEX_FUNCTION_NAME = `${PREFIX}-apps-index`;
/** Ticket 3.11: the CloudFront Function on `/facilitator*` (viewer request): the slash redirect and `index.html` for the folder. */
export const SITE_INDEX_FUNCTION_NAME = `${PREFIX}-site-index`;

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
 * Ticket 3.2: `stepSince`, set with every step change.
 * Ticket 3.6: Build this change stores its request marked `request` and approves the proposed version (`approvedAt`,
 * conditional on `proposedSpecVersion` and `buildId`); Not this one removes `proposedSpecVersion`; a read of a live app
 * notes `suggestionsRequestedAt` (its condition names `suggestions`, which IAM cannot tell from a write: only the AI
 * worker's code writes the list). Never `changeRequestsUsed`, `whatChanges` or `specVersion`.
 */
export const CONVERSATION_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  // Ticket 3.10: the dashboard index's key (BY_TYPE_INDEX_KEY), `conversation`, set with the first message.
  "listType",
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
  "stepSince",
  "proposedSpecVersion",
  "request",
  "suggestions",
  "suggestionsRequestedAt",
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
 * `approvedTextHash`. Ticket 3.2: `stepSince`, set with the step.
 * Ticket 3.6: a change answer's version with its `whatChanges` list and the conversation's `proposedSpecVersion`; the
 * change build's outcome sets `approvedSpecVersion` and `buildId`, removes `proposedSpecVersion` and counts the change
 * (`changeRequestsUsed`, the only role that may write it, conditional on its exact previous value and the cap, in the
 * transaction that creates the change build); the suggested changes (`suggestions`, once).
 * Ticket 3.9: `rebuildApprovedAt` (never `approvedAt`, which only the conversation function writes), on the version
 * Rebuild from my repository creates from the participant's SPEC.md in the same transaction that queues its change
 * build (the press is the participant's approval; created only if absent, with the request's `messageId`): the launcher
 * builds such a version only while its text equals the `repositorySpec` it stored on that request. Never
 * `repositoryRead`, `repositorySpec` or `repositoryName` (only the launcher writes what it read from GitHub).
 */
export const AI_WORKER_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  // Ticket 3.10: the dashboard index's key (BY_TYPE_INDEX_KEY), `usage`, set with every usage total.
  "listType",
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
  "stepSince",
  "whatChanges",
  "proposedSpecVersion",
  "changeRequestsUsed",
  "suggestions",
  "rebuildApprovedAt",
] as const;
/**
 * The attribute names the AI worker may name in `BUILD#*` (UpdateItem only; ticket 2.7): a new build record, created
 * only if absent (`attribute_not_exists(pk)`), queued. Never `deployedCommit`, `failureReasons`, `finishedAt` (the
 * deployer's) or `pushedCommit` (the builder's, ticket 2.8).
 */
export const AI_WORKER_BUILD_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "type",
  // Ticket 3.10: the dashboard index's key (BY_TYPE_INDEX_KEY), `build`, set when the build is created.
  "listType",
  "buildId",
  "nickname",
  "participantId",
  "status",
  "createdAt",
  "updatedAt",
  // Ticket 3.6: a change build's kind, number and spec version (absent kind = first, so first builds are unchanged).
  "kind",
  "changeNumber",
  "specVersion",
] as const;
/**
 * Ticket 3.6: what the AI worker's ConditionCheckItem in `BUILD#*` may name: the build a change follows must be `live` or
 * `failed` (nothing of the participant's running) in the transaction that queues the change build.
 */
export const AI_WORKER_BUILD_CHECK_ATTRIBUTES = ["pk", "sk", "status"] as const;
/**
 * The attribute names the builder (ticket 2.8, its task role from ticket 2.9) may name in `BUILD#*`, split by call for
 * 2.9's `dynamodb:Attributes` conditions (tested against the requests in platform/builder/aws.test.ts):
 *
 * - BUILDER_BUILD_READ_ATTRIBUTES: GetItem, its keys and projection (`nickname`, `participantId`, `status`; ticket 3.7:
 *   `kind` and `changeNumber`, and `changeSpec` and `changeList`, a change build's input the launcher copied from the
 *   spec version, so the task reads nothing outside `BUILD#*`);
 * - BUILDER_BUILD_UPDATE_ATTRIBUTES: UpdateItem (claim, feed, hand-over, failure), every name in its update and
 *   condition expressions. `nickname` and `attemptId` (the launch the task belongs to, ticket 2.9 try 2) are only
 *   compared, never set. Never `participantId` (only
 *   read), `deployedCommit` or `liveAt` (the deployer's), `type`, `buildId` or `createdAt` (the AI worker's).
 */
export const BUILDER_BUILD_READ_ATTRIBUTES = ["pk", "sk", "nickname", "participantId", "status", "kind", "changeNumber", "changeSpec", "changeList"] as const;
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
/**
 * The builder image digest from the CDK context (BUILDER_IMAGE_DIGEST_UNSET when absent), refused unless it is
 * `sha256:<64 hex digits>`. `buildApp` calls it before building any stack (fails fast) and the builds stack uses its result.
 */
export function builderImageDigest(context: unknown): string {
  const digest = String(context ?? BUILDER_IMAGE_DIGEST_UNSET);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${BUILDER_IMAGE_DIGEST_CONTEXT} must be sha256:<64 hex digits>`);
  return digest;
}
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
export const LAUNCHER_READ_ATTRIBUTES = [
  "pk",
  "sk",
  "nickname",
  "participantId",
  "status",
  "buildId",
  "approvedSpecVersion",
  "specVersion",
  "text",
  "approvedAt",
  "queueKey",
  // Ticket 3.7: a change build's kind and number (the build), and its version's "What changes" list (the spec version).
  "kind",
  "changeNumber",
  "whatChanges",
  // Ticket 3.9: a Rebuild from my repository request (the message's author, step, mark and status, and whether a read is
  // already stored on it).
  "author",
  "step",
  "request",
  "repositoryRead",
  // Ticket 3.9 try 2: only the conversation's request in flight and not stale (the conversation's `pendingId`, the
  // message's `pendingSince`); and, to build a version Rebuild from my repository approved (`rebuildApprovedAt`, with its
  // request's `messageId`), the text and repository name the launcher itself stored on that request.
  "pendingId",
  "pendingSince",
  "rebuildApprovedAt",
  "messageId",
  "repositorySpec",
  "repositoryName",
  // Ticket 3.10: Retry of a stuck build (the build's task, launch time and whether it handed a commit over) and a
  // facilitator's Pause (the profile's `paused`: a paused participant's build waits).
  "taskArn",
  "launchedAt",
  "pushedCommit",
  "paused",
] as const;
/**
 * Ticket 3.9: the names the launcher may name in `PARTICIPANT#*` (UpdateItem of a Rebuild from my repository request
 * only, conditional on the item existing and no read stored yet): what it read of the participant's SPEC.md on GitHub.
 * Try 2: with `repositoryName`, the repository the text was read from (the worker and the launcher check it against the
 * profile's). No other role may write them (synth test), so the AI worker and the launcher can trust them; IAM cannot bind them to the request's
 * item (no sort key condition), but the worker reads them only on a pending request with the route's mark.
 */
export const LAUNCHER_PARTICIPANT_UPDATE_ATTRIBUTES = ["pk", "sk", "repositoryRead", "repositorySpec", "repositoryName"] as const;
/**
 * The attribute names the launcher may name in `BUILD#*` (UpdateItem, also inside its claim transaction): the move from
 * `queued` to `building` under a new launch (`attemptId`, ticket 2.9 try 2), the started task, and failure. `nickname`, `participantId` and `pushedCommit` are only
 * compared (IAM counts condition names). Ticket 3.4: `queueKey`, the build's place in the waiting line (set when the
 * launcher first sees it, removed by the claim); also ConditionCheckItem, for the slot release (SLOT_RELEASE_CHECK_ATTRIBUTES).
 * Ticket 3.5: `feed`, removed (with the attempt, launch time and task) when the global Stop puts a running build back in
 * the queue, so it starts again from the beginning. Ticket 3.7: `changeSpec` and `changeList`, a change build's input
 * (only the launcher writes them; the builder task reads them).
 */
export const LAUNCHER_BUILD_UPDATE_ATTRIBUTES = [
  "pk",
  "sk",
  "status",
  "nickname",
  "participantId",
  "pushedCommit",
  "attemptId",
  "taskArn",
  "launchedAt",
  "updatedAt",
  "failureReasons",
  "finishedAt",
  "queueKey",
  "feed",
  // Ticket 3.7: a change build's input for its runner (the spec version's text and "What changes" list), set before the task starts.
  "changeSpec",
  "changeList",
] as const;
/** The watch list's attribute names (`LAUNCHES` partition: PutItem, UpdateItem, DeleteItem, Query). */
export const LAUNCHER_LAUNCH_ATTRIBUTES = ["pk", "sk", "type", "buildId", "taskArn", "claimedAt"] as const;
/** The watch list's partition key (platform/api/keys.ts LAUNCHES_PK). */
export const LAUNCHES_PARTITION = "LAUNCHES";
/** Ticket 3.4: the build slots' partition (platform/api/keys.ts BUILD_SLOTS_PK): the counter `COUNT` and one holder per build. */
export const BUILD_SLOTS_PARTITION = "BUILD_SLOTS";
/** Ticket 3.4: the waiting line's partition (platform/api/keys.ts BUILD_QUEUE_PK): one entry per queued build seen by the launcher. */
export const BUILD_QUEUE_PARTITION = "BUILD_QUEUE";
/**
 * The launcher's names in `BUILD_SLOTS` (GetItem, PutItem, UpdateItem, DeleteItem, Query): the counter (`running`,
 * `version`, and `repairMisses`, the check's refused repairs in a row, try 2) and the holders (`type`, `buildId`,
 * `heldSince`). Its reads (GetItem, Query) must be projected (`dynamodb:Select` SPECIFIC_ATTRIBUTES).
 */
export const LAUNCHER_SLOT_ATTRIBUTES = ["pk", "sk", "type", "buildId", "heldSince", "running", "version", "repairMisses"] as const;
/**
 * The launcher's names in `BUILD_QUEUE` (UpdateItem, DeleteItem, Query): an entry and when its message was last seen. Its
 * Query must be projected or a count (`dynamodb:Select` SPECIFIC_ATTRIBUTES or COUNT).
 */
export const LAUNCHER_QUEUE_ATTRIBUTES = ["pk", "sk", "type", "buildId", "lastSeenAt"] as const;
/**
 * The deployer and the launcher free a build's slot when they end it (platform/api/build/slots.ts): DeleteItem of the
 * holder and UpdateItem of the counter in `BUILD_SLOTS` naming only these, and ConditionCheckItem in `BUILD#*` naming only
 * SLOT_RELEASE_CHECK_ATTRIBUTES (the build must have ended). The builder task has no right on the slots (try 2).
 */
export const SLOT_RELEASE_ATTRIBUTES = ["pk", "sk", "running", "version"] as const;
export const SLOT_RELEASE_CHECK_ATTRIBUTES = ["pk", "sk", "status"] as const;
/**
 * Ticket 3.4: the conversation function counts the queued builds ahead of the caller's (`GET /api/build`): Query in
 * `BUILD_QUEUE` with `dynamodb:Select` `COUNT` only, naming only these.
 */
export const QUEUE_COUNT_ATTRIBUTES = ["pk", "sk", "lastSeenAt"] as const;
