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

/** The queue that hands a stored message to the AI worker (ticket 1.7); it carries ids only. */
export const AI_QUEUE_NAME = "ssd-workshop-ai-messages";
export const AI_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${AI_QUEUE_NAME}`;
