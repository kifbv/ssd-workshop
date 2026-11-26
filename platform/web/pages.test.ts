// Tickets 1.6, 1.8 and 1.9: the sign-in screens, step 1 and step 2 in a real browser (Playwright's Chromium), against a mocked API.
// The built site (buildWeb, as the site stack publishes it) is served by a tiny local server that
// sends the pages' real Content-Security-Policy, so any inline script or style the policy would
// block in production fails these tests too. Every test runs at phone width (375 px); step 2's diagram
// is also checked at laptop width (1280 px).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
// jsqr is CommonJS: the default import is its module, whose `default` is the decoder (in Node.js and in vitest).
import jsQRModule from "jsqr";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PAGES_CONTENT_SECURITY_POLICY } from "../../infra/lib/config.js";
import { buildWeb } from "./build.js";
import { MESSAGES } from "./src/flow.js";
import { BUILD_TEXTS } from "./src/build-view.js";
import { PHASE_3_TEXTS } from "../api/workshop/texts.js";

const jsQR = jsQRModule.default;

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
    "GET /api/conversation": () => (signedIn ? { status: 200, body: { step: "clarify", state: "open", messages: [] } } : { status: 401, body: {} }),
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
async function expectNoSideScroll(width: number = PHONE.width): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.client).toBe(width);
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

    // Code screen: neutral message, Junk-folder hint (ticket 3.1 criterion 4) and resend link (criterion 2).
    await expect.poll(() => screen("code").isVisible()).toBe(true);
    expect(await screen("email").isVisible()).toBe(false);
    expect(await page.locator("#message-code").textContent()).toBe(MESSAGES.neutral);
    expect(await page.getByText("No code after a minute? Check your Junk or Spam folder.").isVisible()).toBe(true);
    // No Sign out link before signing in.
    expect(await page.locator("#account").isVisible()).toBe(false);
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
    expect(await page.locator("#behind-scenes").isVisible()).toBe(true);
    expect(await page.locator("#chat-input").isVisible()).toBe(true);
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

  it("ticket 3.1 criterion 4: WHEN the sign-in screen asks for a code THEN it shows the Junk hint, at 375 px", async () => {
    await mockApi(fakeApi());
    await page.goto(origin);
    await expect.poll(() => screen("email").isVisible()).toBe(true);
    await askForCode(EMAIL);
    await expect.poll(() => screen("code").isVisible()).toBe(true);
    const hint = page.locator("#screen-code .hint");
    expect(await hint.textContent()).toBe("No code after a minute? Check your Junk or Spam folder.");
    expect(await hint.isVisible()).toBe(true);
    const box = await hint.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= PHONE.width).toBe(true);
    await expectNoSideScroll();
  }, 30_000);

  it("ticket 3.1: shows a small Sign out link once signed in; it signs out, stops polling and goes back to the email screen", async () => {
    let signedIn = true;
    const calls = await mockApi({
      ...fakeApi(),
      "GET /api/me": () =>
        signedIn
          ? { status: 200, body: { id: "p-1", nickname: "ada-l", role: "participant", group: "g1", step: "clarify" } }
          : { status: 401, body: { message: "Please sign in." } },
      "GET /api/conversation": () => (signedIn ? { status: 200, body: { step: "clarify", state: "open", messages: [] } } : { status: 401, body: {} }),
      "POST /api/sign-out": () => {
        const was = signedIn;
        signedIn = false;
        return was ? { status: 200, body: { message: "You're signed out." } } : { status: 401, body: { message: "Please sign in." } };
      },
    });
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    const link = page.getByRole("button", { name: "Sign out" });
    expect(await link.isVisible()).toBe(true);
    await expectNoSideScroll();

    await link.click();
    await expect.poll(() => screen("email").isVisible()).toBe(true);
    expect(await page.locator("#message-email").textContent()).toBe("You're signed out.");
    expect(await page.locator("#account").isVisible()).toBe(false);
    const signOuts = calls.filter((c) => c.path === "/api/sign-out");
    expect(signOuts.map((c) => [c.method, c.contentType, c.body])).toEqual([["POST", "application/json", {}]]);
    // Nothing is asked of the API after signing out (no polling left running).
    const after = calls.length;
    await page.waitForTimeout(2500);
    expect(calls.length).toBe(after);
    await expectNoSideScroll();

    // A reload stays signed out.
    await page.reload();
    await expect.poll(() => screen("email").isVisible()).toBe(true);
  }, 30_000);

  it("ticket 3.1: keeps the person on their step and says why when sign-out cannot reach the API", async () => {
    await mockApi({
      ...fakeApi(),
      "GET /api/me": () => ({ status: 200, body: { id: "p-1", nickname: "ada-l", role: "participant", group: "g1", step: "clarify" } }),
      "GET /api/conversation": () => ({ status: 200, body: { step: "clarify", state: "open", messages: [] } }),
      "POST /api/sign-out": () => ({ status: 500, body: { message: "Something went wrong. Please try again in a moment." } }),
    });
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => page.locator("#message-step").textContent()).toBe(MESSAGES.failed);
    expect(await screen("step").isVisible()).toBe(true);
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
      "GET /api/conversation": () => ({ status: 200, body: { step: "clarify", state: "open", messages: [] } }),
    });
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    expect(await page.locator("#step-nickname").textContent()).toBe("grace");
    expect(await screen("email").isVisible()).toBe(false);
    await expect.poll(() => calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/me", "GET /api/conversation"]);
    await expectNoSideScroll();
  }, 30_000);
});

// Ticket 1.8: step 1 (Clarify) against a mocked conversation API.
interface MockMessage {
  id: string;
  author: "participant" | "assistant";
  text: string;
  status?: string;
  offersSpec?: boolean;
  step?: string;
  specVersion?: number;
}

const QUESTIONS = "A run log for you.\n1. Who is it for?\n2. What do you record?\n3. What can wait?";
const ME = { id: "p-1", nickname: "ada-l", role: "participant", group: "g1" };

/**
 * A stand-in for the conversation routes: one participant at `step`, the conversation in `messages`;
 * a sent message stays pending until `answer()` (or `flag()`) is called. Polls are counted per id.
 */
function fakeConversation(start: MockMessage[] = [], step = "clarify") {
  const state = { step, messages: [...start], pendingId: undefined as string | undefined, waiting: false, polls: 0, nextId: 1, budgetLeft: undefined as number | undefined, paused: false, pausedUnknown: false };
  /** Ticket 3.5: the Stop's flags as the API sends them; `pausedUnknown` stands for a failed settings read. */
  const pausedBody = () => (state.pausedUnknown ? { pausedUnknown: true } : state.paused ? { paused: true } : {});
  const answer = (reply: string, offersSpec = false, status = "done") => {
    const id = state.pendingId ?? "";
    const message = state.messages.find((m) => m.id === id);
    if (message) message.status = status;
    state.messages.push({ id: `${id}-r`, author: "assistant", text: reply, ...(offersSpec ? { offersSpec } : {}) });
    state.pendingId = undefined;
    state.waiting = false;
  };
  const flag = () => {
    const message = state.messages.find((m) => m.id === state.pendingId);
    if (message) message.status = "flagged";
    state.waiting = true;
  };
  const handlers: Record<string, Handler> = {
    "GET /api/me": () => ({ status: 200, body: { ...ME, step: state.step } }),
    "GET /api/conversation": () => ({
      status: 200,
      body: {
        step: state.step,
        state: state.waiting ? "waiting" : "open",
        messages: state.messages,
        ...(state.pendingId ? { pendingId: state.pendingId } : {}),
        ...(state.budgetLeft === undefined ? {} : { budgetLeft: state.budgetLeft }),
        ...pausedBody(),
      },
    }),
    "POST /api/conversation/messages": (call) => {
      if (state.pendingId) return { status: 409, body: { reason: "busy", message: "Please wait for the answer to your last message." } };
      const id = `m${state.nextId++}`;
      state.messages.push({ id, author: "participant", text: (call.body as { text: string }).text, status: "pending" });
      state.pendingId = id;
      return { status: 202, body: { id } };
    },
    "POST /api/conversation/step": () => {
      if (!state.messages.some((m) => m.status === "done")) return { status: 409, body: { reason: "too-early", message: "Tell the AI about your idea first." } };
      state.step = "spec";
      return { status: 200, body: { step: "spec" } };
    },
  };
  // Polls of any message id: GET /api/conversation/messages/<id>.
  const pollPath = (id: string) => `GET /api/conversation/messages/${id}`;
  const pollHandler = (id: string): Handler => () => {
    state.polls++;
    const message = state.messages.find((m) => m.id === id);
    const reply = state.messages.find((m) => m.id === `${id}-r`);
    const status = message?.status ?? "pending";
    return { status: 200, body: { id, status, ...(reply ? { reply: reply.text } : {}), ...pausedBody() } };
  };
  for (let n = 1; n <= 9; n++) handlers[pollPath(`m${n}`)] = pollHandler(`m${n}`);
  return { state, handlers, answer, flag };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}
