import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

/** The pages' sources: static files plus TypeScript under src/. */
export const WEB_SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Files published as they are, next to the built app.js. `404.html` (ticket 2.5) is the plain page CloudFront
 * shows for an address that does not exist (S3 answers a missing key with 403; the distribution turns it into
 * this page with status 404), under `/apps/*` and on the site alike: no script, no stylesheet.
 * `facilitator/index.html` (ticket 3.11) is the facilitator dashboard at `/facilitator/` (the distribution's
 * `ssd-workshop-site-index` function asks the bucket for `index.html` in that folder). `app-sign-in/index.html`
 * (ticket 3.24) is the hand-off page for saving in apps at `/app-sign-in/`, served the same way.
 */
export const STATIC_FILES = ["index.html", "style.css", "404.html", "facilitator/index.html", "app-sign-in/index.html"] as const;

/**
 * The scripts esbuild bundles: the page's own, the diagram drawer (Mermaid, ticket 1.9), loaded only at step 2, and
 * the facilitator dashboard's (ticket 3.11), loaded only by its page, and the hand-off page's (ticket 3.24).
 */
export const SCRIPTS = {
  "app.js": "main.ts",
  "diagram.js": "diagram.ts",
  "facilitator/dashboard.js": "facilitator.ts",
  // Ticket 3.24: the hand-off page's own script.
  "app-sign-in/app-sign-in.js": "app-sign-in.ts",
} as const;

/**
 * Builds the site into `outDir`: the static files, `app.js` bundled by esbuild from src/main.ts, and
 * `diagram.js` from src/diagram.ts (no TypeScript sources, tests or build files). Used by the site
 * stack at synth time, by the browser tests and by `npm run eval -- spec`, so all of them publish and
 * test the same output. Returns `outDir`.
 */
export function buildWeb(outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  for (const file of STATIC_FILES) {
    mkdirSync(dirname(join(outDir, file)), { recursive: true });
    copyFileSync(join(WEB_SOURCE_DIR, file), join(outDir, file));
  }
  for (const [outfile, entry] of Object.entries(SCRIPTS)) {
    buildSync({
      entryPoints: [join(WEB_SOURCE_DIR, "src", entry)],
      outfile: join(outDir, outfile),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2020"],
      minify: true,
      legalComments: "none",
      logLevel: "silent",
    });
  }
  return outDir;
}
