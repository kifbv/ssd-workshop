// Ticket 2.3: the app template, templates/basic (criteria 5 and 6).
// Criterion 5 serves the template at /apps/<nickname>/ from a tiny local server with the apps'
// real Content-Security-Policy (sandbox, opaque origin) and opens it at phone width in Playwright's
// Chromium, with the data API (ticket 2.4) mocked.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { ALLOWED_EXTENSIONS, MAX_APP_BYTES, readAppFolder } from "./check.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/basic/", import.meta.url));
const NICKNAME = "test-nick";
const APP_PATH = `/apps/${NICKNAME}/`;
const DATA_PREFIX = `/api/apps/${NICKNAME}/data/`;
const PHONE = { width: 375, height: 667 };
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept" };
/** Chromium logs every non-2xx answer (a missing key's 404) as a console error; that one is expected. */
const EXPECTED_404 = "Failed to load resource: the server responded with a status of 404";

describe("the template in a browser under the apps' sandbox (criterion 5)", () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let store: Map<string, string>;
  let calls: { method: string; path: string; origin: string | undefined; cookie: string | undefined }[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const relative = path.startsWith(APP_PATH) ? path.slice(APP_PATH.length) || "index.html" : "";
      const file = normalize(join(TEMPLATE_DIR, relative));
      try {
        if (relative === "" || !file.startsWith(TEMPLATE_DIR)) throw new Error("outside");
        const body = readFileSync(file);
        response.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "content-security-policy": APPS_CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
        });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    context = await browser.newContext({ viewport: PHONE });
    page = await context.newPage();
    page.setDefaultTimeout(5_000);
    errors = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith(EXPECTED_404)) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    store = new Map();
    calls = [];
    // A stand-in for the data API (ticket 2.4): JSON values by key, CORS for any origin, no cookies.
    await page.route("**/api/apps/**", async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const headers = await request.allHeaders();
      calls.push({ method: request.method(), path, origin: headers.origin, cookie: headers.cookie });
      const key = path.startsWith(DATA_PREFIX) ? path.slice(DATA_PREFIX.length) : "";
      const json = { ...CORS, "content-type": "application/json" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (request.method() === "PUT") {
        store.set(key, request.postData() ?? "");
        return route.fulfill({ status: 204, headers: CORS });
      }
      if (request.method() === "DELETE") {
        store.delete(key);
        return route.fulfill({ status: 204, headers: CORS });
      }
      const value = store.get(key);
      return value === undefined
        ? route.fulfill({ status: 404, headers: json, body: JSON.stringify({ message: "Not found." }) })
        : route.fulfill({ status: 200, headers: json, body: value });
    });
  });

  afterEach(async () => {
    await context.close();
    expect(errors).toEqual([]);
  });

  it("loads at 375 px with no console error and nothing scrolling sideways", async () => {
    const response = await page.goto(`${origin}${APP_PATH}`);
    expect(response?.headers()["content-security-policy"]).toBe(APPS_CONTENT_SECURITY_POLICY);
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    await page.getByRole("heading", { level: 1 }).waitFor();
    // Under the sandbox the page has an opaque origin: no storage, no cookies.
    // (Browser code is passed as strings: the root tsconfig has no DOM types, see platform/web/tsconfig.json.)
    expect(await page.evaluate<string>("window.origin")).toBe("null");
    expect(await page.evaluate<string>(`(() => { try { void localStorage.length; return "usable"; } catch { return "blocked"; } })()`)).toBe("blocked");
    // The stylesheet applied (styles load in the sandbox).
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector("main")).maxWidth`)).toBe("640px");
    const widths = await page.evaluate<{ scroll: number; client: number; body: number }>(`({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      body: document.body.scrollWidth,
    })`);
    expect(widths.client).toBe(PHONE.width);
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    expect(widths.body).toBeLessThanOrEqual(widths.client);
  });

  it("stores and reads data through workshop-data.js, without cookies, from the opaque origin", async () => {
    await context.addCookies([{ name: "session", value: "platform-session", url: origin }]);
    await page.goto(`${origin}${APP_PATH}`);
    await expect.poll(() => page.locator("#count").textContent()).toBe("0");

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(store.get("presses")).toBe("1");
    await page.reload();
    await expect.poll(() => page.locator("#count").textContent()).toBe("1");

    const roundTrip = await page.evaluate<{ read: unknown; gone: unknown; badKey: unknown }>(`(async () => {
      const value = { name: "Ada's list", items: [1, 2, 3], done: false };
      await workshopData.set("list_1", value);
      const read = await workshopData.get("list_1");
      await workshopData.remove("list_1");
      const gone = await workshopData.get("list_1");
      const badKey = await workshopData.get("../me").catch((error) => error.message);
      return { read, gone, badKey };
    })()`);
    expect(roundTrip.read).toEqual({ name: "Ada's list", items: [1, 2, 3], done: false });
    expect(roundTrip.gone).toBeNull();
    expect(roundTrip.badKey).toBe("A key may only hold letters, digits, dashes and underscores.");

    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(`PUT ${DATA_PREFIX}presses`);
    expect(calls.every((call) => call.path.startsWith(DATA_PREFIX))).toBe(true);
    expect(calls.every((call) => call.cookie === undefined)).toBe(true);
    // Every request comes from the opaque origin, so the API (ticket 2.4) must answer it with CORS.
    expect(calls.filter((call) => call.method !== "OPTIONS").map((call) => call.origin)).toEqual(
      calls.filter((call) => call.method !== "OPTIONS").map(() => "null"),
    );
  });

  it("shows a plain message, not a console error, when the data service cannot be reached", async () => {
    await page.unroute("**/api/apps/**");
    await page.route("**/api/apps/**", (route) => route.abort("connectionrefused"));
    // Chromium logs the refused request itself; only that line is allowed.
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: net::ERR_CONNECTION_REFUSED")) errors.push(message.text());
    });
    await page.goto(`${origin}${APP_PATH}`);
    await expect.poll(() => page.locator("#status").textContent()).toBe("The data service could not be reached. Check the connection and try again.");
  });
});

describe("the template's contents", () => {
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
  const SECRETS: [string, RegExp][] = [
    ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ["AWS secret key setting", /aws_secret_access_key/i],
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
    ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{16,}/],
    ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
    ["password setting", /\bpassword\s*[:=]\s*["'][^"']+["']/i],
  ];

  it("the patterns find what they look for", () => {
    expect(EMAIL.test(["someone", "example.org"].join("@"))).toBe(true);
    const samples = [
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "aws_secret_access_key = x",
      "-----BEGIN RSA " + "PRIVATE KEY-----",
      "ghp_" + "a".repeat(36),
      "sk-" + "a".repeat(40),
      "xoxb-" + "1".repeat(12),
      'password: "' + "hunter2" + '"',
    ];
    SECRETS.forEach(([, pattern], index) => expect(pattern.test(samples[index] ?? "")).toBe(true));
  });

  it("holds no email address and no secret (criterion 6)", async () => {
    const files = (await readAppFolder(TEMPLATE_DIR)).filter((file) => file.kind === "file");
    expect(files.map((file) => file.path).sort()).toEqual(
      ["AGENTS.md", "README.md", "SPEC.md", "app.js", "index.html", "style.css", "workshop-data.js"],
    );
    const found: string[] = [];
    for (const file of files) {
      new TextDecoder().decode(file.bytes).split("\n").forEach((line, index) => {
        if (EMAIL.test(line)) found.push(`${file.path}:${index + 1} email address`);
        for (const [name, pattern] of SECRETS) if (pattern.test(line)) found.push(`${file.path}:${index + 1} ${name}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("AGENTS.md states the deploy check's rules as check.ts holds them", () => {
    const agents = readFileSync(join(TEMPLATE_DIR, "AGENTS.md"), "utf8");
    expect(agents).toContain(ALLOWED_EXTENSIONS.join(" "));
    expect(agents).toContain(`${MAX_APP_BYTES / 1024 / 1024} MB`);
  });

  it("README.md lists every file of the template", async () => {
    const readme = readFileSync(join(TEMPLATE_DIR, "README.md"), "utf8");
    for (const file of await readAppFolder(TEMPLATE_DIR)) expect(readme).toContain(`| \`${file.path}\` |`);
  });
});
