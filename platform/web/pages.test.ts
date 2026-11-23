// Ticket 1.6: the sign-in screens in a real browser (Playwright's Chromium), against a mocked API.
// The built site (buildWeb, as the site stack publishes it) is served by a tiny local server that
// sends the pages' real Content-Security-Policy, so any inline script or style the policy would
// block in production fails these tests too. Every test runs at phone width (375 px).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PAGES_CONTENT_SECURITY_POLICY } from "../../infra/lib/config.js";
import { buildWeb } from "./build.js";
import { MESSAGES } from "./src/flow.js";

const PHONE = { width: 375, height: 667 };
const EMAIL = "ada@example.com";
const OTHER_EMAIL = "not-on-the-list@example.com";
const NEUTRAL_BODY = { message: MESSAGES.neutral };
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

let dir: string;
let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let violations: string[];

beforeAll(async () => {
  dir = buildWeb(mkdtempSync(join(tmpdir(), "ssd-workshop-web-")));
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = normalize(join(dir, path === "/" ? "index.html" : path));
    try {
      if (!file.startsWith(dir)) throw new Error("outside");
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-security-policy": PAGES_CONTENT_SECURITY_POLICY,
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
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  context = await browser.newContext({ viewport: PHONE });
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  violations = [];
  page.on("console", (message) => {
    // Chromium logs every non-2xx API answer as an error; those are expected here.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of")) {
      violations.push(message.text());
    }
  });
  page.on("pageerror", (error) => violations.push(error.message));
});

afterEach(async () => {
  await context.close();
  // No Content-Security-Policy violation and no script error on any page.
  expect(violations).toEqual([]);
});

interface Call {
  method: string;
  path: string;
  contentType: string | undefined;
  body: unknown;
}

type Reply = { status: number; body?: unknown; delayMs?: number };
type Handler = (call: Call) => Reply;

/** Mocks every /api/ request with `handlers` (by "METHOD /path") and records the calls. */
async function mockApi(handlers: Record<string, Handler>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const raw = request.postData();
    const call: Call = { method: request.method(), path, contentType: request.headers()["content-type"], body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    const handler = handlers[`${call.method} ${path}`];
    const reply = handler ? handler(call) : { status: 404, body: { message: "Not found." } };
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body ?? {}) });
  });
  return calls;
}

/** A small stand-in for the real API: signed out until a right code, then a person without a nickname. */
function fakeApi(): Record<string, Handler> {
  let signedIn = false;
  let nickname: string | null = null;
  const record = () => ({ id: "p-1", nickname, role: "participant", group: "g1", step: nickname ? "clarify" : "nickname" });
  return {
    "GET /api/me": () => (signedIn ? { status: 200, body: record() } : { status: 401, body: { message: "Please sign in." } }),
    "POST /api/sign-in/code": () => ({ status: 202, body: NEUTRAL_BODY }),
    "POST /api/sign-in/verify": (call) => {
      const body = call.body as { code?: string };
      if (body.code !== "123456") return { status: 401, body: { message: "That code is not right or has expired. Ask for a new one." }, delayMs: 300 };
      signedIn = true;
      return { status: 200, body: { next: "nickname" }, delayMs: 300 };
    },
    "POST /api/me/nickname": (call) => {
      const wanted = (call.body as { nickname: string }).nickname;
      if (wanted.toLowerCase() === "taken") return { status: 409, body: { reason: "taken", message: "That nickname is already taken. Please pick another one." } };
      nickname = wanted;
      return { status: 200, body: record() };
    },
  };
}

/** Nothing on the page is wider than the viewport (criterion 4). */
async function expectNoSideScroll(): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.client).toBe(PHONE.width);
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  expect(widths.body).toBeLessThanOrEqual(widths.client);
}

const screen = (name: string) => page.locator(`#screen-${name}`);

async function askForCode(email: string): Promise<void> {
  await page.getByRole("textbox", { name: "Email address" }).fill(email);
  await page.getByRole("button", { name: "Send me a code" }).click();
}

