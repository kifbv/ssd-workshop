// Ticket 2.4 criterion 5: a page with an opaque origin calls the real data API in Playwright's Chromium.
// One local server plays the workshop's address: it serves the template (templates/basic, with the real
// workshop-data.js) at /apps/<nickname>/ under the apps' sandbox CSP, and sends
// /api/apps/<nickname>/data/<key> (the preflight included) to the real handler on an in-memory table.
// Same host, as in production: under the sandbox the page's origin is opaque ("null"), so even its own
// server is cross-origin and the browser reads an answer only if CORS allows it.
//
// Ticket 3.24: writes need `Authorization: Bearer <token>`. Since 3.28 the template's workshop-data.js sends the app's
// edit secret (ticket 3.26), taking it from the address (`#edit=<secret>`), which also proves the preflight lets a
// sandboxed page send it. The template asks the real API whose link it is (`GET ...?whoami=1`, preflighted too).
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import type { HttpRequest } from "../http.js";
import { createHandler } from "../handlers/app-data.js";
import { hashAppToken } from "../app-token/token.js";
import { APP_DATA_MESSAGES, APP_DATA_PATH, MAX_VALUE_BYTES, type AppDataLogEntry } from "./data.js";
import { FakeAppDataStore } from "./fakes.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/basic/", import.meta.url));
const NICKNAME = "test-nick";
const APP_PATH = `/apps/${NICKNAME}/`;
const DATA_PREFIX = `/api/apps/${NICKNAME}/data/`;
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const DATA_ROUTE = /^\/api\/apps\/([^/]+)\/data\/([^/]+)$/;

interface Seen {
  method: string;
  path: string;
  origin: string | undefined;
  cookie: string | undefined;
  status: number;
  allowOrigin: string | undefined;
  /** The preflight's `Access-Control-Request-Headers` (ticket 3.24). */
  requestHeaders: string | undefined;
  allowCredentials: string | undefined;
}

/** The edit secret the tests give the page (ticket 3.26), in the address as the edit link carries it (3.28). */
const TOKEN = Buffer.alloc(32, 5).toString("base64url");
const HAND_OFF = `#edit=${TOKEN}`;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The request as API Gateway (payload 2.0) would hand it over: lower-cased headers, cookies apart. */
function toEvent(request: IncomingMessage, path: string, body: string): HttpRequest {
  const match = DATA_ROUTE.exec(path);
  const query = Object.fromEntries(new URL(request.url ?? "/", "http://localhost").searchParams);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string" && name !== "cookie") headers[name] = value;
  const cookie = request.headers.cookie;
  return {
    routeKey: `${request.method ?? "GET"} ${APP_DATA_PATH}`,
    pathParameters: { nickname: decodeURIComponent(match?.[1] ?? ""), key: decodeURIComponent(match?.[2] ?? "") },
    headers,
    ...(cookie === undefined ? {} : { cookies: cookie.split(/;\s*/) }),
    ...(Object.keys(query).length === 0 ? {} : { queryStringParameters: query }),
    ...(body === "" ? {} : { body }),
  };
}

