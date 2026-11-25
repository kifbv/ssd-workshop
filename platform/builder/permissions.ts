/**
 * What the coding agent may do (ticket 2.8): file tools inside its workspace folder and, since ticket 2.15, Claude
 * Code's WebFetch on public https addresses. The spec's rule "the AI that writes code has no AWS rights" (decision
 * "Spec delta, CHANGED ... Builder", and its 2.15 change) rests on this: no shell, no web search, no subagent, no MCP
 * server, no path outside the workspace, and no fetch of anything but an https address with a named public host
 * (checkWebAddress).
 *
 * `checkToolCall` is pure apart from reading the file system to resolve links (`realpath` of the nearest existing
 * part of a path), so it is unit-tested directly on temporary folders. The agent (./agent.ts) runs it as a PreToolUse
 * hook on every tool call, before Claude Code's own permission rules; it is the only gate (`canUseTool` is not set: the
 * SDK never consults it for tools in `allowedTools`). It denies by default: any tool not on ALLOWED_TOOLS, any input it
 * does not understand, any path that is absolute outside the workspace, climbs out with `..`, starts with `~`, or
 * reaches outside through a symlink; any Glob pattern or folder with braces, brackets, `..`, a leading `/` or `~`; and
 * any write to tool or CI configuration (CONFIG_FOLDERS, CONFIG_FILES); and any WebFetch whose address
 * checkWebAddress refuses or whose other inputs are not what WebFetch takes.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The only tools the agent gets: read, write and edit files, list them by pattern, and read a public web page or API
 * answer (ticket 2.15). WebSearch is not here: Claude Code does not offer it on Bedrock (decision "(2.15) WebSearch").
 */
export const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "WebFetch"] as const;

/**
 * Removed from the agent's context as well (belt and braces: the tool list above already leaves them out, and the
 * hook denies anything not allowed). Shell, web search, notebooks, subagents and workflows, skills, tasks and plans.
 */
export const DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "WebSearch",
  "Task",
  "Agent",
  "NotebookEdit",
  "Skill",
  "SlashCommand",
  "TodoWrite",
  "ExitPlanMode",
  "Grep",
  "LS",
  "MultiEdit",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "Workflow",
  "Monitor",
] as const;

/** Files the agent may read but never change (AGENTS.md says so; this makes it so). */
export const PROTECTED_FILES = ["AGENTS.md", "SPEC.md", "workshop-data.js"] as const;

/**
 * Folders the agent may never write in, at any depth (case ignored): Git, GitHub workflows and Claude Code's own
 * settings. A participant's app needs none of them, and a file there could change what tools or CI do later.
 */
export const CONFIG_FOLDERS = [".git", ".github", ".claude"] as const;

/** Files the agent may never write, in any folder (case ignored): Claude Code's instructions and MCP servers, Git's attributes. */
export const CONFIG_FILES = ["claude.md", ".mcp.json", ".gitattributes"] as const;

/** True when a workspace-relative path (`/` between folders) names tool or CI configuration. */
export function isConfigPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts[parts.length - 1] ?? "";
  return parts.some((part) => (CONFIG_FOLDERS as readonly string[]).includes(part)) || (CONFIG_FILES as readonly string[]).includes(name);
}

/**
 * A pattern segment made only of dots and wildcards that holds both (`.?`, `.*`, `*.*`, `?.`): it could match `.` or
 * `..` and climb out (try 3).
 */
const dotWildcardSegment = (segment: string): boolean => /^[.?*]+$/.test(segment) && segment.includes(".") && /[?*]/.test(segment);

/**
 * A Glob pattern or folder the check can reason about: not empty, relative, no `~`, backslash or NUL, no `..` anywhere,
 * none of the expansion characters `{`, `}`, `[`, `]` (with them, `.{.,}/*` or `[.][.]/*` would climb out), and no
 * segment of only dots and wildcards (dotWildcardSegment).
 */
function plainGlobText(text: string): boolean {
  return (
    text !== "" &&
    !text.startsWith("/") &&
    !text.startsWith("~") &&
    !isAbsolute(text) &&
    !/[{}[\]\\\0]/.test(text) &&
    !text.includes("..") &&
    !text.split("/").some(dotWildcardSegment)
  );
}

