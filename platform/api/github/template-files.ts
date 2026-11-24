/**
 * Reads an app template folder as the repository's first commit takes it (ticket 2.6). Kept apart from ./template.ts
 * (which finds the repository's own `templates/basic` through `import.meta.url`) so the launcher's CommonJS bundle
 * (ticket 2.9), which passes the folder bundled next to its code, holds no `import.meta`.
 */
import { readAppFolder } from "../build/check.js";
import { GitHubProblem } from "./app.js";
import type { RepositoryFile } from "./repository.js";

/** Every plain file of the folder (folders are implied by paths), sorted by path; anything else (a symlink) fails. */
export async function readTemplateFolder(dir: string): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];
  for (const entry of await readAppFolder(dir)) {
    if (entry.kind === "dir") continue;
    if (entry.kind !== "file") throw new GitHubProblem("The template holds something other than plain files and folders.");
    files.push({ path: entry.path, bytes: entry.bytes });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