describe("criterion 5: a page with an opaque origin reads the data API's answers (CORS)", () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let store: FakeAppDataStore;
  let seen: Seen[];
  let logs: AppDataLogEntry[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (DATA_ROUTE.test(path)) {
          const handle = createHandler({ store, tokens: store.tokens, now: () => new Date(), log: (entry) => logs.push(entry), pause: async () => {} });
          const answer = await handle(toEvent(request, path, await readBody(request)));
          seen.push({
            method: request.method ?? "",
            path,
            origin: request.headers.origin,
            cookie: request.headers.cookie,
            status: answer.statusCode,
            allowOrigin: answer.headers?.["access-control-allow-origin"],
            requestHeaders: request.headers["access-control-request-headers"],
            allowCredentials: answer.headers?.["access-control-allow-credentials"],
          });
          response.writeHead(answer.statusCode, answer.headers);
          response.end(answer.body);
          return;
        }
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
      })();
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
    store = new FakeAppDataStore();
    store.tokens.tokens.set(hashAppToken(TOKEN), { app: NICKNAME, nickname: "Bob", kind: "edit" });
    seen = [];
    logs = [];
    context = await browser.newContext({ viewport: { width: 375, height: 667 } });
    // The platform's session cookie for the same host: the sandboxed page must never send it.
    await context.addCookies([{ name: "ssd_session", value: "platform-session", url: origin }]);
    page = await context.newPage();
    page.setDefaultTimeout(5_000);
    errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
  });

  afterEach(async () => {
    await context.close();
  });

  const openApp = async (shown: string, hash = ""): Promise<void> => {
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === `${DATA_PREFIX}presses` && response.request().method() === "GET");
    // From a blank page, so an address that differs only after the # loads the page again.
    await page.goto("about:blank");
    await page.goto(`${origin}${APP_PATH}${hash}`);
    expect((await read).status()).toBe(200);
    await expect.poll(() => page.locator("#count").textContent()).toBe(shown);
    expect(await page.locator("#status").textContent()).toBe("");
  };

  it("the template's counter and workshop-data.js store and read values through the real API, preflight included", async () => {
    store.live.add(NICKNAME);
    await openApp("0", HAND_OFF);
    expect(await page.evaluate<string>("window.origin")).toBe("null");
    expect(page.url()).toBe(`${origin}${APP_PATH}${HAND_OFF}`);

    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Saved.");
    expect(store.values.get(`${NICKNAME}/presses`)?.json).toBe("1");
    await openApp("1", HAND_OFF);
    // Ticket 3.25: the real API's `?info=1` names the writer, which the template shows.
    expect(await page.locator("#who").textContent()).toBe("Last press by Bob. You save as Bob.");

    const roundTrip = await page.evaluate<{ read: unknown; list: unknown; text: unknown; gone: unknown }>(`(async () => {
      await workshopData.set("list_1", { name: "Ada's list", items: [1, 2, 3], done: false, note: null });
      const read = await workshopData.get("list_1");
      await workshopData.set("scores", [3, 1.5, -2]);
      const list = await workshopData.get("scores");
      await workshopData.set("greeting", "héllo ☕");
      const text = await workshopData.get("greeting");
      await workshopData.remove("list_1");
      const gone = await workshopData.get("list_1");
      return { read, list, text, gone };
    })()`);
    expect(roundTrip).toEqual({ read: { name: "Ada's list", items: [1, 2, 3], done: false, note: null }, list: [3, 1.5, -2], text: "héllo ☕", gone: null });

    // Ticket 3.25 try 2: whoAmI() came from the real API, which named the token's writer; the GET was preflighted for
    // `authorization` (a GET with that header is not a simple request), and allowed.
    const whoami = seen.filter((s) => s.path === `${DATA_PREFIX}whoami`);
    // Once per page load (the page was opened twice); each preceded by its preflight (Chromium keeps none for an opaque origin).
    expect(whoami.filter((s) => s.method === "GET").map((s) => s.status)).toEqual([200, 200]);
    expect(whoami[0]?.method).toBe("OPTIONS");
    for (const preflight of whoami.filter((s) => s.method === "OPTIONS")) expect([preflight.status, preflight.requestHeaders]).toEqual([204, "authorization"]);
    expect(logs.filter((entry) => entry.outcome === "whoami")).toHaveLength(2);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBe("Bob");
    // The PUTs were preflighted (JSON content type), and every answer, preflight included, allowed any origin.
    expect(seen.filter((s) => s.method === "OPTIONS").length).toBeGreaterThan(0);
    expect(seen.map((s) => s.method)).toEqual(expect.arrayContaining(["OPTIONS", "PUT", "GET", "DELETE"]));
    expect(seen.every((s) => s.allowOrigin === "*")).toBe(true);
    expect(seen.filter((s) => s.method !== "OPTIONS").every((s) => s.origin === "null")).toBe(true);
    expect(seen.every((s) => s.cookie === undefined)).toBe(true);
    expect(logs.every((entry) => entry.outcome !== "failed")).toBe(true);
    // Ticket 3.24 criterion 6: the preflight asked for `authorization` and was allowed; no answer allows credentials.
    expect(seen.filter((s) => s.method === "OPTIONS").every((s) => s.requestHeaders?.split(",").includes("authorization") === true)).toBe(true);
    expect(seen.filter((s) => s.method === "PUT").every((s) => s.status === 204)).toBe(true);
    expect(seen.every((s) => s.allowCredentials === undefined)).toBe(true);
    expect(store.values.get(`${NICKNAME}/scores`)?.updatedBy).toBe("Bob");
    expect(errors).toEqual([]);
  });

  it("ticket 3.24/3.28: a visitor without a secret reads and a save is refused unsent with the API's text; with an edit link the API does not know, the save gets the plain 401 reason and stores nothing", async () => {
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 401")) errors.push(message.text());
    });
    store.live.add(NICKNAME);
    store.values.set(`${NICKNAME}/presses`, { json: "5", bytes: 1 });
    await openApp("5");
    // View only: the template hides its Press button; no secret, no whoami question, whoAmI() is null at once.
    expect(await page.getByRole("button", { name: "Press" }).isVisible()).toBe(false);
    expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBeNull();
    expect(seen.some((s) => s.path === `${DATA_PREFIX}whoami`)).toBe(false);
    expect(await page.evaluate<string>(`workshopData.set("presses", 6).then(() => "stored", (error) => error.message)`)).toBe(APP_DATA_MESSAGES.viewOnly);
    expect(seen.filter((s) => s.method === "PUT")).toEqual([]);
    // An edit link that was replaced (well formed, unknown to the API): the real API's 401, readable from the opaque origin.
    await openApp("5", `#edit=${Buffer.alloc(32, 8).toString("base64url")}`);
    await page.getByRole("button", { name: "Press" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toBe(APP_DATA_MESSAGES.viewOnly);
    expect(store.values.get(`${NICKNAME}/presses`)?.json).toBe("5");
    expect(seen.filter((s) => s.method === "PUT").map((s) => s.status)).toEqual([401]);
    expect(seen.find((s) => s.method === "PUT")).toMatchObject({ status: 401, allowOrigin: "*", allowCredentials: undefined });
    expect(errors).toEqual([]);
  });

  it("shows the API's plain 413 reason to the page, and stores nothing", async () => {
    store.live.add(NICKNAME);
    await openApp("0", HAND_OFF);
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 413")) errors.push(message.text());
    });
    const message = await page.evaluate<string>(`workshopData.set("big", "x".repeat(${MAX_VALUE_BYTES})).then(() => "stored", (error) => error.message)`);
    expect(message).toBe(APP_DATA_MESSAGES.valueTooBig);
    expect(store.values.has(`${NICKNAME}/big`)).toBe(false);
    expect(seen.find((s) => s.method === "PUT")).toMatchObject({ status: 413, allowOrigin: "*" });
    expect(errors).toEqual([]);
  });

  it("ticket 3.25 try 2 / 3.28: WHEN the address holds a secret the API does not accept THEN whoAmI() stays null and the page names no one", async () => {
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 401")) errors.push(message.text());
    });
    store.live.add(NICKNAME);
    // Another app's token, then an unknown one: both well formed, neither for this app.
    store.tokens.tokens.set(hashAppToken(Buffer.alloc(32, 6).toString("base64url")), { app: "other-app", nickname: "Eve", kind: "edit" });
    for (const token of [Buffer.alloc(32, 6).toString("base64url"), Buffer.alloc(32, 7).toString("base64url")]) {
      await openApp("0", `#edit=${token}`);
      expect(await page.evaluate<unknown>("workshopData.whoAmI()")).toBeNull();
      expect(await page.locator("#who").textContent()).toBe("");
    }
    expect(seen.filter((s) => s.method === "GET" && s.path === `${DATA_PREFIX}whoami`).map((s) => s.status)).toEqual([401, 401]);
    expect(errors).toEqual([]);
  });

  it("an app that is not live gets the 404 and the page says so", async () => {
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 404")) errors.push(message.text());
    });
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === `${DATA_PREFIX}presses`);
    await page.goto(`${origin}${APP_PATH}`);
    expect((await read).status()).toBe(404);
    await expect.poll(() => page.locator("#status").textContent()).toBe("This app is not live on the workshop yet, so it cannot load or save data.");
    expect(seen).toEqual([expect.objectContaining({ method: "GET", status: 404, allowOrigin: "*" })]);
    expect(errors).toEqual([]);
  });
});
