import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, checkToolCall, insideWorkspace, workspacePath } from "./permissions.js";

let base: string;
let ws: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ssd-builder-perm-"));
  ws = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(join(ws, "images"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(ws, "index.html"), "<p>hi</p>");
  writeFileSync(join(outside, "secret.txt"), "secret");
  // Links planted in the workspace (the agent cannot make them, but a repository could hold one).
  symlinkSync(outside, join(ws, "escape"));
  symlinkSync(join(outside, "secret.txt"), join(ws, "secret-link.txt"));
  symlinkSync(join(outside, "not-yet.txt"), join(ws, "dangling.txt"));
  symlinkSync(join(ws, "images"), join(ws, "pictures"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const allowed = { allow: true };

describe("criterion 2: the permission hook refuses anything outside the workspace, any command and any fetch", () => {
  it("allows reading, writing and editing files inside the workspace, absolute or relative, existing or new", () => {
    expect(checkToolCall(ws, "Read", { file_path: join(ws, "index.html") })).toEqual(allowed);
    expect(checkToolCall(ws, "Read", { file_path: "index.html" })).toEqual(allowed);
    expect(checkToolCall(ws, "Write", { file_path: join(ws, "app.js"), content: "x" })).toEqual(allowed);
    expect(checkToolCall(ws, "Write", { file_path: join(ws, "images", "new", "logo.svg"), content: "x" })).toEqual(allowed);
    expect(checkToolCall(ws, "Edit", { file_path: join(ws, "index.html"), old_string: "a", new_string: "b" })).toEqual(allowed);
    expect(checkToolCall(ws, "Write", { file_path: join(ws, "pictures", "cat.svg"), content: "x" })).toEqual(allowed);
    expect(checkToolCall(ws, "Glob", { pattern: "**/*.js" })).toEqual(allowed);
    expect(checkToolCall(ws, "Glob", { pattern: "*.css", path: join(ws, "images") })).toEqual(allowed);
  });

  it("refuses absolute paths outside the workspace", () => {
    for (const tool of ["Read", "Write", "Edit"]) {
      for (const path of ["/etc/passwd", join(outside, "secret.txt"), join(base, "ws-sibling", "x.txt"), "/", base]) {
        const decision = checkToolCall(ws, tool, { file_path: path, content: "x", old_string: "a", new_string: "b" });
        expect(decision.allow, `${tool} ${path}`).toBe(false);
      }
    }
  });

  it("refuses .. escapes, even ones that would come back inside, and ~", () => {
    for (const path of ["../outside/secret.txt", join(ws, "..", "outside", "secret.txt"), "images/../../outside/secret.txt", "images/../index.html", "~/.aws/credentials", "~", "..\\outside\\secret.txt", "", "index.html\0"]) {
      expect(checkToolCall(ws, "Read", { file_path: path }).allow, path).toBe(false);
      expect(checkToolCall(ws, "Write", { file_path: path, content: "x" }).allow, path).toBe(false);
    }
  });

  it("refuses paths that leave through a symlink: a linked folder, a linked file, and a dangling link a write would create", () => {
    expect(checkToolCall(ws, "Read", { file_path: join(ws, "escape", "secret.txt") }).allow).toBe(false);
    expect(checkToolCall(ws, "Write", { file_path: join(ws, "escape", "new.txt"), content: "x" }).allow).toBe(false);
    expect(checkToolCall(ws, "Read", { file_path: join(ws, "secret-link.txt") }).allow).toBe(false);
    expect(checkToolCall(ws, "Edit", { file_path: "secret-link.txt", old_string: "a", new_string: "b" }).allow).toBe(false);
    expect(checkToolCall(ws, "Write", { file_path: join(ws, "dangling.txt"), content: "x" }).allow).toBe(false);
    expect(checkToolCall(ws, "Glob", { pattern: "*", path: join(ws, "escape") }).allow).toBe(false);
  });

  it("refuses Glob patterns and folders that reach outside", () => {
    for (const input of [{ pattern: "/etc/*" }, { pattern: "../**" }, { pattern: "images/../../*" }, { pattern: "{..,x}/*" }, { pattern: "~/*" }, { pattern: "*", path: "/etc" }, { pattern: "*", path: ".." }, { pattern: "" }]) {
      expect(checkToolCall(ws, "Glob", input).allow, JSON.stringify(input)).toBe(false);
    }
  });

  it("refuses Glob patterns and folders with braces, brackets, '..' anywhere, a leading / or ~ (checker try 1)", () => {
    const patterns = [".{.,}/*", "{.,}./*", "[.][.]/*", ".[.]/*", "{/etc,x}/*", "**/*.{js,css}", "img/[ab].png", "a..b/*", "x/..*", "/*", "~*", "~/x"];
    for (const pattern of patterns) expect(checkToolCall(ws, "Glob", { pattern }).allow, pattern).toBe(false);
    for (const path of [join(ws, "{images,x}"), join(ws, "[i]mages"), `${ws}/images/..`, "~", "images/..x"]) {
      expect(checkToolCall(ws, "Glob", { pattern: "*", path }).allow, path).toBe(false);
    }
    expect(checkToolCall(ws, "Glob", { pattern: "images/*.svg" })).toEqual(allowed);
    expect(checkToolCall(ws, "Glob", { pattern: "**/*", path: ws })).toEqual(allowed);
  });

  it("refuses writes and edits to tool and CI settings in any letter case, and still lets the agent read them", () => {
    const paths = [
      ".github/workflows/ci.yml",
      ".GitHub/workflows/x.yml",
      ".claude/settings.json",
      ".Claude/commands/x.md",
      ".git/config",
      ".git/hooks/pre-commit",
      "images/.git/config",
      ".mcp.json",
      ".MCP.json",
      "CLAUDE.md",
      "claude.md",
      "docs/CLAUDE.md",
      ".gitattributes",
      ".GitAttributes",
    ];
    for (const path of paths) {
      expect(checkToolCall(ws, "Write", { file_path: path, content: "x" }).allow, path).toBe(false);
      expect(checkToolCall(ws, "Write", { file_path: join(ws, path), content: "x" }).allow, path).toBe(false);
      expect(checkToolCall(ws, "Edit", { file_path: path, old_string: "a", new_string: "b" }).allow, path).toBe(false);
    }
    expect(checkToolCall(ws, "Read", { file_path: "CLAUDE.md" })).toEqual(allowed);
    expect(checkToolCall(ws, "Write", { file_path: "github.css", content: "x" })).toEqual(allowed);
    expect(checkToolCall(ws, "Write", { file_path: "images/claude.md.png", content: "x" })).toEqual(allowed);
  });

  it("refuses running a command, fetching an address, searching the web, subagents, notebooks and any unknown tool", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["Bash", { command: "ls" }],
      ["Bash", { command: "curl https://example.org" }],
      ["WebFetch", { url: "https://example.org", prompt: "x" }],
      ["WebSearch", { query: "x" }],
      ["Task", { prompt: "x", description: "x", subagent_type: "general-purpose" }],
      ["Agent", { prompt: "x" }],
      ["NotebookEdit", { notebook_path: join(ws, "a.ipynb"), new_source: "x" }],
      ["Grep", { pattern: "x" }],
      ["mcp__any__tool", {}],
      ["SomethingNew", { file_path: join(ws, "index.html") }],
      ["read", { file_path: join(ws, "index.html") }],
    ];
    for (const [tool, input] of calls) expect(checkToolCall(ws, tool, input).allow, tool).toBe(false);
  });

  it("refuses inputs it does not understand", () => {
    expect(checkToolCall(ws, "Read", null).allow).toBe(false);
    expect(checkToolCall(ws, "Read", {}).allow).toBe(false);
    expect(checkToolCall(ws, "Read", { file_path: 42 }).allow).toBe(false);
    expect(checkToolCall(ws, "Write", ["index.html"]).allow).toBe(false);
  });

  it("refuses changes to AGENTS.md, SPEC.md and workshop-data.js, but lets the agent read them", () => {
    for (const file of ["AGENTS.md", "SPEC.md", "workshop-data.js"]) {
      expect(checkToolCall(ws, "Write", { file_path: join(ws, file), content: "x" }).allow, file).toBe(false);
      expect(checkToolCall(ws, "Edit", { file_path: file, old_string: "a", new_string: "b" }).allow, file).toBe(false);
      expect(checkToolCall(ws, "Read", { file_path: join(ws, file) })).toEqual(allowed);
    }
  });

  it("allows exactly the file tools, and lists the shell, network and agent tools as disallowed", () => {
    expect([...ALLOWED_TOOLS]).toEqual(["Read", "Write", "Edit", "Glob"]);
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"]) expect(DISALLOWED_TOOLS).toContain(tool);
    for (const tool of ALLOWED_TOOLS) expect(DISALLOWED_TOOLS).not.toContain(tool);
  });

  it("gives the workspace-relative path of an allowed file", () => {
    expect(insideWorkspace(ws, join(ws, "images", "a.svg"))).toBe(true);
    expect(workspacePath(ws, join(ws, "images", "a.svg"))).toBe("images/a.svg");
    expect(workspacePath(ws, "pictures/a.svg")).toBe("images/a.svg");
  });
});
