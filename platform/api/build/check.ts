/**
 * The deploy check (ticket 2.3): the spec's rules for what may go live at `/apps/<nickname>/`.
 * Only allowed file types, at most 5 MB in total, and in text files:
 * - no outside address other than a plain `https://` one (ticket 2.14, spec delta of 2026-11-25): `https://`, a
 *   host of letters, digits, dashes and dots, then the end or `/`, `?`, `#` (or a template literal's `${`, with no
 *   `@` or `:` after it before the path, try 3). No other scheme (`http:`, `ws:`,
 *   `wss:`, `ftp:`, ...), no scheme-relative `//host`, no user name, password or port, and no address written
 *   with escapes or entities (`https&#58;//`, `https:\/\/`). The apps' CSP lets such addresses be read
 *   (`connect-src`) and shown as images (`img-src`) only; scripts, styles and fonts from them are blocked there.
 * - no API key or token (ticket 2.14): `api_key`/`apikey`/`api-key`/`access_token`/`accessToken` given a value
 *   (`=`, `:`, or after a quoted name a `,`), also at the end of a longer name (`weatherApiKey`, `myAccessToken`,
 *   `WEATHERAPI_KEY`); an `Authorization` header; `key=`, `token=` or `appid=` in an address with a value of
 *   `KEY_VALUE_MIN_CHARS` characters or more (also joined on with `+`); or a name that is or ends in `key`, `token`
 *   or `appid` (`"key"`, `OPENWEATHER_KEY`, `myKey`, `apiToken`), or such a name set with `.set(`/`.append(`, given a
 *   quoted value that `looksLikeKeyValue` (`"key": "AIzaSy..."`).
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

/** Text types, scanned line by line for outside addresses and keys. The others are images and fonts. */
export const TEXT_EXTENSIONS = [".html", ".css", ".js", ".json", ".md", ".txt", ".svg"] as const;

/** 5 MB, counted as 5 x 1024 x 1024 bytes. */
export const MAX_APP_BYTES = 5 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * A plain HTTPS address (ticket 2.14), matched on an address the scan already cut out: the scheme, a host of
 * letters, digits and dashes with at least one dot between parts, then the end or the start of a path, query or
 * fragment. A `:` (port, or a user name and password) or an `@` (user name) right after the host fails it, and
 * so does any other character there (`%`, `[`, a trailing dot). A template literal's `${` may also follow the host
 * (`` `https://openlibrary.org${doc.key}.json` ``): what it adds is built at run time, which no scan can see, and the
 * CSP still allows only https there. Its match is the address's start (`https://host`); `hostTail` then reads what
 * follows it up to the path (try 3).
 */
