import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, BLOCKED_NAME_ENDINGS, DISALLOWED_TOOLS, checkToolCall, checkWebAddress, fetchedHost, insideWorkspace, workspacePath } from "./permissions.js";

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

describe("criterion 2: the permission hook refuses anything outside the workspace and any command", () => {
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

  it("refuses a pattern segment of only dots and wildcards that holds a dot and a wildcard (it could match . or ..; try 3)", () => {
    const patterns = [".?/*", ".*/*", "*/.?/*", "?./*", "*.*/x", "images/.?", ".??/*", "**/.*/*"];
    for (const pattern of patterns) expect(checkToolCall(ws, "Glob", { pattern }).allow, pattern).toBe(false);
    // Wildcards next to letters, or a dot with letters, stay allowed.
    for (const pattern of ["*.css", "**/*.js", "images/*", "a?.html", "**/*"]) expect(checkToolCall(ws, "Glob", { pattern }), pattern).toEqual(allowed);
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

  it("refuses running a command, searching the web (not offered on Bedrock), subagents, notebooks and any unknown tool", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["Bash", { command: "ls" }],
      ["Bash", { command: "curl https://example.org" }],
      ["WebSearch", { query: "x" }],
      ["webfetch", { url: "https://example.org/", prompt: "x" }],
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

  it("allows exactly the file tools and WebFetch (ticket 2.15), and lists the shell, web search and agent tools as disallowed", () => {
    expect([...ALLOWED_TOOLS]).toEqual(["Read", "Write", "Edit", "Glob", "WebFetch"]);
    for (const tool of ["Bash", "WebSearch", "Task", "Agent", "NotebookEdit"]) expect(DISALLOWED_TOOLS).toContain(tool);
    for (const tool of ALLOWED_TOOLS) expect(DISALLOWED_TOOLS).not.toContain(tool);
  });

  it("gives the workspace-relative path of an allowed file", () => {
    expect(insideWorkspace(ws, join(ws, "images", "a.svg"))).toBe(true);
    expect(workspacePath(ws, join(ws, "images", "a.svg"))).toBe("images/a.svg");
    expect(workspacePath(ws, "pictures/a.svg")).toBe("images/a.svg");
  });
});

// Ticket 2.15: WebFetch only for an https address of a named public host.
describe("ticket 2.15: WebFetch is allowed only for https addresses with a named public host", () => {
  const fetchCall = (url: unknown, extra: Record<string, unknown> = {}) => checkToolCall(ws, "WebFetch", { url, prompt: "What fields does the answer hold?", ...extra });

  it("criterion 2: allows an https address of a named public host, with or without a path, query or fragment", () => {
    const urls = [
      "https://en.wikipedia.org/api/rest_v1/page/summary/Inception",
      "https://en.wikipedia.org",
      "https://en.wikipedia.org/",
      "https://openlibrary.org/search.json?q=the+hobbit",
      "https://api.open-meteo.com/v1/forecast?latitude=52.5&longitude=13.4&current=temperature_2m",
      "https://api.frankfurter.app/latest#top",
      "https://API.TVMaze.com/search/shows?q=girls",
      "https://xn--bcher-kva.example.com/",
      "https://my-site.github.io/docs/",
      "https://en.wikipedia.org/wiki/Am%C3%A9lie",
      "https://1password.com/",
    ];
    for (const url of urls) expect(fetchCall(url), url).toEqual(allowed);
    expect(fetchCall("https://en.wikipedia.org/", { offset: 2000 })).toEqual(allowed);
  });

  it("criterion 3: refuses http and every other scheme", () => {
    const urls = [
      "http://en.wikipedia.org/",
      "HTTP://en.wikipedia.org/",
      "ftp://example.com/",
      "file:///etc/passwd",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "ws://example.com/",
      "wss://example.com/",
      "gopher://example.com/",
      "//en.wikipedia.org/",
      "en.wikipedia.org/",
      "https:en.wikipedia.org/",
      "https:/en.wikipedia.org/",
      "https:///en.wikipedia.org/",
      "https:\\\\en.wikipedia.org\\",
      "HTTPS://en.wikipedia.org/",
      " https://en.wikipedia.org/",
      "https://en.wikipedia.org/ ",
    ];
    for (const url of urls) expect(fetchCall(url).allow, url).toBe(false);
  });

  it("criterion 3: refuses an IPv4 address in any notation: dotted, decimal, hex, octal and short forms", () => {
    const hosts = [
      "169.254.170.2",
      "169.254.169.254",
      "127.0.0.1",
      "10.0.0.1",
      "0.0.0.0",
      "8.8.8.8",
      "2130706433",
      "0x7f000001",
      "0X7F000001",
      "017700000001",
      "0177.0.0.1",
      "0x7f.0.0.1",
      "0x7f.1",
      "127.1",
      "127.0.1",
      "169.254.43518",
      "0",
      "1.1.1.1.",
      "4294967295",
    ];
    for (const host of hosts) {
      expect(fetchCall(`https://${host}/`).allow, host).toBe(false);
      expect(fetchCall(`https://${host}/latest/meta-data/`).allow, host).toBe(false);
    }
  });

  it("criterion 3: refuses an IPv6 address in brackets, mapped IPv4 included", () => {
    const hosts = ["[::1]", "[::]", "[::ffff:169.254.170.2]", "[::ffff:a9fe:aa02]", "[fd00:ec2::254]", "[fe80::1%25eth0]", "[2001:db8::1]", "::1"];
    for (const host of hosts) expect(fetchCall(`https://${host}/`).allow, host).toBe(false);
  });

  it("criterion 3: refuses localhost, single-label names and internal or local names", () => {
    const hosts = [
      "localhost",
      "LOCALHOST",
      "api.localhost",
      "intranet",
      "metadata",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "ip-10-0-0-1.eu-central-1.compute.internal",
      "router.lan",
      "nas.home.arpa",
      "wiki.intranet",
      "app.corp",
      "box.home",
      "box.localdomain",
      "x.test",
      "x.invalid",
      "x.example",
      "abc.onion",
      "2.170.254.169.in-addr.arpa",
      "x.private",
    ];
    for (const host of hosts) expect(fetchCall(`https://${host}/`).allow, host).toBe(false);
    for (const ending of BLOCKED_NAME_ENDINGS) expect(fetchCall(`https://name.${ending}/`).allow, ending).toBe(false);
  });

  it("criterion 3: refuses a user name, a password or any port, explicit default port included", () => {
    const urls = [
      "https://user@en.wikipedia.org/",
      "https://user:pass@en.wikipedia.org/",
      "https://:pass@en.wikipedia.org/",
      "https://@en.wikipedia.org/",
      "https://en.wikipedia.org@169.254.170.2/",
      "https://en.wikipedia.org:443/",
      "https://en.wikipedia.org:8443/",
      "https://en.wikipedia.org:/",
      "https://en.wikipedia.org:0x1bb/",
    ];
    for (const url of urls) expect(fetchCall(url).allow, url).toBe(false);
  });

  it("refuses trailing-dot, empty-label, percent-encoded, backslash and non-ASCII hosts and other parser tricks", () => {
    const urls = [
      "https://en.wikipedia.org./",
      "https://localhost./",
      "https://.en.wikipedia.org/",
      "https://en..wikipedia.org/",
      "https://%6c%6f%63%61%6c%68%6f%73%74/",
      "https://en.wikipedia%2eorg/",
      "https://127%2e0%2e0%2e1/",
      "https://en.wikipedia.org\\@169.254.170.2/",
      "https://en.wikipedia.org\\.evil/",
      "https://b\u00fccher.example.com/",
      "https://ｌｏｃａｌｈｏｓｔ/",
      "https://en.wikipedia.org\t/",
      "https://en.wiki\npedia.org/",
      "https://en.wikipedia.org/\u0000",
      "https://-bad.example.com/",
      "https://bad-.example.com/",
      "https://under_score.example.com/",
      "https://en.wikipedia.org;x/",
      "https://en.wikipedia.org,x/",
      "https://*.example.com/",
      "https:// en.wikipedia.org/",
      "https://en.wikipedia.123/",
      "https://en.wikipedia.0x1/",
      `https://${"a".repeat(64)}.com/`,
      `https://en.wikipedia.org/${"a".repeat(3000)}`,
      "https://",
      "https:",
      "",
    ];
    for (const url of urls) expect(fetchCall(url).allow, JSON.stringify(url)).toBe(false);
  });

  it("refuses inputs that are not what WebFetch takes", () => {
    expect(checkToolCall(ws, "WebFetch", { url: "https://en.wikipedia.org/" }).allow).toBe(false);
    expect(checkToolCall(ws, "WebFetch", { url: "https://en.wikipedia.org/", prompt: 42 }).allow).toBe(false);
    expect(checkToolCall(ws, "WebFetch", { url: "https://en.wikipedia.org/", prompt: "" }).allow).toBe(false);
    expect(checkToolCall(ws, "WebFetch", { url: "https://en.wikipedia.org/", prompt: "x".repeat(20_001) }).allow).toBe(false);
    expect(checkToolCall(ws, "WebFetch", { url: ["https://en.wikipedia.org/"], prompt: "x" }).allow).toBe(false);
    expect(checkToolCall(ws, "WebFetch", { url: 42, prompt: "x" }).allow).toBe(false);
    expect(checkToolCall(ws, "WebFetch", null).allow).toBe(false);
    expect(fetchCall("https://en.wikipedia.org/", { offset: -1 }).allow).toBe(false);
    expect(fetchCall("https://en.wikipedia.org/", { offset: 1.5 }).allow).toBe(false);
    expect(fetchCall("https://en.wikipedia.org/", { offset: "10" }).allow).toBe(false);
    expect(fetchCall("https://en.wikipedia.org/", { headers: { authorization: "x" } }).allow).toBe(false);
    expect(fetchCall("https://en.wikipedia.org/", { file_path: "index.html" }).allow).toBe(false);
  });

  it("checkWebAddress gives a reason the agent can act on, and fetchedHost gives only the host of an allowed address", () => {
    const refused = checkWebAddress("http://169.254.170.2/v2/credentials");
    expect(refused.allow).toBe(false);
    if (!refused.allow) expect(refused.reason).toMatch(/https/);
    expect(fetchedHost({ url: "https://en.wikipedia.org/api/rest_v1/page/summary/Inception?redirect=true" })).toBe("en.wikipedia.org");
    expect(fetchedHost({ url: "https://API.TVMaze.com/search/shows?q=x" })).toBe("api.tvmaze.com");
    expect(fetchedHost({ url: "http://169.254.170.2/" })).toBeUndefined();
    expect(fetchedHost({ url: 42 })).toBeUndefined();
    expect(fetchedHost(null)).toBeUndefined();
  });
});
