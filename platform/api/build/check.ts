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
  /** Bytes of every file given. */
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
 * (`xmlns="http://www.w3.org/2000/svg"`), MathML and `document.createElementNS` needs them.
 * Matched exactly (no path after them). DOCTYPEs with a DTD address are not allowed (AGENTS.md).
 */
export const NAMESPACE_ADDRESSES = [
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/1998/Math/MathML",
] as const;

/** Letters, digits, `-`, `_` and `.` in each part of a path, parts separated by `/`. */
const SAFE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

// The address patterns below run on every line of every build, so each must stay linear in the line's
// length: a pattern may only start where a run it would otherwise rescan begins (the lookbehinds), and
// what follows a variable-length run must be a character that run cannot hold. A test feeds them lines
// of several MB.

/** Spaces and control characters, which the browser ignores around an address (`src=" //host"`). */
const GAP = String.raw`[\s\x00-\x20]*`;
/** Two or more slashes, in any mix with backslashes: browsers read `\` as `/` in web addresses. */
const SLASHES = String.raw`[\\/]{2,}`;
/** The first character of a host: anything but a space, a slash, a comment's `*` or a delimiter. */
const HOST_START = String.raw`[^\s\x00-\x20\\/*"'\`<>(),;]`;
/** The rest of an address, up to its first delimiter. */
const REST = String.raw`[^\s\x00-\x20"'\`<>()\\]*`;

/**
 * An address with a scheme and slashes (`https://`, `wss://`, `ftp:\\`, any `name://`), from the
 * start of the scheme. The lookbehind starts a match only at the beginning of a run of scheme letters.
 */
const SCHEME_ADDRESS = new RegExp(String.raw`(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:[\\/]{2}${REST}`, "gi");

/** A web scheme without slashes (`http:host`, `wss:host`), which browsers still open on another server. */
const BARE_SCHEME = new RegExp(String.raw`(?<![a-z0-9+.-])(?:https?|wss?|ftp):(?![\\/]{2})[^\s\x00-\x20"'\`<>()]+`, "gi");

/**
 * A protocol-relative address (`//host`, which the browser opens on another server) where code or
 * markup uses an address: after a quote or backtick, inside `url(`, after `=` (any attribute, a meta
 * refresh's `url=`), or after a comma (later `srcset` entries); spaces may come between.
 * `//` followed by a space or `*`, as in a comment, is never a host.
 */
const RELATIVE_ADDRESS = new RegExp(
  // Never two GAPs side by side: splitting one run of spaces between them would be quadratic.
  String.raw`(?:["'\`]|url\(|url\(${GAP}["']|=|=${GAP}["']|,)${GAP}(${SLASHES}${HOST_START}${REST})`,
  "gi",
);

const TOO_LONG = 80;

/** The few named HTML entities that can spell out an address. */
const NAMED_ENTITIES: Record<string, string> = {
  colon: ":",
  sol: "/",
  bsol: "\\",
  period: ".",
  tab: "\t",
  newline: "\n",
  quot: '"',
  apos: "'",
  lpar: "(",
  rpar: ")",
  equals: "=",
  comma: ",",
  amp: "&",
  nbsp: " ",
};

const fromCodePoint = (hex: string, radix: number): string => {
  const code = parseInt(hex, radix);
  return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
};

/** HTML and SVG character references: `&#47;`, `&#x2f;`, `&sol;`, `&colon;` (the semicolon is optional in browsers). */
const decodeEntities = (line: string): string =>
  line.replace(/&#x([0-9a-f]{1,8});?|&#([0-9]{1,8});?|&([a-z]{2,8});/gi, (all, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined) return fromCodePoint(hex, 16);
    if (dec !== undefined) return fromCodePoint(dec, 10);
    return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? all;
  });

/** JavaScript and JSON escapes: `/`, `\u{2f}`, `\x2f`, `\/`. */
const decodeScriptEscapes = (line: string): string =>
  line
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_all, braced?: string, four?: string, two?: string) =>
      fromCodePoint(braced ?? four ?? two ?? "", 16),
    )
    .replace(/\\([^ux])/gi, "$1");

