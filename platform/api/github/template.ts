/**
 * The app template's files as the repository's first commit takes them (ticket 2.6). The GitHub module takes the
 * file list as input; this loader reads it from the repository's `templates/basic` folder (scripts, tests). The
 * build launcher Lambda (ticket 2.9) has no repository folder: it must bundle the template's files and pass them
 * in the same shape.
 */
import { fileURLToPath } from "node:url";
import { readAppFolder } from "../build/check.js";
import { GitHubProblem } from "./app.js";
import type { RepositoryFile } from "./repository.js";

/** templates/basic in this repository. */
export const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/basic/", import.meta.url));

/** Every plain file of the folder (folders are implied by paths); anything else (a symlink) fails. */
export async function loadTemplateFiles(dir: string = TEMPLATE_DIR): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];
  for (const entry of await readAppFolder(dir)) {
    if (entry.kind === "dir") continue;
    if (entry.kind !== "file") throw new GitHubProblem("The template holds something other than plain files and folders.");
    files.push({ path: entry.path, bytes: entry.bytes });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
