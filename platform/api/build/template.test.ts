// Ticket 2.3: the app template, templates/basic (criteria 5 and 6).
// Criterion 5 serves the template at /apps/<nickname>/ from a tiny local server with the apps'
// real Content-Security-Policy (sandbox, opaque origin) and opens it at phone width in Playwright's
// Chromium, with the data API (ticket 2.4) mocked.
// Ticket 2.14: a second, HTTPS origin (a certificate made in the test) proves that the policy lets an app read data
// and show images from an outside HTTPS address, and still blocks its scripts, styles and fonts and any http: address.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { APP_DATA_MESSAGES } from "../app-data/data.js";
import { ALLOWED_EXTENSIONS, MAX_APP_BYTES, NAMESPACE_ADDRESSES, checkApp, readAppFolder } from "./check.js";
import { selfSignedCertificate } from "./test-certificate.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/basic/", import.meta.url));
const NICKNAME = "test-nick";
const APP_PATH = `/apps/${NICKNAME}/`;
const DATA_PREFIX = `/api/apps/${NICKNAME}/data/`;
const PHONE = { width: 375, height: 667 };
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" };
/** Ticket 3.25: the app write token the fake API accepts (as the hand-off gives it), and the 401 text of the real API. */
const TOKEN = Buffer.alloc(32, 9).toString("base64url");
const HAND_OFF = `#wt=${TOKEN}`;
const SIGN_IN_TO_SAVE = APP_DATA_MESSAGES.signInToSave;
/** Chromium logs every 401 answer itself (a visitor's save): only that line is expected then. */
const LOGGED_401 = "Failed to load resource: the server responded with a status of 401";