const PLAIN_HTTPS = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?=[/?#]|\$\{|$)/i;

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
 * A meta refresh's delay and its separator, where the address may follow without `url=`
 * (`content="0; //host"`, `content="0 //host"`): the browser opens it.
 */
const META_REFRESH = String.raw`content${GAP}=${GAP}(?:["']${GAP})?\d+(?:\.\d*)?[;,\s]`;

/**
 * A protocol-relative address (`//host`, which the browser opens on another server) where code or
 * markup uses an address: after a quote or backtick, inside `url(`, after `=` (any attribute, a meta
 * refresh's `url=`), after a comma (later `srcset` entries), or after a meta refresh's delay; spaces may
 * come between.
 * `//` followed by a space or `*`, as in a comment, is never a host.
 */
const RELATIVE_ADDRESS = new RegExp(
  // Never two GAPs side by side: splitting one run of spaces between them would be quadratic.
  String.raw`(?:["'\`]|url\(|url\(${GAP}["']|=|=${GAP}["']|,|${META_REFRESH})${GAP}(${SLASHES}${HOST_START}${REST})`,
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

/**
 * HTML and SVG character references: `&#47;`, `&#x2f;`, `&#00047;`, `&sol;`, `&colon;` (leading zeros
 * and the semicolon are optional in browsers).
 */
const decodeEntities = (line: string): string =>
  line.replace(/&#x0*([0-9a-f]{1,8});?|&#0*([0-9]{1,8});?|&([a-z]{2,8});/gi, (all, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined) return fromCodePoint(hex, 16);
    if (dec !== undefined) return fromCodePoint(dec, 10);
    return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? all;
  });

/** The control characters JavaScript writes as `\t`, `\n`, `\r`, `\v`, `\f`, `\b`. */
const CONTROL_ESCAPES: Record<string, string> = { t: "\t", n: "\n", r: "\r", v: "\v", f: "\f", b: "\b" };

/**
 * JavaScript and JSON escapes, in one pass: `\u002f`, `\u{2f}` (leading zeros allowed), `\x2f`, legacy
 * octal `\57`, the control escapes (`\t` is a tab, which browsers drop from addresses) and `\/`.
 */
const decodeScriptEscapes = (line: string): string =>
  line.replace(
    /\\u\{0*([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\([0-3][0-7]{0,2}|[4-7][0-7]?)|\\([^ux])/gi,
    (_all, braced?: string, four?: string, two?: string, octal?: string, other?: string) => {
      if (octal !== undefined) return fromCodePoint(octal, 8);
      if (other !== undefined) return CONTROL_ESCAPES[other] ?? other;
      return fromCodePoint(braced ?? four ?? two ?? "", 16);
    },
  );

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

/**
 * A namespace name, or a plain HTTPS address whose start (`https://host`) is written as is in the line: an
 * address that only a decoded reading shows (`https&#58;//host`, `https:\/\/host`, `\x68ttps://host`) is
 * refused, so that what people read in the file is what the browser opens.
 */
const isAllowedAddress = (address: string, original: string, line: string, at: number): boolean => {
  const lower = address.toLowerCase();
  if (NAMESPACE_ADDRESSES.some((name) => name.toLowerCase() === lower)) return true;
  const start = PLAIN_HTTPS.exec(address)?.[0];
  if (start === undefined || !original.includes(start)) return false;
  const tail = hostTail(address, start.length);
  return tail === "path" || (tail === "end" && !atSignAfter(line, at + address.length));
};

/**
 * What follows the host of a plain https address, up to its path (ticket 2.14 try 3): `path` when a `/`, `?` or `#`
 * comes first, `end` when the address ends first, `refused` for an `@` or `:` outside a template literal's `${...}`
 * (a user name, a password or a port written after a run-time part: `https://a.b${x}@evil.example/`) or a `${` not
 * closed within the address (what follows it was cut off at a delimiter, as in `${f(x)}`, so no scan sees it). The
 * braces are counted, so a `/` inside `${x/y}` does not end the host. One pass over the address: linear.
 */
function hostTail(address: string, from: number): "path" | "end" | "refused" {
  let depth = 0;
  for (let i = from; i < address.length; i += 1) {
    const char = address[i];
    if (depth === 0) {
      if (char === "/" || char === "?" || char === "#") return "path";
      if (char === "@" || char === ":") return "refused";
      if (char === "$" && address[i + 1] === "{") {
        depth = 1;
        i += 1;
      }
    } else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth === 0 ? "end" : "refused";
}

/** How far past an address without a path `atSignAfter` looks. */
const AT_SIGN_LOOKAHEAD = 256;

/**
 * An `@` right after an address that has no path yet, before a space, `<`, `>`, `,`, `;`, a slash, backslash, `?` or
 * `#`: the scan cut the address at a quote or a bracket (`'https://a.b"@evil.example/'`), but the browser reads on
 * and takes what came before the `@` as a user name. Looks at most `AT_SIGN_LOOKAHEAD` characters, so it stays linear.
 */
function atSignAfter(line: string, from: number): boolean {
  const stop = Math.min(line.length, from + AT_SIGN_LOOKAHEAD);
  for (let i = from; i < stop; i += 1) {
    const char = line[i] ?? "";
    if (char === "@") return true;
    if (char <= " " || "<>,;/\\?#".includes(char)) return false;
  }
  return false;
}

const shorten = (address: string): string => (address.length > TOO_LONG ? `${address.slice(0, TOO_LONG)}...` : address);

const outsideAddressReason = (address: string): string =>
  `It refers to an outside address that is not allowed (${shorten(address)}). An app may use its own files and outside addresses written plainly as https:// and the site's name, with no user name, password or port.`;

/** The outside addresses in one reading of a line (`original`: the line as written), in the order they appear. */
function addressesIn(line: string, original: string): string[] {
  const found: { at: number; address: string }[] = [];
  for (const match of line.matchAll(SCHEME_ADDRESS)) {
    if (!isAllowedAddress(match[0], original, line, match.index)) found.push({ at: match.index, address: match[0] });
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
    const found = addressesIn(reading, line);
    if (found.length > 0) return found;
  }
  return [];
}

/** `key=`, `token=` or `appid=` in an address counts as a key from this many value characters (a word or an id is shorter). */
export const KEY_VALUE_MIN_CHARS = 16;

/**
 * A key's or token's name given a value: `api_key=`, `apiKey:`, `"x-api-key":`, `access_token=`, `"accessToken",`
 * (as in `headers.set("api-key", k)`). Starts only at the name (a fixed word), so it stays linear.
 */
const KEY_NAME = /(?<![a-z0-9])(?:api[_-]?key|access[_-]?token)(?:["'`]\s*[=:,]|\s*[=:])/gi;
/**
 * The same names at the end of a longer camelCase or upper-case name (`weatherApiKey =`, `myAccessToken:`,
 * `WEATHERAPI_KEY =`). Case-sensitive, so `monkey` and `apiKeyless` do not match; it starts only after a letter or
 * digit, where `KEY_NAME` cannot, so the two never report one name twice. Starts only at the fixed word: linear.
 */
const CAMEL_KEY_NAME = /(?<=[A-Za-z0-9])(?:ApiKey|API_?KEY|AccessToken|ACCESS_?TOKEN)(?:["'`]\s*[=:,]|\s*[=:])/g;
/**
 * A name that is or ends in `key`, `token` or `appid` (a property or a variable) given a quoted value: the whole name
 * (`"key": "AIzaSy..."`, `token = "..."`), after `_` (`OPENWEATHER_KEY`, `my_token`), after a lower-case letter or a
 * digit in camelCase (`myKey`, `apiToken`, `weatherAppId`), or `apikey` in any case after a letter (`WeatherApikey`).
 * The name must end there (`keyboard`, `apiKeyless`, `tokens` do not match; `monkey`, `hotkey` neither, as a lower-case
 * `key` counts only alone or after `_`). Only a value that `looksLikeKeyValue` counts (checked in `keyNamesIn`):
 * `key: "title"`, Open Library's `"key": "/works/OL45883W"` (a slash) and storage names pass. Starts only at the fixed
 * words, `\s*[=:]\s*` has a fixed character between its runs, and the value's run ends at a quote it cannot hold:
 * linear.
 */
const KEY_PROPERTY = new RegExp(
  String.raw`((?<![A-Za-z0-9$])(?:[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Pp][Ii][Dd])|(?<=[a-z0-9])(?:K(?:ey|EY)|T(?:oken|OKEN)|App[Ii]d|APPID)|(?<=[A-Za-z0-9])[Aa][Pp][Ii][Kk][Ee][Yy])(?![A-Za-z0-9_$])["'\`]?\s*([=:])\s*["'\`]([A-Za-z0-9_-]+)["'\`]`,
  "g",
);
/**
 * `key`, `token` or `appid` set on a query or headers with a quoted value: `url.searchParams.set("appid", "...")`,
 * `params.append('key', '...')`. Starts only at `.set(` or `.append(`: linear.
 */
const KEY_SET_CALL = /\.(?:set|append)\(\s*(["'`])(key|token|appid)\1\s*,\s*["'`]([a-z0-9_-]+)["'`]/gi;
/**
 * A value that looks like a key: `KEY_VALUE_MIN_CHARS` or more letters, digits, `_` and `-`, holding both a letter
 * and a digit; and, when it holds `-` or `_`, one of the parts between them is 8 or more characters long with both a
 * letter and a digit (`AIzaSy...`, `ghp_...`). Storage names are words joined with
 * dashes or underscores, each part a word, a short version or a year (`movie-watchlist-v1`, `book_club_2024_v2`), so
 * they pass; one long run such as `movieWatchlist2024` under a key's name does not.
 */
const looksLikeKeyValue = (value: string): boolean => {
  if (value.length < KEY_VALUE_MIN_CHARS || !/[a-z]/i.test(value) || !/[0-9]/.test(value)) return false;
  return value.split(/[-_]/).some((part) => part.length >= 8 && /[a-z]/i.test(part) && /[0-9]/.test(part));
};
/** An `Authorization` header: `Authorization: "Bearer ..."`, `"authorization": ...`, `headers.set("Authorization", ...)`. */
const AUTHORIZATION = /(?<![a-z0-9])authorization(?:["'`]\s*[:,]|\s*:)/gi;
/**
 * A key in an address's query: `?key=`, `&token=`, `&appid=` and a long value, also joined on with `+`
 * (`"...?appid=" + "..."`, try 3). Starts only at `?` or `&`, which the value cannot hold, so it stays linear.
 */
const QUERY_KEY = new RegExp(String.raw`[?&](key|token|appid)=(?:["'\`]\s*\+\s*["'\`])?[a-z0-9_.~%-]{${KEY_VALUE_MIN_CHARS},}`, "gi");

/**
 * What looks like a key in one reading of a line: the name as written (never the value), in the order found. A
 * finding that starts inside an earlier one (`api_key = "..."` is both a key's name and a name ending in `key`) is
 * reported once, as the earlier one.
 */
function keyNamesIn(line: string): string[] {
  const found: { at: number; end: number; name: string }[] = [];
  const add = (match: RegExpMatchArray, name: string): void => {
    const at = match.index ?? 0;
    found.push({ at, end: at + match[0].length, name });
  };
  for (const match of line.matchAll(KEY_NAME)) add(match, match[0]);
  for (const match of line.matchAll(CAMEL_KEY_NAME)) add(match, match[0]);
  for (const match of line.matchAll(AUTHORIZATION)) add(match, match[0]);
  for (const match of line.matchAll(KEY_PROPERTY)) {
    if (looksLikeKeyValue(match[3] ?? "")) add(match, `${match[1] ?? ""}${match[2] ?? ""}`);
  }
  for (const match of line.matchAll(KEY_SET_CALL)) {
    if (looksLikeKeyValue(match[3] ?? "")) add(match, `${match[1] ?? ""}${match[2] ?? ""}${match[1] ?? ""},`);
  }
  for (const match of line.matchAll(QUERY_KEY)) add(match, `${match[1] ?? ""}=`);
  const kept: string[] = [];
  let end = -1;
  for (const item of found.sort((a, b) => a.at - b.at)) {
    if (item.at < end) continue;
    kept.push(item.name);
    end = item.end;
  }
  return kept;
}

/**
 * The API keys or tokens one line of text seems to hold, shown by their name: those of the first reading (as
 * written, then decoded) that holds any. A key's value is never part of the result, so it is never stored or shown.
 */
export function keysIn(line: string): string[] {
  for (const reading of readings(line)) {
    const found = keyNamesIn(reading);
    if (found.length > 0) return found;
  }
  return [];
}

const keyReason = (name: string): string =>
  `It holds what looks like a key or password for another service (${shorten(name)}). Anything in an app's files is public: use free services that need no key.`;

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

/** At most this many problems are listed; the rest are counted in one closing line. */
export const MAX_PROBLEMS = 50;

const moreProblemsReason = (count: number): string => `…and ${count} more ${count === 1 ? "problem" : "problems"}.`;

/**
 * Runs every rule on the app's files and lists the problems found: the first `MAX_PROBLEMS` problems
 * with files, then the app's own (no index.html, its size), then one line counting the ones left out.
 * Every path given is checked and counted, `.git` included: only `readAppFolder` leaves out a working
 * copy's top-level `.git`. An app over the size limit is not scanned for addresses or keys (its names and
 * types still are): it fails anyway, and the scan's time grows with the size.
 */
export function checkApp(files: readonly AppFile[]): CheckResult {
  const problems: Problem[] = [];
  let leftOut = 0;
  const report = (problem: Problem): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
    else leftOut += 1;
  };
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const tooBig = totalBytes > MAX_APP_BYTES;

  for (const file of files) {
    const reason = pathProblem(file);
    if (reason) {
      report({ file: file.path, reason });
      continue;
    }
    if (tooBig || file.kind !== "file" || !(TEXT_EXTENSIONS as readonly string[]).includes(extensionOf(file.path))) continue;
    const lines = textLines(file.bytes);
    if (!lines) {
      report({ file: file.path, reason: NOT_TEXT_REASON });
      continue;
    }
    lines.forEach((line, index) => {
      for (const address of outsideAddresses(line)) {
        report({ file: file.path, line: index + 1, reason: outsideAddressReason(address) });
      }
      for (const name of keysIn(line)) {
        report({ file: file.path, line: index + 1, reason: keyReason(name) });
      }
    });
  }

  if (!files.some((file) => file.path === "index.html" && file.kind === "file")) {
    problems.push({ file: "index.html", reason: "The app has no index.html at its top level, so it has no page to open." });
  }
  if (tooBig) {
    problems.push({ reason: `The app is ${formatSize(totalBytes)}; the limit is ${MAX_APP_BYTES / MB} MB.` });
  }
  if (leftOut > 0) problems.push({ reason: moreProblemsReason(leftOut) });
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
