/**
 * Fixed facts the API functions need. Constants rather than environment variables, so a
 * function cannot be pointed at another table or sender by configuration; the values that
 * infra also knows are checked against infra/lib/config.ts by a test (platform code does not
 * import infra).
 */
export const REGION = "eu-central-1";
/** The single DynamoDB table (key scheme in types.ts). */
export const TABLE_NAME = "ssd-workshop-data";
/** The only address the workshop sends from (SES identity; it receives no mail). */
export const SENDER_ADDRESS = "ssd-workshop@rankly.games";
export const SENDER_NAME = "SSD Workshop";
/** Display name and address, as recipients see it: "SSD Workshop" <ssd-workshop@rankly.games>. */
export const FROM_HEADER = `"${SENDER_NAME}" <${SENDER_ADDRESS}>`;
/** Every send names it; without it SES uses the domain's default set (another project's). */
export const CONFIGURATION_SET = "ssd-workshop-email";

/** The workshop's AWS account (the queue's address names it). */
export const ACCOUNT = "360206963848";

/**
 * The one model setting (Franck, 2026-11-23): Claude Sonnet 4.6 through the EU cross-region
 * inference profile, used by the AI worker, the guardrail eval and the smoke check.
 */
export const MODEL_ID = "eu.anthropic.claude-sonnet-4-6";

/**
 * US dollars per million tokens for MODEL_ID through the EU geographic profile (ticket 1.7): the
 * list price ($3 in, $15 out) plus Bedrock's 10% premium for geographic cross-region inference.
 */
export const PRICE_PER_MILLION_TOKENS = { input: 3.3, output: 16.5 } as const;

/** US dollars per million tokens of each kind a call is billed for (prompt-cache reads and writes included). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One AI role's model: an EU inference profile and its prices (decision "Models per role"). */
export interface ModelSetting {
  modelId: string;
  price: ModelPrice;
}

/**
 * The model of each AI role that has moved to this table (ticket 2.8 starts it with `build`, the coding agent); the
 * other roles still use MODEL_ID and PRICE_PER_MILLION_TOKENS until a later ticket moves them. Sonnet 4.6 through the
 * EU profile: list prices ($3 in, $15 out, cache reads $0.30, 5-minute cache writes $3.75) plus Bedrock's 10%.
 */
export const MODELS = {
  build: { modelId: MODEL_ID, price: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 } },
} as const satisfies Record<string, ModelSetting>;

/** The queue that hands a stored message to the AI worker (ticket 1.7); it carries ids only. */
export const AI_QUEUE_NAME = "ssd-workshop-ai-messages";
export const AI_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${AI_QUEUE_NAME}`;

/**
 * Apps hosting (ticket 2.5): the private bucket served at `/apps/*`, where every app's files live under
 * `apps/<lower-cased nickname>/`. Only the deployer's role may write to it (bucket policy).
 */
export const APPS_BUCKET_NAME = `ssd-workshop-apps-${ACCOUNT}`;
/** Prefix of every app's files in the apps bucket; the CloudFront path `/apps/<nickname>/...` maps straight to it. */
export const APPS_KEY_PREFIX = "apps/";
/** The live CloudFront distribution of workshop.rankly.games (edge stack); the deployer invalidates `/apps/<nickname>/*` on it. */
export const DISTRIBUTION_ID = "E2TOZV0ERAXKZ9";
/** The free GitHub organization that holds the participants' public repositories (Franck, 2026-11-23). */
export const APPS_GITHUB_OWNER = "ssd-workshop-apps";
/** A participant's repository: `ssd-<lower-cased nickname>` in APPS_GITHUB_OWNER. */
export const appRepositoryName = (nickname: string): string => `ssd-${nickname.toLowerCase()}`;
/** GitHub's tarball of a repository at one commit (public repositories, downloaded without a token). */
export const appArchiveUrl = (nickname: string, commit: string): string =>
  `https://codeload.github.com/${APPS_GITHUB_OWNER}/${appRepositoryName(nickname)}/tar.gz/${commit}`;
/**
 * GitHub's tarball of the app repository's `main` branch, named in full (`refs/heads/main`: a bare `main` would pick a
 * tag of that name first). The deployer downloads this one (ticket 2.8, try 3).
 */
export const appMainArchiveUrl = (nickname: string): string =>
  `https://codeload.github.com/${APPS_GITHUB_OWNER}/${appRepositoryName(nickname)}/tar.gz/refs/heads/main`;
/** The deploy queue (FIFO, one message group per app) from the builder (ticket 2.8) to the deployer. */
export const DEPLOY_QUEUE_NAME = "ssd-workshop-deploys.fifo";
export const DEPLOY_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${DEPLOY_QUEUE_NAME}`;
/**
 * SQS delivers a deploy at most this many times: a passing failure (GitHub or AWS) is retried, and on the last
 * delivery the build is marked failed instead (only a failure to record that reaches the dead-letter queue).
 */
export const DEPLOY_MAX_RECEIVES = 3;

/**
 * GitHub access (ticket 2.6). The secret holds `{"appId": "<id>", "privateKey": "<PEM>"}` of the GitHub App
 * `ssd-workshop-gh-app`, installed only on APPS_GITHUB_OWNER; Franck loads it (CDK creates it with a random
 * placeholder). The installation is looked up with the app's own key, so the secret needs nothing else.
 */
export const GITHUB_SECRET_NAME = "ssd-workshop-github";
export const GITHUB_API_URL = "https://api.github.com";
/** The REST API version every call asks for. */
export const GITHUB_API_VERSION = "2022-11-28";
/** GitHub refuses calls without a User-Agent. */
export const GITHUB_USER_AGENT = "ssd-workshop-platform";
/** The branch every app's repository builds and deploys from. */
export const APPS_DEFAULT_BRANCH = "main";
/**
 * Author and committer of every commit the platform and the builder make: a fixed name and an address on the
 * workshop's own domain that has no mailbox. No participant's email address ever reaches GitHub.
 */
export const BUILDER_COMMIT_NAME = "SSD Workshop builder";
export const BUILDER_COMMIT_EMAIL = "noreply@workshop.rankly.games";

/**
 * The launch queue (ticket 2.7): the AI worker sends `{"buildId": "<id>"}` once the readiness check passed and the build
 * record exists; the build launcher (ticket 2.9) consumes it. FIFO: the build id is the deduplication id and the
 * participant id the message group, so a re-send within 5 minutes is dropped by SQS and one participant's launches
 * run one at a time. A later re-send can still arrive: the launcher acts only on a build that is still `queued`.
 */
export const BUILD_QUEUE_NAME = "ssd-workshop-builds.fifo";
export const BUILD_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${BUILD_QUEUE_NAME}`;

/**
 * The builder (ticket 2.8): the coding agent stops after this long (from its start) and the build fails with
 * "The build took too long.".
 */
export const BUILD_AGENT_TIMEOUT_MS = 12 * 60 * 1000;
