import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPLOY_ROLE_ARN, DOMAIN, HOSTED_ZONE_ID, REGION, STACK_NAMES } from "./config.js";

/** The sign-in page source; the site stack publishes its build (same HTML). */
const INDEX_HTML = fileURLToPath(new URL("../../platform/web/index.html", import.meta.url));

export interface DeploySettings {
  /** Role the deploy workflow assumes through OIDC. */
  roleArn: string;
  /** Region for the AWS credentials; each stack carries its own region. */
  region: string;
  /** Page the smoke check requests after the deploy. */
  siteUrl: string;
  /** Text of the page's first <h1>; the smoke check expects it on the live page. */
  heading: string;
  /** Stack whose `ApiEndpoint` output the API health check reads. */
  apiStack: string;
  /** rankly.games zone, snapshotted before and after the deploy (no record may change). */
  hostedZoneId: string;
}

/** Returns the text of the first <h1> of an HTML document, whitespace collapsed. */
export function firstHeading(html: string): string {
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const text = match?.[1]?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("no <h1> heading found");
  return text;
}

/** Deploy workflow settings, all derived from config.ts and the page itself. */
export function deploySettings(): DeploySettings {
  return {
    roleArn: DEPLOY_ROLE_ARN,
    region: REGION,
    siteUrl: `https://${DOMAIN}/`,
    heading: firstHeading(readFileSync(INDEX_HTML, "utf8")),
    apiStack: STACK_NAMES.api,
    hostedZoneId: HOSTED_ZONE_ID,
  };
}

/** `key=value` lines for `$GITHUB_OUTPUT`. */
export function toGitHubOutput(settings: DeploySettings): string {
  return [
    `role_arn=${settings.roleArn}`,
    `region=${settings.region}`,
    `site_url=${settings.siteUrl}`,
    `heading=${settings.heading}`,
    `api_stack=${settings.apiStack}`,
    `hosted_zone_id=${settings.hostedZoneId}`,
    "",
  ].join("\n");
}
