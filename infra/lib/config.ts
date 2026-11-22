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

export const ASSETS_BUCKET_NAME = `${PREFIX}-cdk-assets-${ACCOUNT}`;
export const SITE_BUCKET_NAME = `${PREFIX}-site-${ACCOUNT}`;
/** Regional endpoint, so CloudFront reaches the eu-central-1 bucket directly. */
export const SITE_BUCKET_REGIONAL_DOMAIN = `${SITE_BUCKET_NAME}.s3.${REGION}.amazonaws.com`;

export const STACK_NAMES = {
  assets: `${PREFIX}-cdk-assets`,
  site: `${PREFIX}-site`,
  edge: `${PREFIX}-edge`,
} as const;

/**
 * Created by the access stack; GitHub Actions assumes it through OIDC, from `main` only.
 * The deploy workflow reads it from here (infra/bin/print-deploy-settings.ts).
 */
export const DEPLOY_ROLE_NAME = `${PREFIX}-deploy`;
export const DEPLOY_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${DEPLOY_ROLE_NAME}`;
