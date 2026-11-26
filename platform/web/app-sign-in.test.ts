// Ticket 3.24: the hand-off page /app-sign-in/?app=<nickname> in a real browser (Playwright's Chromium), against a mocked
// API. The built site (buildWeb, as the site stack publishes it) is served by a tiny local server that, like the
// distribution's `ssd-workshop-site-index` function, serves a folder's index.html, with the pages' real
// Content-Security-Policy; `/apps/<nickname>/` answers a stand-in app page. Phone width (375 px).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PAGES_CONTENT_SECURITY_POLICY } from "../../infra/lib/config.js";
import { APP_SIGN_IN_TEXTS } from "../api/workshop/texts.js";
import { buildWeb } from "./build.js";

const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const BOB = { id: "p-bob", nickname: "Bob", role: "participant", group: "g1", step: "clarify" };

let dir: string;
let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let violations: string[];
const appPagesServed: string[] = [];

beforeAll(async () => {
  dir = buildWeb(mkdtempSync(join(tmpdir(), "ssd-workshop-app-sign-in-")));
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path.startsWith("/apps/")) {
      appPagesServed.push(path);
      response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>An app</title><p>The app</p>");
      return;
    }
    const file = normalize(join(dir, path.endsWith("/") ? `${path}index.html` : path));
    try {
      if (!file.startsWith(dir)) throw new Error("outside");
      const body = readFileSync(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": PAGES_CONTENT_SECURITY_POLICY });
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
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  violations = [];
  appPagesServed.length = 0;
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of")) violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(error.message));
});

afterEach(async () => {
  await context.close();
  expect(violations).toEqual([]);
});

interface Call {
  method: string;
  path: string;
  body: string | null;
}
type Reply = { status: number; body?: unknown };

async function mockApi(handlers: Record<string, (call: Call) => Reply>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const call: Call = { method: request.method(), path: new URL(request.url()).pathname, body: request.postData() };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    const reply = handler ? handler(call) : { status: 404, body: { message: "Not found." } };
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body ?? {}) });
  });
  return calls;
}

describe("the hand-off page /app-sign-in (ticket 3.24)", () => {
  it("criterion 2 (page): WHEN a signed-in participant presses Continue THEN they land on /apps/<nick>/#wt=<token>", async () => {
    const calls = await mockApi({
      "GET /api/me": () => ({ status: 200, body: BOB }),
      "POST /api/app-tokens": () => ({ status: 200, body: { token: TOKEN, app: "ada", nickname: "Bob", expiresAt: 1 } }),
    });
    await page.goto(`${origin}/app-sign-in/?app=Ada`);
    await expect.poll(() => page.locator("#app-sign-in-question").textContent()).toBe("Save in Ada's app as Bob?");
    expect(await page.locator("#app-sign-in-explainer").textContent()).toBe(APP_SIGN_IN_TEXTS.explainer);
    const before = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(`${origin}/apps/ada/#wt=${TOKEN}`);
    expect(appPagesServed).toEqual(["/apps/ada/"]);
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({ path: "/api/app-tokens", body: JSON.stringify({ app: "Ada" }) });
    // The hand-off page is replaced in the history, not left behind.
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  it("criterion 3 (page): WHEN `app` names no live app THEN the page says the app is not live and redirects nowhere", async () => {
    await mockApi({
      "GET /api/me": () => ({ status: 200, body: BOB }),
      "POST /api/app-tokens": () => ({ status: 404, body: { message: "This app is not live.", reason: "not-live" } }),
    });
    await page.goto(`${origin}/app-sign-in/?app=nobody`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => page.locator("#message-app-sign-in").textContent()).toBe(APP_SIGN_IN_TEXTS.notLive);
    expect(await page.locator("#app-sign-in-ask").isHidden()).toBe(true);
    expect(page.url()).toBe(`${origin}/app-sign-in/?app=nobody`);
    expect(appPagesServed).toEqual([]);
  });

  it("criterion 3 (page): WHEN `app` is not a valid nickname THEN the page says the app is not live, asks the API nothing and redirects nowhere", async () => {
    for (const query of ["?app=..%2Fx", "?app=a", "?app=https://evil.example", "", "?app=ada&app=bob"]) {
      const calls = await mockApi({ "GET /api/me": () => ({ status: 200, body: BOB }) });
      await page.goto(`${origin}/app-sign-in/${query}`);
      await expect.poll(() => page.locator("#message-app-sign-in").textContent()).toBe(APP_SIGN_IN_TEXTS.notLive);
      expect(await page.locator("#app-sign-in-ask").isHidden(), query).toBe(true);
      expect(calls, query).toEqual([]);
      await page.unrouteAll();
    }
    expect(appPagesServed).toEqual([]);
  });

  it("uses the existing sign-in when there is no session, then comes back to the same question", async () => {
    let signedIn = false;
    await mockApi({
      "GET /api/me": () => (signedIn ? { status: 200, body: BOB } : { status: 401, body: { message: "Please sign in." } }),
      "POST /api/sign-in/code": () => ({ status: 202, body: {} }),
      "POST /api/sign-in/verify": () => {
        signedIn = true;
        return { status: 200, body: {} };
      },
    });
    await page.goto(`${origin}/app-sign-in/?app=ada`);
    await expect.poll(() => page.locator("#message-app-sign-in").textContent()).toBe(APP_SIGN_IN_TEXTS.signInFirst);
    expect(await page.locator("#app-sign-in-ask").isHidden()).toBe(true);
    await page.getByRole("link", { name: "Sign in to the workshop" }).click();
    await page.waitForURL(`${origin}/?app=ada`);
    await expect.poll(() => page.locator("#app-sign-in-note").textContent()).toBe("Sign in to save in ada's app. You come back to it afterwards.");
    await page.locator("#email-input").fill("someone@example.test");
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.locator("#code-input").fill("123456");
    await page.locator("#code-form button[type=submit]").click();
    await page.waitForURL(`${origin}/app-sign-in/?app=ada`);
    await expect.poll(() => page.locator("#app-sign-in-question").textContent()).toBe("Save in ada's app as Bob?");
  });

  it("asks a participant without a nickname to choose one first, and opens nothing", async () => {
    await mockApi({ "GET /api/me": () => ({ status: 200, body: { ...BOB, nickname: null, step: "nickname" } }) });
    await page.goto(`${origin}/app-sign-in/?app=ada`);
    await expect.poll(() => page.locator("#message-app-sign-in").textContent()).toBe(APP_SIGN_IN_TEXTS.noNickname);
    expect(await page.locator("#app-sign-in-ask").isHidden()).toBe(true);
    expect(await page.locator("#home-link").isVisible()).toBe(true);
  });

  it("shows a refusal (too many tokens) and stays, Continue usable again", async () => {
    await mockApi({
      "GET /api/me": () => ({ status: 200, body: BOB }),
      "POST /api/app-tokens": () => ({ status: 429, body: { message: APP_SIGN_IN_TEXTS.tooMany, reason: "too-many" } }),
    });
    await page.goto(`${origin}/app-sign-in/?app=ada`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => page.locator("#message-app-sign-in").textContent()).toBe(APP_SIGN_IN_TEXTS.tooMany);
    expect(await page.getByRole("button", { name: "Continue" }).isEnabled()).toBe(true);
    expect(appPagesServed).toEqual([]);
  });
});
