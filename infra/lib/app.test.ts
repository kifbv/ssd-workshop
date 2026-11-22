import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, REGION } from "./app.js";

describe("buildApp", () => {
  let outdir: string | undefined;

  afterEach(() => {
    if (outdir) rmSync(outdir, { recursive: true, force: true });
  });

  it("synthesizes the site stack in eu-central-1 without the CDK bootstrap", () => {
    const dir = mkdtempSync(join(tmpdir(), "ssd-workshop-cdk-"));
    outdir = dir;
    const assembly = buildApp({ outdir: dir }).synth();

    const stack = assembly.getStackByName("ssd-workshop-site");
    expect(stack.environment.region).toBe(REGION);
    // The default synthesizer adds a BootstrapVersion parameter that needs the
    // account-wide cdk-hnb659fds bootstrap; ours must not.
    expect(stack.template.Parameters?.BootstrapVersion).toBeUndefined();
    expect(stack.tags).toEqual({ project: "ssd-workshop" });
  });
});
