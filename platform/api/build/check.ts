/**
 * The deploy check (ticket 2.3): the spec's rules for what may go live at `/apps/<nickname>/`.
 * Only allowed file types, no address outside the workshop, at most 5 MB in total.
 *
 * `checkApp` is pure: it takes the app's files as a list, so the deployer (ticket 2.5, a GitHub
 * tarball) and the builder (ticket 2.8, a working copy read with `readAppFolder`) share one check.
 * Reasons are plain English, written for participants and facilitators.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** `other`: anything that is not a plain file, folder or symlink (a device, a socket, a pipe). */
export type FileKind = "file" | "symlink" | "dir" | "other";

export interface AppFile {
  /** Path inside the app, with `/` between folders and no leading `/` (`images/cat.png`). */
  path: string;
  kind: FileKind;
  /** The file's content; empty for anything but a file. */
  bytes: Uint8Array;
}

export interface Problem {
  /** The file at fault; absent when the problem is the app as a whole (its size). */
  file?: string;
  /** 1-based line, for an outside address. */
  line?: number;
  reason: string;
}

export interface CheckResult {
  ok: boolean;
  problems: Problem[];
  /** Bytes of every file counted (the `.git` folder is not). */
  totalBytes: number;
}

/** The file types an app may hold: a static single page with its styles, scripts, data, images and fonts. */
export const ALLOWED_EXTENSIONS = [
  ".html",
  ".css",
  ".js",
  ".json",
  ".md",
  ".txt",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
] as const;

/** Text types, scanned line by line for outside addresses. The others are images and fonts. */
export const TEXT_EXTENSIONS = [".html", ".css", ".js", ".json", ".md", ".txt", ".svg"] as const;

/** 5 MB, counted as 5 x 1024 x 1024 bytes. */
export const MAX_APP_BYTES = 5 * 1024 * 1024;
const MB = 1024 * 1024;

/** The only address an app may name: the workshop itself, over HTTPS (any path under it). */
export const WORKSHOP_ORIGIN = "https://workshop.rankly.games";

/**
 * XML namespace names. They look like addresses but are only labels, never fetched: every SVG
 * (`xmlns="http://www.w3.org/2000/svg"`) and `document.createElementNS` needs them.
 */
export const NAMESPACE_ADDRESSES = [
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/XML/1998/namespace",
] as const;

/** Letters, digits, `-`, `_` and `.` in each part of a path, parts separated by `/`. */
const SAFE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

