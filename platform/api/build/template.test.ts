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
import { ALLOWED_EXTENSIONS, MAX_APP_BYTES, NAMESPACE_ADDRESSES, readAppFolder } from "./check.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/basic/", import.meta.url));
const NICKNAME = "test-nick";
const APP_PATH = `/apps/${NICKNAME}/`;
const DATA_PREFIX = `/api/apps/${NICKNAME}/data/`;
const PHONE = { width: 375, height: 667 };
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept" };

describe("the template in a browser under the apps' sandbox (criterion 5)", () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let store: Map<string, string>;
  let calls: { method: string; path: string; origin: string | undefined; cookie: string | undefined }[];
  /** Another server (another origin) that answers anything, to prove the CSP keeps the app from it. */
  let outside: Server;
  let outsideOrigin: string;
  let outsideHits: string[];

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
    outside = createServer((request, response) => {
      outsideHits.push(request.url ?? "");
      response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    });
    await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
    outsideOrigin = `http://127.0.0.1:${(outside.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    await new Promise((resolve) => outside?.close(resolve));
  });

  beforeEach(async () => {
    context = await browser.newContext({ viewport: PHONE });
    page = await context.newPage();
    page.setDefaultTimeout(5_000);
    errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    store = new Map();
    calls = [];
    outsideHits = [];
    // A stand-in for the data API (ticket 2.4): JSON values by key, CORS for any origin, no cookies.
    // A key with no value answers 200 with null (Chromium logs every 404 as a console error).
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
      return route.fulfill({ status: 200, headers: json, body: store.get(key) ?? "null" });
    });
  });

  afterEach(async () => {
    await context.close();
  });

  /** The stored count the mock starts with, so a page that shows it has really read it. */
  const STORED = 41;

  /** Opens the app and waits until it has read the counter: the GET answered and the page shows it. */
  const openApp = async (shown: string): Promise<void> => {
    const read = page.waitForResponse((response) => response.url().endsWith(`${DATA_PREFIX}presses`) && response.request().method() === "GET");
    const response = await page.goto(`${origin}${APP_PATH}`);
    expect(response?.headers()["content-security-policy"]).toBe(APPS_CONTENT_SECURITY_POLICY);
    expect((await read).status()).toBe(200);
    await expect.poll(() => page.locator("#count").textContent()).toBe(shown);
    // load() shows the count and clears the status in the same step: the page has settled.
    expect(await page.locator("#status").textContent()).toBe("");
  };

  it("loads at 375 px with no console error and nothing scrolling sideways", async () => {
    store.set("presses", String(STORED));
    await openApp(String(STORED));
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
    expect(errors).toEqual([]);
  });

  it("stores and reads data through workshop-data.js, without cookies, from the opaque origin", async () => {
    await context.addCookies([{ name: "session", value: "platform-session", url: origin }]);
    store.set("presses", String(STORED));
    await openApp(String(STORED));

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(await page.locator("#count").textContent()).toBe(String(STORED + 1));
    expect(store.get("presses")).toBe(String(STORED + 1));
    await openApp(String(STORED + 1));

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
    expect(errors).toEqual([]);
  });

  it("blocks an outside fetch and an outside image under the CSP, while its own files and data load", async () => {
    store.set("presses", String(STORED));
    await openApp(String(STORED));
    // The CSP's refusals are console errors here, and only they are expected.
    page.removeAllListeners("console");
    const refused: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.text().includes("Content Security Policy")) refused.push(message.text());
      else errors.push(message.text());
    });
    const outcome = await page.evaluate<{ fetch: string; image: string; violations: string[] }>(`(async () => {
      const violations = [];
      document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
      const fetched = await fetch("${outsideOrigin}/data.json").then(() => "loaded", () => "blocked");
      const image = await new Promise((resolve) => {
        const img = document.createElement("img");
        img.onload = () => resolve("loaded");
        img.onerror = () => resolve("blocked");
        img.src = "${outsideOrigin}/pixel.svg";
        document.body.append(img);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { fetch: fetched, image, violations };
    })()`);
    expect(outcome).toEqual({ fetch: "blocked", image: "blocked", violations: ["connect-src", "img-src"] });
    expect(refused).toEqual([
      expect.stringContaining(`Connecting to '${outsideOrigin}/data.json' violates`),
      expect.stringContaining("Refused to connect"),
      expect.stringContaining(`Loading the image '${outsideOrigin}/pixel.svg' violates`),
    ]);
    expect(outsideHits).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("refuses an inline script under the CSP", async () => {
    store.set("presses", String(STORED));
    await openApp(String(STORED));
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Executing inline script violates")) errors.push(message.text());
    });
    const ran = await page.evaluate<boolean>(`(async () => {
      const script = document.createElement("script");
      script.textContent = "window.inlineRan = true;";
      document.body.append(script);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return window.inlineRan === true;
    })()`);
    expect(ran).toBe(false);
    expect(errors).toEqual([]);
  });

  it("shows a plain message when the app is not live (the data API answers 404)", async () => {
    await page.unroute("**/api/apps/**");
    await page.route("**/api/apps/**", (route) =>
      route.fulfill({ status: 404, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ message: "Not found." }) }),
    );
    // Chromium logs the 404 itself; only that line is allowed in this test.
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 404")) errors.push(message.text());
    });
    const read = page.waitForResponse((response) => response.url().endsWith(`${DATA_PREFIX}presses`));
    await page.goto(`${origin}${APP_PATH}`);
    expect((await read).status()).toBe(404);
    await expect.poll(() => page.locator("#status").textContent()).toBe("This app is not live on the workshop yet, so it cannot load or save data.");
    expect(await page.locator("#count").textContent()).toBe("0");
    expect(errors).toEqual([]);
  });

  it("shows a plain message, not a console error, when the data service cannot be reached", async () => {
    await page.unroute("**/api/apps/**");
    await page.route("**/api/apps/**", (route) => route.abort("connectionrefused"));
    // Chromium logs the refused request itself; only that line is allowed.
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: net::ERR_CONNECTION_REFUSED")) errors.push(message.text());
    });
    const failed = page.waitForEvent("requestfailed", (request) => request.url().endsWith(`${DATA_PREFIX}presses`));
    await page.goto(`${origin}${APP_PATH}`);
    await failed;
    await expect.poll(() => page.locator("#status").textContent()).toBe("The data service could not be reached. Check the connection and try again.");
    expect(await page.locator("#count").textContent()).toBe("0");
    expect(errors).toEqual([]);
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
    // The namespace names it lists, one per line in a code block, are exactly the allowed ones.
    const listed = agents.split("\n").map((line) => line.trim()).filter((line) => /^[a-z]+:\/\//.test(line));
    expect(listed).toEqual([...NAMESPACE_ADDRESSES]);
  });

  it("README.md lists every file of the template", async () => {
    const readme = readFileSync(join(TEMPLATE_DIR, "README.md"), "utf8");
    for (const file of await readAppFolder(TEMPLATE_DIR)) expect(readme).toContain(`| \`${file.path}\` |`);
  });
});
