/**
 * Bundles the builder (ticket 2.9) into one ES module for its container image (platform/builder/Dockerfile):
 * `tsx platform/builder/bundle.ts <out file>`. The Claude Agent SDK stays outside the bundle: it starts Claude Code from
 * its own package folder (and its platform package's binary), which the image copies next to the bundle.
 */
import { build, type BuildOptions } from "esbuild";
import { fileURLToPath } from "node:url";

export const BUILDER_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));
/** Packages the image installs beside the bundle instead of bundling them. */
export const BUILDER_EXTERNAL = ["@anthropic-ai/claude-agent-sdk"] as const;

export function bundleOptions(outfile: string): BuildOptions {
  return {
    entryPoints: [BUILDER_ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: [...BUILDER_EXTERNAL],
    // Bundled CommonJS packages (the AWS SDK's dependencies) call require(): give the ES module one.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    minify: false,
    sourcemap: false,
    logLevel: "warning",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outfile = process.argv[2];
  if (outfile === undefined) {
    console.error("Usage: tsx platform/builder/bundle.ts <out file>");
    process.exitCode = 2;
  } else {
    await build(bundleOptions(outfile));
  }
}
