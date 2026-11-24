// Ticket 2.9: the builder's image bundle (./bundle.ts, as platform/builder/Dockerfile runs it) starts on its own, reads
// its job from the environment and keeps the Claude Agent SDK outside the bundle.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleOptions } from "./bundle.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let dir: string;
let outfile: string;

beforeAll(async () => {
  // Inside the repository's node_modules, so Node finds the SDK the way the image places it (node_modules beside it).
  const cache = join(ROOT, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, "ssd-builder-bundle-"));
  outfile = join(dir, "main.mjs");
  await build(bundleOptions(outfile));
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (env: Record<string, string>) => spawnSync(process.execPath, [outfile], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 20_000 });

describe("the builder's image bundle (ticket 2.9)", () => {
  it("imports the Claude Agent SDK from beside it instead of bundling it", () => {
    const code = readFileSync(outfile, "utf8");
    expect(code).toMatch(/from "@anthropic-ai\/claude-agent-sdk"/);
  });

  it("starts, and refuses a job without BUILD_ID or BUILDER_GITHUB_TOKEN with exit code 1, naming only the variable", () => {
    const none = run({});
    expect(none.status).toBe(1);
    expect(none.stderr.trim()).toBe(JSON.stringify({ event: "builder", phase: "start", outcome: "error", error: "BUILD_ID is missing or not a build id" }));
    const noToken = run({ BUILD_ID: "b-1" });
    expect(noToken.status).toBe(1);
    expect(noToken.stderr).toContain("BUILDER_GITHUB_TOKEN is missing");
    expect(noToken.stdout).toBe("");
  });

  it("is what the Dockerfile builds and runs", () => {
    const dockerfile = readFileSync(join(ROOT, "platform/builder/Dockerfile"), "utf8");
    expect(dockerfile).toContain("RUN npx tsx platform/builder/bundle.ts /out/main.mjs");
    expect(dockerfile).toContain('CMD ["node", "/app/main.mjs"]');
    expect(dockerfile).toContain("USER node");
    // No secret or token is baked into the image.
    expect(dockerfile).not.toMatch(/^\s*(ENV|ARG)\s+[A-Z_]*(TOKEN|SECRET|KEY)/m);
  });
});