describe("the template in a browser under the apps' sandbox (criterion 5)", () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let store: Map<string, string>;
  let calls: { method: string; path: string; search: string; origin: string | undefined; cookie: string | undefined; authorization: string | undefined; status: number }[];
  /** Who saved each key last (ticket 3.24's `updatedBy`), for `?info=1`. */
  let writers: Map<string, string>;
  /** Another server (another origin) that answers anything, to prove the CSP keeps the app from it. */
  let outside: Server;
  let outsideOrigin: string;
  let outsideHits: string[];
  /** An outside HTTPS service (ticket 2.14): JSON with CORS, an image, and a script, stylesheet and font the CSP must block. */
  let service: Server;
  let serviceOrigin: string;
  let serviceHits: string[];

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
    const SERVICE_FILES: Record<string, [string, string]> = {
      "/data.json": ["application/json", JSON.stringify({ title: "Casablanca", year: 1942 })],
      "/poster.svg": ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>'],
      "/lib.js": ["text/javascript", "window.serviceScriptRan = true;"],
      "/style.css": ["text/css", "body { margin: 7px; }"],
      "/font.woff2": ["font/woff2", "not really a font"],
    };
    service = createHttpsServer(selfSignedCertificate(), (request, response) => {
      const path = new URL(request.url ?? "/", "https://localhost").pathname;
      serviceHits.push(path);
      const [type, body] = SERVICE_FILES[path] ?? ["text/plain", ""];
      response.writeHead(SERVICE_FILES[path] ? 200 : 404, { "access-control-allow-origin": "*", "content-type": type });
      response.end(body);
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    serviceOrigin = `https://127.0.0.1:${(service.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    await new Promise((resolve) => outside?.close(resolve));
    await new Promise((resolve) => service?.close(resolve));
  });

  beforeEach(async () => {
    // The service's certificate is made in the test, so no browser trusts it: only that error is ignored.
    context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true });
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
    serviceHits = [];
    // A stand-in for the data API (ticket 2.4): JSON values by key, CORS for any origin, no cookies.
    // A key with no value answers 200 with null (Chromium logs every 404 as a console error).
    // Ticket 3.24/3.25: like the real API, a write needs `Authorization: Bearer <token>` (401 with its text otherwise), and
    // `?info=1` answers `{value, updatedBy, updatedAt}`.
    writers = new Map();
    await page.route("**/api/apps/**", async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const headers = await request.allHeaders();
      const call = { method: request.method(), path, search: url.search, origin: headers.origin, cookie: headers.cookie, authorization: headers.authorization, status: 0 };
      calls.push(call);
      const answer = (status: number, extra: { body?: string } = {}) => {
        call.status = status;
        return route.fulfill({ status, headers: extra.body === undefined ? CORS : { ...CORS, "content-type": "application/json" }, ...extra });
      };
      const key = path.startsWith(DATA_PREFIX) ? path.slice(DATA_PREFIX.length) : "";
      if (request.method() === "OPTIONS") return answer(204);
      if (request.method() === "PUT" || request.method() === "DELETE") {
        if (headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { body: JSON.stringify({ message: SIGN_IN_TO_SAVE }) });
        if (request.method() === "PUT") {
          store.set(key, request.postData() ?? "");
          writers.set(key, "Bob");
        } else {
          store.delete(key);
          writers.delete(key);
        }
        return answer(204);
      }
      // Try 2: `?whoami=1` names the token's writer (Bob), 401 without the token.
      if (url.searchParams.get("whoami") === "1") {
        if (headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { body: JSON.stringify({ message: SIGN_IN_TO_SAVE }) });
        return answer(200, { body: JSON.stringify({ nickname: "Bob" }) });
      }
      const value = store.get(key) ?? "null";
      if (url.searchParams.get("info") === "1") {
        const by = writers.get(key) ?? null;
        return answer(200, { body: `{"value":${value},"updatedBy":${JSON.stringify(by)},"updatedAt":${by === null ? "null" : '"2026-11-26T10:00:00.000Z"'}}` });
      }
      return answer(200, { body: value });
    });
  });

  afterEach(async () => {
    await context.close();
  });

  /** The stored count the mock starts with, so a page that shows it has really read it. */
  const STORED = 41;

  /** Opens the app and waits until it has read the counter: the GET answered and the page shows it. */
  const openApp = async (shown: string, hash = ""): Promise<void> => {
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === `${DATA_PREFIX}presses` && response.request().method() === "GET");
    // From a blank page, so an address that differs only after the # loads the page again.
    await page.goto("about:blank");
    const response = await page.goto(`${origin}${APP_PATH}${hash}`);
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
    await openApp(String(STORED), HAND_OFF);

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(await page.locator("#count").textContent()).toBe(String(STORED + 1));
    expect(store.get("presses")).toBe(String(STORED + 1));
    await openApp(String(STORED + 1), HAND_OFF);

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

  it("blocks an outside http: fetch and an outside http: image under the CSP, while its own files and data load", async () => {
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

  it("ticket 2.14: reads JSON and shows an image from an outside HTTPS service, and blocks its script, stylesheet and font, and an http: fetch", async () => {
    store.set("presses", String(STORED));
    await openApp(String(STORED));
    // The CSP's refusals are console errors here, and only they are expected.
    page.removeAllListeners("console");
    const refused: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.text().includes("Content Security Policy") || message.text().startsWith("Refused to connect")) refused.push(message.text());
      else errors.push(message.text());
    });
    const outcome = await page.evaluate<{
      data: unknown;
      image: string;
      imageSize: string;
      script: string;
      scriptRan: boolean;
      style: string;
      margin: string;
      font: string;
      http: string;
      violations: string[];
    }>(`(async () => {
      const violations = [];
      document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
      const service = "${serviceOrigin}";
      const data = await fetch(service + "/data.json").then((response) => response.json(), (error) => "blocked: " + error.message);
      const loaded = (element) => new Promise((resolve) => {
        element.onload = () => resolve("loaded");
        element.onerror = () => resolve("blocked");
        document.body.append(element);
      });
      const img = document.createElement("img");
      img.src = service + "/poster.svg";
      const image = await loaded(img);
      const script = document.createElement("script");
      script.src = service + "/lib.js";
      const scriptOutcome = await loaded(script);
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = service + "/style.css";
      const style = await loaded(link);
      const font = await new FontFace("Outside", "url(" + service + "/font.woff2)").load().then(() => "loaded", () => "blocked");
      const http = await fetch("${outsideOrigin}/data.json").then(() => "loaded", () => "blocked");
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        data,
        image,
        imageSize: img.naturalWidth + "x" + img.naturalHeight,
        script: scriptOutcome,
        scriptRan: window.serviceScriptRan === true,
        style,
        margin: getComputedStyle(document.body).marginTop,
        font,
        http,
        violations,
      };
    })()`);
    expect(outcome).toEqual({
      data: { title: "Casablanca", year: 1942 },
      image: "loaded",
      imageSize: "2x3",
      script: "blocked",
      scriptRan: false,
      style: "blocked",
      margin: expect.not.stringMatching(/^7px$/),
      font: "blocked",
      http: "blocked",
      violations: ["script-src-elem", "style-src-elem", "font-src", "connect-src"],
    });
    // Only the data and the image reached the service; nothing reached the http: server.
    expect(serviceHits.sort()).toEqual(["/data.json", "/poster.svg"]);
    expect(outsideHits).toEqual([]);
    expect(refused).toEqual([
      expect.stringContaining(`Loading the script '${serviceOrigin}/lib.js' violates`),
      expect.stringContaining(`Loading the stylesheet '${serviceOrigin}/style.css' violates`),
      expect.stringContaining(`Loading the font '${serviceOrigin}/font.woff2' violates`),
      expect.stringContaining(`Connecting to '${outsideOrigin}/data.json' violates`),
      expect.stringContaining("Refused to connect"),
    ]);
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
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === `${DATA_PREFIX}presses`);
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
    const failed = page.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === `${DATA_PREFIX}presses`);
    await page.goto(`${origin}${APP_PATH}`);
    await failed;
    await expect.poll(() => page.locator("#status").textContent()).toBe("The data service could not be reached. Check the connection and try again.");
    expect(await page.locator("#count").textContent()).toBe("0");
    expect(errors).toEqual([]);
  });

  /** Ticket 3.25: the console check of a visitor's save, where Chromium logs the API's 401 itself. */
  const allow401 = (): void => {
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith(LOGGED_401)) errors.push(message.text());
    });
  };

  it("ticket 3.25 criterion 1: WHEN the template opens without a token THEN reads work, a save shows the sign-in button, and nothing is written", async () => {
    store.set("presses", String(STORED));
    writers.set("presses", "Ada");
    allow401();
    await openApp(String(STORED));
    // Reads work for a visitor, who-posted included (`?info=1`).
    expect(calls.find((call) => call.method === "GET")?.search).toBe("?info=1");
    expect(await page.locator("#who").textContent()).toBe("Last press by Ada.");
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBeNull();
    expect(await page.evaluate<unknown>(`workshopData.get("presses")`)).toBe(STORED);
    expect(await page.evaluate<unknown>(`workshopData.getInfo("presses")`)).toEqual({ value: STORED, updatedBy: "Ada", updatedAt: "2026-11-26T10:00:00.000Z" });
    expect(await page.evaluate<unknown>(`workshopData.getInfo("nothing-here")`)).toEqual({ value: null, updatedBy: null, updatedAt: null });
    expect(await page.evaluate<string>("workshopData.signInLink()")).toBe(`${origin}/app-sign-in/?app=${NICKNAME}`);
    // The sign-in button shows where saving happens, before any save.
    const signIn = page.getByRole("button", { name: "Sign in to save" });
    expect(await signIn.isVisible()).toBe(true);

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(await page.locator("#count").textContent()).toBe(String(STORED));
    expect(await signIn.isVisible()).toBe(true);
    const removed = await page.evaluate<string>(`workshopData.remove("presses").then(() => "removed", (error) => error.message)`);
    expect(removed).toBe(SIGN_IN_TO_SAVE);
    // Nothing written: the writes carried no token and were refused; the value is as it was.
    const writes = calls.filter((call) => call.method === "PUT" || call.method === "DELETE");
    expect(writes.map((call) => [call.method, call.authorization, call.status])).toEqual([
      ["PUT", undefined, 401],
      ["DELETE", undefined, 401],
    ]);
    expect(store.get("presses")).toBe(String(STORED));
    expect(writers.get("presses")).toBe("Ada");

    // The button opens the workshop's hand-off page in a new tab (the CSP's allow-popups-to-escape-sandbox, 3.24).
    const popup = page.waitForEvent("popup");
    await signIn.click();
    const tab = await popup;
    await tab.waitForURL(`${origin}/app-sign-in/?app=${NICKNAME}`);
    expect(page.url()).toBe(`${origin}${APP_PATH}`);
    expect(errors).toEqual([]);
  });

  it("ticket 3.25: WHEN an app without a sign-in element (built before 3.25) gets a 401 THEN workshop-data.js adds its own sign-in button, under the CSP", async () => {
    allow401();
    await openApp("0");
    // An older app's page: no element with data-workshop-sign-in.
    await page.evaluate(`document.querySelector("[data-workshop-sign-in]").remove()`);
    expect(await page.locator("[data-workshop-sign-in]").count()).toBe(0);
    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    const added = page.getByRole("button", { name: "Sign in to save" });
    expect(await added.isVisible()).toBe(true);
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector("[data-workshop-sign-in]")).position`)).toBe("fixed");
    // A second refusal does not add another one.
    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => calls.filter((call) => call.method === "PUT").length).toBe(2);
    expect(await page.locator("[data-workshop-sign-in]").count()).toBe(1);
    const popup = page.waitForEvent("popup");
    await added.click();
    await (await popup).waitForURL(`${origin}/app-sign-in/?app=${NICKNAME}`);
    expect(store.has("presses")).toBe(false);
    // No CSP refusal of the button's look (CSSOM, not a style attribute) and no other console error.
    expect(errors).toEqual([]);
  });

  // Sign-in fix (2026-11-27, a live app): the app's only sign-in button sat in a form on a hidden detail screen, while the
  // list screen's Add buttons also saved; a refused save there showed no way to sign in.
  const SCREENS_APP: Record<string, string> = {
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <script src="workshop-data.js"></script>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Movies</title>
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="style.css">
    <script src="app.js" defer></script>
  </head>
  <body>
    <main>
      <section id="list" class="screen">
        <h1>Movies</h1>
        <p>Casablanca <button id="add" type="button">Add</button> <button id="open" type="button">Details</button></p>
      </section>
      <section id="detail" class="screen hidden">
        <form id="form">
          <label>Title <input name="title"></label>
          <button type="submit">Save</button>
          <p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p>
        </form>
      </section>
      <p id="status" role="status"></p>
    </main>
  </body>
</html>
`,
    "style.css": ".screen.hidden { display: none; }\n",
    "app.js": `"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const save = async () => {
    try { await workshopData.set("movies", ["Casablanca"]); status.textContent = "Saved."; } catch (error) { status.textContent = error.message; }
  };
  document.getElementById("add").addEventListener("click", save);
  document.getElementById("open").addEventListener("click", () => {
    document.getElementById("list").classList.add("hidden");
    document.getElementById("detail").classList.remove("hidden");
  });
  document.getElementById("form").addEventListener("submit", (event) => { event.preventDefault(); save(); });
});
`,
  };

  /** Serves SCREENS_APP with every file routed (workshop-data.js from the template): none comes from the loopback server. */
  const openScreensApp = async (hash = ""): Promise<void> => {
    await serveApp({ ...SCREENS_APP, "workshop-data.js": readFileSync(join(TEMPLATE_DIR, "workshop-data.js"), "utf8") });
    await page.goto("about:blank");
    await page.goto(`${origin}${APP_PATH}${hash}`);
    await page.getByRole("button", { name: "Add" }).waitFor();
  };

  /** The floating sign-in button workshop-data.js adds at the end of the body (the app's own sits inside its form). */
  const floating = () => page.locator("body > [data-workshop-sign-in]");

  it("sign-in fix: WHEN the page's only sign-in element sits on a hidden screen and a save is refused with 401 THEN a floating Sign in to save button shows and opens the workshop's sign-in in a new tab", async () => {
    allow401();
    await openScreensApp();
    // Before any save: only the app's own element, on its hidden screen.
    expect(await page.locator("[data-workshop-sign-in]").count()).toBe(1);
    await page.getByRole("button", { name: "Add" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(calls.filter((call) => call.method === "PUT").map((call) => [call.authorization, call.status])).toEqual([[undefined, 401]]);
    // The app's own element is on a hidden screen, so the one button a visitor can find is the floating one.
    const button = page.getByRole("button", { name: "Sign in to save" });
    expect(await button.isVisible()).toBe(true);
    expect(await floating().count()).toBe(1);
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector("body > [data-workshop-sign-in]")).position`)).toBe("fixed");
    // A second refusal reuses it.
    await page.getByRole("button", { name: "Add" }).click();
    await expect.poll(() => calls.filter((call) => call.method === "PUT").length).toBe(2);
    expect(await page.locator("[data-workshop-sign-in]").count()).toBe(2);
    const popup = page.waitForEvent("popup");
    await button.click();
    await (await popup).waitForURL(`${origin}/app-sign-in/?app=${NICKNAME}`);
    expect(store.has("movies")).toBe(false);
    // No CSP refusal of the button's look and no other console error.
    expect(errors).toEqual([]);
  });

  it("sign-in fix: WHEN the browser has no checkVisibility THEN the layout check still finds the hidden screen's element unseen and the shown one seen", async () => {
    allow401();
    await page.addInitScript(`delete Element.prototype.checkVisibility;`);
    await openScreensApp();
    expect(await page.evaluate<string>("typeof document.body.checkVisibility")).toBe("undefined");
    await page.getByRole("button", { name: "Add" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(await floating().isVisible()).toBe(true);
    await openScreensApp();
    await page.getByRole("button", { name: "Details" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(await floating().count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("sign-in fix: WHEN a visitor without a pass asks for something that needs the sign-in and no sign-in element is visible THEN the floating button shows and nothing is sent", async () => {
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
    });
    await openScreensApp();
    const outcome = await page.evaluate<string[]>(`Promise.all([
      workshopData.ai.sortText("Milk and bread", ["Food", "Drink"]).then(() => "sorted", (error) => error.message),
      workshopData.deleteMedia(location.origin + "/app-media/${NICKNAME}/" + "A".repeat(22)).then(() => "deleted", (error) => error.message),
    ])`);
    expect(outcome).toEqual([SIGN_IN_TO_SAVE, SIGN_IN_TO_SAVE]);
    expect(await page.getByRole("button", { name: "Sign in to save" }).isVisible()).toBe(true);
    expect(await floating().count()).toBe(1);
    expect(sent).toEqual([]);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("sign-in fix: WHEN a visible sign-in element already exists THEN no floating button is added", async () => {
    allow401();
    // The template: its sign-in button shows right after the Press button.
    await openApp("0");
    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(await page.evaluate<string>("workshopData.ai.sortText('Milk', ['Food']).catch((error) => error.message)")).toBe(SIGN_IN_TO_SAVE);
    expect(await page.locator("[data-workshop-sign-in]").count()).toBe(1);
    // The screens app with its detail screen open: its own button shows by the form, so none is added.
    await openScreensApp();
    await page.getByRole("button", { name: "Details" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(await page.locator("form [data-workshop-sign-in]").isVisible()).toBe(true);
    expect(await page.locator("[data-workshop-sign-in]").count()).toBe(1);
    expect(errors).toEqual([]);
  });

  it("sign-in fix: WHEN the visitor is signed in (hand-off) THEN no floating button shows, and once the sign-in is refused it shows", async () => {
    allow401();
    await openScreensApp(HAND_OFF);
    await page.getByRole("button", { name: "Add" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(await floating().count()).toBe(0);
    // The token ends (signed out elsewhere): the next refused save shows the floating button.
    await page.unroute("**/api/apps/**");
    await page.route("**/api/apps/**", (route) =>
      route.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ message: SIGN_IN_TO_SAVE }) }),
    );
    await page.getByRole("button", { name: "Add" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(await floating().isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });

  it("ticket 3.25 criterion 2: WHEN it opens with #wt=<token> THEN the token is gone from the address at once, saves carry the token, and whoAmI() gives the nickname", async () => {
    // What the address holds when the page's scripts have run (DOMContentLoaded comes after the deferred scripts).
    await page.addInitScript(`document.addEventListener("DOMContentLoaded", () => { window.addressAtLoad = location.href; });`);
    store.set("presses", String(STORED));
    await openApp(String(STORED), `${HAND_OFF}&screen=list`);
    expect(await page.evaluate<string>("window.addressAtLoad")).toBe(`${origin}${APP_PATH}#screen=list`);
    expect(page.url()).toBe(`${origin}${APP_PATH}#screen=list`);
    expect(await page.evaluate<string>("location.hash")).toBe("#screen=list");
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBe("Bob");
    expect(await page.locator("#who").textContent()).toBe("You save as Bob.");
    // Signed in: the sign-in button is hidden.
    expect(await page.locator("[data-workshop-sign-in]").isHidden()).toBe(true);
    // Kept in memory only: nothing in the page's address, history state or title holds it.
    expect(await page.evaluate<string>("JSON.stringify(history.state) + document.title + location.href")).not.toContain(TOKEN);

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(await page.locator("#who").textContent()).toBe("Last press by Bob. You save as Bob.");
    expect(await page.evaluate<string>(`workshopData.remove("other").then(() => "removed")`)).toBe("removed");
    const writes = calls.filter((call) => call.method === "PUT" || call.method === "DELETE");
    expect(writes.map((call) => [call.method, call.authorization, call.status])).toEqual([
      ["PUT", `Bearer ${TOKEN}`, 204],
      ["DELETE", `Bearer ${TOKEN}`, 204],
    ]);
    // Reads never carry it; only the one question who the token names does (try 2), asked once when the page opened.
    const whoami = calls.filter((call) => call.method === "GET" && call.search === "?whoami=1");
    expect(whoami.map((call) => [call.path, call.authorization])).toEqual([[`${DATA_PREFIX}whoami`, `Bearer ${TOKEN}`]]);
    expect(calls.filter((call) => call.method === "GET" && call.search !== "?whoami=1").every((call) => call.authorization === undefined)).toBe(true);
    expect(store.get("presses")).toBe(String(STORED + 1));
    expect(errors).toEqual([]);
  });

  it("ticket 3.25: WHEN the token is refused (expired or signed out) THEN whoAmI() is null and the sign-in button shows again", async () => {
    allow401();
    await openApp("0", HAND_OFF);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBe("Bob");
    // The API stops accepting it (as after a sign-out).
    await page.unroute("**/api/apps/**");
    await page.route("**/api/apps/**", (route) =>
      route.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ message: SIGN_IN_TO_SAVE }) }),
    );
    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(SIGN_IN_TO_SAVE);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBeNull();
    expect(await page.getByRole("button", { name: "Sign in to save" }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });

  it("ticket 3.25: WHEN the fragment holds a malformed token THEN it is removed and the visitor is not signed in", async () => {
    for (const hash of ["#wt=short", "#wt=", `#wt=${TOKEN}x`]) {
      await openApp("0", hash);
      expect(page.url(), hash).toBe(`${origin}${APP_PATH}`);
      expect(await page.evaluate<unknown>("workshopData.whoAmI()"), hash).toBeNull();
      expect(await page.getByRole("button", { name: "Sign in to save" }).isVisible(), hash).toBe(true);
    }
    expect(calls.some((call) => call.search === "?whoami=1")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("ticket 3.25 try 2 (finding A): WHEN the address names someone (an old #wn=) THEN whoAmI() still gives only the nickname the API confirms for the token", async () => {
    allow401();
    await openApp("0", `#wt=${TOKEN}&wn=Ada`);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBe("Bob");
    expect(await page.locator("#who").textContent()).toBe("You save as Bob.");
    // A token the API does not accept: no name at all, whatever the address says.
    await page.unroute("**/api/apps/**");
    await page.route("**/api/apps/**", (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (url.searchParams.get("whoami") === "1") return route.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ message: SIGN_IN_TO_SAVE }) });
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: url.searchParams.get("info") === "1" ? '{"value":0,"updatedBy":null,"updatedAt":null}' : "0" });
    });
    await openApp("0", `#wt=${TOKEN}&wn=Ada`);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBeNull();
    expect(await page.locator("#who").textContent()).toBe("");
    expect(errors).toEqual([]);
  });

  /**
   * Try 2 (finding B): app code that runs after workshop-data.js, trying every way short of reading browser internals to
   * see the token: wrapping fetch, XMLHttpRequest, Headers, history and location, getters on Object.prototype (read by
   * fetch for its options), and Symbol.iterator. It records any text that holds the token in `window.stolen`.
   */
  const HOSTILE_APP = `"use strict";
    window.stolen = [];
    const T = ${JSON.stringify(TOKEN)};
    const grab = (where, value) => { try { if (String(JSON.stringify(value) ?? value).includes(T)) window.stolen.push(where); } catch (e) { if (String(value).includes(T)) window.stolen.push(where); } };
    const realFetch = window.fetch;
    window.fetch = function (input, init) { grab("fetch", [input, init, init && init.headers]); return realFetch.apply(this, arguments); };
    const realOpen = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (n, v) { grab("xhr", v); return realOpen.apply(this, arguments); };
    for (const name of ["append", "set"]) { const real = Headers.prototype[name]; Headers.prototype[name] = function (n, v) { grab("headers." + name, v); return real.apply(this, arguments); }; }
    const realReplace = History.prototype.replaceState;
    History.prototype.replaceState = function () { grab("replaceState", [...arguments]); return realReplace.apply(this, arguments); };
    for (const name of ["signal", "referrer", "mode", "cache", "redirect", "integrity", "keepalive", "window", "priority", "duplex", "referrerPolicy", "body", "headers"]) {
      Object.defineProperty(Object.prototype, name, { configurable: true, get() { grab("Object.prototype." + name, this); return undefined; } });
    }
    Object.defineProperty(Object.prototype, Symbol.iterator, { configurable: true, get() { grab("Symbol.iterator", this); return undefined; } });
    const realStringify = JSON.stringify;
    JSON.stringify = function (v) { const out = realStringify.apply(this, arguments); if (typeof out === "string" && out.includes(T)) window.stolen.push("JSON.stringify"); return out; };
    grab("location", [location.href, location.hash, document.URL, history.state]);
    document.addEventListener("DOMContentLoaded", async () => {
      await workshopData.whoAmI();
      try { await workshopData.set("presses", 1); window.saved = "yes"; } catch (e) { window.saved = e.message; }
    });`;

  const serveApp = async (files: Record<string, string>): Promise<void> => {
    for (const [name, body] of Object.entries(files)) {
      await page.route(`${origin}${APP_PATH}${name === "index.html" ? "" : name}`, (route) =>
        route.fulfill({ status: 200, headers: { "content-type": TYPES[extname(name)] ?? "text/plain", "content-security-policy": APPS_CONTENT_SECURITY_POLICY }, body }),
      );
    }
  };

  it("ticket 3.25 try 2 (finding B): WHEN the app's own code wraps fetch, XMLHttpRequest, history and Object.prototype THEN it never sees the token, and saves still carry it", async () => {
    await serveApp({ "app.js": HOSTILE_APP });
    await page.goto(`${origin}${APP_PATH}${HAND_OFF}`);
    await expect.poll(() => page.evaluate<unknown>("window.saved")).toBe("yes");
    expect(await page.evaluate<string[]>("window.stolen")).toEqual([]);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBe("Bob");
    expect(calls.filter((call) => call.method === "PUT").map((call) => [call.authorization, call.status])).toEqual([[`Bearer ${TOKEN}`, 204]]);
    expect(page.url()).toBe(`${origin}${APP_PATH}`);
    expect(errors).toEqual([]);
  });

  it("ticket 3.25 (access review of try 3): WHEN the app's own code adds a <base> to another server THEN saves and the sign-in still go to the workshop's own addresses", async () => {
    const elsewhere: string[] = [];
    await page.route("https://evil.example/**", (route) => {
      elsewhere.push(route.request().url());
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" }, body: "" });
    });
    await serveApp({
      "app.js": `"use strict";
        document.addEventListener("DOMContentLoaded", async () => {
          await workshopData.whoAmI();
          const base = document.createElement("base");
          base.href = "https://evil.example/";
          document.head.append(base);
          window.link = workshopData.signInLink();
          try { await workshopData.set("presses", 1); window.saved = "yes"; } catch (e) { window.saved = e.message; }
        });`,
    });
    await page.goto(`${origin}${APP_PATH}${HAND_OFF}`);
    await expect.poll(() => page.evaluate<unknown>("window.saved")).toBe("yes");
    expect(elsewhere).toEqual([]);
    expect(await page.evaluate<string>("window.link")).toBe(`${origin}/app-sign-in/?app=${encodeURIComponent(APP_PATH.split("/")[2] ?? "")}`);
    expect(calls.filter((call) => call.method === "PUT").map((call) => [call.authorization, call.status])).toEqual([[`Bearer ${TOKEN}`, 204]]);
  });

  it("ticket 3.25 try 2 (finding B, control):the same code run BEFORE workshop-data.js sees the token, which is why the deploy check requires it first", async () => {
    const index = readFileSync(join(TEMPLATE_DIR, "index.html"), "utf8").replace('<script src="workshop-data.js"></script>', '<script src="early.js"></script><script src="workshop-data.js"></script>');
    expect(checkApp([{ path: "index.html", kind: "file", bytes: new TextEncoder().encode(index) }]).ok).toBe(false);
    // Every file through the same route (Chromium refuses a routed page's loads from the loopback server).
    const own = (name: string) => readFileSync(join(TEMPLATE_DIR, name), "utf8");
    await serveApp({ "index.html": index, "early.js": HOSTILE_APP, "workshop-data.js": own("workshop-data.js"), "app.js": own("app.js"), "style.css": own("style.css") });
    await page.goto(`${origin}${APP_PATH}${HAND_OFF}`);
    await expect.poll(() => page.evaluate<unknown>("window.saved")).toBe("yes");
    // It read the address before workshop-data.js removed the token, and saw it again in every save it wrapped.
    expect(await page.evaluate<string[]>("window.stolen")).toEqual(expect.arrayContaining(["location", "fetch"]));
  });

  it("ticket 3.25 try 2 (residual, docs/decisions.md): the browser's navigation timing entry still holds the address the page opened with, token included", async () => {
    await openApp("0", HAND_OFF);
    expect(page.url()).toBe(`${origin}${APP_PATH}`);
    // Any script of the page can read it; no script can clear it. Only a hand-off that keeps the token out of the app's own
    // address (another origin or frame for the data client) would close this.
    expect(await page.evaluate<string>(`performance.getEntriesByType("navigation")[0].name`)).toBe(`${origin}${APP_PATH}${HAND_OFF}`);
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

  it("AGENTS.md lists the preferred keyless services with addresses the deploy check accepts (ticket 2.14)", () => {
    const agents = readFileSync(join(TEMPLATE_DIR, "AGENTS.md"), "utf8");
    const addresses = [
      "https://en.wikipedia.org/api/rest_v1/",
      "https://openlibrary.org",
      "https://covers.openlibrary.org",
      "https://api.open-meteo.com",
      "https://api.frankfurter.app",
      "https://api.tvmaze.com",
      "https://restcountries.com",
    ];
    for (const address of addresses) expect(agents).toContain(`\`${address}\``);
    const index = { path: "index.html", kind: "file" as const, bytes: new TextEncoder().encode("<!doctype html>") };
    const uses = { path: "app.js", kind: "file" as const, bytes: new TextEncoder().encode(addresses.map((address) => `fetch("${address}");`).join("\n")) };
    expect(checkApp([index, uses]).problems).toEqual([]);
    expect(agents).toContain("never write a key or token in any file");
    expect(agents).toContain("show a friendly message in the page");
  });

  it("ticket 3.25: the whole template, sign-in included, passes the deploy check as it is", async () => {
    expect(checkApp(await readAppFolder(TEMPLATE_DIR)).problems).toEqual([]);
  });

  it("README.md lists every file of the template", async () => {
    const readme = readFileSync(join(TEMPLATE_DIR, "README.md"), "utf8");
    for (const file of await readAppFolder(TEMPLATE_DIR)) expect(readme).toContain(`| \`${file.path}\` |`);
  });
});
