// Pure logic of the allow-list command: no AWS calls and no file access here, so every rule is unit tested.
// Email addresses are personal data: nothing built here for output ever contains one.
import { isAbsolute, relative, sep } from "node:path";
import { isValidEmail } from "../../api/email.js";
import { normalizeEmail } from "../../api/keys.js";
import type { Role } from "../../api/types.js";
import { redactError, redactEmails } from "../smoke/logic.js";

export { isValidEmail, redactError };

export const REGION = "eu-central-1";
/** Same value as TABLE_NAME in infra/lib/config.ts (checked by a test); platform code does not import infra. */
export const TABLE_NAME = "ssd-workshop-data";

export const ROLES: readonly Role[] = ["participant", "facilitator", "admin"];

export const USAGE = `Usage: npm run -s allowlist -- <command>

Commands:
  import </absolute/path/file.csv>   add or update the people in the file (header: email,group,role)
  list                               print how many people are allow-listed, per group and role
  remove <email> [--yes]             say whether this address has an entry; with --yes, remove it and delete the
                                     edit link of the person's app
                                     (the person is signed out at their next call)

Give the CSV file as an absolute path, outside this repository and any other git work tree.
The command prints counts, never addresses.
Run it with your own AWS credentials (dynamodb:UpdateItem, dynamodb:Scan, dynamodb:GetItem and
dynamodb:DeleteItem on ${TABLE_NAME}).`;

export type AllowlistCommand =
  | { command: "import"; file: string }
  | { command: "list" }
  /** `email` is normalized (trimmed, lower-cased) and valid; `confirmed` is true with `--yes`. */
  | { command: "remove"; email: string; confirmed: boolean };

/** The confirmation flag of `remove`: without it the command only looks. */
export const CONFIRM_FLAG = "--yes";

export function parseArgs(args: readonly string[]): AllowlistCommand | { error: string } {
  const [command, ...rest] = args;
  switch (command) {
    case "import": {
      const [file, ...extra] = rest;
      if (file === undefined || file === "") return { error: "import needs a CSV file" };
      if (extra.length > 0) return { error: "import takes exactly one file" };
      return { command: "import", file };
    }
    case "list":
      return rest.length === 0 ? { command: "list" } : { error: "list takes no arguments" };
    case "remove":
      return parseRemove(rest);
    case undefined:
      return { error: "no command given" };
    default:
      return { error: "unknown command" };
  }
}

/**
 * `remove <email> [--yes]`, the flag before or after the address. Refusals never repeat what was typed,
 * so a mistyped address is not printed either.
 */
function parseRemove(rest: readonly string[]): AllowlistCommand | { error: string } {
  const confirmed = rest.includes(CONFIRM_FLAG);
  const others = rest.filter((arg) => arg !== CONFIRM_FLAG);
  if (rest.length - others.length > 1) return { error: `remove takes ${CONFIRM_FLAG} once` };
  const [raw, ...extra] = others;
  if (raw === undefined || raw.trim() === "") return { error: "remove needs an email address" };
  if (extra.length > 0) return { error: `remove takes one email address and optionally ${CONFIRM_FLAG}` };
  const email = raw.trim().toLowerCase();
  if (!isValidEmail(email)) return { error: "remove needs a valid email address" };
  return { command: "remove", email: normalizeEmail(email), confirmed };
}

/** What `remove` prints: about "this address" only, never the address or anyone else's. */
export function formatRemoveReport(result: "found" | "absent" | "removed", editLinkDeleted = false): string {
  switch (result) {
    case "found":
      return `This address has an allow-list entry. Nothing was changed: run again with ${CONFIRM_FLAG} to remove it.`;
    case "absent":
      return "This address has no allow-list entry. Nothing was changed.";
    case "removed":
      return `Removed the allow-list entry for this address${editLinkDeleted ? " and deleted their app's edit link" : ""}. Their sessions end at their next call; their profile and app are kept.`;
  }
}

export interface CsvEntry {
  /** 1-based line of the file. */
  line: number;
  /** Trimmed and lower-cased. */
  email: string;
  group: string;
  role: Role;
}

export interface CsvRejection {
  line: number;
  /** Never contains the email address. */
  reason: string;
}

export type CsvResult = { entries: CsvEntry[]; rejections: CsvRejection[] } | { error: string };

const HEADER = ["email", "group", "role"];

