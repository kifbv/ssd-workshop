import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ACCOUNT, DEPLOY_ROLE_ARN, DOMAIN, REGION, STACK_NAMES } from "./config.js";
import { deploySettings, firstHeading, toGitHubOutput } from "./deploy-settings.js";

const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  "working-directory"?: string;
}

interface Job {
  environment?: unknown;
  permissions?: unknown;
  steps: Step[];
}

interface Workflow {
  on: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  jobs: Record<string, Job>;
}

const DEPLOY_PATH = ".github/workflows/deploy.yml";
const deployText = repoFile(DEPLOY_PATH);
const deploy = parse(deployText) as Workflow;
const ci = parse(repoFile(".github/workflows/ci.yml")) as Workflow;
const deployJobs = Object.values(deploy.jobs);
const deploySteps = deployJobs.flatMap((job) => job.steps);

describe("deploy workflow (ticket 0.5)", () => {
  it("runs only on a push to main", () => {
    expect(deploy.on).toEqual({ push: { branches: ["main"] } });
  });

  it("asks only for an OIDC token and read access to the code", () => {
    expect(deploy.permissions).toEqual({ "id-token": "write", contents: "read" });
    for (const job of deployJobs) expect(job.permissions).toBeUndefined();
  });

  it("uses no GitHub environment (the role trusts the main ref subject only)", () => {
    for (const job of deployJobs) expect(job.environment).toBeUndefined();
  });

  it("never runs two deploys at once and never cancels a running one", () => {
    expect(deploy.concurrency).toEqual({ group: "deploy", "cancel-in-progress": false });
  });

  it("reads no secrets and holds no AWS access keys", () => {
    expect(deployText).not.toMatch(/secrets\./);
    expect(deployText).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
    expect(deployText).not.toMatch(/aws-access-key-id|aws-secret-access-key/);
  });

  it("checks out without persisting the GitHub token", () => {
    const checkout = deploySteps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("assumes the role through OIDC with the ARN and region from config.ts", () => {
    const settings = deploySteps.find((step) => step.run?.includes("print-deploy-settings.ts"));
    expect(settings?.run).toContain(">> \"$GITHUB_OUTPUT\"");

    const creds = deploySteps.filter((step) =>
      step.uses?.startsWith("aws-actions/configure-aws-credentials@"),
    );
    expect(creds).toHaveLength(1);
    const withs = creds[0]?.with ?? {};
    expect(Object.keys(withs).sort()).toEqual(
      ["aws-region", "role-session-name", "role-to-assume"].sort(),
    );
    expect(withs["role-to-assume"]).toMatch(/^\$\{\{ steps\.\w+\.outputs\.role_arn \}\}$/);
    expect(withs["aws-region"]).toMatch(/^\$\{\{ steps\.\w+\.outputs\.region \}\}$/);
    expect(withs["role-session-name"]).toMatch(/^ssd-workshop-deploy-/);
  });

  it("assumes the role before it deploys, and deploys after the unit tests", () => {
    const index = (match: (step: Step) => boolean): number => deploySteps.findIndex(match);
    const tests = index((step) => step.run === "npm test");
    const creds = index((step) => !!step.uses?.startsWith("aws-actions/configure-aws-credentials@"));
    const cdk = index((step) => !!step.run?.includes("cdk deploy --all"));
    expect(tests).toBeGreaterThanOrEqual(0);
    expect(creds).toBeGreaterThan(tests);
    expect(cdk).toBeGreaterThan(creds);
  });

  it("runs cdk deploy --all without an approval prompt, from infra/", () => {
    const cdk = deploySteps.filter((step) => step.run?.includes("cdk deploy"));
    expect(cdk).toHaveLength(1);
    expect(cdk[0]?.run).toContain("cdk deploy --all --require-approval never");
    expect(cdk[0]?.["working-directory"]).toBe("infra");
  });

  it("checks the live page for the heading after the deploy", () => {
    const cdk = deploySteps.findIndex((step) => !!step.run?.includes("cdk deploy"));
    const smoke = deploySteps.findIndex((step) => !!step.run?.includes("curl"));
    expect(smoke).toBeGreaterThan(cdk);
    const env = deploySteps[smoke]?.env ?? {};
    expect(env["SITE_URL"]).toMatch(/outputs\.site_url/);
    expect(env["HEADING"]).toMatch(/outputs\.heading/);
  });

  it("calls GET /api/health on the API's own endpoint after the deploy (ticket 1.1 criterion 3)", () => {
    const cdk = deploySteps.findIndex((step) => !!step.run?.includes("cdk deploy"));
    const health = deploySteps.findIndex((step) => !!step.run?.includes("/api/health"));
    expect(health).toBeGreaterThan(cdk);
    const step = deploySteps[health];
    expect(step?.env?.["API_STACK"]).toMatch(/outputs\.api_stack/);
    // Reads only the workshop API stack's ApiEndpoint output, and expects exactly {"ok":true}.
    expect(step?.run).toContain('--stack-name "$API_STACK"');
    expect(step?.run).toContain("OutputKey=='ApiEndpoint'");
    expect(step?.run).toContain(`'{"ok":true}'`);
  });

  it("pins every action to a major version", () => {
    for (const step of deploySteps.filter((s) => s.uses)) {
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@v\d+$/);
    }
  });
});

describe("deploy settings", () => {
  it("come from config.ts and the placeholder page", () => {
    const settings = deploySettings();
    expect(settings.roleArn).toBe(DEPLOY_ROLE_ARN);
    expect(DEPLOY_ROLE_ARN).toBe(`arn:aws:iam::${ACCOUNT}:role/ssd-workshop-deploy`);
    expect(settings.region).toBe(REGION);
    expect(settings.siteUrl).toBe(`https://${DOMAIN}/`);
    expect(settings.heading).toBe("SSD Workshop, coming soon");
    expect(settings.apiStack).toBe("ssd-workshop-api");
  });

  it("print as GITHUB_OUTPUT lines", () => {
    const out = toGitHubOutput(deploySettings());
    expect(out.trimEnd().split("\n")).toEqual([
      `role_arn=${DEPLOY_ROLE_ARN}`,
      `region=${REGION}`,
      `site_url=https://${DOMAIN}/`,
      "heading=SSD Workshop, coming soon",
      `api_stack=${STACK_NAMES.api}`,
    ]);
  });

  it("take the heading text without markup", () => {
    expect(firstHeading('<h1 class="x">\n  Hello <em>there</em>\n</h1>')).toBe("Hello there");
    expect(() => firstHeading("<p>no heading</p>")).toThrow();
  });
});

describe("CI workflow", () => {
  it("still gets no OIDC token (pull requests never reach AWS)", () => {
    expect(JSON.stringify(ci)).not.toMatch(/id-token/);
    expect(ci.permissions).toEqual({ contents: "read" });
  });
});
