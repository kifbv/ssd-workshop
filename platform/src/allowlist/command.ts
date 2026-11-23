// The allow-list command with its outside world passed in (file system reads, store, output),
// so the whole flow is tested against an in-memory store. ./main.ts wires in the real ones.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  USAGE,
  formatImportReport,
  formatListReport,
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
 * True when `dir` is inside a git work tree (any repository, not only this one). No shell, output
 * ignored; GIT_DIR / GIT_WORK_TREE are dropped so only the folder itself decides. If git is missing
 * or fails, the answer is false: the check against this repository still applies.
 */
export function isInGitWorkTree(dir: string): boolean {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: "ignore", env });
    return true;
  } catch {
    return false;
  }
}

const NOT_ABSOLUTE = "Refused: give an absolute path to the CSV file.";
const IN_REPO = "Refused: the CSV file is inside the repository. Keep it outside, so personal data never reaches git.";
const IN_GIT = "Refused: the CSV file is inside a git repository. Keep it outside, so personal data never reaches git.";
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
  // realpath does not follow hard links: a second name could sit inside a repository.
  if (statSync(real).nlink > 1) {
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
