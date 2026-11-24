/**
 * What the coding agent may do (ticket 2.8): file tools only, inside its workspace folder. The spec's rule "the AI
 * that writes code has no AWS rights" (decision "Spec delta, CHANGED ... Builder") rests on this: no shell, no
 * network tool, no subagent, no MCP server, and no path outside the workspace.
 *
 * `checkToolCall` is pure apart from reading the file system to resolve links (`realpath` of the nearest existing
 * part of a path), so it is unit-tested directly on temporary folders. The agent (./agent.ts) runs it as a PreToolUse
 * hook on every tool call, before Claude Code's own permission rules; it is the only gate (`canUseTool` is not set: the
 * SDK never consults it for tools in `allowedTools`). It denies by default: any tool not on ALLOWED_TOOLS, any input it
 * does not understand, any path that is absolute outside the workspace, climbs out with `..`, starts with `~`, or
 * reaches outside through a symlink; any Glob pattern or folder with braces, brackets, `..`, a leading `/` or `~`; and
 * any write to tool or CI configuration (CONFIG_FOLDERS, CONFIG_FILES).
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The only tools the agent gets: read, write and edit files, and list them by pattern. */
export const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob"] as const;

/**
 * Removed from the agent's context as well (belt and braces: the tool list above already leaves them out, and the
 * hook denies anything not allowed). Shell, network, notebooks, subagents and workflows, skills, tasks and plans.
 */
export const DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
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
 * Allows a call only for an allowed tool whose every path stays inside `workspace`. Write and Edit may not touch
 * PROTECTED_FILES or tool and CI configuration (isConfigPath). Glob's pattern must be plain (plainGlobText: it is
 * joined to its folder and expanded by Claude Code).
 */
export function checkToolCall(workspace: string, tool: string, input: unknown): ToolDecision {
  if (!(ALLOWED_TOOLS as readonly string[]).includes(tool)) return deny(`The tool ${JSON.stringify(tool).slice(0, 60)} is not available: only Read, Write, Edit and Glob.`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) return deny("The tool call has no input.");
  const fields = input as Record<string, unknown>;
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
