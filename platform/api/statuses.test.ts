import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every non-test TypeScript source under platform/api. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the API never answers 403 (ticket 2.5: the distribution shows every 403 as the plain 404 page)", () => {
  it("has no 403 in any API source", () => {
    const files = sources(API_DIR);
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((file) => relative(API_DIR, file))).toContain("http.ts");
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text.match(/\b403\b|\bForbidden\b/g), relative(API_DIR, file)).toBeNull();
    }
  });
});