describe("sign-in screens (ticket 1.6)", () => {
  it("leads from email to code to nickname to step 1, at 375 px without sideways scrolling (criteria 1, 2, 3, 4)", async () => {
    const calls = await mockApi(fakeApi());
    await page.goto(origin);

    await expect.poll(() => screen("email").isVisible()).toBe(true);
    expect(await page.locator("h1").textContent()).toBe("SSD Workshop");
    await expectNoSideScroll();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("email-input");
    await askForCode(EMAIL);

    // Code screen: neutral message, Junk-folder hint and resend link (criterion 2).
    await expect.poll(() => screen("code").isVisible()).toBe(true);
    expect(await screen("email").isVisible()).toBe(false);
    expect(await page.locator("#message-code").textContent()).toBe(MESSAGES.neutral);
    expect(await page.getByText("Not in your inbox? Check your Junk folder.").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Send me a new code" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Use a different email" }).isVisible()).toBe(true);
    await expectNoSideScroll();

    await page.getByRole("textbox", { name: "6-digit code" }).fill("123 456");
    await page.getByRole("button", { name: "Sign in" }).click();
    // The check takes a few seconds by design: a waiting state shows meanwhile.
    await expect.poll(() => page.locator("#code-form button[type=submit]").textContent()).toBe("Checking…");
    expect(await page.locator("#code-form button[type=submit]").isDisabled()).toBe(true);
    expect(await page.locator("#message-code").textContent()).toBe(MESSAGES.checking);

    // Nickname screen with the rule on screen (criterion 3).
    await expect.poll(() => screen("nickname").isVisible()).toBe(true);
    const rule = page.locator("#screen-nickname .rule");
    expect(await rule.isVisible()).toBe(true);
    expect((await rule.textContent())?.toLowerCase()).toContain("no confidential or customer data");
    await expectNoSideScroll();

    await page.getByRole("textbox", { name: "Nickname" }).fill("ada-l");
    await page.getByRole("button", { name: "Save my nickname" }).click();

    // Step 1 (criterion 1).
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    expect(await page.locator("#step-heading").textContent()).toBe("Step 1: Clarify");
    expect(await page.locator("#step-nickname").textContent()).toBe("ada-l");
    expect(await page.locator("#step-intro").isVisible()).toBe(true);
    await expectNoSideScroll();

    // The real API contract: JSON bodies with the JSON content type; the step comes from GET /api/me.
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [c.path, c.body])).toEqual([
      ["/api/sign-in/code", { email: EMAIL }],
      ["/api/sign-in/verify", { email: EMAIL, code: "123456" }],
      ["/api/me/nickname", { nickname: "ada-l" }],
    ]);
    for (const post of posts) expect(post.contentType).toBe("application/json");
    const verifyAt = calls.findIndex((c) => c.path === "/api/sign-in/verify");
    expect(calls[verifyAt + 1]).toMatchObject({ method: "GET", path: "/api/me" });

    // The address is never kept anywhere persistent or in the URL.
    expect(page.url()).not.toContain("ada");
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
    expect(await page.locator("#email-input").inputValue()).toBe("");
  }, 30_000);

  it("shows the same neutral message for an address that is not on the list (criterion 6)", async () => {
    await mockApi(fakeApi());
    const shown: (string | null)[] = [];
    for (const email of [EMAIL, OTHER_EMAIL]) {
      await page.goto(origin);
      await expect.poll(() => screen("email").isVisible()).toBe(true);
      await askForCode(email);
      await expect.poll(() => screen("code").isVisible()).toBe(true);
      shown.push(await page.locator("#message-code").textContent());
    }
    expect(shown).toEqual([MESSAGES.neutral, MESSAGES.neutral]);
  }, 30_000);

  it("resends a code to the same address, offers a different email, and shows a wrong code's message", async () => {
    const calls = await mockApi(fakeApi());
    await page.goto(origin);
    await expect.poll(() => screen("email").isVisible()).toBe(true);
    await askForCode(EMAIL);
    await expect.poll(() => screen("code").isVisible()).toBe(true);

    await page.getByRole("textbox", { name: "6-digit code" }).fill("000000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect
      .poll(() => page.locator("#message-code").textContent())
      .toBe("That code is not right or has expired. Ask for a new one.");
    expect(await page.locator("#message-code").getAttribute("data-tone")).toBe("error");

    await page.getByRole("button", { name: "Send me a new code" }).click();
    await expect.poll(() => page.locator("#message-code").textContent()).toBe(MESSAGES.neutral);
    const codeRequests = calls.filter((c) => c.path === "/api/sign-in/code");
    expect(codeRequests.map((c) => c.body)).toEqual([{ email: EMAIL }, { email: EMAIL }]);

    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect.poll(() => screen("email").isVisible()).toBe(true);
    await expectNoSideScroll();
  }, 30_000);

  it("shows a throttled code request or code check (429) as 'Please try again in a moment'", async () => {
    let throttled = true;
    await mockApi({
      ...fakeApi(),
      "POST /api/sign-in/code": () => (throttled ? { status: 429, body: { message: "Too Many Requests" } } : { status: 202, body: NEUTRAL_BODY }),
      "POST /api/sign-in/verify": () => ({ status: 429, body: { message: "Too Many Requests" } }),
    });
    await page.goto(origin);
    await expect.poll(() => screen("email").isVisible()).toBe(true);
    await askForCode(EMAIL);
    await expect.poll(() => page.locator("#message-email").textContent()).toBe("Please try again in a moment.");
    expect(await page.locator("#message-email").getAttribute("data-tone")).toBe("info");
    expect(await screen("email").isVisible()).toBe(true);

    throttled = false;
    await page.getByRole("button", { name: "Send me a code" }).click();
    await expect.poll(() => screen("code").isVisible()).toBe(true);
    await page.getByRole("textbox", { name: "6-digit code" }).fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.poll(() => page.locator("#message-code").textContent()).toBe("Please try again in a moment.");
    expect(await page.locator("#message-code").getAttribute("data-tone")).toBe("info");
  }, 30_000);

  it("refuses an obvious typo in the address without calling the API", async () => {
    const calls = await mockApi(fakeApi());
    await page.goto(origin);
    await expect.poll(() => screen("email").isVisible()).toBe(true);
    await askForCode("ada.example.com");
    await expect.poll(() => page.locator("#message-email").textContent()).toBe(MESSAGES.badEmail);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  }, 30_000);

  it("shows a refused nickname's reason and stays on the nickname screen", async () => {
    const api = fakeApi();
    await mockApi(api);
    // Already signed in, no nickname yet: the page goes straight to the nickname screen.
    api["POST /api/sign-in/verify"]?.({ method: "POST", path: "", contentType: "", body: { code: "123456" } });
    await page.goto(origin);
    await expect.poll(() => screen("nickname").isVisible()).toBe(true);
    await page.getByRole("textbox", { name: "Nickname" }).fill("Taken");
    await page.getByRole("button", { name: "Save my nickname" }).click();
    await expect
      .poll(() => page.locator("#message-nickname").textContent())
      .toBe("That nickname is already taken. Please pick another one.");
    expect(await screen("nickname").isVisible()).toBe(true);
    await expectNoSideScroll();
  }, 30_000);

  it("takes a returning person with a valid session straight to their step", async () => {
    const calls = await mockApi({
      "GET /api/me": () => ({ status: 200, body: { id: "p-1", nickname: "grace", role: "participant", group: "g1", step: "clarify" } }),
    });
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    expect(await page.locator("#step-nickname").textContent()).toBe("grace");
    expect(await screen("email").isVisible()).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/me"]);
    await expectNoSideScroll();
  }, 30_000);
});

describe("built site", () => {
  it("holds only the page, its stylesheet and one script, and the page has no inline script, style or handler", () => {
    expect(readdirSync(dir).sort()).toEqual(["app.js", "index.html", "style.css"]);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain('<script src="app.js" defer></script>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });
});
