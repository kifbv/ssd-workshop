// The allow-list command with its outside world passed in (file system reads, store, output),
// so the whole flow is tested against an in-memory store. ./main.ts wires in the real ones.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  /** Real path of the repository root: CSV files inside it are refused. */
  repoRoot: string;
  /** Directory relative CSV paths are resolved against. */
  cwd: string;
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
      if (parsed.workspaces !== undefined) return realpathSync(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repository root not found");
    dir = parent;
  }
}

const IN_REPO = "Refused: the CSV file is inside the repository. Keep it outside, so personal data never reaches git.";

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
  // Checked twice: as written (also catches a file that does not exist yet), then with symlinks resolved.
  const asWritten = resolve(deps.cwd, file);
  if (isInside(deps.repoRoot, asWritten)) {
    deps.err(IN_REPO);
    return 1;
  }
  let real: string;
  try {
    real = realpathSync(asWritten);
  } catch {
    deps.err("CSV file not found.");
    return 1;
  }
  if (isInside(deps.repoRoot, real)) {
    deps.err(IN_REPO);
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
