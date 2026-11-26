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
/**
 * Ticket 3.18: the private bucket of apps' photos and recordings, served at `/app-media/*`; every app's files live under
 * `app-media/<lower-cased nickname>/`. Only the media function's role may put files there (bucket policy).
 */
export const APP_MEDIA_BUCKET_NAME = `ssd-workshop-app-media-${ACCOUNT}`;
/** The free GitHub organization that holds the participants' public repositories (Franck, 2026-11-23). */
export const APPS_GITHUB_OWNER = "ssd-workshop-apps";
/** A participant's repository: `ssd-<lower-cased nickname>` in APPS_GITHUB_OWNER. */
export const appRepositoryName = (nickname: string): string => `ssd-${nickname.toLowerCase()}`;
/** The workshop's own address (infra's DOMAIN): apps are served from it at `/apps/<lower-cased nickname>/`. */
export const SITE_DOMAIN = "workshop.rankly.games";
/** A live app's address (ticket 2.10's step 4): `https://workshop.rankly.games/apps/<lower-cased nickname>/`. */
export const appAddress = (nickname: string): string => `https://${SITE_DOMAIN}/apps/${nickname.toLowerCase()}/`;
/** A participant's public repository on GitHub (ticket 2.10: the step 3 page links each commit under it). */
export const appRepositoryUrl = (nickname: string): string => `https://github.com/${APPS_GITHUB_OWNER}/${appRepositoryName(nickname)}`;
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

/**
 * The build launcher (ticket 2.9): where it starts the builder's Fargate tasks. The cluster and the two public build
 * subnets (infra/lib/config.ts BUILDS_CLUSTER_NAME and BUILDS_SUBNET_IDS, kept equal by a test): IAM cannot pin RunTask
 * to subnets (no `ecs:subnet` key on RunTask), so the launcher names them itself, always with a public IP (the subnets
 * have no NAT gateway). The task definition's ARN and the security group's id change with deploys and come from the
 * function's environment (not secrets).
 */
export const BUILDS_CLUSTER_NAME = "ssd-workshop-builds";
export const BUILDS_SUBNET_IDS = ["subnet-05229d71b1e0b41ff", "subnet-0965bcee41d455dba"] as const;
/** The builder's container in the task definition `ssd-workshop-builder`: RunTask's overrides name it. */
export const BUILDER_CONTAINER_NAME = "builder";
/** The launch queue's dead-letter queue: the launcher's check marks the builds of its messages failed. */
export const BUILD_DLQ_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/ssd-workshop-builds-dlq.fifo`;
/** The deploy queue's dead-letter queue: the launcher's check marks the builds of its messages failed. */
export const DEPLOY_DLQ_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/ssd-workshop-deploys-dlq.fifo`;
/** The queue EventBridge Scheduler fills every minute to run the launcher's stuck-build check (ticket 2.9). */
export const BUILD_CHECK_QUEUE_NAME = "ssd-workshop-builds-check";
/**
 * A claimed build with no task yet (the launcher stopped between its claim and RunTask) is marked failed by the check
 * after this long: well past the launcher's own timeout, so a launch still under way is never cut off.
 */
export const LAUNCH_UNSTARTED_MS = 20 * 60 * 1000;
/** A build task running longer than this is stopped by the check (the agent alone stops at 12 minutes). */
export const BUILD_TASK_MAX_MS = 30 * 60 * 1000;
/**
 * Ticket 3.14 try 2 (checker A): a builds-cluster task whose network interface names no subnet yet is left alone by the
 * minute check while it is younger than this (from its `createdAt`): a fresh Fargate task may still be PROVISIONING, and
 * a task with no subnet has no network to misuse. After it, a task still without a subnet is stopped.
 */
export const OUTSIDE_NO_SUBNET_GRACE_MS = 5 * 60 * 1000;
/** Ticket 3.14 try 2 (checker B): the minute check reads at most this many ListTasks pages (100 tasks each) per status. */
export const CLUSTER_LIST_MAX_PAGES = 10;
/**
 * A build still `building` with a pushed commit (the builder handed it over) whose task has stopped is waiting for the
 * deployer to take its message (the deployer moves it to `deploying`). After this long since the task stopped, no
 * deploy will come (the message was lost, or never sent and the builder died), and the check marks it failed (ticket
 * 2.9 try 2, checker 1). Longer than every delivery of a deploy message (3 deliveries, 150 s visibility, a 120 s
 * deployer: about 7 minutes; tested in infra/lib/app.test.ts).
 */
export const HANDED_OVER_GRACE_MS = 20 * 60 * 1000;
/**
 * Ticket 3.4: a build that finds no free slot stays `queued` and its launch message comes back after this many seconds
 * (the launcher sets the message's visibility and reports it as a batch item failure).
 */
export const LAUNCH_WAIT_SECONDS = 30;
/**
 * Ticket 3.4: a waiting entry counts as "ahead" (on the page, and for the start order) only while its message was seen
 * within this long. A waiting message comes back every LAUNCH_WAIT_SECONDS, or after the launch queue's visibility
 * timeout (150 s) when setting its visibility failed or a launcher was busy; 4 minutes is above both, so a busy launcher
 * never lets a later build pass an earlier one, and an entry not seen for 4 minutes belongs to a build whose message is
 * gone (dead-lettered, or the build was retried or reset): it never blocks the line for longer (try 2: was 2 minutes).
 */
export const QUEUE_SEEN_MS = 4 * 60 * 1000;
/**
 * Ticket 3.4 try 2: a build still `queued` this long after the launcher first placed it in the waiting line (its
 * `queueKey` time) is failed by the minute check (QUEUE_TIMEOUT_REASON in ../launcher/launcher.ts). Longer than the
 * longest sensible wait (about 40 participants at a lowered cap of 3, each build up to 12 minutes plus its deploy: about
 * 3.5 hours at worst), far shorter than the 42 hours a launch message the launcher keeps failing on takes to reach the
 * dead-letter queue, and shorter than a waiting message's life (1,000 deliveries every 30 s, over 8 hours).
 */
export const QUEUE_WAIT_MAX_MS = 4 * 60 * 60 * 1000;
/**
 * Ticket 3.4 try 2: after this many consecutive minute checks whose repair of the slot counter was refused because its
 * `version` moved (a claim or release in between), the next repair writes without that condition, so a writer that
 * keeps moving the version cannot hold a wrong counter forever.
 */
export const SLOT_REPAIR_FORCE_AFTER = 3;

/**
 * Ticket 3.10: the table's sparse index by `listType` (infra/lib/config.ts BY_TYPE_INDEX_NAME), which only the facilitator
 * function queries (profiles, conversations, usage totals and builds, never the allow-list).
 */
export const BY_TYPE_INDEX_NAME = "ssd-workshop-by-type";
/**
 * Ticket 3.10: the index's partition key: the same value as `type`, written only on profiles, conversations, usage
 * totals and builds (the index is sparse; an allow-list entry, a code or a session is never in it).
 */
export const BY_TYPE_INDEX_KEY = "listType";
/** Ticket 3.10: a build `building` for longer than this is stuck: the dashboard marks it and Retry may restart it. */
export const STUCK_BUILD_MS = 15 * 60 * 1000;
/**
 * Ticket 3.10: a retry request the launcher's check could not act on yet (a build still handing over or deploying) is
 * dropped after this long, so a build that later fails is never restarted by a forgotten press.
 */
export const RETRY_REQUEST_MAX_MS = 30 * 60 * 1000;
/** Ticket 3.10: what one press of Add budget grants, in dollars (set by the server, never read from the request). */
export const BUDGET_STEP_USD = 2;