const bubbles = () => page.locator("#chat .bubble").allTextContents();
/**
 * Stops the installed page clock from following real time: from here only runFor moves it. The target is
 * 1 s ahead because real time keeps passing between reading the page's clock and pausing it (under a
 * loaded full run, more than 1 ms: "Cannot fast-forward to the past"). Call it only while the page has
 * no timer set (before the first send), since pausing fires the timers due in that second.
 */
async function pauseClock(): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
}
/** Lets the page's pending fetches and their handlers run (real time, a little). */
const settle = () => page.waitForTimeout(250);
/**
 * Moves page time by `ms`, which must fire one poll, waits for its answer and lets the page handle it,
 * so the next poll's timer is set before time moves again.
 */
async function pollAfter(ms: number): Promise<void> {
  const answered = page.waitForResponse((r) => r.url().includes("/api/conversation/messages/"));
  await page.clock.runFor(ms);
  await answered;
  await settle();
}

describe("step 1: Clarify (ticket 1.8)", () => {
  it("WHEN the screen waits for a reply THEN it shows a typing indicator, polls every 2 seconds and stops once the reply has arrived (criterion 3)", async () => {
    const api = fakeConversation();
    await mockApi(api.handlers);
    await page.clock.install();
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    await pauseClock();
    expect(await page.locator("#behind-scenes").isVisible()).toBe(true);
    expect(await page.locator("#behind-flow li").allTextContents()).toEqual(["Your message", "Safety check", "Claude on Bedrock", "Reply"]);
    expect(await page.locator("#typing").isVisible()).toBe(false);
    expect(await page.locator("#spec-offer").isVisible()).toBe(false);
    await expectNoSideScroll();

    await page.getByRole("textbox", { name: "Your message" }).fill("I'd like a fitness tracker for my runs.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);
    expect(await bubbles()).toEqual(["I'd like a fitness tracker for my runs."]);
    expect(await page.locator("#behind-flow").getAttribute("data-stage")).toBe("working");
    expect(await page.locator("#chat-send").isDisabled()).toBe(true);
    expect(await page.getByRole("textbox", { name: "Your message" }).inputValue()).toBe("");
    await expectNoSideScroll();

    // No poll before 2 seconds, then one every 2 seconds.
    await page.clock.runFor(1900);
    await settle();
    expect(api.state.polls).toBe(0);
    await pollAfter(100);
    expect(api.state.polls).toBe(1);
    await pollAfter(2000);
    expect(api.state.polls).toBe(2);
    await page.clock.runFor(1000);
    await settle();
    expect(api.state.polls).toBe(2);
    expect(await page.locator("#typing").isVisible()).toBe(true);

    // The reply arrives: shown at the next poll, typing indicator gone, no more polls.
    api.answer(QUESTIONS);
    await pollAfter(1000);
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(false);
    expect(api.state.polls).toBe(3);
    await expect.poll(bubbles).toEqual(["I'd like a fitness tracker for my runs.", QUESTIONS]);
    expect(await page.locator("#behind-flow").getAttribute("data-stage")).toBe("reply");
    await page.clock.runFor(20_000);
    await settle();
    expect(api.state.polls).toBe(3);

    // The numbered questions keep their lines; Write my spec appears, not yet highlighted.
    expect(await page.locator("#chat .bubble").nth(1).evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("pre-wrap");
    expect(await page.locator("#spec-offer").isVisible()).toBe(true);
    expect(await page.locator("#spec-offer").getAttribute("data-offered")).toBe("false");
    expect(await page.locator("#chat-send").isDisabled()).toBe(false);
    await expectNoSideScroll();
  }, 30_000);

  it("ticket 3.3: WHEN the AI budget is used THEN the budget text shows where the AI reply would, the budget left reads $0.00, and Send stays available, at 375 px", async () => {
    const budgetText = "You've used your AI budget for today. Your facilitator can add more.";
    const api = fakeConversation();
    api.state.budgetLeft = 0.04;
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    await expect.poll(() => page.locator("#chat-budget").textContent()).toBe("AI budget left: $0.04");
    expect(await page.locator("#chat-budget").isVisible()).toBe(true);

    await page.getByRole("textbox", { name: "Your message" }).fill("A plant watering reminder.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);
    // The worker made no AI call: the message ends failed with the budget text as its reply.
    api.state.budgetLeft = 0;
    api.answer(budgetText, false, "failed");
    await expect.poll(bubbles, { timeout: 6000 }).toEqual(["A plant watering reminder.", budgetText]);
    expect(await page.locator("#chat .bubble").nth(1).getAttribute("data-author")).toBe("assistant");
    await expect.poll(() => page.locator("#chat-budget").textContent()).toBe("AI budget left: $0.00");
    expect(await page.locator("#typing").isVisible()).toBe(false);
    expect(await page.locator("#chat-send").isDisabled()).toBe(false);
    await expectNoSideScroll();
  }, 30_000);

  it("ticket 3.5 criterion 4: WHEN Stop is on THEN step 1 shows the paused line, also while a message waits; WHEN Resume THEN it goes, at 375 px", async () => {
    const api = fakeConversation();
    api.state.paused = true;
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    const banner = page.locator("#workshop-paused");
    await expect.poll(() => banner.isVisible()).toBe(true);
    expect(await banner.textContent()).toBe(PHASE_3_TEXTS.workshopPaused);
    expect(await banner.getAttribute("role")).toBe("status");
    await expectNoSideScroll();

    // A message sent meanwhile stays pending (the worker holds it); each poll says the workshop is paused.
    await page.getByRole("textbox", { name: "Your message" }).fill("A plant watering reminder.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);
    await expect.poll(() => api.state.polls, { timeout: 6000 }).toBeGreaterThan(0);
    expect(await banner.isVisible()).toBe(true);
    await expectNoSideScroll();

    // Resume: the next poll no longer says paused, and the line goes; the held message is then answered.
    api.state.paused = false;
    const polls = api.state.polls;
    await expect.poll(() => api.state.polls, { timeout: 6000 }).toBeGreaterThan(polls);
    await expect.poll(() => banner.isVisible()).toBe(false);
    api.answer(QUESTIONS);
    await expect.poll(bubbles, { timeout: 6000 }).toEqual(["A plant watering reminder.", QUESTIONS]);
    expect(await banner.isVisible()).toBe(false);
  }, 30_000);

  it("ticket 3.5 criterion 4: WHEN a flagged message waits for a facilitator while Stop is on THEN the paused line stays across 10 s polls; WHEN Resume THEN it goes, at 375 px", async () => {
    const api = fakeConversation();
    api.state.paused = true;
    await mockApi(api.handlers);
    await page.clock.install();
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    await pauseClock();
    const banner = page.locator("#workshop-paused");
    await expect.poll(() => banner.isVisible()).toBe(true);
    await page.getByRole("textbox", { name: "Your message" }).fill("An app that tells me which medicine to take.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);
    api.flag();
    await pollAfter(2000);
    expect(await page.locator("#waiting-notice").isVisible()).toBe(true);
    expect(await banner.isVisible()).toBe(true);
    for (let n = 0; n < 3; n++) {
      const polls = api.state.polls;
      await pollAfter(10_000);
      expect(api.state.polls).toBe(polls + 1);
      expect(await banner.isVisible()).toBe(true);
    }
    await expectNoSideScroll();
    api.state.paused = false;
    await pollAfter(10_000);
    expect(await banner.isVisible()).toBe(false);
    expect(await page.locator("#waiting-notice").isVisible()).toBe(true);
  }, 30_000);

  it("ticket 3.5: WHEN the server could not read the settings (pausedUnknown) THEN the poll and the conversation keep the paused line as shown; WHEN a read works THEN it follows it", async () => {
    const api = fakeConversation();
    api.state.paused = true;
    await mockApi(api.handlers);
    await page.clock.install();
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    await pauseClock();
    const banner = page.locator("#workshop-paused");
    await expect.poll(() => banner.isVisible()).toBe(true);
    await page.getByRole("textbox", { name: "Your message" }).fill("A plant watering reminder.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);
    // The settings read fails: pending polls and the flagged ones keep the line.
    api.state.pausedUnknown = true;
    await pollAfter(2000);
    await pollAfter(2000);
    expect(await banner.isVisible()).toBe(true);
    api.flag();
    await pollAfter(2000);
    await pollAfter(10_000);
    expect(await page.locator("#waiting-notice").isVisible()).toBe(true);
    expect(await banner.isVisible()).toBe(true);
    // The read works again and still says paused: the line stays.
    api.state.pausedUnknown = false;
    await pollAfter(10_000);
    expect(await banner.isVisible()).toBe(true);
    // The read works again and says running: the line goes.
    api.state.paused = false;
    await pollAfter(10_000);
    expect(await banner.isVisible()).toBe(false);
    // pausedUnknown never shows the line by itself.
    api.state.paused = true;
    api.state.pausedUnknown = true;
    await pollAfter(10_000);
    expect(await banner.isVisible()).toBe(false);
  }, 30_000);

  it("WHEN the page is reloaded THEN the conversation so far is shown again, and a pending message is polled again (criterion 4)", async () => {
    const api = fakeConversation([
      { id: "m1", author: "participant", text: "A movie watchlist", status: "done" },
      { id: "m1-r", author: "assistant", text: QUESTIONS },
    ]);
    api.state.nextId = 2;
    const calls = await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(bubbles).toEqual(["A movie watchlist", QUESTIONS]);
    expect(await page.locator("#typing").isVisible()).toBe(false);

    await page.getByRole("textbox", { name: "Your message" }).fill("Just me, with star ratings.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);

    await page.reload();
    await expect.poll(bubbles).toEqual(["A movie watchlist", QUESTIONS, "Just me, with star ratings."]);
    expect(await page.locator("#typing").isVisible()).toBe(true);
    api.answer("Thanks!");
    await expect.poll(bubbles, { timeout: 6000 }).toEqual(["A movie watchlist", QUESTIONS, "Just me, with star ratings.", "Thanks!"]);
    expect(await page.locator("#typing").isVisible()).toBe(false);
    expect(calls.filter((c) => c.path === "/api/conversation").length).toBeGreaterThanOrEqual(2);
    await expectNoSideScroll();
  }, 30_000);

  it("shows 'waiting for your facilitator' for a flagged message, also after a reload, and blocks sending meanwhile", async () => {
    const api = fakeConversation();
    await mockApi(api.handlers);
    await page.clock.install();
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    await pauseClock();
    await page.getByRole("textbox", { name: "Your message" }).fill("An app that tells me which medicine to take.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);
    api.flag();
    await page.clock.runFor(2000);
    await expect.poll(() => page.locator("#waiting-notice").isVisible()).toBe(true);
    expect(await page.locator("#typing").isVisible()).toBe(false);
    expect(await page.locator("#waiting-notice").textContent()).toBe(
      "Your message is waiting for your facilitator. You can write again once they have looked at it.",
    );
    expect(await page.locator("#behind-flow").getAttribute("data-stage")).toBe("facilitator");
    expect(await page.locator("#chat-send").isDisabled()).toBe(true);
    // While the facilitator decides, the page checks every 10 seconds instead of every 2.
    const polls = api.state.polls;
    await page.clock.runFor(9000);
    await settle();
    expect(api.state.polls).toBe(polls);
    await page.clock.runFor(1000);
    await expect.poll(() => api.state.polls).toBe(polls + 1);

    await page.reload();
    await expect.poll(() => page.locator("#waiting-notice").isVisible()).toBe(true);
    expect(await page.locator("#chat-send").isDisabled()).toBe(true);
    await expectNoSideScroll();
  }, 30_000);

  it("WHEN the participant presses Write my spec THEN they move to step 2, also after a reload (criterion 5)", async () => {
    const api = fakeConversation([
      { id: "m1", author: "participant", text: "A run log", status: "done" },
      { id: "m1-r", author: "assistant", text: QUESTIONS },
      { id: "m2", author: "participant", text: "Just me, distance and time, no maps.", status: "done" },
      { id: "m2-r", author: "assistant", text: 'I have enough to write your spec. Press "Write my spec" when you are ready.', offersSpec: true },
    ]);
    const calls = await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-offer").isVisible()).toBe(true);
    // The AI offered: the button is the highlighted one.
    expect(await page.locator("#spec-offer").getAttribute("data-offered")).toBe("true");
    expect(await page.locator("#spec-offer-text").textContent()).toBe("The AI has enough to write your spec.");
    await expectNoSideScroll();

    await page.getByRole("button", { name: "Write my spec" }).click();
    await expect.poll(() => screen("spec").isVisible()).toBe(true);
    expect(await screen("step").isVisible()).toBe(false);
    expect(await page.locator("#spec-heading").textContent()).toBe("Step 2: Spec");
    expect(await page.locator("#spec-nickname").textContent()).toBe("ada-l");
    const step = calls.find((c) => c.path === "/api/conversation/step");
    expect(step).toMatchObject({ method: "POST", contentType: "application/json", body: { step: "spec" } });
    await expectNoSideScroll();

    await page.reload();
    await expect.poll(() => screen("spec").isVisible()).toBe(true);
    expect(await screen("step").isVisible()).toBe(false);
  }, 30_000);

  it("keeps a message sent before the page's first conversation read has answered, and keeps waiting for its reply", async () => {
    const api = fakeConversation();
    let first = true;
    const read = must(api.handlers["GET /api/conversation"]);
    await mockApi({
      ...api.handlers,
      // The first read leaves with the empty conversation and answers late.
      "GET /api/conversation": (call) => {
        const reply = read(call);
        if (!first) return reply;
        first = false;
        return { ...reply, body: JSON.parse(JSON.stringify(reply.body)) as unknown, delayMs: 1500 };
      },
    });
    await page.goto(origin);
    await expect.poll(() => screen("step").isVisible()).toBe(true);
    await page.getByRole("textbox", { name: "Your message" }).fill("A plant watering reminder.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#typing").isVisible()).toBe(true);
    await page.waitForTimeout(1800);
    expect(await bubbles()).toEqual(["A plant watering reminder."]);
    expect(await page.locator("#typing").isVisible()).toBe(true);
    api.answer(QUESTIONS);
    await expect.poll(bubbles, { timeout: 6000 }).toEqual(["A plant watering reminder.", QUESTIONS]);
  }, 30_000);

  it("shows the API's reason when Write my spec is refused, and stays on step 1", async () => {
    const api = fakeConversation([
      { id: "m1", author: "participant", text: "A run log", status: "done" },
      { id: "m1-r", author: "assistant", text: QUESTIONS },
    ]);
    await mockApi({
      ...api.handlers,
      "POST /api/conversation/step": () => ({ status: 409, body: { reason: "busy", message: "Please wait for the answer to your last message." } }),
    });
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-offer").isVisible()).toBe(true);
    expect(await page.locator("#spec-offer").getAttribute("data-offered")).toBe("false");
    await page.getByRole("button", { name: "Write my spec" }).click();
    await expect.poll(() => page.locator("#message-step").textContent()).toBe("Please wait for the answer to your last message.");
    expect(await screen("step").isVisible()).toBe(true);
  }, 30_000);
});

// Ticket 1.9: step 2 (Spec and approval) against a mocked API.
const LAPTOP = { width: 1280, height: 800 };
const SPEC_1 = `# Run log

\`\`\`mermaid
flowchart TD
  home[Home] -->|add a run| add[Add a run]
  add -->|saves| runs[(Runs)]
  runs -->|weekly total| home
\`\`\`

## What it does
A log of your runs that shows this week's **total** distance.

## Screens
- Home: this week's total and the list of runs.
- Add a run: date, distance and time.

## Data it keeps
- Runs: date, distance in km and time.`;
const SPEC_2 = SPEC_1.replace("- Add a run: date, distance and time.", "- Add a run: date, distance and time.\n- Longest run: your longest run so far.").replace(
  "runs -->|weekly total| home",
  "runs -->|weekly total| home\n  runs -->|longest| longest[Longest run]",
);
const CLARIFY_DONE: MockMessage[] = [
  { id: "m1", author: "participant", text: "A run log", status: "done", step: "clarify" },
  { id: "m1-r", author: "assistant", text: QUESTIONS, step: "clarify" },
];

/**
 * A stand-in for step 2: the conversation (with steps), the spec versions, Write my spec and Approve
 * spec. A message stays pending until `answer()`; an answer may carry a new spec version.
 */
function fakeSpecApi(step = "spec", specs: string[] = [SPEC_1]) {
  const base = fakeConversation(
    specs.length > 0
      ? [...CLARIFY_DONE, { id: "m2", author: "participant", text: "Please write my spec.", status: "done", step: "spec" }, { id: "m2-r", author: "assistant", text: "Here is your spec.", step: "spec", specVersion: 1 }]
      : CLARIFY_DONE,
    step,
  );
  base.state.nextId = 3;
  const spec = { versions: [...specs], approved: undefined as number | undefined, approves: [] as unknown[] };
  const answer = (reply: string, newSpec?: string) => {
    base.answer(reply);
    must(base.state.messages.at(-1)).step = "spec";
    if (newSpec !== undefined) {
      spec.versions.push(newSpec);
      must(base.state.messages.at(-1)).specVersion = spec.versions.length;
    }
  };
  const conversationBody = () => {
    const body = must(base.handlers["GET /api/conversation"])({ method: "GET", path: "", contentType: undefined, body: null }).body as Record<string, unknown>;
    return {
      ...body,
      step: base.state.step,
      ...(spec.versions.length > 0 ? { latestSpecVersion: spec.versions.length } : {}),
      ...(spec.approved === undefined ? {} : { approvedSpecVersion: spec.approved }),
    };
  };
  const handlers: Record<string, Handler> = {
    ...base.handlers,
    "GET /api/conversation": () => ({ status: 200, body: conversationBody() }),
    "GET /api/conversation/spec": () => {
      const text = spec.versions.at(-1);
      if (text === undefined) return { status: 404, body: { message: "Not found." } };
      return { status: 200, body: { version: spec.versions.length, text, createdAt: "x", approved: spec.approved === spec.versions.length } };
    },
    "POST /api/conversation/messages": (call) => {
      const reply = must(base.handlers["POST /api/conversation/messages"])(call);
      if (reply.status === 202) must(base.state.messages.at(-1)).step = "spec";
      return reply;
    },
    "POST /api/conversation/step": () => {
      base.state.step = "spec";
      if (spec.versions.length > 0 || base.state.pendingId) return { status: 200, body: { step: "spec" } };
      const id = `m${base.state.nextId++}`;
      base.state.messages.push({ id, author: "participant", text: "Please write my spec.", status: "pending", step: "spec" });
      base.state.pendingId = id;
      return { status: 200, body: { step: "spec", id } };
    },
    "POST /api/conversation/spec/approve": (call) => {
      spec.approves.push(call.body);
      const version = (call.body as { version: number }).version;
      if (version !== spec.versions.length) return { status: 409, body: { reason: "stale", message: "There is a newer version of your spec. Please have a look at it, then approve it." } };
      spec.approved = version;
      base.state.step = "approved";
      // Ticket 2.7: the readiness request becomes the message in flight.
      const id = `m${base.state.nextId++}`;
      base.state.messages.push({ id, author: "participant", text: "I approve my spec. Please check that it is ready to build.", status: "pending", step: "approved" });
      base.state.pendingId = id;
      return { status: 200, body: { step: "approved", version, id } };
    },
  };
  /** The readiness check's outcome (ticket 2.7): a pass moves to building, a fail back to step 2 with the reasons. */
  const check = (reply: string, passed: boolean) => {
    base.answer(reply);
    must(base.state.messages.at(-1)).step = "approved";
    base.state.step = passed ? "building" : "spec";
    if (!passed) spec.approved = undefined;
  };
  return { ...base, spec, handlers, answer, check };
}

/** Each bubble's words, without the "See version n" button a reply that saved a version carries. */
const specBubbles = () => page.locator("#spec-chat .bubble").evaluateAll((items) => items.map((item) => item.firstChild?.textContent ?? ""));

/** The diagram is a decoded picture with pixels drawn, within the card, above the spec's sections. */
async function expectDiagramPicture(viewportWidth: number): Promise<void> {
  const img = page.locator("#spec-diagram-img");
  await expect.poll(() => img.isVisible(), { timeout: 15_000 }).toBe(true);
  const facts = await img.evaluate((element) => {
    const image = element as HTMLImageElement;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context?.drawImage(image, 0, 0);
    const data = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray();
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i + 3] ?? 0) > 0 && (data[i] ?? 255) < 160) inked++;
    const box = image.getBoundingClientRect();
    const card = document.getElementById("spec-doc")?.getBoundingClientRect();
    const firstSection = document.querySelector("#spec-sections h4")?.getBoundingClientRect();
    return {
      complete: image.complete,
      natural: [image.naturalWidth, image.naturalHeight],
      shown: [box.width, box.height],
      inked,
      src: image.src.slice(0, 27),
      alt: image.alt,
      insideCard: card !== undefined && box.left >= card.left && box.right <= card.right,
      aboveSections: firstSection !== undefined && box.bottom <= firstSection.top,
    };
  });
  expect(facts.complete).toBe(true);
  expect(facts.src).toBe("data:image/svg+xml;charset=");
  expect(facts.natural[0]).toBeGreaterThan(50);
  expect(facts.natural[1]).toBeGreaterThan(50);
  expect(facts.shown[0]).toBeGreaterThan(50);
  expect(facts.shown[0]).toBeLessThanOrEqual(viewportWidth);
  // Boxes, arrows and labels drawn in dark ink, not an empty or broken image.
  expect(facts.inked).toBeGreaterThan(200);
  expect(facts.alt).toContain("Diagram of Run log");
  expect(facts.insideCard).toBe(true);
  expect(facts.aboveSections).toBe(true);
  expect(await page.locator("#spec-diagram-status").textContent()).toBe("");
}

describe("step 2: Spec and approval (ticket 1.9)", () => {
  it("WHEN the spec is shown THEN the diagram is drawn as a picture at laptop and phone widths, above the sections (criterion 3)", async () => {
    const api = fakeSpecApi();
    const calls = await mockApi(api.handlers);
    for (const viewport of [LAPTOP, PHONE]) {
      await page.setViewportSize(viewport);
      await page.goto(origin);
      await expect.poll(() => screen("spec").isVisible()).toBe(true);
      await expect.poll(() => page.locator("#spec-title").textContent()).toBe("Run log");
      expect(await page.locator("#spec-version").textContent()).toBe("Version 1");
      expect(await page.locator("#spec-sections h4").allTextContents()).toEqual(["What it does", "Screens", "Data it keeps"]);
      expect(await page.locator("#spec-sections p").first().textContent()).toBe("A log of your runs that shows this week's total distance.");
      expect(await page.locator("#spec-sections li").allTextContents()).toEqual([
        "Home: this week's total and the list of runs.",
        "Add a run: date, distance and time.",
        "Runs: date, distance in km and time.",
      ]);
      await expectDiagramPicture(viewport.width);
      // Step 2 shows its own conversation only, and the behind-the-scenes box.
      expect(await specBubbles()).toEqual(["Please write my spec.", "Here is your spec."]);
      expect(await page.locator("#spec-behind-flow li").allTextContents()).toEqual(["Your message", "Safety check", "Claude on Bedrock", "Answer or new version"]);
      expect(await page.getByRole("button", { name: "Approve spec" }).isEnabled()).toBe(true);
      await expectNoSideScroll(viewport.width);
    }
    // diagram.js is fetched from the site itself, under its Content-Security-Policy (afterEach: no violation).
    expect(calls.filter((c) => c.path === "/api/conversation/spec").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("WHEN Write my spec is pressed THEN step 2 shows the AI writing, then the spec with its diagram", async () => {
    const api = fakeSpecApi("clarify", []);
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-offer").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Write my spec" }).click();
    await expect.poll(() => screen("spec").isVisible()).toBe(true);
    await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
    expect(await page.locator("#spec-typing-text").textContent()).toBe("The AI is writing your spec…");
    expect(await page.locator("#spec-doc").isVisible()).toBe(false);
    expect(await page.locator("#spec-missing").isVisible()).toBe(false);
    expect(await page.locator("#spec-approve").isVisible()).toBe(false);
    expect(await page.locator("#spec-behind-flow").getAttribute("data-stage")).toBe("working");
    api.answer("Here is your spec.", SPEC_1);
    await expect.poll(() => page.locator("#spec-doc").isVisible(), { timeout: 6000 }).toBe(true);
    expect(await page.locator("#spec-typing").isVisible()).toBe(false);
    await expectDiagramPicture(PHONE.width);
    expect(await specBubbles()).toEqual(["Please write my spec.", "Here is your spec."]);
    await expectNoSideScroll();
  }, 30_000);

  it("WHEN the first spec could not be written THEN step 2 offers Write my spec again", async () => {
    const api = fakeSpecApi("spec", []);
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-missing").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Write my spec" }).click();
    await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
    expect(await page.locator("#spec-missing").isVisible()).toBe(false);
  }, 30_000);

  it("WHEN the participant asks a question THEN the answer shows and the spec stays; WHEN they ask for a change THEN the new version is shown (criterion 2)", async () => {
    const api = fakeSpecApi();
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 1");

    await page.getByRole("textbox", { name: "Ask a question or ask for a change" }).fill("What does the cylinder mean?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
    expect(await page.locator("#spec-typing-text").textContent()).toBe("The AI is writing…");
    expect(await page.getByRole("button", { name: "Approve spec" }).isDisabled()).toBe(true);
    api.answer("It is where the app keeps your runs.");
    await expect.poll(specBubbles, { timeout: 6000 }).toContain("It is where the app keeps your runs.");
    expect(await page.locator("#spec-version").textContent()).toBe("Version 1");

    await page.getByRole("textbox", { name: "Ask a question or ask for a change" }).fill("Please add a screen with my longest run.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
    api.answer("I added a Longest run screen.", SPEC_2);
    await expect.poll(() => page.locator("#spec-version").textContent(), { timeout: 6000 }).toBe("Version 2");
    expect(await page.locator("#spec-sections li").allTextContents()).toContain("Longest run: your longest run so far.");
    await expectDiagramPicture(PHONE.width);
    expect(await page.getByRole("button", { name: "Approve spec" }).isEnabled()).toBe(true);
    await expectNoSideScroll();
  }, 30_000);

  it("WHEN a change saves a new version THEN the page scrolls the new spec into view, and the reply links back to it (live check fix)", async () => {
    const api = fakeSpecApi();
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 1");
    const specInView = () =>
      page.locator("#spec-doc").evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.top >= -1 && box.top < window.innerHeight;
      });

    // A few questions first, so the conversation pushes the spec far above the form on a phone.
    for (const question of ["What does the cylinder mean?", "What is a screen?", "Why four screens at most?"]) {
      await page.getByRole("textbox", { name: "Ask a question or ask for a change" }).fill(question);
      await page.getByRole("button", { name: "Send" }).click();
      await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
      api.answer(`An answer to "${question}" that is long enough to take a few lines on a phone, so the page grows.`);
      await expect.poll(() => page.locator("#spec-typing").isVisible(), { timeout: 6000 }).toBe(false);
    }
    // A question leaves the reader where they are: no jump to the spec. Only the reply that wrote version 1 links to it.
    expect(await specInView()).toBe(false);
    expect(await page.locator("#spec-chat .bubble button").allTextContents()).toEqual(["See version 1 of the spec"]);

    await page.getByRole("textbox", { name: "Ask a question or ask for a change" }).fill("Please add a screen with my longest run.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
    expect(await specInView()).toBe(false);
    api.answer("I added a Longest run screen. Here is the updated spec!", SPEC_2);
    await expect.poll(() => page.locator("#spec-version").textContent(), { timeout: 6000 }).toBe("Version 2");
    await expect.poll(specInView).toBe(true);

    // The reply that saved the version offers a way back to it.
    const back = page.locator("#spec-chat .bubble").last().getByRole("button", { name: "See version 2 of the spec" });
    expect(await back.isVisible()).toBe(true);
    // Older versions are not shown on the page: the reply that wrote version 1 no longer links.
    expect(await page.locator("#spec-chat .bubble button").allTextContents()).toEqual(["See version 2 of the spec"]);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(specInView).toBe(false);
    await back.click();
    await expect.poll(specInView).toBe(true);
    await expectNoSideScroll();
  }, 40_000);

  it("WHEN the participant presses Approve spec THEN the version is approved, the page says the build comes next, and changes are closed (criterion 4)", async () => {
    const api = fakeSpecApi("spec", [SPEC_1, SPEC_2]);
    const calls = await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 2");
    await page.getByRole("button", { name: "Approve spec" }).click();
    await expect.poll(() => page.locator("#spec-approved").isVisible()).toBe(true);
    expect(calls.find((c) => c.path === "/api/conversation/spec/approve")).toMatchObject({ method: "POST", contentType: "application/json", body: { version: 2 } });
    expect(await page.locator("#spec-approved").textContent()).toContain("Next comes the build");
    // Ticket 2.7: the readiness check runs, and the page says so.
    expect(await page.locator("#spec-approved").textContent()).toContain("checks that your spec is ready to build");
    expect(await page.locator("#spec-approved").textContent()).not.toContain("facilitator");
    await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
    expect(await page.locator("#spec-typing-text").textContent()).toBe("The AI is checking your spec…");
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 2 (approved)");
    expect(await page.locator("#spec-chat-form").isVisible()).toBe(false);
    expect(await page.locator("#spec-approve").isVisible()).toBe(false);
    expect(await page.locator("#spec-doc").isVisible()).toBe(true);
    await expectNoSideScroll();

    // A reload (step approved, the check still running) shows the same.
    await page.reload();
    await expect.poll(() => page.locator("#spec-approved").isVisible()).toBe(true);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 2 (approved)");
    expect(await page.locator("#spec-chat-form").isVisible()).toBe(false);
    expect(await page.locator("#spec-approve").isVisible()).toBe(false);

    // The check passes: the page picks it up by its polling and moves to step 3, which follows the build (ticket 2.10;
    // until then step 2 said "the build is starting").
    api.check("Your spec is ready to build. The build is starting now: the AI turns your spec into your app.", true);
    await expect.poll(() => screen("build").isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await screen("spec").isVisible()).toBe(false);
    expect(await page.locator("#build-heading").textContent()).toBe("Step 3: Build");
    await expect.poll(() => calls.some((c) => c.method === "GET" && c.path === "/api/build")).toBe(true);
    expect(await page.locator("#build-now").textContent()).toBe(BUILD_TEXTS.now.queued);
    await expectNoSideScroll();
  }, 40_000);

  it("WHEN the readiness check fails THEN its reasons show in the conversation as text and Approve spec is offered again (ticket 2.7)", async () => {
    const api = fakeSpecApi("spec", [SPEC_1]);
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 1");
    await page.getByRole("button", { name: "Approve spec" }).click();
    await expect.poll(() => page.locator("#spec-typing").isVisible()).toBe(true);
    const reasons = "Your spec is not ready to build yet:\n- Your spec needs a <b>login</b> for each runner.\nAsk me to change the spec (or answer the open question), then press Approve spec again.";
    api.check(reasons, false);
    await expect.poll(() => page.locator("#spec-approve").isVisible(), { timeout: 10_000 }).toBe(true);
    // Shown as text: the markup-looking part is not markup.
    expect(await page.locator("#spec-chat b").count()).toBe(0);
    await expect.poll(async () => (await specBubbles()).some((b) => b.includes("needs a <b>login</b> for each runner"))).toBe(true);
    expect(await page.locator("#spec-approved").isVisible()).toBe(false);
    expect(await page.locator("#spec-chat-form").isVisible()).toBe(true);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 1");
    expect(await page.locator("#approve-spec-button").isDisabled()).toBe(false);
  }, 40_000);

  it("WHEN a diagram cannot be drawn THEN the page says so and keeps it readable as text", async () => {
    const broken = SPEC_1.replace("home[Home] -->|add a run| add[Add a run]", "home[Home (main)] -->|add a run| add[Add a run");
    const api = fakeSpecApi("spec", [broken]);
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-diagram-status").textContent(), { timeout: 15_000 }).toBe(
      "The diagram could not be drawn. Ask the AI to fix it, or read it as text below.",
    );
    expect(await page.locator("#spec-diagram-img").isVisible()).toBe(false);
    expect(await page.locator("#spec-diagram-text").textContent()).toContain("home[Home (main)]");
    expect(await page.locator("#spec-sections h4").allTextContents()).toEqual(["What it does", "Screens", "Data it keeps"]);
    await expectNoSideScroll();
  }, 30_000);

  it("shows the API's reason when an approval is refused, and shows the newer version", async () => {
    const api = fakeSpecApi();
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 1");
    // A change landed from another tab meanwhile.
    api.spec.versions.push(SPEC_2);
    await page.getByRole("button", { name: "Approve spec" }).click();
    await expect.poll(() => page.locator("#message-spec").textContent()).toBe("There is a newer version of your spec. Please have a look at it, then approve it.");
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 2");
    expect(await page.locator("#spec-approved").isVisible()).toBe(false);
  }, 30_000);

  it("draws two diagrams at once without a Content-Security-Policy violation", async () => {
    const api = fakeSpecApi();
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => page.locator("#spec-version").textContent()).toBe("Version 1");
    await expect.poll(() => page.evaluate(() => "ssdDiagram" in window)).toBe(true);
    const source = "flowchart LR\n  a[Open the app] --> b[Add a run] --> c[See the list]";
    // Overlapping draws used to restore the DOM methods while the other was still drawing.
    const drawn = await page.evaluate(async (diagram) => {
      const api = (window as unknown as { ssdDiagram: { render(source: string): Promise<unknown> } }).ssdDiagram;
      const pictures = await Promise.all([api.render(diagram), api.render(diagram), api.render(diagram)]);
      return pictures.length;
    }, source);
    expect(drawn).toBe(3);
  }, 30_000);
});

// Ticket 2.10: step 3 (Build) and the start of step 4 (Live) against a mocked GET /api/build.
const SHA_1 = "1111111111111111111111111111111111111111";
const SHA_2 = "2222222222222222222222222222222222222222";
const REPOSITORY_URL = "https://github.com/ssd-workshop-apps/ssd-ada-l";
const APP_URL = "https://workshop.rankly.games/apps/ada-l/";
type FeedEvent = Record<string, string>;
const stepEvent = (step: string): FeedEvent => ({ kind: "step", step, at: "2026-11-25T10:00:00.000Z" });
const fileEvent = (path: string): FeedEvent => ({ kind: "file", path, at: "2026-11-25T10:00:01.000Z" });

/** A participant at step building and their build, which the test moves on; every GET /api/build is counted. */
function fakeBuildApi(status = "building", feed: FeedEvent[] = [stepEvent("preparing"), stepEvent("writing"), fileEvent("index.html")]) {
  const state = { status, feed: [...feed], polls: 0, answer: undefined as Reply | undefined, failureReasons: undefined as string[] | undefined, ahead: undefined as number | undefined, paused: false, pausedUnknown: false };
  const handlers: Record<string, Handler> = {
    "GET /api/me": () => ({ status: 200, body: { ...ME, step: "building" } }),
    "GET /api/build": () => {
      state.polls++;
      if (state.answer !== undefined) return state.answer;
      return {
        status: 200,
        body: {
          buildId: "b-1",
          status: state.status,
          feed: state.feed,
          repositoryUrl: REPOSITORY_URL,
          appUrl: APP_URL,
          ...(state.failureReasons === undefined ? {} : { failureReasons: state.failureReasons }),
          ...(state.ahead === undefined ? {} : { ahead: state.ahead }),
          ...(state.pausedUnknown ? { pausedUnknown: true } : state.paused ? { paused: true } : {}),
        },
      };
    },
  };
  return { state, handlers };
}

/** Like pollAfter, for the build: moves page time by `ms`, which must fire one GET /api/build, and lets the page handle it. */
async function buildPollAfter(ms: number): Promise<void> {
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/build"));
  await page.clock.runFor(ms);
  await answered;
  await settle();
}

/**
 * Opens the page with its clock paused from the start, so the first poll (sent at once) and every later one
 * happen only when the test moves time.
 */
async function openPaused(): Promise<void> {
  await page.clock.install({ time: new Date("2026-11-25T10:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-11-25T10:00:01.000Z"));
  await page.goto(origin);
  await expect.poll(() => screen("build").isVisible()).toBe(true);
}

const stageStatesOnPage = () =>
  page.locator("#build-stages li").evaluateAll((items) => items.map((item) => `${item.textContent ?? ""}:${(item as HTMLElement).dataset["state"] ?? ""}`));
const feedOnPage = () => page.locator("#build-feed li").allTextContents();

describe("step 3: Build (ticket 2.10)", () => {
  it("WHEN a build waits for a slot THEN step 3 shows how many builds are ahead of it (ticket 3.4, criterion 4)", async () => {
    const api = fakeBuildApi("queued", []);
    api.state.ahead = 3;
    await mockApi(api.handlers);
    await openPaused();
    await expect.poll(() => api.state.polls).toBe(1);
    await settle();
    await expect.poll(() => page.locator("#build-now").textContent()).toBe("Your build is in the queue: 3 builds ahead of you.");
    await expectNoSideScroll();
    api.state.ahead = 1;
    await buildPollAfter(2000);
    await expect.poll(() => page.locator("#build-now").textContent()).toBe("Your build is in the queue: 1 build ahead of you.");
    api.state.ahead = 0;
    await buildPollAfter(2000);
    await expect.poll(() => page.locator("#build-now").textContent()).toBe("Your build is next in the queue.");
    api.state.ahead = undefined;
    api.state.status = "building";
    api.state.feed.push(stepEvent("preparing"));
    await buildPollAfter(2000);
    await expect.poll(() => page.locator("#build-now").textContent()).not.toContain("queue");
    await expectNoSideScroll();
  }, 30_000);

  it("ticket 3.5 criterion 4: WHEN Stop is on THEN step 3 shows the paused line over the queued build; WHEN Resume THEN it goes, at 375 px", async () => {
    const api = fakeBuildApi("queued", []);
    api.state.ahead = 0;
    api.state.paused = true;
    await mockApi(api.handlers);
    await openPaused();
    await expect.poll(() => api.state.polls).toBe(1);
    await settle();
    const banner = page.locator("#workshop-paused");
    await expect.poll(() => banner.isVisible()).toBe(true);
    expect(await banner.textContent()).toBe(PHASE_3_TEXTS.workshopPaused);
    await expectNoSideScroll();
    await buildPollAfter(2000);
    expect(await banner.isVisible()).toBe(true);
    // A build read whose settings read failed (pausedUnknown) keeps the line as shown.
    api.state.pausedUnknown = true;
    await buildPollAfter(2000);
    await buildPollAfter(2000);
    expect(await banner.isVisible()).toBe(true);
    api.state.pausedUnknown = false;
    api.state.paused = false;
    await buildPollAfter(2000);
    await expect.poll(() => banner.isVisible()).toBe(false);
    expect(await page.locator("#build-now").textContent()).toBe("Your build is next in the queue.");
  }, 30_000);

  it("WHEN a build is running THEN the page shows its stages, files and commits, and polls every 2 seconds (criteria 1, 4 and 5)", async () => {
    const api = fakeBuildApi();
    await mockApi(api.handlers);
    await openPaused();
    await expect.poll(() => api.state.polls).toBe(1);
    await settle();
    expect(await page.locator("#build-heading").textContent()).toBe("Step 3: Build");
    expect(await page.locator("#build-nickname").textContent()).toBe("ada-l");
    await expect.poll(stageStatesOnPage).toEqual(["Preparing:done", "Writing:current", "Checking:todo", "Saving:todo", "Publishing:todo", "Live:todo"]);
    expect(await page.locator("#build-stages li[aria-current=step]").textContent()).toBe("Writing");
    expect(await page.locator("#build-now").textContent()).toBe(BUILD_TEXTS.now.writing);
    expect(await feedOnPage()).toEqual(["Wroteindex.html"]);
    // Behind the scenes: the brief's flow, diagram first, the coding agent working now.
    expect(await page.locator("#build-behind-flow li").allTextContents()).toEqual([
      "Readiness check",
      "Build launcher",
      "Builder container",
      "Claude coding agent",
      "GitHub repository",
      "Deployer",
      "Your app online",
    ]);
    expect(await page.locator("#build-behind-flow li[data-current=true]").textContent()).toBe("Claude coding agent");
    await expectNoSideScroll();

    // No poll before 2 seconds, then one every 2 seconds, each showing what arrived meanwhile.
    await page.clock.runFor(1900);
    await settle();
    expect(api.state.polls).toBe(1);
    const longName = `${"very-long-folder-name-without-spaces/".repeat(6)}app.js`;
    api.state.feed.push(fileEvent("<img src=x>.js"), fileEvent(longName), { kind: "fetch", host: "en.wikipedia.org", at: "x" });
    api.state.feed.push(stepEvent("committing"), { kind: "commit", sha: SHA_1, message: "Add the home screen", at: "x" });
    await buildPollAfter(100);
    expect(api.state.polls).toBe(2);
    await expect.poll(feedOnPage).toEqual([
      "Wroteindex.html",
      "Wrote<img src=x>.js",
      `Wrote${longName}`,
      "Readen.wikipedia.org",
      "SavedAdd the home screen1111111",
    ]);
    // Names are text, never markup.
    expect(await page.locator("#build-feed img").count()).toBe(0);
    // Criterion 5: the commit links to it on GitHub.
    const link = page.locator("#build-feed li[data-kind=commit] a");
    expect(await link.getAttribute("href")).toBe(`https://github.com/ssd-workshop-apps/ssd-ada-l/commit/${SHA_1}`);
    expect(await page.locator("#build-stages li[aria-current=step]").textContent()).toBe("Saving");
    expect(await page.locator("#build-behind-flow li[data-current=true]").textContent()).toBe("GitHub repository");
    // Criterion 4: 375 px, a long file name included, and nothing scrolls sideways.
    await expectNoSideScroll();

    api.state.feed.push({ kind: "commit", sha: SHA_2, message: "Add the weekly total", at: "x" });
    await buildPollAfter(2000);
    expect(api.state.polls).toBe(3);
    await expect.poll(() => page.locator("#build-feed li[data-kind=commit] a").count()).toBe(2);
    expect(await page.locator("#build-feed li[data-kind=commit] a").nth(1).getAttribute("href")).toBe(`${REPOSITORY_URL}/commit/${SHA_2}`);
    await page.clock.runFor(1000);
    await settle();
    expect(api.state.polls).toBe(3);
  }, 30_000);

  it("WHEN the build is live THEN polling stops and the page moves to step 4 with the app's address (criterion 2)", async () => {
    const api = fakeBuildApi("building", [stepEvent("preparing"), stepEvent("writing"), fileEvent("index.html"), stepEvent("checking"), stepEvent("committing"), stepEvent("deploying")]);
    await mockApi(api.handlers);
    await openPaused();
    await expect.poll(() => api.state.polls).toBe(1);
    await settle();
    await expect.poll(() => page.locator("#build-stages li[aria-current=step]").textContent()).toBe("Publishing");
    api.state.status = "deploying";
    await buildPollAfter(2000);
    expect(await screen("build").isVisible()).toBe(true);
    expect(await page.locator("#build-behind-flow li[data-current=true]").textContent()).toBe("Deployer");

    api.state.status = "live";
    await buildPollAfter(2000);
    await expect.poll(() => screen("live").isVisible()).toBe(true);
    expect(await screen("build").isVisible()).toBe(false);
    expect(await page.locator("#live-heading").textContent()).toBe("Step 4: Live");
    expect(await screen("live").textContent()).toContain("Your app is live");
    const link = page.getByRole("link", { name: APP_URL });
    expect(await link.getAttribute("href")).toBe(APP_URL);
    await expectNoSideScroll();
    // No more polls.
    const polls = api.state.polls;
    await page.clock.runFor(20_000);
    await settle();
    expect(api.state.polls).toBe(polls);
  }, 30_000);

  it("WHEN the page is reloaded mid-build THEN the feed so far is shown again (criterion 3)", async () => {
    const api = fakeBuildApi("building", [stepEvent("preparing"), stepEvent("writing"), fileEvent("index.html"), fileEvent("app.js"), { kind: "fetch", host: "openlibrary.org", at: "x" }]);
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(feedOnPage).toEqual(["Wroteindex.html", "Wroteapp.js", "Readopenlibrary.org"]);
    api.state.feed.push(fileEvent("style.css"));
    await page.reload();
    await expect.poll(() => screen("build").isVisible()).toBe(true);
    await expect.poll(feedOnPage).toEqual(["Wroteindex.html", "Wroteapp.js", "Readopenlibrary.org", "Wrotestyle.css"]);
    expect(await page.locator("#build-stages li[aria-current=step]").textContent()).toBe("Writing");
    await expectNoSideScroll();
  }, 30_000);

  it("WHEN the build failed THEN the page says so, shows the reasons as text and stops polling", async () => {
    const api = fakeBuildApi("failed", [stepEvent("preparing"), stepEvent("writing"), fileEvent("index.html"), stepEvent("checking")]);
    api.state.failureReasons = ["index.html, line 3: <b>an outside address</b>"];
    await mockApi(api.handlers);
    await openPaused();
    await expect.poll(() => page.locator("#build-now").textContent()).toBe("Something went wrong with your build. Your facilitator can restart it.");
    expect(await page.locator("#build-reasons li").allTextContents()).toEqual(["index.html, line 3: <b>an outside address</b>"]);
    expect(await page.locator("#build-reasons b").count()).toBe(0);
    expect(await page.locator("#build-stages li[aria-current=step]").getAttribute("data-failed")).toBe("true");
    expect(await page.locator("#build-behind-flow li[data-current=true]").count()).toBe(0);
    await expectNoSideScroll();
    const polls = api.state.polls;
    await page.clock.runFor(20_000);
    await settle();
    expect(api.state.polls).toBe(polls);
  }, 30_000);

  it("WHEN the build is not there yet or the API fails THEN the page keeps asking every 2 seconds", async () => {
    const api = fakeBuildApi("queued", []);
    api.state.answer = { status: 404, body: { message: "Not found." } };
    await mockApi(api.handlers);
    await openPaused();
    await expect.poll(() => api.state.polls).toBe(1);
    await settle();
    expect(await page.locator("#build-now").textContent()).toBe(BUILD_TEXTS.now.queued);
    expect(await page.locator("#build-feed-empty").isVisible()).toBe(true);
    api.state.answer = { status: 500, body: { message: "Something went wrong." } };
    await buildPollAfter(2000);
    expect(await page.locator("#message-build").textContent()).toBe(MESSAGES.failed);
    api.state.answer = undefined;
    await buildPollAfter(2000);
    expect(api.state.polls).toBe(3);
    await expect.poll(() => page.locator("#message-build").textContent()).toBe("");
    expect(await page.locator("#build-now").textContent()).toBe(BUILD_TEXTS.now.queued);
    expect(await page.locator("#build-behind-flow li[data-current=true]").textContent()).toBe("Build launcher");
    await buildPollAfter(2000);
    expect(api.state.polls).toBe(4);
  }, 30_000);
});

// Ticket 2.11: step 4 (Live) complete: the address, its QR code (decoded from the rendered pixels), the repository.
const LIVE_FEED = [stepEvent("preparing"), stepEvent("writing"), fileEvent("index.html"), stepEvent("checking"), stepEvent("committing"), stepEvent("deploying")];

/** Takes a screenshot of the QR code as it is on the screen and decodes its pixels with jsQR. */
async function decodeQrOnScreen(): Promise<string | undefined> {
  const png = await page.locator("#live-qr-code svg").screenshot();
  // The browser turns the PNG back into pixels (no file, no network); jsQR reads them here.
  const image = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, data: Array.from(data) };
  }, png.toString("base64"));
  return jsQR(Uint8ClampedArray.from(image.data), image.width, image.height)?.data;
}

