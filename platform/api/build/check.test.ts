// Ticket 2.3: the deploy check (criteria 1 to 4). Pure rules on a list of files, plus the folder reader.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS, MAX_APP_BYTES, checkApp, outsideAddresses, readAppFolder, type AppFile } from "./check.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/basic/", import.meta.url));

const text = (path: string, content: string): AppFile => ({ path, kind: "file", bytes: new TextEncoder().encode(content) });
const INDEX = text("index.html", "<!doctype html><title>App</title>");

/** The check's result on the minimal app plus `files`. */
const check = (...files: AppFile[]) => checkApp([INDEX, ...files]);

describe("the deploy check on the template (criterion 1)", () => {
  it("passes templates/basic as read from disk", async () => {
    const result = checkApp(await readAppFolder(TEMPLATE_DIR));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.totalBytes).toBeGreaterThan(0);
  });
});

describe("file types (criterion 2)", () => {
  it.each(["server.php", "tool.exe", "lib/engine.wasm", "run.sh", "Makefile", "notes.docx"])(
    "fails a build that adds %s and names it",
    (path) => {
      const result = check(text(path, "x"));
      expect(result.ok).toBe(false);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]?.file).toBe(path);
      expect(result.problems[0]?.reason).toMatch(/not an allowed file type/);
    },
  );

  it("fails a symlink and names it, without following it", () => {
    const result = check({ path: "data.json", kind: "symlink", bytes: new Uint8Array() });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ file: "data.json", reason: expect.stringMatching(/link/i) }]);
  });

  it("accepts every allowed type, in any letter case", () => {
    const files = ALLOWED_EXTENSIONS.map((extension) => text(`assets/file${extension}`, "plain"));
    expect(check(...files, text("images/PHOTO.JPG", "x")).problems).toEqual([]);
  });

  it.each(["../outside.js", "/etc/passwd.txt", "a/../../b.js", "a//b.js", "C:\\app.js", "a\\b.js", "my file.js", ""])(
    "fails the unsafe name %j",
    (path) => {
      const result = check(text(path, "x"));
      expect(result.ok).toBe(false);
      expect(result.problems[0]?.file).toBe(path);
    },
  );

  it("fails hidden files and folders, .git included: only readAppFolder leaves a working copy's .git out", () => {
    const result = check(
      text(".env.json", "{}"),
      text("css/.hidden.css", ""),
      { path: ".git", kind: "dir", bytes: new Uint8Array() },
      text(".git/config.txt", "x"),
      text(".git/objects/ab.txt", "x"),
    );
    expect(result.problems.map((problem) => problem.file)).toEqual([".env.json", "css/.hidden.css", ".git", ".git/config.txt", ".git/objects/ab.txt"]);
    expect(result.problems.every((problem) => /Hidden files/.test(problem.reason))).toBe(true);
  });

  it("ignores folders themselves", () => {
    expect(check({ path: "images", kind: "dir", bytes: new Uint8Array() }).ok).toBe(true);
  });

  it("fails an app without index.html at its root", () => {
    const result = checkApp([text("pages/index.html", "<p>hi</p>")]);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ file: "index.html", reason: expect.stringMatching(/no index\.html/) }]);
  });
});

