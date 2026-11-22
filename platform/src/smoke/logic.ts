// Pure logic of the smoke checks: no AWS calls here, so every rule is unit tested.

export const REGION = "eu-central-1";
export const SENDER = "ssd-workshop@rankly.games";
export const DEFAULT_MODEL_ID = "eu.anthropic.claude-sonnet-4-6";

export const USAGE = `Usage: npm run -s smoke -- <command>

Commands:
  bedrock          ask Claude on Bedrock (EU inference profile) for a short answer and print the latency
  quota            print the model's tokens-per-minute and requests-per-minute quotas in ${REGION}
  ses <address>    send a test email from ${SENDER} to <address>

Environment:
  SMOKE_MODEL_ID   inference profile to use (default ${DEFAULT_MODEL_ID}); must start with eu.anthropic.

Keep the -s: without it npm echoes the command line, recipient address included.`;

export type SmokeCommand =
  | { command: "bedrock" }
  | { command: "quota" }
  | { command: "ses"; address: string };

export function parseArgs(args: readonly string[]): SmokeCommand | { error: string } {
  const [command, ...rest] = args;
  switch (command) {
    case "bedrock":
    case "quota":
      return rest.length === 0 ? { command } : { error: `${command} takes no arguments` };
    case "ses": {
      const [address, ...extra] = rest;
      if (address === undefined) return { error: "ses needs a recipient address" };
      if (extra.length > 0) return { error: "ses takes exactly one address" };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
        return { error: "the ses argument is not an email address" };
      }
      return { command: "ses", address };
    }
    case undefined:
      return { error: "no command given" };
    default:
      return { error: "unknown command" };
  }
}

export function resolveModelId(env: Readonly<Record<string, string | undefined>>): string {
  const modelId = env["SMOKE_MODEL_ID"] || DEFAULT_MODEL_ID;
  if (!modelId.startsWith("eu.anthropic.")) {
    throw new Error(`SMOKE_MODEL_ID must be an EU inference profile (eu.anthropic.*), got ${modelId}`);
  }
  return modelId;
}

const FAMILY_ID = /^(?:[a-z]+\.)?anthropic\.claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?(?:-v\d+(?::\d+)?)?$/;

/** "eu.anthropic.claude-sonnet-5-5" -> "Anthropic Claude Sonnet 5.5", as Service Quotas names it. */
export function modelQuotaLabel(modelId: string): string | undefined {
  const match = FAMILY_ID.exec(modelId);
  if (!match) return undefined;
  const [, family = "", major = "", minor] = match;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return `Anthropic Claude ${name} ${minor === undefined ? major : `${major}.${minor}`}`;
}

export interface QuotaEntry {
  code: string;
  name: string;
  value: number;
}

export interface ModelQuota {
  code: string;
  name: string;
  applied?: number;
  default?: number;
}

export interface ModelQuotas {
  tokens?: ModelQuota;
  requests?: ModelQuota;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the cross-region (geographic, as eu.* profiles are) per-minute quotas of the model.
 * "Global cross-region" quotas and "1M Context Length" variants are left out; a " V1" suffix is allowed.
 */
export function findModelQuotas(
  modelId: string,
  applied: readonly QuotaEntry[],
  defaults: readonly QuotaEntry[],
): ModelQuotas {
  const label = modelQuotaLabel(modelId);
  if (label === undefined) return {};
  const find = (kind: "tokens" | "requests"): ModelQuota | undefined => {
    const pattern = new RegExp(
      `^Cross-region model inference ${kind} per minute for ${escapeRegExp(label)}( V\\d+)?$`,
    );
    const a = applied.find((q) => pattern.test(q.name));
    const d = defaults.find((q) => pattern.test(q.name) || (a !== undefined && q.code === a.code));
    const base = a ?? d;
    if (base === undefined) return undefined;
    return {
      code: base.code,
      name: base.name,
      ...(a !== undefined && { applied: a.value }),
      ...(d !== undefined && { default: d.value }),
    };
  };
  const tokens = find("tokens");
  const requests = find("requests");
  return { ...(tokens && { tokens }), ...(requests && { requests }) };
}

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatQuotaLine(label: string, quota: ModelQuota | undefined): string {
  if (quota === undefined) return `${label}: no quota listed for this model in ${REGION}`;
  const tag = `[${quota.code}]`;
  if (quota.applied === undefined) {
    return `${label}: ${number.format(quota.default ?? 0)} (AWS default; no applied value listed) ${tag}`;
  }
  const defaultPart = quota.default === undefined ? "" : `; AWS default ${number.format(quota.default)}`;
  return `${label}: ${number.format(quota.applied)} (applied to this account${defaultPart}) ${tag}`;
}

/** "franck@example.com" -> "f***@e***.com": enough to recognise, never the full address. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (dot <= 0 || dot === domain.length - 1) return "***";
  return `${local.charAt(0)}***@${domain.charAt(0)}***${domain.slice(dot)}`;
}

/**
 * Masks every address in a text (error messages from SES can echo the recipient).
 * `/` and `*` are not taken as part of an address, so an already redacted `scheme://***@host` stays.
 */
export function redactEmails(text: string): string {
  return text.replace(/[^\s@<>"',;:()/*]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (m) => maskEmail(m));
}

/** "https://user:secret@host" -> "https://***@host": credentials in URLs never reach the output. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1***@");
}

/** Everything printed from an error goes through this: URL credentials, then addresses. */
export function redactError(text: string): string {
  return redactEmails(redactUrlCredentials(text));
}

/** The proxy the session asks for, upper or lower case (curl and Node read both). */
export function proxyFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return env["HTTPS_PROXY"] || env["https_proxy"] || undefined;
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function buildTestEmail(code: string): { subject: string; text: string } {
  if (!/^\d{6}$/.test(code)) throw new Error("the sample code must be six digits");
  return {
    subject: "SSD Workshop smoke test",
    text: [
      "This is a test email from the SSD Workshop smoke check.",
      "",
      `Your sign-in code would look like this: ${code}`,
      "",
      "It is a sample, not a real code. You can ignore this email.",
    ].join("\n"),
  };
}
