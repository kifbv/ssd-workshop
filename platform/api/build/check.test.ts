// Ticket 2.3: the deploy check (criteria 1 to 4). Pure rules on a list of files, plus the folder reader.
// Ticket 2.14: plain https:// addresses are accepted, and API keys or tokens written in a file are refused.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS, KEY_VALUE_MIN_CHARS, MAX_APP_BYTES, MAX_PROBLEMS, checkApp, keysIn, outsideAddresses, readAppFolder, type AppFile } from "./check.js";

/** Fake key values, built at run time so secret scanners do not take the test file for a leak (ticket 2.14). */
const FAKE_KEY = ["FAKE", "test", "KEY", "0123456789", "not", "REAL"].join("");
const GOOGLE_LIKE = ["AI", "za", "Sy", FAKE_KEY, "x1"].join("");
const GOOGLE_LIKE_DASHED = ["AI", "za", "Sy", "D-", FAKE_KEY, "-x1"].join("");
const GITHUB_LIKE = ["gh", "p_", FAKE_KEY, "q7r8"].join("");

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

describe("outside addresses (criterion 3; ticket 2.14: plain https:// addresses are fine)", () => {
  it.each([
    ['<img src="//images.example.com/cat.png" alt="">', "index.html"],
    ['<a href=//example.com>x</a>', "index.html"],
    ['const data = await fetch("http://api.example.com/items");', "app.js"],
    ["const socket = new WebSocket('wss://chat.example.com');", "app.js"],
    ["const image = `//images.example.com/${name}.png`;", "app.js"],
    ["body { background: url(//images.example.com/bg.png); }", "style.css"],
    ['fetch("https://workshop.rankly.games@example.com/x")', "app.js"],
    ['fetch("https://workshop.rankly.games:8443/x")', "app.js"],
    ['fetch("http://workshop.rankly.games/x")', "app.js"],
    ["const link = 'git+ssh://example.com/repo';", "app.js"],
    // Ticket 2.14: every scheme but https stays refused, and an https address must be plain.
    ['fetch("http://api.example.com/items")', "app.js"],
    ["const socket = new WebSocket('ws://chat.example.com');", "app.js"],
    ['<a href="ftp://files.example.com/a.txt">x</a>', "index.html"],
    ['<iframe src="data://example.com"></iframe>', "index.html"],
    ['<a href="javascript://example.com/%0Aalert(1)">x</a>', "index.html"],
    ['fetch("https://user:secret@api.example.com/x")', "app.js"],
    ['fetch("https://user@api.example.com/x")', "app.js"],
    ['fetch("https://api.example.com:8443/x")', "app.js"],
    ['fetch("https://api.example.com:443/x")', "app.js"],
    ['fetch("https://api.example.com@evil.example.com/x")', "app.js"],
    ['fetch("https://%65vil.example.com/x")', "app.js"],
    ['fetch("https://localhost/x")', "app.js"],
    ['fetch("https://")', "app.js"],
    ['fetch("https://example.com./x")', "app.js"],
    ['fetch("https://[::1]/x")', "app.js"],
    // Ticket 2.14 try 2: `${` may follow the host, but a literal port or user name still may not.
    ["fetch(`https://api.example.com:8080${path}`)", "app.js"],
    ["fetch(`https://user@api.example.com${path}`)", "app.js"],
    ["fetch(`https://api.example.com$/x`)", "app.js"],
    ["fetch(`https://api.example.com{x}`)", "app.js"],
    // Ticket 2.14 try 3: what follows `${...}` up to the path is read too, and an `@` right after an address.
    ['<img src="https://a.b${x}@evil.example/p.png">', "index.html"],
    ['fetch("https://a.b${x}@evil.example/p.json")', "app.js"],
    ['fetch("https://a.b${:pw@evil.example/")', "app.js"],
    ["fetch(`https://a.b${}:8080/`)", "app.js"],
    ["fetch(`https://a.b${x}.c:8080/`)", "app.js"],
    ["fetch(`https://a.b${x/y}@evil.example/`)", "app.js"],
    ["fetch(`https://a.b${f(x)}@evil.example/`)", "app.js"],
    ["fetch(`https://a.b${f(x)}`)", "app.js"],
    ["<a href='https://a.b\"@evil.example/'>x</a>", "index.html"],
    ["fetch(`https://a.b${x}\"@evil.example/`)", "app.js"],
    // An https address written with escapes or entities is refused: write it plainly.
    ['<img src="https&#58;&#47;&#47;images.example.com/a.png">', "index.html"],
    ['fetch("https://ex\\u0061mple.com/x")', "app.js"],
    ["fetch('https://example.com\\x2fx')", "app.js"],
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
    // Leading zeros in entities and in \u{...}.
    ['<img src="&#0000000047;&#0000000047;example.com/a.png">', "index.html"],
    ['<img src="&#x00000002f;&#x00000002f;example.com/a.png">', "index.html"],
    ['<a href="https&#00000000058;//example.com">x</a>', "index.html"],
    ['fetch("\\u{00000002f}/example.com")', "app.js"],
    // JavaScript control escapes (a tab or line break inside an address is dropped) and legacy octal escapes.
    ['fetch("ht\\ttp:example.com")', "app.js"],
    ['fetch("ht\\rtp:example.com")', "app.js"],
    ['fetch("\\57\\57example.com")', "app.js"],
    ['fetch("https\\72//example.com")', "app.js"],
    // A meta refresh without url=.
    ['<meta http-equiv="refresh" content="0; //example.com">', "index.html"],
    ['<meta http-equiv="refresh" content="0 //example.com">', "index.html"],
    ['<meta http-equiv="refresh" content="0,//example.com">', "index.html"],
    ['<meta http-equiv="refresh" content="2.5;//example.com">', "index.html"],
  ])("fails %s and names the file and line", (line, file) => {
    const result = check(text(file, `first line\n\n${line}\nlast line`));
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ file, line: 3, reason: expect.stringMatching(/outside address/) }]);
  });

  it("names the address in the reason, in plain words", () => {
    const [problem] = check(text("app.js", 'fetch("http://api.example.com/items");')).problems;
    expect(problem?.reason).toBe(
      "It refers to an outside address that is not allowed (http://api.example.com/items). An app may use its own files and outside addresses written plainly as https:// and the site's name, with no user name, password or port.",
    );
  });

  it("reports every outside address of a line once", () => {
    const result = check(text("index.html", '<a href="http://a.example.com">a</a> <a href="//b.example.com">b</a> <a href="https://c.example.com">c</a>'));
    expect(result.problems.map((problem) => problem.reason)).toEqual([
      expect.stringContaining("http://a.example.com"),
      expect.stringContaining("//b.example.com"),
    ]);
  });

  it.each([
    'fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title))',
    '<img src="https://upload.wikimedia.org/wikipedia/en/a/a1/Poster.jpg" alt="Poster">',
    'fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`)',
    'const cover = "https://covers.openlibrary.org/b/isbn/" + isbn + "-M.jpg";',
    '{ "source": "HTTPS://Example.com/data", "home": "https://openlibrary.org" }',
    "See https://example.com for more.",
    "// Data from https://api.frankfurter.app/latest?from=EUR",
    '<a href="https://api.tvmaze.com/search/shows?q=girls#top">TV</a>',
    'fetch("https://restcountries.com/v3.1/name/" + name)',
    'fetch("https://workshop.rankly.games.example.com/x")',
    'fetch("https://xn--bcher-kva.example/x")',
    'fetch("https://api.example.com/path/@user:42")',
    'fetch("https://api.example.com?q=1")',
    // Scripts, styles and fonts from other sites pass the check, but the apps' CSP blocks them (template.test.ts).
    '<script src="https://cdn.example.com/lib.js"></script>',
    'import confetti from "https://esm.sh/confetti";',
    '@import url("https://fonts.googleapis.com/css2?family=Inter");',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>',
    // A template literal's part right after the host (Open Library's `doc.key` starts with a slash).
    "fetch(`https://openlibrary.org${doc.key}.json`)",
    "const cover = `https://covers.openlibrary.org${path}`;",
    "const cover = `https://a.b${path}`;",
    "fetch(`https://openlibrary.org${doc.key}.json?fields=${fields}`)",
    // An at sign after a space, a tag's end or a comma is not part of the address.
    '<a href="https://example.com">Mail me</a> at me@example.com',
    "Data from https://example.com @someone",
  ])("accepts the plain https address in %s (ticket 2.14)", (line) => {
    expect(check(text("app.js", line), text("page.html", line), text("notes.md", line)).problems).toEqual([]);
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
    const result = check(text("app.js", "one\r\ntwo\rthree\nfetch('http://example.com')"));
    expect(result.problems).toEqual([{ file: "app.js", line: 4, reason: expect.stringMatching(/outside address/) }]);
  });

  it("accepts a UTF-8 file that starts with a byte order mark, and still scans it", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new TextEncoder().encode("ok\nfetch('http://example.com')");
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
    ["zero-padded entities", "&#x0"],
    ["zeros after an entity start", "0"],
    ["octal escapes", "\\5"],
    ["braced escapes with zeros", "\\u{0"],
    ["meta refresh starts", 'content="0 '],
    ["spaces after content=", "content= "],
  ])("scans a line of 256 KB of %s within a second (no backtracking blow-up)", (_name, unit) => {
    // The patterns are linear (a few ms here): a quadratic one took 72 s on 400 KB of letters.
    const line = unit.repeat(Math.ceil((256 * 1024) / unit.length));
    for (const variant of [line, `=${line}`, `"${line}`, `&#x${line}`, `content="${line}`]) {
      const started = performance.now();
      outsideAddresses(variant);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it.each([
    ["letters after https://", "https://a"],
    ["dots after https://", "https://a."],
    ["https:// over and over", "https://"],
    ["key= in an address", "?key="],
    ["key names", "api_key"],
    ["key names and quotes", "apikey'"],
    ["key names and spaces", "access_token "],
    ["Authorization and quotes", "Authorization\" "],
    ["long key values", "&token=a"],
    ["camelCase key names", "aApiKey"],
    ["camelCase names and spaces", "xAccessToken "],
    ["upper-case names", "AAPI_KEY"],
    ["key properties", 'key: "'],
    ["key properties and long values", 'key:"a1'],
    ["quoted key properties", '"token" : '],
    // Ticket 2.14 try 3.
    ["template parts after https://", "https://a.b${"],
    ["closed template parts", "${x}"],
    ["open braces", "${"],
    ["at signs", "@"],
    ["key names ending a longer name", 'OPENWEATHER_KEY = "'],
    ["camelCase key names and long values", 'aKey:"a1'],
    ["Apikey names", "aApikey"],
    ["set calls", '.set("key", "'],
    ["set calls and long values", '.set("appid","a1'],
    ["joined query values", '?appid=" + "'],
  ])("scans a line of 256 KB of %s within a second, for addresses and keys (ticket 2.14)", (_name, unit) => {
    const line = unit.repeat(Math.ceil((256 * 1024) / unit.length));
    for (const variant of [line, `=${line}`, `"${line}`, `?key=${line}`, `api_key ${line}`, `key: "${line}`, `https://a.b${line}`]) {
      const started = performance.now();
      outsideAddresses(variant);
      keysIn(variant);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("does not scan binary files", () => {
    expect(check(text("photo.png", "http://example.com api_key=x")).ok).toBe(true);
  });

  it("lists the first 50 problems and counts the rest in one line", () => {
    // 100,000 outside addresses on one line plus a file type: 100,001 problems, 50 listed.
    const result = check(text("app.js", '"//a" '.repeat(100_000)), text("run.sh", "x"));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(MAX_PROBLEMS + 1);
    expect(result.problems.slice(0, MAX_PROBLEMS).every((problem) => problem.file === "app.js" && problem.line === 1)).toBe(true);
    expect(result.problems[MAX_PROBLEMS]).toEqual({ reason: "…and 99951 more problems." });
  });

  it("keeps the app's own problems after the first 50", () => {
    const files = Array.from({ length: 52 }, (_, index) => text(`tool${index}.exe`, "x"));
    const result = checkApp(files);
    expect(result.problems.map((problem) => problem.reason).slice(MAX_PROBLEMS)).toEqual([
      expect.stringMatching(/no index\.html/),
      "…and 2 more problems.",
    ]);
  });

  it("lists every problem when there are 50 or fewer", () => {
    const files = Array.from({ length: MAX_PROBLEMS }, (_, index) => text(`tool${index}.exe`, "x"));
    expect(check(...files).problems).toHaveLength(MAX_PROBLEMS);
  });
});

describe("API keys and tokens (ticket 2.14)", () => {
  const LONG = "a".repeat(KEY_VALUE_MIN_CHARS);
  it.each([
    ['fetch("https://api.example.com/x?api_key=abc123")', "app.js", "api_key="],
    ['fetch("https://api.example.com/x?apikey=abc123")', "app.js", "apikey="],
    ['fetch("https://api.example.com/x?APIKEY=abc123")', "app.js", "APIKEY="],
    ['fetch("https://api.example.com/x?access_token=abc123")', "app.js", "access_token="],
    ['const API_KEY = "abc123";', "app.js", "API_KEY ="],
    ['const apiKey = "abc123";', "app.js", "apiKey ="],
    ["const config = { apiKey: 'abc123' };", "app.js", "apiKey:"],
    ['{ "api_key": "abc123" }', "data.json", 'api_key":'],
    ['{ "accessToken": "abc123" }', "data.json", 'accessToken":'],
    ['fetch(url, { headers: { "x-api-key": "abc123" } })', "app.js", 'api-key":'],
    ['fetch(url, { headers: { Authorization: "Bearer abc123" } })', "app.js", "Authorization:"],
    ['fetch(url, { headers: { "authorization": token } })', "app.js", 'authorization":'],
    ['headers.set("Authorization", "Bearer abc123");', "app.js", 'Authorization",'],
    [`fetch("https://maps.example.com/api?key=${LONG}")`, "app.js", "key="],
    [`fetch("https://api.example.com/x?q=paris&appid=${LONG}")`, "app.js", "appid="],
    [`fetch("https://api.example.com/x?q=1&token=${LONG}")`, "app.js", "token="],
    ['<img src="https://api.example.com/x?api&#95;key=abc123">', "index.html", "api_key="],
    ['fetch("https://api.example.com/x?api\\u005fkey=abc123")', "app.js", "api_key="],
    ["See the api_key=abc123 example.", "notes.md", "api_key="],
    // Ticket 2.14 try 2: camelCase and run-together names, and a property named key, token or appid with a long value.
    [`const weatherApiKey = "${FAKE_KEY}";`, "app.js", "ApiKey ="],
    ['const config = { myAccessToken: "abc123" };', "app.js", "AccessToken:"],
    ["const myApiKey = 'abc123';", "app.js", "ApiKey ="],
    ['const WEATHERAPI_KEY = "abc123";', "app.js", "API_KEY ="],
    ['{ "openWeatherApiKey": "abc123" }', "data.json", 'ApiKey":'],
    ['headers.set("myAccessToken", "abc123");', "app.js", 'AccessToken",'],
    [`{ "key": "${GOOGLE_LIKE}" }`, "data.json", "key:"],
    [`const settings = { key: "${FAKE_KEY}" };`, "app.js", "key:"],
    ['const token = "abc123def456ghi789";', "app.js", "token="],
    [`config.appid = '${FAKE_KEY}';`, "app.js", "appid="],
    ['{ "token" : "abcdef0123456789" }', "data.json", "token:"],
    // Ticket 2.14 try 3: any name ending in key, token or appid, set() calls and query values joined with +.
    [`const OPENWEATHER_KEY = "${FAKE_KEY}";`, "app.js", "KEY="],
    [`const myKey = "${FAKE_KEY}";`, "app.js", "Key="],
    [`const apiToken = "${FAKE_KEY}";`, "app.js", "Token="],
    [`const WeatherApikey = "${FAKE_KEY}";`, "app.js", "Apikey="],
    [`const weatherAppId = "${FAKE_KEY}";`, "app.js", "AppId="],
    [`const my_token = "${FAKE_KEY}";`, "app.js", "token="],
    [`url.searchParams.set("appid", "${FAKE_KEY}");`, "app.js", '"appid",'],
    [`params.append('key', '${GOOGLE_LIKE}');`, "app.js", "'key',"],
    [`const url = "https://x.y/?appid=" + "${FAKE_KEY}";`, "app.js", "appid="],
    [`const url = "https://x.y/?q=paris&key=" + "${FAKE_KEY}";`, "app.js", "key="],
    // A key with dashes or underscores still counts when one part mixes letters and digits.
    [`const MAPS_KEY = "${GOOGLE_LIKE_DASHED}";`, "app.js", "KEY="],
    [`const GITHUB_TOKEN = "${GITHUB_LIKE}";`, "app.js", "TOKEN="],
    ['const STORAGE_KEY = "movieWatchlist2024";', "app.js", "KEY="],
  ])("fails %s and names the file, the line and what looks like a key, not its value", (line, file, shown) => {
    const result = check(text(file, `first line\n\n${line}\nlast line`));
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      {
        file,
        line: 3,
        reason: `It holds what looks like a key or password for another service (${shown}). Anything in an app's files is public: use free services that need no key.`,
      },
    ]);
    expect(result.problems[0]?.reason).not.toContain("abc123");
    expect(result.problems[0]?.reason).not.toContain(LONG);
  });

  it.each([
    `fetch("https://maps.example.com/api?key=${"a".repeat(KEY_VALUE_MIN_CHARS - 1)}")`,
    'fetch("https://api.example.com/x?key=" + encodeURIComponent(word))',
    'fetch("https://api.tvmaze.com/lookup/shows?imdb=tt0944947")',
    'const params = new URLSearchParams({ q: name, sort: "key" });',
    'const key = "score-" + nickname;',
    "await workshopData.set(key, value);",
    "const monkey = 1, keyboard = 2, tokens = [];",
    "<p>This app needs no API key, no password and no authorization.</p>",
    "Free services that need no key: Wikipedia, Open-Meteo.",
    'const apiKeyless = true; const accessTokens = [];',
    'fetch("https://example.com/x?donkey=abcdefghijklmnopqrstuvwxyz")',
    'fetch("https://example.com/x?monkey_key=1")',
    // Ticket 2.14 try 2: names that only contain a key's name, short or plain values, Open Library's `key`.
    "const apiKeyless = true; const hasApiKeys = false; const myApiKeyName = 1;",
    'const monkey = "abcdef0123456789abcdef"; const keyboard = { key: "Enter" };',
    'const columns = [{ key: "title" }, { key: "author_name" }];',
    'fetch(`https://openlibrary.org${doc.key}.json`)',
    'if (doc.key === "/works/OL45883W") show(doc);',
    '{ "key": "/works/OL45883W", "title": "Fantastic Mr Fox" }',
    '{ "key": "/authors/OL1234567A" }',
    'await workshopData.set("favourite-books-list", list); const item = { key: "favourite-books-list" };',
    'const token = "abc123"; const appid = 42;',
    "const isSecret = true; const secretWord = 'banana';",
    // Ticket 2.14 try 3: storage names (words joined with dashes or underscores), names that only contain key or token.
    'const sortKey = "title"; const storageKey = "favourite-books-list";',
    'const STORAGE_KEY = "movie-watchlist-v1";',
    'const SAVE_KEY = "book_club_2024_v2"; const listKey = "films-watched-2025";',
    `const hotkey = "${FAKE_KEY}"; const turkey = "${FAKE_KEY}";`,
    `const keyboardLayout = "${FAKE_KEY}"; const tokenizer = "${FAKE_KEY}";`,
    `if (key === "${FAKE_KEY}") go();`,
    `url.searchParams.set("q", "${FAKE_KEY}"); url.searchParams.set("key", "title");`,
    'const url = "https://x.y/?appid=" + appid;',
  ])("accepts %s", (line) => {
    expect(check(text("app.js", line), text("notes.md", line)).problems).toEqual([]);
  });

  it("sets the long-value threshold for key= at 16 characters", () => {
    expect(KEY_VALUE_MIN_CHARS).toBe(16);
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

  it("does not scan an app over the limit for addresses, but still checks names and types", () => {
    const result = check(text("app.js", 'fetch("http://example.com") // api_key=x'), text("run.sh", "x"), big("a.png", MAX_APP_BYTES));
    expect(result.problems).toEqual([
      { file: "run.sh", reason: expect.stringMatching(/not an allowed file type/) },
      { reason: "The app is 5.1 MB; the limit is 5 MB." },
    ]);
  });

  it("answers quickly on an oversized app full of text", () => {
    const started = performance.now();
    const result = check(text("app.js", '"//a" '.repeat(1_000_000)));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.problems).toEqual([{ reason: "The app is 5.7 MB; the limit is 5 MB." }]);
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