export type ToolDecision = { allow: true } | { allow: false; reason: string };

const deny = (reason: string): ToolDecision => ({ allow: false, reason });

const OUTSIDE = "Only files inside the app's folder can be used.";

/**
 * The real path of `path`, or of its nearest existing parent with the missing rest appended (a file not written yet).
 * A part that exists but cannot be resolved (a dangling symlink, whose target a write would create) throws.
 */
function realPathOf(path: string): string {
  const missing: string[] = [];
  let at = path;
  for (;;) {
    try {
      return resolve(realpathSync(at), ...missing.reverse());
    } catch {
      if (exists(at)) throw new Error("cannot resolve");
      const parent = dirname(at);
      if (parent === at) throw new Error("no existing parent");
      missing.push(basename(at));
      at = parent;
    }
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `path` (relative to the workspace, or absolute as Claude Code passes it) stays inside the workspace once
 * every symlink is resolved. Refused outright: an empty path, NUL, backslashes, `~` (Claude Code expands it to the
 * home folder) and any `..` part (the agent never needs it, even when it would stay inside).
 */
export function insideWorkspace(workspace: string, path: string): boolean {
  if (path === "" || path.includes("\0") || path.includes("\\") || path.startsWith("~")) return false;
  if (path.split("/").includes("..")) return false;
  try {
    const rel = relative(realpathSync(workspace), realPathOf(resolve(workspace, path)));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch {
    return false;
  }
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The workspace-relative path (with `/`) of a path the agent names, once links are resolved; call after insideWorkspace. */
export function workspacePath(workspace: string, path: string): string {
  return relative(realpathSync(workspace), realPathOf(resolve(workspace, path))).split(sep).join("/");
}

/**
 * Allows a call only for an allowed tool whose every path stays inside `workspace` (WebFetch: checkWebFetch). Write and Edit may not touch
 * PROTECTED_FILES or tool and CI configuration (isConfigPath). Glob's pattern must be plain (plainGlobText: it is
 * joined to its folder and expanded by Claude Code).
 */
export function checkToolCall(workspace: string, tool: string, input: unknown): ToolDecision {
  if (!(ALLOWED_TOOLS as readonly string[]).includes(tool)) return deny(`The tool ${JSON.stringify(tool).slice(0, 60)} is not available: only Read, Write, Edit, Glob and WebFetch.`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) return deny("The tool call has no input.");
  const fields = input as Record<string, unknown>;
  if (tool === "WebFetch") return checkWebFetch(fields);
  if (tool === "Glob") {
    const pattern = text(fields.pattern);
    if (pattern === undefined || !plainGlobText(pattern)) {
      return deny("Use a plain relative pattern inside the app's folder, without braces, brackets or '..'.");
    }
    if (fields.path !== undefined) {
      const folder = text(fields.path) ?? "";
      // An absolute folder is how Claude Code names the workspace itself; it must still resolve inside.
      if (folder === "" || /[{}[\]]/.test(folder) || folder.includes("..") || folder.startsWith("~") || !insideWorkspace(workspace, folder)) return deny(OUTSIDE);
    }
    return { allow: true };
  }
  const filePath = text(fields.file_path);
  if (filePath === undefined || !insideWorkspace(workspace, filePath)) return deny(OUTSIDE);
  if (tool === "Write" || tool === "Edit") {
    const path = workspacePath(workspace, filePath);
    if (path === "") return deny(OUTSIDE);
    if ((PROTECTED_FILES as readonly string[]).includes(path)) return deny(`${path} must not be changed.`);
    if (isConfigPath(path)) return deny("Tool and CI settings (.git, .github, .claude, CLAUDE.md, .mcp.json, .gitattributes) must not be written.");
  }
  return { allow: true };
}

/**
 * Names under these endings are never fetched (ticket 2.15, decision "(2.15) Web addresses"): names that only resolve
 * inside a network (`localhost`, `.local`, `.internal` as in `compute.internal`, `.lan`, `.home.arpa`, `.intranet`,
 * `.corp`, `.home`, `.localdomain`, `.private`), names reserved for tests and examples that never reach the public web
 * (`.test`, `.invalid`, `.example`), Tor's `.onion`, and `.arpa` (reverse lookups of IP addresses). Matched on whole
 * labels, case ignored.
 */
export const BLOCKED_NAME_ENDINGS = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "private",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
] as const;

/** At most this many characters in an address (Claude Code's own limit is about 2000). */
export const MAX_WEB_ADDRESS_LENGTH = 2000;
/** At most this many characters in WebFetch's prompt (what the small model is asked about the page). */
export const MAX_WEB_PROMPT_LENGTH = 20_000;

const WEB_FIELDS = ["url", "prompt", "offset"];

const HTTPS_ONLY = "WebFetch may only read an https address of a public site, written plainly: https, a colon, two slashes and the site's name (letters, digits, dashes and dots), then a slash and the rest.";

/** One host name label: letters, digits and inner dashes, 1 to 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The last label must start with a letter: that rules out every numeric form of an IPv4 address (`127.1`, `0x7f`). */
const TOP_LABEL = /^[a-z][a-z0-9-]*$/;

/**
 * Allows only an `https://` address with a named public host (ticket 2.15). The raw text is checked first, so that no
 * parser's repairs matter: printable ASCII only (no spaces, control characters, backslashes or other letters),
 * lower-case `https://` exactly, and the host (up to the first `/`, `?` or `#`) made only of letters, digits, dashes and
 * dots, which leaves out a user name or password (`@`), any port (`:`), brackets (IPv6), percent-encoding and every
 * other trick. The host must then have at least two labels, none empty (no leading, double or trailing dot), each a
 * plain label, the last starting with a letter (no IPv4 in any notation), and no BLOCKED_NAME_ENDINGS. Finally
 * `new URL()` must parse it the same way: protocol `https:`, no user name, password or port, and exactly the same
 * host. Anything unparseable is refused.
 */
export function checkWebAddress(address: unknown): ToolDecision {
  if (typeof address !== "string" || address === "") return deny(HTTPS_ONLY);
  if (address.length > MAX_WEB_ADDRESS_LENGTH) return deny(`The address is longer than ${MAX_WEB_ADDRESS_LENGTH} characters.`);
  if (!/^[\x21-\x7e]+$/.test(address) || address.includes("\\")) return deny(`${HTTPS_ONLY} Percent-encode any other character in the path.`);
  if (!address.startsWith("https://")) return deny(HTTPS_ONLY);
  const rest = address.slice("https://".length);
  const end = rest.search(/[/?#]/);
  const host = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return deny(`${HTTPS_ONLY} No user name, password, port, IP address or encoded characters in the site's name.`);
  const labels = host.split(".");
  const top = labels[labels.length - 1] ?? "";
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TOP_LABEL.test(top)) {
    return deny(`${HTTPS_ONLY} The site's name must be a full public name such as en.wikipedia.org: no IP address, no name without a dot.`);
  }
  if (BLOCKED_NAME_ENDINGS.some((ending) => host === ending || host.endsWith(`.${ending}`))) return deny("WebFetch may only read public sites, not local, internal or reserved names.");
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return deny(HTTPS_ONLY);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.hostname !== host || parsed.host !== host) {
    return deny(HTTPS_ONLY);
  }
  return { allow: true };
}

/** WebFetch: an address checkWebAddress allows, a prompt (a non-empty string), an optional whole `offset` >= 0, nothing else. */
function checkWebFetch(fields: Record<string, unknown>): ToolDecision {
  const unknown = Object.keys(fields).filter((name) => !WEB_FIELDS.includes(name));
  if (unknown.length > 0) return deny("WebFetch takes only url, prompt and offset.");
  const prompt = fields.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > MAX_WEB_PROMPT_LENGTH) return deny("WebFetch needs a prompt: what to find in the page.");
  const offset = fields.offset;
  if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) return deny("WebFetch's offset must be a whole number, 0 or more.");
  return checkWebAddress(fields.url);
}

/** The host (lower case) of a WebFetch call whose address checkWebAddress allows, for the build feed; never the path or query. */
export function fetchedHost(input: unknown): string | undefined {
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !checkWebAddress(url).allow) return undefined;
  return new URL(url).hostname;
}