/** CSS escapes: `\2f ` (one to six hex digits and an optional space), `\/`. */
const decodeCssEscapes = (line: string): string =>
  line.replace(/\\([0-9a-f]{1,6})[ \t]?/gi, (_all, hex: string) => fromCodePoint(hex, 16)).replace(/\\([^0-9a-f])/gi, "$1");

/** Browsers drop tabs and line breaks anywhere in an address (`ht&Tab;tps:`). */
const dropTabs = (line: string): string => line.replace(/[\t\n\r]/g, "");

/**
 * The ways a line may be read by the browser, in order: as written, then with HTML entities and
 * JavaScript escapes decoded, then with entities and CSS escapes decoded. Every text file gets every
 * reading (a style block or script may sit inside HTML), so the file's type does not matter.
 */
const readings = (line: string): string[] => {
  const entities = decodeEntities(line);
  return [line, decodeEntities(decodeScriptEscapes(entities)), decodeCssEscapes(entities)].map(dropTabs);
};

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

const isAllowedAddress = (address: string): boolean => {
  const lower = address.toLowerCase();
  if (NAMESPACE_ADDRESSES.some((name) => name.toLowerCase() === lower)) return true;
  if (!lower.startsWith(WORKSHOP_ORIGIN)) return false;
  const next = lower.charAt(WORKSHOP_ORIGIN.length);
  return next === "" || next === "/" || next === "?" || next === "#";
};

const shorten = (address: string): string => (address.length > TOO_LONG ? `${address.slice(0, TOO_LONG)}...` : address);

const outsideAddressReason = (address: string): string =>
  `It refers to an outside address (${shorten(address)}). An app may only use its own files and ${WORKSHOP_ORIGIN}.`;

/** The outside addresses in one reading of a line, in the order they appear. */
function addressesIn(line: string): string[] {
  const found: { at: number; address: string }[] = [];
  for (const match of line.matchAll(SCHEME_ADDRESS)) {
    if (!isAllowedAddress(match[0])) found.push({ at: match.index, address: match[0] });
  }
  for (const match of line.matchAll(BARE_SCHEME)) found.push({ at: match.index, address: match[0] });
  for (const match of line.matchAll(RELATIVE_ADDRESS)) {
    const address = match[1] ?? "";
    found.push({ at: match.index + match[0].length - address.length, address });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.address);
}

/**
 * The outside addresses of one line of text, in the order they appear: those of the first reading
 * (as written, then decoded) that holds any. Addresses built from parts at run time
 * (`location.protocol + "//host"`) cannot be found by a scan; the apps' CSP blocks loading them.
 */
export function outsideAddresses(line: string): string[] {
  for (const reading of readings(line)) {
    const found = addressesIn(reading);
    if (found.length > 0) return found;
  }
  return [];
}

/** Text that is not UTF-8, or holds NUL bytes, cannot be scanned reliably. A UTF-8 BOM is fine. */
const NOT_TEXT_REASON = "It is not plain UTF-8 text, so it cannot be checked. Save it as UTF-8 text.";

/** The file's lines, or undefined when it is not UTF-8 text (UTF-16, other encodings, NUL bytes). */
function textLines(bytes: Uint8Array): string[] | undefined {
  if (bytes.includes(0)) return undefined;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r\n|\r|\n/);
  } catch {
    return undefined;
  }
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

/**
 * Runs every rule on the app's files and lists all the problems found. Every path given is checked
 * and counted, `.git` included: only `readAppFolder` leaves out a working copy's top-level `.git`.
 */
export function checkApp(files: readonly AppFile[]): CheckResult {
  const problems: Problem[] = [];
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.bytes.length;
    const reason = pathProblem(file);
    if (reason) {
      problems.push({ file: file.path, reason });
      continue;
    }
    if (file.kind !== "file" || !(TEXT_EXTENSIONS as readonly string[]).includes(extensionOf(file.path))) continue;
    const lines = textLines(file.bytes);
    if (!lines) {
      problems.push({ file: file.path, reason: NOT_TEXT_REASON });
      continue;
    }
    lines.forEach((line, index) => {
      for (const address of outsideAddresses(line)) {
        problems.push({ file: file.path, line: index + 1, reason: outsideAddressReason(address) });
      }
    });
  }

  if (!files.some((file) => file.path === "index.html" && file.kind === "file")) {
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
