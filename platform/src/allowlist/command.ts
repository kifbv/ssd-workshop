// The allow-list command with its outside world passed in (file system reads, store, output),
// so the whole flow is tested against an in-memory store. ./main.ts wires in the real ones.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  USAGE,
  formatImportReport,
  formatListReport,
  formatRemoveReport,
  isInside,
  parseArgs,
  parseCsv,
  redactError,
} from "./logic.js";
import type { AllowListStore } from "./store.js";

export interface CommandDeps {
  /** Real path of the repository root: CSV files inside it are refused, with or without git. */
  repoRoot: string;
  /** Called only once the arguments and the file are accepted, so a refusal makes no AWS call. */
  createStore: () => AllowListStore;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Walks up from `start` to the directory whose package.json declares workspaces (the monorepo root). */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown };
      if (parsed.workspaces !== undefined) return realpathSync.native(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repository root not found");
    dir = parent;
  }
}

/**
 * True when `dir` or any folder above it holds a `.git` entry: a folder in a normal clone, a plain
 * file in a work tree or submodule. No git subprocess, so no git environment variable, missing git
 * or "dubious ownership" error can turn the answer into a false "not in a repository".
 */
export function isInGitWorkTree(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, ".git");
    // existsSync follows symlinks and says false for a broken one; lstatSync then decides the kind.
    if (existsSync(candidate)) {
      const stats = lstatSync(candidate, { throwIfNoEntry: false });
      if (stats !== undefined && (stats.isDirectory() || stats.isFile() || stats.isSymbolicLink())) return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

const NOT_ABSOLUTE = "Refused: give an absolute path to the CSV file.";
const IN_REPO = "Refused: the CSV file is inside the repository. Keep it outside, so personal data never reaches git.";
const IN_GIT = "Refused: the CSV file is inside a git repository. Keep it outside, so personal data never reaches git.";
const NOT_A_FILE = "Refused: the CSV path is not a file.";
const HARD_LINKED = "Refused: the CSV file has more than one hard link. Use a plain copy outside any git repository.";

export async function runAllowlist(args: readonly string[], deps: CommandDeps): Promise<number> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    deps.err(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  try {
    if (parsed.command === "list") {
      deps.out(formatListReport(await deps.createStore().listAll()));
      return 0;
    }
    if (parsed.command === "remove") {
      const store = deps.createStore();
      // Without --yes the command only looks; with it, the delete itself says whether there was an entry.
      // With --yes the person's app write tokens are ended too (ticket 3.24); only their number is printed.
      if (parsed.confirmed) {
        const { removed, revokedTokens } = await store.remove(parsed.email);
        deps.out(formatRemoveReport(removed ? "removed" : "absent", revokedTokens));
      } else {
        deps.out(formatRemoveReport((await store.exists(parsed.email)) ? "found" : "absent"));
      }
      return 0;
    }
    return await importFile(parsed.file, deps);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    deps.err(`Allow-list ${parsed.command} failed: ${redactError(message)}`);
    return 1;
  }
}

async function importFile(file: string, deps: CommandDeps): Promise<number> {
  // Every check runs before the file is read and before any AWS client exists.
  // Absolute only: a relative path would resolve from wherever npm started (the repository root
  // through the root script), not from where the command was typed.
  if (!isAbsolute(file)) {
    deps.err(NOT_ABSOLUTE);
    return 1;
  }
  // Checked as written (also catches a file that does not exist yet), then with symlinks resolved.
  const asWritten = resolve(file);
  if (isInside(deps.repoRoot, asWritten)) {
    deps.err(IN_REPO);
    return 1;
  }
  let real: string;
  try {
    real = realpathSync.native(asWritten);
  } catch {
    deps.err("CSV file not found.");
    return 1;
  }
  if (isInside(deps.repoRoot, real)) {
    deps.err(IN_REPO);
    return 1;
  }
  // A directory (or a socket, a device) is not a CSV: say so before the hard-link message, whose
  // count means nothing for a directory.
  const stats = statSync(real);
  if (!stats.isFile()) {
    deps.err(NOT_A_FILE);
    return 1;
  }
  // realpath does not follow hard links: a second name could sit inside a repository.
  if (stats.nlink > 1) {
    deps.err(HARD_LINKED);
    return 1;
  }
  if (isInGitWorkTree(dirname(real))) {
    deps.err(IN_GIT);
    return 1;
  }

  const csv = parseCsv(readFileSync(real, "utf8"));
  if ("error" in csv) {
    deps.err(`Nothing imported: ${csv.error}.`);
    return 1;
  }

  const store = deps.createStore();
  const counts = { added: 0, updated: 0, rejected: csv.rejections.length };
  try {
    for (const entry of csv.entries) {
      const result = await store.upsert({ email: entry.email, group: entry.group, role: entry.role });
      counts[result]++;
    }
  } catch (error) {
    // Rows before the failure are stored: say how many, then let the caller print the error.
    deps.out(formatImportReport(counts, csv.rejections));
    throw error;
  }
  deps.out(formatImportReport(counts, csv.rejections));
  return 0;
}
