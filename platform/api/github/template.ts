/**
 * The app template's files as the repository's first commit takes them (ticket 2.6). The GitHub module takes the
 * file list as input; this loader reads it from the repository's `templates/basic` folder (scripts, tests). The
 * build launcher Lambda (ticket 2.9) has no repository folder: its bundle carries the template's files (`template/`
 * next to its code) and reads them with ./template-files.ts.
 */
import { fileURLToPath } from "node:url";
import type { RepositoryFile } from "./repository.js";
import { readTemplateFolder } from "./template-files.js";

/** templates/basic in this repository. */
export const templateDir = (): string => fileURLToPath(new URL("../../../templates/basic/", import.meta.url));

/** Every plain file of the folder (folders are implied by paths); anything else (a symlink) fails. */
export function loadTemplateFiles(dir: string = templateDir()): Promise<RepositoryFile[]> {
  return readTemplateFolder(dir);
}
