import { describe, expect, it } from "vitest";
import { appJwt, findInstallation, getApp, parseGitHubSecret, type GitHubDeps } from "../../api/github/app.js";
import { FAKE_TOKEN_PREFIX, FakeGitHub, TEST_PRIVATE_KEY_PEM, TEST_SECRET_TEXT } from "../../api/github/fakes.js";
import {
  CONFIGURATION_SET,
  DEFAULT_MODEL_ID,
  SIGN_IN_CODE_URL,
  USAGE,
  buildSignInRequest,
  buildTestEmail,
  findModelQuotas,
  formatGitHubReport,
  formatLatency,
  formatQuotaLine,
  formatSignInResult,
  maskEmail,
  modelQuotaLabel,
  parseArgs,
  proxyFromEnv,
  redactEmails,
  redactError,
  redactUrlCredentials,
  resolveModelId,
  type QuotaEntry,
} from "./logic.js";

describe("parseArgs", () => {
  it("accepts bedrock and quota with no further arguments", () => {
    expect(parseArgs(["bedrock"])).toEqual({ command: "bedrock" });
    expect(parseArgs(["quota"])).toEqual({ command: "quota" });
  });

  it("accepts ses with one address", () => {
    expect(parseArgs(["ses", "someone@example.com"])).toEqual({
      command: "ses",
      address: "someone@example.com",
    });
  });

  it("rejects ses without an address or with something that is not an address", () => {
    expect(parseArgs(["ses"])).toHaveProperty("error");
    expect(parseArgs(["ses", "not-an-address"])).toHaveProperty("error");
  });

  it("rejects an unknown command, no command and extra arguments", () => {
    expect(parseArgs(["deploy"])).toHaveProperty("error");
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["bedrock", "extra"])).toHaveProperty("error");
    expect(parseArgs(["ses", "a@b.com", "c@d.com"])).toHaveProperty("error");
  });
});

describe("CONFIGURATION_SET", () => {
  it("names the workshop's own SES configuration set", () => {
    expect(CONFIGURATION_SET).toBe("ssd-workshop-email");
  });
});

describe("resolveModelId", () => {
  it("defaults to the EU Sonnet inference profile", () => {
    expect(resolveModelId({})).toBe(DEFAULT_MODEL_ID);
    expect(DEFAULT_MODEL_ID).toBe("eu.anthropic.claude-sonnet-4-6");
  });

  it("takes SMOKE_MODEL_ID when it is an eu.anthropic.* profile", () => {
    expect(resolveModelId({ SMOKE_MODEL_ID: "eu.anthropic.claude-sonnet-4-6" })).toBe(
      "eu.anthropic.claude-sonnet-4-6",
    );
  });

  it("ignores an empty SMOKE_MODEL_ID", () => {
    expect(resolveModelId({ SMOKE_MODEL_ID: "" })).toBe(DEFAULT_MODEL_ID);
  });

  it("refuses a model that is not an EU inference profile", () => {
    expect(() => resolveModelId({ SMOKE_MODEL_ID: "anthropic.claude-sonnet-5-5" })).toThrow();
    expect(() => resolveModelId({ SMOKE_MODEL_ID: "us.anthropic.claude-sonnet-5-5" })).toThrow();
  });
});

