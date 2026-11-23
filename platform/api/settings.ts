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