describe("outside addresses (criterion 3)", () => {
  it.each([
    ['<script src="https://cdn.example.com/lib.js"></script>', "index.html"],
    ['<img src="//images.example.com/cat.png" alt="">', "index.html"],
    ['<a href=//example.com>x</a>', "index.html"],
    ['const data = await fetch("http://api.example.com/items");', "app.js"],
    ["const socket = new WebSocket('wss://chat.example.com');", "app.js"],
    ["const image = `//images.example.com/${name}.png`;", "app.js"],
    ['import confetti from "https://esm.sh/confetti";', "app.js"],
    ["body { background: url(//images.example.com/bg.png); }", "style.css"],
    ['@import url("https://fonts.googleapis.com/css2?family=Inter");', "style.css"],
    ['{ "source": "HTTPS://Example.com/data" }', "data.json"],
    ["See https://example.com for more.", "notes.md"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>', "logo.svg"],
    ['fetch("https://workshop.rankly.games.example.com/x")', "app.js"],
    ['fetch("https://workshop.rankly.games@example.com/x")', "app.js"],
    ['fetch("https://workshop.rankly.games:8443/x")', "app.js"],
    ['fetch("http://workshop.rankly.games/x")', "app.js"],
    ["const link = 'git+ssh://example.com/repo';", "app.js"],
    // A scheme without slashes still opens another server.
    ['<a href="http:example.com">x</a>', "index.html"],
    ["new WebSocket('wss:example.com')", "app.js"],
    ['fetch("https:example.com/x")', "app.js"],
    ['<img src="HTTP:example.com/a.png">', "index.html"],
    // Backslashes count as slashes, and so do three or more.
    ['<img src="\\\\example.com/a.png">', "index.html"],
    ['<img src="/\\example.com/a.png">', "index.html"],
    ['fetch("///example.com/x")', "app.js"],
    ['<img src="https:\\\\example.com/a.png">', "index.html"],
    // Spaces, tabs or control characters before the slashes.
    ['<img src=" //example.com/a.png">', "index.html"],
    ['<img src="\t//example.com/a.png">', "index.html"],
    ["<img src = //example.com/a.png>", "index.html"],
    ['<form action= //example.com/send>', "index.html"],
    ["<img src='\u0001//example.com/a.png'>", "index.html"],
    // After a comma (srcset) and in a meta refresh.
    ['<img srcset="a.png 1x, //example.com/b.png 2x" src="a.png" alt="">', "index.html"],
    ['<meta http-equiv="refresh" content="0;url=//example.com">', "index.html"],
    ['<meta http-equiv="refresh" content="0; URL = //example.com">', "index.html"],
    // HTML entities.
    ['<a href="https&#58;//example.com">x</a>', "index.html"],
    ['<img src="&#47;&#47;example.com/a.png">', "index.html"],
    ['<a href="https&colon;&sol;&sol;example.com">x</a>', "index.html"],
    ['<img src="&#x2f;&#X2F;example.com/a.png">', "index.html"],
    ['<a href="ht&Tab;tps://example.com">x</a>', "index.html"],
    ['<image href="&#x68;ttps://example.com/a.png"/>', "logo.svg"],
    // CSS escapes, also inside an HTML style block.
    ['body { background: url("\\2f\\2f example.com/a.png"); }', "style.css"],
    ["body { background: url(\\/\\/example.com/a.png); }", "style.css"],
    ['<style>body { background: url("\\2f\\2f example.com/a.png"); }</style>', "index.html"],
    // JavaScript and JSON escapes.
    ['fetch("\\/\\/example.com/x")', "app.js"],
    ['fetch("\\u002f\\u002fexample.com/x")', "app.js"],
    ['fetch("\\x2f\\x2fexample.com/x")', "app.js"],
    ['fetch("\\u{2f}/example.com/x")', "app.js"],
    ['{ "source": "https:\\/\\/example.com" }', "data.json"],
    ["fetch('\\x68ttps://example.com')", "app.js"],
  ])("fails %s and names the file and line", (line, file) => {
    const result = check(text(file, `first line\n\n${line}\nlast line`));
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ file, line: 3, reason: expect.stringMatching(/outside address/) }]);
  });

  it("names the address in the reason", () => {
    const [problem] = check(text("app.js", 'fetch("https://api.example.com/items");')).problems;
    expect(problem?.reason).toContain("https://api.example.com/items");
  });

  it("reports every outside address of a line once", () => {
    const result = check(text("index.html", '<a href="https://a.example.com">a</a> <a href="//b.example.com">b</a>'));
    expect(result.problems.map((problem) => problem.reason)).toEqual([
      expect.stringContaining("https://a.example.com"),
      expect.stringContaining("//b.example.com"),
    ]);
  });

  it.each([
    "// a comment line must not fail",
    "const half = a // b",
    "const ratio = total / 2; // per player",
    "/* block comment */ const x = 1;",
    'const url = "/api/apps/" + nickname + "/data/" + key;',
    'fetch("https://workshop.rankly.games/api/apps/demo/data/score")',
    'const home = "https://workshop.rankly.games";',
    '<a href="https://workshop.rankly.games/">The workshop</a>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>',
    'const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");',
    'const empty = ""; // note',
    "const pattern = /\\/\\//;",
    '<link rel="icon" href="data:,">',
    "<p>Scores: 3/4 and 1//2</p>",
    '<math xmlns="http://www.w3.org/1998/Math/MathML"></math>',
    'el.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:xlink", "http://www.w3.org/1999/xlink");',
    "a:hover { color: red; }",
    "const handlers = { http: 1, https: 2 };",
    'if (location.protocol === "https:") show();',
    "const text = 'x'; // note",
    "call(a, b); // see below",
    "body { margin: 0; } /* a // b */",
    '<img srcset="small.png 1x, large.png 2x" src="small.png" alt="">',
    "const ok = a === b && c !== d;",
    "<p>Tom &amp; Jerry &#8212; 3 &lt; 4</p>",
    'const path = "C:\\Users\\demo";',
  ])("accepts %s", (line) => {
    expect(check(text("app.js", line), text("page.html", line)).problems).toEqual([]);
  });

  it("fails a comment that starts right after a closing quote ('x'//note): a scan cannot tell it from an address", () => {
    // AGENTS.md tells the agent to put a space after // in comments, which passes.
    expect(check(text("app.js", "const a = 'x'//note")).ok).toBe(false);
    expect(check(text("app.js", "const a = 'x'// note")).ok).toBe(true);
  });

  it("reads lines split by \\r\\n, \\r or \\n", () => {
    const result = check(text("app.js", "one\r\ntwo\rthree\nfetch('https://example.com')"));
    expect(result.problems).toEqual([{ file: "app.js", line: 4, reason: expect.stringMatching(/outside address/) }]);
  });

  it("accepts a UTF-8 file that starts with a byte order mark, and still scans it", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new TextEncoder().encode("ok\nfetch('https://example.com')");
    const withBom = (content: Uint8Array): AppFile => ({ path: "app.js", kind: "file", bytes: new Uint8Array([...bom, ...content]) });
    expect(check(withBom(new TextEncoder().encode("const a = 1;"))).ok).toBe(true);
    expect(check(withBom(body)).problems).toEqual([{ file: "app.js", line: 2, reason: expect.stringMatching(/outside address/) }]);
  });

  it.each([
    ["UTF-16 with a byte order mark", [0xff, 0xfe, 0x2f, 0x00, 0x2f, 0x00]],
    ["UTF-16 big-endian with a byte order mark", [0xfe, 0xff, 0x00, 0x2f, 0x00, 0x2f]],
    ["Latin-1", [0x63, 0x61, 0x66, 0xe9]],
    ["a NUL byte", [0x22, 0x2f, 0x00, 0x2f, 0x65, 0x22]],
    ["a cut UTF-8 sequence", [0x61, 0xe2, 0x82]],
  ])("fails a text file holding %s, naming it", (_name, bytes) => {
    const result = check({ path: "app.js", kind: "file", bytes: new Uint8Array(bytes) });
    expect(result.problems).toEqual([{ file: "app.js", reason: "It is not plain UTF-8 text, so it cannot be checked. Save it as UTF-8 text." }]);
  });

  it.each([
    ["letters", "a"],
    ["slashes", "/"],
    ["backslashes", "\\"],
    ["digits", "1"],
    ["spaces after =", "= "],
    ["spaces after a quote", "' "],
    ["url( and spaces", "url( "],
    ["quotes and slashes", "'//"],
    ["scheme starts", "http:"],
    ["scheme letters and colons", "a:/"],
    ["entities", "&#"],
    ["CSS escapes", "\\2f"],
    ["commas and slashes", ",/"],
  ])("scans a line of 3 MB of %s within a second (no backtracking blow-up)", (_name, unit) => {
    // The patterns are linear: a quadratic one took 72 s on 400 KB of letters.
    const line = unit.repeat(Math.ceil((3 * 1024 * 1024) / unit.length));
    for (const variant of [line, `=${line}`, `"${line}`]) {
      const started = performance.now();
      outsideAddresses(variant);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("does not scan binary files", () => {
    expect(check(text("photo.png", "https://example.com")).ok).toBe(true);
  });
});

describe("size (criterion 4)", () => {
  const big = (path: string, bytes: number): AppFile => ({ path, kind: "file", bytes: new Uint8Array(Math.round(bytes)) });

  it("fails when the files total more than 5 MB, with the size", () => {
    const result = check(big("a.png", 3 * 1024 * 1024), big("b.png", 2.2 * 1024 * 1024));
    expect(result.ok).toBe(false);
    expect(result.totalBytes).toBe(INDEX.bytes.length + 3 * 1024 * 1024 + Math.round(2.2 * 1024 * 1024));
    expect(result.problems).toEqual([{ reason: "The app is 5.2 MB; the limit is 5 MB." }]);
  });

  it("never shows a size over the limit as 5 MB", () => {
    const result = check(big("a.png", MAX_APP_BYTES + 1 - INDEX.bytes.length));
    expect(result.problems).toEqual([{ reason: "The app is 5.1 MB; the limit is 5 MB." }]);
  });

  it("passes exactly 5 MB", () => {
    expect(check(big("a.png", MAX_APP_BYTES - INDEX.bytes.length)).ok).toBe(true);
  });

});

describe("readAppFolder", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists files with their bytes, reports symlinks without following them and skips .git", async () => {
    dir = mkdtempSync(join(tmpdir(), "ssd-workshop-check-"));
    mkdirSync(join(dir, "images"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    writeFileSync(join(dir, "images", "a.svg"), "<svg/>");
    writeFileSync(join(dir, ".git", "HEAD"), "ref");
    // A working copy's history is not part of the app: neither checked nor counted in the size.
    writeFileSync(join(dir, ".git", "pack.txt"), new Uint8Array(MAX_APP_BYTES + 1));
    symlinkSync("/etc/hostname", join(dir, "images", "link.txt"));

    const files = await readAppFolder(dir);
    const summary = files.map((file) => [file.path, file.kind, file.bytes.length]).sort();
    expect(summary).toEqual([
      ["images", "dir", 0],
      ["images/a.svg", "file", 6],
      ["images/link.txt", "symlink", 0],
      ["index.html", "file", 9],
    ]);
    expect(checkApp(files).problems).toEqual([{ file: "images/link.txt", reason: expect.stringMatching(/link/i) }]);
  });
});