describe("modelQuotaLabel", () => {
  it("turns an inference profile id into the quota name's model label", () => {
    expect(modelQuotaLabel("eu.anthropic.claude-sonnet-5-5")).toBe("Anthropic Claude Sonnet 5.5");
    expect(modelQuotaLabel("eu.anthropic.claude-sonnet-5")).toBe("Anthropic Claude Sonnet 5");
    expect(modelQuotaLabel("eu.anthropic.claude-haiku-5-5")).toBe("Anthropic Claude Haiku 5.5");
  });

  it("drops a date and version suffix", () => {
    expect(modelQuotaLabel("eu.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "Anthropic Claude Sonnet 4.5",
    );
  });

  it("returns undefined for an id it does not understand", () => {
    expect(modelQuotaLabel("eu.meta.llama3")).toBeUndefined();
  });
});

// Names copied from `aws service-quotas list-service-quotas --service-code bedrock` (2026-11-22).
const applied: QuotaEntry[] = [
  { code: "L-94A31E46", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5", value: 0 },
  { code: "L-31AB82D0", name: "Global cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5", value: 0 },
  { code: "L-D4FBCF4E", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5", value: 0 },
  { code: "L-F4DDD3EB", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1", value: 5000000 },
  { code: "L-8EA73537", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1 1M Context Length", value: 1000000 },
  { code: "L-4A6BFAB1", name: "Cross-region model inference requests per minute for Anthropic Claude Sonnet 4.5 V1", value: 50 },
  { code: "L-15B8E632", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.6", value: 6000000 },
  { code: "L-00FF3314", name: "Cross-region model inference requests per minute for Anthropic Claude Sonnet 4.6", value: 50 },
];
const defaults: QuotaEntry[] = [
  { code: "L-94A31E46", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5", value: 6000000 },
  { code: "L-D4FBCF4E", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5", value: 6000000 },
  { code: "L-00FF3314", name: "Cross-region model inference requests per minute for Anthropic Claude Sonnet 4.6", value: 50 },
];

describe("findModelQuotas", () => {
  it("finds the cross-region (not global) tokens quota of Sonnet 5.5 with applied and default values", () => {
    const result = findModelQuotas("eu.anthropic.claude-sonnet-5-5", applied, defaults);
    expect(result.tokens).toEqual({
      code: "L-94A31E46",
      name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5",
      applied: 0,
      default: 6000000,
    });
    expect(result.requests).toBeUndefined();
  });

  it("does not take Sonnet 5's quota for Sonnet 5.5 or the other way round", () => {
    expect(findModelQuotas("eu.anthropic.claude-sonnet-5", applied, defaults).tokens?.code).toBe("L-D4FBCF4E");
  });

  it("matches a V1 suffix but not the 1M context variant", () => {
    const result = findModelQuotas("eu.anthropic.claude-sonnet-4-5-20250929-v1:0", applied, []);
    expect(result.tokens?.code).toBe("L-F4DDD3EB");
    expect(result.requests?.code).toBe("L-4A6BFAB1");
    expect(result.tokens?.default).toBeUndefined();
  });

  it("finds both quotas of a model that has a requests-per-minute quota", () => {
    const result = findModelQuotas("eu.anthropic.claude-sonnet-4-6", applied, defaults);
    expect(result.tokens?.applied).toBe(6000000);
    expect(result.requests).toMatchObject({ applied: 50, default: 50 });
  });

  it("uses the default value alone when the account lists no applied value", () => {
    const result = findModelQuotas("eu.anthropic.claude-sonnet-5-5", [], defaults);
    expect(result.tokens).toMatchObject({ default: 6000000 });
    expect(result.tokens?.applied).toBeUndefined();
  });
});

describe("formatQuotaLine", () => {
  it("shows the applied value next to the AWS default", () => {
    expect(
      formatQuotaLine("Tokens per minute", { code: "L-1", name: "n", applied: 0, default: 6000000 }),
    ).toBe("Tokens per minute: 0 (applied to this account; AWS default 6,000,000) [L-1]");
  });

  it("says when only the default is known", () => {
    expect(formatQuotaLine("Tokens per minute", { code: "L-1", name: "n", default: 6000000 })).toBe(
      "Tokens per minute: 6,000,000 (AWS default; no applied value listed) [L-1]",
    );
  });

  it("says when the applied value has no known default", () => {
    expect(formatQuotaLine("Requests per minute", { code: "L-2", name: "n", applied: 50 })).toBe(
      "Requests per minute: 50 (applied to this account) [L-2]",
    );
  });

  it("says when there is no quota for the model", () => {
    expect(formatQuotaLine("Requests per minute", undefined)).toBe(
      "Requests per minute: no quota listed for this model in eu-central-1",
    );
  });
});

describe("maskEmail", () => {
  it("keeps the first letter of the local part and of the domain, and the top-level domain", () => {
    expect(maskEmail("franck@example.com")).toBe("f***@e***.com");
    expect(maskEmail("success@simulator.amazonses.com")).toBe("s***@s***.com");
    expect(maskEmail("a@b.co.uk")).toBe("a***@b***.uk");
  });

  it("never returns the full address", () => {
    const address = "jane.doe@company.org";
    expect(maskEmail(address)).not.toContain("jane.doe");
    expect(maskEmail(address)).not.toContain("company");
  });

  it("hides everything when the input is not an address", () => {
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
    expect(maskEmail("user@localhost")).toBe("***");
  });
});

describe("formatLatency", () => {
  it("prints milliseconds below one second and seconds above", () => {
    expect(formatLatency(850.4)).toBe("850 ms");
    expect(formatLatency(1234)).toBe("1.23 s");
    expect(formatLatency(0)).toBe("0 ms");
  });
});

describe("buildTestEmail", () => {
  it("builds a subject and a body holding the sample code", () => {
    const email = buildTestEmail("123456");
    expect(email.subject).toBe("SSD Workshop smoke test");
    expect(email.text).toContain("123456");
    expect(email.text).toMatch(/test/i);
  });

  it("refuses a code that is not six digits", () => {
    expect(() => buildTestEmail("12345")).toThrow();
    expect(() => buildTestEmail("abcdef")).toThrow();
  });
});

describe("redactEmails", () => {
  it("masks every address inside a message", () => {
    expect(
      redactEmails("Email address is not verified: jane@company.org, bob@example.co.uk."),
    ).toBe("Email address is not verified: j***@c***.org, b***@e***.uk.");
  });

  it("leaves a message without addresses unchanged", () => {
    expect(redactEmails("Throttling: rate exceeded")).toBe("Throttling: rate exceeded");
  });
});

describe("redactUrlCredentials", () => {
  it("replaces user and password in a URL with ***", () => {
    expect(redactUrlCredentials("connect ECONNREFUSED http://bob:s3cret@proxy.local:8080/x")).toBe(
      "connect ECONNREFUSED http://***@proxy.local:8080/x",
    );
  });

  it("replaces a user-only credential and works on every URL in the text", () => {
    expect(redactUrlCredentials("a https://token@h.io and socks5://u:p@10.0.0.1")).toBe(
      "a https://***@h.io and socks5://***@10.0.0.1",
    );
  });

  it("leaves URLs without credentials unchanged", () => {
    const text = "https://bedrock-runtime.eu-central-1.amazonaws.com/model/x?a=b@c";
    expect(redactUrlCredentials(text)).toBe(text);
  });
});

describe("redactError", () => {
  it("strips URL credentials and masks addresses in one pass", () => {
    expect(redactError("proxy http://user:pw@proxy.example.com failed for jane@company.org")).toBe(
      "proxy http://***@proxy.example.com failed for j***@c***.org",
    );
  });
});

describe("proxyFromEnv", () => {
  it("reads HTTPS_PROXY", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "http://p:1" })).toBe("http://p:1");
  });

  it("reads lowercase https_proxy", () => {
    expect(proxyFromEnv({ https_proxy: "http://p:2" })).toBe("http://p:2");
  });

  it("returns undefined when neither is set or both are empty", () => {
    expect(proxyFromEnv({})).toBeUndefined();
    expect(proxyFromEnv({ HTTPS_PROXY: "", https_proxy: "" })).toBeUndefined();
  });
});

describe("USAGE", () => {
  it("tells the operator to run the command silently", () => {
    expect(USAGE).toContain("npm run -s smoke -- <command>");
  });
});

describe("signin (ticket 1.4 criterion 6)", () => {
  it("parses one address, trimmed and lower-cased like the API does", () => {
    expect(parseArgs(["signin", " Franck@Example.com "])).toEqual({ command: "signin", address: "franck@example.com" });
  });

  it("rejects a missing address, extra arguments and something the API would refuse", () => {
    expect(parseArgs(["signin"])).toEqual({ error: "signin needs an email address" });
    expect(parseArgs(["signin", "a@b.com", "c@d.com"])).toEqual({ error: "signin takes exactly one address" });
    for (const bad of ["not-an-address", "a@b", "ja#ne@example.com", "jösé@example.com"]) {
      expect(parseArgs(["signin", bad]), bad).toEqual({ error: "the signin argument is not an email address" });
    }
  });

  it("errors never contain the address", () => {
    const parsed = parseArgs(["signin", "secret.person@example"]);
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("POSTs {\"email\"} as JSON to the live code route", () => {
    expect(SIGN_IN_CODE_URL).toBe("https://workshop.rankly.games/api/sign-in/code");
    expect(buildSignInRequest("franck@example.com")).toEqual({
      url: "https://workshop.rankly.games/api/sign-in/code",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"email":"franck@example.com"}',
      },
    });
  });

  it("prints the status and the neutral answer, the address only masked", () => {
    const out = formatSignInResult("franck@example.com", 202, JSON.stringify({ message: "If this address is on the list..." }));
    expect(out).toBe(
      [
        "Asked https://workshop.rankly.games/api/sign-in/code for a code for f***@e***.com",
        "Status: 202",
        "Answer: If this address is on the list...",
      ].join("\n"),
    );
    expect(out).not.toContain("franck@");
  });

  it("prints a non-JSON answer shortened and redacted", () => {
    const out = formatSignInResult("franck@example.com", 502, `<html>bad gateway for franck@example.com${"x".repeat(600)}</html>`);
    expect(out).toContain("Status: 502");
    expect(out).toContain("f***@e***.com");
    expect(out).not.toContain("franck@");
    expect(out.length).toBeLessThan(700);
    expect(formatSignInResult("a@b.com", 500, "")).toContain("Answer: (empty)");
  });

  it("is listed in the usage text", () => {
    expect(USAGE).toContain("signin <address>");
  });
});

describe("smoke github (ticket 2.6 criterion 6)", () => {
  it("parses github with no arguments", () => {
    expect(parseArgs(["github"])).toEqual({ command: "github" });
    expect(parseArgs(["github", "extra"])).toHaveProperty("error");
    expect(USAGE).toContain("github");
  });

  it("reports the app, the account the secret reaches and its rights, and prints no token, JWT or key", async () => {
    const now = new Date("2026-11-24T10:00:00Z");
    const github = new FakeGitHub(() => now);
    const deps: GitHubDeps = { fetch: github.fetch, now: () => now, log: () => undefined };
    const jwt = appJwt(parseGitHubSecret(TEST_SECRET_TEXT), now);
    const report = formatGitHubReport(await getApp(deps, jwt), await findInstallation(deps, jwt));
    expect(report).toBe(
      [
        "Secret:        ssd-workshop-github (eu-central-1)",
        "GitHub App:    SSD Workshop GH App (ssd-workshop-gh-app), owned by ssd-workshop-apps",
        "Installed on:  ssd-workshop-apps (Organization), installation 9001",
        "Repositories:  all repositories of the account",
        "Rights:        administration: write, contents: write, metadata: read",
      ].join("\n"),
    );
    // The check signs a JWT but mints no installation token.
    expect(github.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /app", "GET /orgs/ssd-workshop-apps/installation"]);
    expect(report).not.toContain(jwt);
    expect(report).not.toContain("eyJ");
    expect(report).not.toContain(FAKE_TOKEN_PREFIX);
    expect(report).not.toContain("PRIVATE KEY");
    expect(report).not.toContain(TEST_PRIVATE_KEY_PEM.split("\n")[1] ?? "?");
  });
});