/** An address with a scheme (`https://`, `http://`, `wss://`, `ftp://`, ...), up to its first delimiter. */
const SCHEME_ADDRESS = /[a-z][a-z0-9+-]*:\/\/[^\s"'`<>()\\]*/gi;

/**
 * A protocol-relative address (`//host`, which the browser opens on another server) where code or
 * markup uses an address: right after a quote, inside `url(`, or as an unquoted HTML attribute value.
 * `//` followed by a space or `*`, as in a comment, is never a host.
 */
const RELATIVE_ADDRESS =
  /(?:["'`]|url\(\s*["']?|\b(?:src|href|action|formaction|srcset|poster|data|cite|background)=)(\/\/[a-z0-9[][^\s"'`<>()\\]*)/gi;

const TOO_LONG = 80;

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

const isAllowedAddress = (address: string): boolean => {
  const lower = address.toLowerCase();
  if ((NAMESPACE_ADDRESSES as readonly string[]).includes(lower)) return true;
  if (!lower.startsWith(WORKSHOP_ORIGIN)) return false;
  const next = lower.charAt(WORKSHOP_ORIGIN.length);
  return next === "" || next === "/" || next === "?" || next === "#";
};

const shorten = (address: string): string => (address.length > TOO_LONG ? `${address.slice(0, TOO_LONG)}...` : address);

const outsideAddressReason = (address: string): string =>
  `It refers to an outside address (${shorten(address)}). An app may only use its own files and ${WORKSHOP_ORIGIN}.`;

/** The outside addresses of one line of text, in the order they appear. */
export function outsideAddresses(line: string): string[] {
  const found: { at: number; address: string }[] = [];
  for (const match of line.matchAll(SCHEME_ADDRESS)) {
    if (!isAllowedAddress(match[0])) found.push({ at: match.index, address: match[0] });
  }
  for (const match of line.matchAll(RELATIVE_ADDRESS)) {
    const address = match[1] ?? "";
    found.push({ at: match.index + match[0].length - address.length, address });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.address);
}

/** Why a path may not be published, or undefined when its name and type are fine. */
function pathProblem(file: AppFile): string | undefined {
  if (!SAFE_PATH.test(file.path) || file.path.split("/").includes("..")) {
    return "The file name is not allowed: use letters, digits, dashes, underscores and dots, in folders inside the app.";
  }
  if (file.path.split("/").some((part) => part.startsWith("."))) {
    return "Hidden files and folders (names starting with a dot) are not allowed.";
  }
  if (file.kind === "symlink") return "Links to other files are not allowed; copy the file instead.";
  if (file.kind === "other") return "Only plain files and folders are allowed.";
  if (file.kind === "dir") return undefined;
  const extension = extensionOf(file.path);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    const shown = extension === "" ? "A file without a type" : `"${extension}"`;
    return `${shown} is not an allowed file type. Allowed: ${ALLOWED_EXTENSIONS.join(" ")}.`;
  }
  return undefined;
}

/** The size as people read it, one decimal; never shown as the limit itself when it is over it. */
function formatSize(bytes: number): string {
  const limit = MAX_APP_BYTES / MB;
  const shown = Math.max(Math.round((bytes / MB) * 10) / 10, limit + 0.1);
  return `${shown.toFixed(1)} MB`;
}

const isGitFolder = (path: string): boolean => path === ".git" || path.startsWith(".git/");

/** Runs every rule on the app's files and lists all the problems found. */
export function checkApp(files: readonly AppFile[]): CheckResult {
  const problems: Problem[] = [];
  let totalBytes = 0;
  const decoder = new TextDecoder();

  const counted = files.filter((file) => !isGitFolder(file.path));
  for (const file of counted) {
    totalBytes += file.bytes.length;
    const reason = pathProblem(file);
    if (reason) {
      problems.push({ file: file.path, reason });
      continue;
    }
    if (file.kind !== "file" || !(TEXT_EXTENSIONS as readonly string[]).includes(extensionOf(file.path))) continue;
    decoder
      .decode(file.bytes)
      .split("\n")
      .forEach((line, index) => {
        for (const address of outsideAddresses(line)) {
          problems.push({ file: file.path, line: index + 1, reason: outsideAddressReason(address) });
        }
      });
  }

  if (!counted.some((file) => file.path === "index.html" && file.kind === "file")) {
    problems.push({ file: "index.html", reason: "The app has no index.html at its top level, so it has no page to open." });
  }
  if (totalBytes > MAX_APP_BYTES) {
    problems.push({ reason: `The app is ${formatSize(totalBytes)}; the limit is ${MAX_APP_BYTES / MB} MB.` });
  }
  return { ok: problems.length === 0, problems, totalBytes };
}

/**
 * Reads a folder as the check sees it (ticket 2.8's working copy). Uses `lstat`, so a symlink is
 * reported as one and never followed; the top-level `.git` folder is skipped.
 */
export async function readAppFolder(root: string): Promise<AppFile[]> {
  const files: AppFile[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const name of await readdir(join(root, relative))) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (isGitFolder(path)) continue;
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) {
        files.push({ path, kind: "symlink", bytes: new Uint8Array() });
      } else if (stat.isDirectory()) {
        files.push({ path, kind: "dir", bytes: new Uint8Array() });
        await visit(path);
      } else if (stat.isFile()) {
        files.push({ path, kind: "file", bytes: await readFile(join(root, path)) });
      } else {
        files.push({ path, kind: "other", bytes: new Uint8Array() });
      }
    }
  };
  await visit("");
  return files;
}