/**
 * Reads `email,group,role` rows. The header is required (case and spaces ignored); a UTF-8 BOM,
 * CRLF line ends and blank lines are fine. No quoted fields: a row must have exactly three fields.
 * An email seen on an earlier line makes the later line a duplicate. A group holding an `@` is
 * rejected, so an address pasted in the group column is never stored or printed.
 */
export function parseCsv(text: string): CsvResult {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => l.trim() !== "");
  const header = headerIndex === -1 ? undefined : lines[headerIndex];
  if (header === undefined) return { error: "the file is empty" };
  const headerFields = header.split(",").map((f) => f.trim().toLowerCase());
  if (headerFields.join(",") !== HEADER.join(",")) {
    return { error: "the first line must be the header email,group,role" };
  }

  const entries: CsvEntry[] = [];
  const rejections: CsvRejection[] = [];
  const firstLineOf = new Map<string, number>();
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = i + 1;
    if (raw.trim() === "") continue;
    const fields = raw.split(",");
    if (fields.length !== 3) {
      rejections.push({ line, reason: `expected 3 fields, found ${fields.length}` });
      continue;
    }
    const [rawEmail = "", rawGroup = "", rawRole = ""] = fields;
    const email = rawEmail.trim().toLowerCase();
    const group = rawGroup.trim();
    const role = rawRole.trim().toLowerCase();
    const reasons: string[] = [];
    if (!isValidEmail(email)) reasons.push("invalid email");
    if (group === "") reasons.push("empty group");
    // An address pasted in the group column would be stored and printed as a group name.
    else if (group.includes("@")) reasons.push("group looks like an email address");
    if (!isRole(role)) reasons.push("unknown role");
    if (reasons.length === 0) {
      const earlier = firstLineOf.get(email);
      if (earlier !== undefined) reasons.push(`duplicate of line ${earlier}`);
    }
    // `!isRole(role)` is already a reason; repeated here so TypeScript narrows `role` below.
    if (reasons.length > 0 || !isRole(role)) {
      rejections.push({ line, reason: reasons.join(", ") });
      continue;
    }
    firstLineOf.set(email, line);
    entries.push({ line, email: normalizeEmail(email), group, role });
  }
  return { entries, rejections };
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * True when `target` is `dir` itself or anywhere below it (both absolute, already resolved).
 * Letter case is ignored: macOS file systems ignore it and `realpath` does not fix it, and a false
 * refusal on a case-sensitive file system is harmless.
 */
export function isInside(dir: string, target: string): boolean {
  const rel = relative(dir.toLowerCase(), target.toLowerCase());
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface ImportCounts {
  added: number;
  updated: number;
  rejected: number;
}

export function formatImportReport(counts: ImportCounts, rejections: readonly CsvRejection[]): string {
  const lines = [`Added: ${counts.added}`, `Updated: ${counts.updated}`, `Rejected: ${counts.rejected}`];
  for (const r of rejections) lines.push(`Line ${r.line}: ${r.reason}`);
  return lines.join("\n");
}

export interface GroupRole {
  group: string;
  role: string;
}

/**
 * Counts per group and role as a text table, groups in alphabetical order, roles in the order
 * participant, facilitator, admin (anything else after them), then a total. Group names go through
 * the email redaction, in case an address ever lands in the group column.
 */
export function formatListReport(items: readonly GroupRole[]): string {
  const counts = new Map<string, number>();
  for (const { group, role } of items) {
    const key = JSON.stringify([group, role]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const roleRank = (role: string): number => {
    const index = (ROLES as readonly string[]).indexOf(role);
    return index === -1 ? ROLES.length : index;
  };
  const rows = [...counts.entries()]
    .map(([key, count]) => {
      const [group, role] = JSON.parse(key) as [string, string];
      return { group: redactEmails(group), role, count };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || roleRank(a.role) - roleRank(b.role) || a.role.localeCompare(b.role));

  const table: [string, string, string][] = [
    ["Group", "Role", "Count"],
    ...rows.map((r): [string, string, string] => [r.group, r.role, String(r.count)]),
    ["Total", "", String(items.length)],
  ];
  const width = (col: 0 | 1 | 2): number => Math.max(...table.map((row) => row[col].length));
  const [w0, w1, w2] = [width(0), width(1), width(2)];
  return table
    .map(([g, r, c]) => `${g.padEnd(w0)}  ${r.padEnd(w1)}  ${c.padStart(w2)}`.trimEnd())
    .join("\n");
}