/** Step 4 with everything a live build shows; the QR code fits the phone screen, square, and nothing scrolls sideways. */
async function expectLiveScreen(): Promise<void> {
  await expect.poll(() => screen("live").isVisible()).toBe(true);
  expect(await screen("build").isVisible()).toBe(false);
  expect(await page.locator("#live-heading").textContent()).toBe("Step 4: Live");
  expect(await screen("live").textContent()).toContain("Your app is live");
  const address = page.getByRole("link", { name: APP_URL });
  expect(await address.getAttribute("href")).toBe(APP_URL);
  expect(await address.getAttribute("target")).toBe("_blank");
  expect(await address.getAttribute("rel")).toBe("noopener noreferrer");
  const repository = page.getByRole("link", { name: REPOSITORY_URL });
  expect(await repository.getAttribute("href")).toBe(REPOSITORY_URL);
  expect(await repository.getAttribute("target")).toBe("_blank");
  expect(await repository.getAttribute("rel")).toBe("noopener noreferrer");
  const qr = page.getByRole("img", { name: `QR code for ${APP_URL}` });
  expect(await qr.isVisible()).toBe(true);
  expect(await page.locator("#live-next").textContent()).toBe("Next: you will be able to ask for changes to your app, and the AI builds a new version.");
  // Behind the scenes leads with its diagram, the text under it.
  expect(await page.locator("#live-behind-flow li").allTextContents()).toEqual([
    "GitHub repository",
    "Deployer: checks, then publishes",
    "Amazon S3 and CloudFront",
    "Your address",
  ]);
  expect(await page.locator("#live-behind > :nth-child(2)").getAttribute("id")).toBe("live-behind-flow");
  expect(await page.locator("#live-behind > p.help").isVisible()).toBe(true);
  // 375 px: the QR code is a square inside the screen, big enough to scan.
  const box = await qr.boundingBox();
  if (box === null) throw new Error("the QR code has no box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  expect(Math.abs(box.width - box.height)).toBeLessThan(1);
  expect(box.width).toBeGreaterThanOrEqual(150);
  await expectNoSideScroll();
}

describe("step 4: Live (ticket 2.11)", () => {
  it("WHEN the build turns live THEN step 4 shows the address, the repository link and a QR code that fits 375 px (criteria 1 and 3)", async () => {
    const api = fakeBuildApi("building", LIVE_FEED);
    await mockApi(api.handlers);
    await openPaused();
    await expect.poll(() => api.state.polls).toBe(1);
    await settle();
    api.state.status = "live";
    await buildPollAfter(2000);
    await expectLiveScreen();
    // No more polls once live.
    const polls = api.state.polls;
    await page.clock.runFor(20_000);
    await settle();
    expect(api.state.polls).toBe(polls);
  }, 30_000);

  it("WHEN the QR code is decoded THEN it gives exactly the app's address (criterion 2)", async () => {
    const api = fakeBuildApi("live", LIVE_FEED);
    await mockApi(api.handlers);
    await page.goto(origin);
    await expectLiveScreen();
    expect(await decodeQrOnScreen()).toBe(APP_URL);
  }, 30_000);

  it("WHEN a participant reloads at step 4 THEN they land on step 4 again (criterion 4)", async () => {
    const api = fakeBuildApi("live", LIVE_FEED);
    await mockApi(api.handlers);
    await page.goto(origin);
    await expectLiveScreen();
    await page.reload();
    await expectLiveScreen();
    expect(await decodeQrOnScreen()).toBe(APP_URL);
  }, 30_000);

  it("WHEN the answer has no address the page trusts THEN step 4 shows neither a link nor a QR code for it", async () => {
    const api = fakeBuildApi("live", LIVE_FEED);
    api.state.answer = {
      status: 200,
      body: { buildId: "b-1", status: "live", feed: [], repositoryUrl: "https://evil.example/ssd-ada-l", appUrl: "javascript:alert(1)//workshop.rankly.games/apps/ada-l/" },
    };
    await mockApi(api.handlers);
    await page.goto(origin);
    await expect.poll(() => screen("live").isVisible()).toBe(true);
    expect(await screen("live").textContent()).toContain("Your app is live");
    expect(await page.locator("#live-address").isHidden()).toBe(true);
    expect(await page.locator("#live-qr").isHidden()).toBe(true);
    expect(await page.locator("#live-qr-code svg").count()).toBe(0);
    expect(await page.locator("#live-repository").isHidden()).toBe(true);
    expect(await page.locator("#screen-live a[href]").count()).toBe(0);
    await expectNoSideScroll();
  }, 30_000);
});

/** Ticket 3.5: `GET /api/status` as the API answers it, counted; `paused` is the admin's switch. */
function fakeStatus() {
  const state = { paused: false, polls: 0 };
  const handler: Handler = () => {
    state.polls++;
    return { status: 200, body: state.paused ? { paused: true } : {} };
  };
  return { state, handler };
}

/** Like pollAfter, for the status poll: moves page time by `ms`, which must fire one GET /api/status, and lets the page handle it. */
async function statusPollAfter(ms: number): Promise<void> {
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/status"));
  await page.clock.runFor(ms);
  await answered;
  await settle();
}

/** Opens the page with its clock paused from the start (any screen), so only the test moves page time. */
async function openWithPausedClock(): Promise<void> {
  await page.clock.install({ time: new Date("2026-11-25T10:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-11-25T10:00:01.000Z"));
  await page.goto(origin);
}

/** Makes the page believe its tab was hidden or shown again (Chromium keeps a test page visible). */
async function setTabHidden(hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

describe("ticket 3.5: the paused line on idle signed-in screens (status poll every 30 s)", () => {
  it("WHEN Stop is pressed while step 4 sits idle THEN the paused line shows within 30 s; WHEN Resume THEN it goes within 30 s, at 375 px", async () => {
    const api = fakeBuildApi("live", LIVE_FEED);
    const status = fakeStatus();
    api.handlers["GET /api/status"] = status.handler;
    await mockApi(api.handlers);
    await openWithPausedClock();
    await expectLiveScreen();
    await settle();
    const builds = api.state.polls;
    const banner = page.locator("#workshop-paused");
    expect(await banner.isVisible()).toBe(false);

    // Stop: nothing is asked before 30 s, then one status read shows the line.
    status.state.paused = true;
    await page.clock.runFor(29_000);
    await settle();
    expect(status.state.polls).toBe(0);
    await statusPollAfter(1000);
    expect(status.state.polls).toBe(1);
    await expect.poll(() => banner.isVisible()).toBe(true);
    expect(await banner.textContent()).toBe(PHASE_3_TEXTS.workshopPaused);
    expect(await banner.getAttribute("role")).toBe("status");
    await expectNoSideScroll();
    await statusPollAfter(30_000);
    expect(await banner.isVisible()).toBe(true);

    // Resume: the next status read clears it; step 4 itself asks nothing else.
    status.state.paused = false;
    await statusPollAfter(30_000);
    expect(status.state.polls).toBe(3);
    await expect.poll(() => banner.isVisible()).toBe(false);
    expect(api.state.polls).toBe(builds);
    await expectLiveScreen();
    await expectNoSideScroll();
  }, 30_000);

  it("WHEN Stop is pressed while the nickname screen is open THEN the paused line shows within 30 s and goes on Resume; a hidden tab and signing out stop the poll, at 375 px", async () => {
    const status = fakeStatus();
    const calls = await mockApi({
      "GET /api/me": () => ({ status: 200, body: { id: "p-1", nickname: null, role: "participant", group: "g1", step: "nickname" } }),
      "GET /api/status": status.handler,
      "POST /api/sign-out": () => ({ status: 200, body: { message: "You're signed out." } }),
    });
    await openWithPausedClock();
    await expect.poll(() => screen("nickname").isVisible()).toBe(true);
    await settle();
    const banner = page.locator("#workshop-paused");
    expect(await banner.isVisible()).toBe(false);

    status.state.paused = true;
    await statusPollAfter(30_000);
    await expect.poll(() => banner.isVisible()).toBe(true);
    expect(await banner.textContent()).toBe(PHASE_3_TEXTS.workshopPaused);
    await expectNoSideScroll();
    status.state.paused = false;
    await statusPollAfter(30_000);
    await expect.poll(() => banner.isVisible()).toBe(false);
    expect(status.state.polls).toBe(2);

    // A hidden tab asks nothing; shown again, it asks within 30 s.
    await setTabHidden(true);
    await page.clock.runFor(90_000);
    await settle();
    expect(status.state.polls).toBe(2);
    status.state.paused = true;
    await setTabHidden(false);
    await statusPollAfter(30_000);
    expect(status.state.polls).toBe(3);
    await expect.poll(() => banner.isVisible()).toBe(true);

    // Signing out hides the line and stops the poll.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => screen("email").isVisible()).toBe(true);
    expect(await banner.isVisible()).toBe(false);
    const after = calls.length;
    await page.clock.runFor(90_000);
    await settle();
    expect(calls.length).toBe(after);
    expect(status.state.polls).toBe(3);
  }, 30_000);
});

describe("built site", () => {
  it("holds only the page, its stylesheet, its two scripts and the 404 page, and the page has no inline script, style or handler", () => {
    expect(readdirSync(dir).sort()).toEqual(["404.html", "app.js", "diagram.js", "index.html", "style.css"]);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain('<script src="app.js" defer></script>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it("holds a plain 404 page (ticket 2.5 criterion 5): no script, no stylesheet, no inline style or handler, no email address", () => {
    const html = readFileSync(join(dir, "404.html"), "utf8");
    expect(html).toContain("<title>Page not found - SSD Workshop</title>");
    expect(html).toContain("This page does not exist.");
    expect(html).not.toMatch(/<script|<style|<link rel="stylesheet"|\son[a-z]+=|\sstyle=/i);
    expect(html).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]+/i);
  });
});
