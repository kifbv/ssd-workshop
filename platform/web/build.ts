import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

/** The pages' sources: static files plus TypeScript under src/. */
export const WEB_SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Files published as they are, next to the built app.js. */
export const STATIC_FILES = ["index.html", "style.css"] as const;

/**
 * Builds the site into `outDir`: the static files and `app.js`, one script bundled by esbuild
 * from src/main.ts (no TypeScript sources, tests or build files). Used by the site stack at synth
 * time and by the browser tests, so both publish and test the same output. Returns `outDir`.
 */
export function buildWeb(outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  for (const file of STATIC_FILES) copyFileSync(join(WEB_SOURCE_DIR, file), join(outDir, file));
  buildSync({
    entryPoints: [join(WEB_SOURCE_DIR, "src", "main.ts")],
    outfile: join(outDir, "app.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    logLevel: "silent",
  });
  return outDir;
}
