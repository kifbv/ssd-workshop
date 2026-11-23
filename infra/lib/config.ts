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
} as const;

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
