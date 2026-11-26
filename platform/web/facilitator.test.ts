// Ticket 3.11: the facilitator dashboard at /facilitator/ in a real browser (Playwright's Chromium), against a mocked
// facilitator API (ticket 3.10's routes and answers). The built site (buildWeb, as the site stack publishes it) is served
// by a tiny local server that, like the distribution's `ssd-workshop-site-index` function, serves a folder's
// index.html, and sends the pages' real Content-Security-Policy, so any inline script or style fails these tests too.
// Every test runs at phone width (375 px); one also at laptop width (1280 px).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PAGES_CONTENT_SECURITY_POLICY } from "../../infra/lib/config.js";
import { DASHBOARD_TEXTS, PHASE_3_TEXTS, otherGroupFlagsText } from "../api/workshop/texts.js";
import { buildWeb } from "./build.js";

const PHONE = { width: 375, height: 667 };
const LAPTOP = { width: 1280, height: 800 };
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
/** Where the ticket's screenshots go when asked (`DASHBOARD_SCREENSHOTS=<folder> npx vitest run ...`); CI takes none. */
const SHOTS = process.env["DASHBOARD_SCREENSHOTS"];
const LIST = "/api/facilitator/participants";

let dir: string;
let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let violations: string[];

beforeAll(async () => {
  dir = buildWeb(mkdtempSync(join(tmpdir(), "ssd-workshop-dashboard-")));
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    // As the distribution: `/` is index.html (default root object), a folder its index.html (site-index function).
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

async function openContext(viewport = PHONE, deviceScaleFactor = 1): Promise<void> {
  context = await browser.newContext({ viewport, deviceScaleFactor });
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  violations = [];
  page.on("console", (message) => {
    // Chromium logs every non-2xx API answer as an error; those are expected here.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of")) violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(error.message));
}

beforeEach(async () => {
  await openContext();
});

afterEach(async () => {
  await context.close();
  // No Content-Security-Policy violation and no script error on any page.
  expect(violations).toEqual([]);
});

interface Call {
  method: string;
  path: string;
  search: string;
  contentType: string | undefined;
}
type Reply = { status: number; body?: unknown };
type Handler = (call: Call) => Reply;

/** Mocks every /api/ request with `handlers` (by "METHOD /path") and records the calls. */
async function mockApi(handlers: Record<string, Handler>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call: Call = { method: request.method(), path: url.pathname, search: url.search, contentType: request.headers()["content-type"] };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    const reply = handler ? handler(call) : { status: 404, body: { message: "Not found." } };
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body ?? {}) });
  });
  return calls;
}

interface TestRow {
  nickname: string | null;
  group: string | null;
  step: string | null;
  stepSince: string | null;
  minutesInStep: number | null;
  build: { status: string; kind: "first" | "change"; changeNumber?: number; stuck: boolean; minutesBuilding?: number; retryRequested: boolean } | null;
  spentUsd: number;
  budgetUsd: number;
  extraBudgetUsd: number;
  changeRequestsUsed: number;
  changeRequestsPerPerson: number;
  paused: boolean;
  flags: { text: string; reason: string }[];
}

const participant = (nickname: string | null, group: string, over: Partial<TestRow> = {}): TestRow => ({
  nickname,
  group,
  step: "clarify",
  stepSince: "2026-11-26T09:50:00.000Z",
  minutesInStep: 10,
  build: null,
  spentUsd: 0.42,
  budgetUsd: 5,
  extraBudgetUsd: 0,
  changeRequestsUsed: 0,
  changeRequestsPerPerson: 5,
  paused: false,
  flags: [],
  ...over,
});

/** A room: a failed build, one stuck in Build for 17 min, a normal one, a flag, and someone in another group. */
function room(): TestRow[] {
  return [
    participant("ada", "g1", { step: "building", minutesInStep: 22, build: { status: "failed", kind: "first", stuck: false, retryRequested: false }, spentUsd: 1.1 }),
    participant("bo", "g1", { step: "building", minutesInStep: 18, build: { status: "building", kind: "first", stuck: true, minutesBuilding: 17, retryRequested: false } }),
    participant("cy", "g1", { step: "building", minutesInStep: 6, build: { status: "building", kind: "first", stuck: false, minutesBuilding: 5, retryRequested: false } }),
    participant("dee", "g1", { flags: [{ text: "Can my app show my colleague's salary list from the HR export?", reason: "It mentions confidential personal data." }] }),
    participant("eli", "g2", { step: "building", build: { status: "live", kind: "change", changeNumber: 2, stuck: false, retryRequested: false }, changeRequestsUsed: 2 }),
    participant(null, "g1", { step: "nickname", minutesInStep: 1 }),
  ];
}

/** A stand-in for the facilitator API (ticket 3.10): the list, and every action, with its answers. */
function fakeFacilitatorApi(rows: TestRow[] = room(), viewer = { role: "facilitator", group: "g1" }) {
  const state = { rows, viewer, stopped: false, lists: 0 };
  const find = (call: Call) => state.rows.find((r) => r.nickname !== null && call.path.startsWith(`${LIST}/${r.nickname}/`));
  const handlers: Record<string, Handler> = {
    [`GET ${LIST}`]: () => {
      state.lists++;
      return { status: 200, body: { viewer: state.viewer, stopped: state.stopped, participants: state.rows } };
    },
  };
  for (const r of rows) {
    if (r.nickname === null) continue;
    const base = `${LIST}/${r.nickname}`;
    handlers[`POST ${base}/flag/approve`] = (call) => decide(call, "Approved: the message goes to the AI now; the answer appears on the participant's page.");
    handlers[`POST ${base}/flag/reject`] = (call) => decide(call, "Rejected: the participant got a polite decline and can write again.");
    handlers[`POST ${base}/retry`] = (call) => {
      const row = find(call);
      if (row?.build?.status !== "failed" && row?.build?.stuck !== true) return { status: 409, body: { message: "Only a failed build, or one building for over 15 minutes, can be retried." } };
      row.build = { ...row.build, retryRequested: true };
      return { status: 202, body: { message: "Retry requested: the build starts again within a minute." } };
    };
    handlers[`POST ${base}/pause`] = (call) => {
      const row = find(call);
      if (row) row.paused = true;
      return { status: 200, body: { message: "Paused: the participant's next message and build wait until you press Resume.", paused: true } };
    };
    handlers[`POST ${base}/resume`] = (call) => {
      const row = find(call);
      if (row) row.paused = false;
      return { status: 200, body: { message: "Resumed: the participant's messages and builds go ahead.", paused: false } };
    };
    handlers[`POST ${base}/budget`] = (call) => {
      const row = find(call);
      if (!row) return { status: 404, body: { message: "Not found." } };
      row.extraBudgetUsd += 2;
      row.budgetUsd += 2;
      return { status: 200, body: { message: "Added $2 of AI budget.", extraBudgetUsd: row.extraBudgetUsd, budgetUsd: row.budgetUsd } };
    };
    handlers[`GET ${base}/conversation`] = () => ({
      status: 200,
      body: {
        nickname: r.nickname,
        messages: [
          { author: "participant", step: "clarify", status: "done", text: "A tracker for <b>our</b> runs" },
          { author: "assistant", text: "Who will use it?" },
        ],
      },
    });
  }
  function decide(call: Call, message: string): Reply {
    const row = find(call);
    if (!row || row.flags.length === 0) return { status: 409, body: { message: "No message is waiting for a decision." } };
    row.flags = [];
    return { status: 200, body: { message } };
  }
  return { state, handlers };
}

/** Opens the dashboard with its clock paused from the start, so only the test moves page time (it polls at once). */
async function openDashboard(): Promise<void> {
  await page.clock.install({ time: new Date("2026-11-26T10:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-11-26T10:00:01.000Z"));
  await page.goto(`${origin}/facilitator/`);
}

const settle = () => page.waitForTimeout(250);
const card = (nickname: string) => page.locator("#rows > li", { has: page.locator(".participant-name", { hasText: new RegExp(`^${nickname}$`) }) });

/** Moves page time by `ms`, which must fire one list read; waits for it and lets the page handle it. */
async function listAfter(ms: number): Promise<void> {
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === LIST);
  await page.clock.runFor(ms);
  await answered;
  await settle();
}

/** Makes the page believe its tab was hidden or shown again (Chromium keeps a test page visible). */
async function setTabHidden(hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** Nothing on the page is wider than the viewport. */
async function expectNoSideScroll(width: number = PHONE.width): Promise<void> {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth }));
  expect(widths.client).toBe(width);
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  expect(widths.body).toBeLessThanOrEqual(widths.client);
}

async function expectDashboard(): Promise<void> {
  await expect.poll(() => page.locator("#dashboard").isVisible()).toBe(true);
}

describe("facilitator dashboard (ticket 3.11)", () => {
  it("criterion 1: WHEN the list holds a build over 15 minutes in Build or a failed build THEN its row is highlighted, with Retry on those rows only", async () => {
    await mockApi(fakeFacilitatorApi().handlers);
    await openDashboard();
    await expectDashboard();

    expect(await card("ada").getAttribute("data-alert")).toBe("failed");
    expect(await card("bo").getAttribute("data-alert")).toBe("stuck");
    expect(await card("cy").getAttribute("data-alert")).toBeNull();
    expect(await card("dee").getAttribute("data-alert")).toBeNull();
    // Highlighted in red (the page's alert colour), and the reason in words, not by colour alone.
    const border = (nickname: string) => card(nickname).evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(await border("ada")).not.toBe(await border("cy"));
    expect(await border("ada")).toBe(await border("bo"));
    expect(await card("ada").locator(".participant-build").textContent()).toBe("Build: failed");
    expect(await card("bo").locator(".participant-build").textContent()).toBe("Build: stuck, building for 17 min");
    expect(await card("cy").locator(".participant-build").textContent()).toBe("Build: building for 5 min");

    // Retry only where the API would accept it.
    for (const [nickname, offered] of [["ada", true], ["bo", true], ["cy", false], ["dee", false]] as const) {
      expect(await card(nickname).getByRole("button", { name: "Retry" }).isVisible(), nickname).toBe(offered);
    }
    await expectNoSideScroll();
  });

  it("criterion 2: WHEN a flag is open THEN it appears above the rows with Approve and Reject, and pressing one calls the route and removes the alert", async () => {
    const api = fakeFacilitatorApi();
    const second = api.state.rows.find((r) => r.nickname === "cy");
    if (second) second.flags = [{ text: "Make it send emails to everyone", reason: "Unusual request." }];
    const calls = await mockApi(api.handlers);
    await openDashboard();
    await expectDashboard();

    const alerts = page.locator("#flag-list > li");
    await expect.poll(() => alerts.count()).toBe(2);
    expect(await page.locator("#flags").isVisible()).toBe(true);
    // Above the rows.
    const flagsBox = await page.locator("#flags").boundingBox();
    const rowsBox = await page.locator("#rows").boundingBox();
    expect((flagsBox?.y ?? 0) + (flagsBox?.height ?? 0)).toBeLessThanOrEqual(rowsBox?.y ?? 0);
    const dee = alerts.filter({ hasText: "dee" });
    expect(await dee.locator(".flag-text").textContent()).toBe("Can my app show my colleague's salary list from the HR export?");
    expect(await dee.getByText("Safety check: It mentions confidential personal data.").isVisible()).toBe(true);
    expect(await dee.getByRole("button", { name: "Approve" }).isVisible()).toBe(true);
    expect(await dee.getByRole("button", { name: "Reject" }).isVisible()).toBe(true);

    // Approve: the route is called (JSON content type) and the alert goes at once.
    await dee.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => alerts.count()).toBe(1);
    expect(calls.filter((c) => c.method === "POST").map((c) => `${c.path} ${String(c.contentType)}`)).toEqual([`${LIST}/dee/flag/approve application/json`]);
    expect(await page.locator("#message-flags").textContent()).toBe("Approved: the message goes to the AI now; the answer appears on the participant's page.");

    // Reject the other one: its route, and the flags section goes with the last alert.
    await alerts.filter({ hasText: "cy" }).getByRole("button", { name: "Reject" }).click();
    await expect.poll(() => alerts.count()).toBe(0);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`${LIST}/dee/flag/approve`, `${LIST}/cy/flag/reject`]);
    expect(await page.locator("#flags").isVisible()).toBe(false);
    expect(await page.locator("#message-flags").textContent()).toBe("Rejected: the participant got a polite decline and can write again.");

    // The next list reads no flag: nothing comes back.
    await listAfter(5000);
    expect(await alerts.count()).toBe(0);
    await expectNoSideScroll();
  });

  it("removes an alert another facilitator decided meanwhile (409) and says so; keeps it when the workshop cannot be reached", async () => {
    const api = fakeFacilitatorApi();
    let reachable = false;
    api.handlers[`POST ${LIST}/dee/flag/reject`] = () => ({ status: 409, body: { message: "This message was decided meanwhile; nothing changed." } });
    await mockApi(api.handlers);
    // Registered last, so asked first: no answer at all until `reachable`, then the mock above.
    await page.route(`**${LIST}/dee/flag/reject`, async (route) => (reachable ? route.fallback() : route.abort()));
    await openDashboard();
    await expectDashboard();
    const alert = page.locator("#flag-list > li").filter({ hasText: "dee" });
    await alert.getByRole("button", { name: "Reject" }).click();
    await expect.poll(() => page.locator("#message-flags").textContent()).toBe(DASHBOARD_TEXTS.actionOffline);
    expect(await alert.count()).toBe(1);
    reachable = true;
    await alert.getByRole("button", { name: "Reject" }).click();
    await expect.poll(() => alert.count()).toBe(0);
    expect(await page.locator("#message-flags").textContent()).toBe("This message was decided meanwhile; nothing changed.");
    expect(await page.locator("#message-flags").getAttribute("data-tone")).toBe("error");
    // The aborted request is logged by Chromium; it is the one expected console error here.
    violations = violations.filter((v) => v !== "Failed to load resource: net::ERR_FAILED");
  });

  it("criterion 3: WHEN a participant opens /facilitator/ THEN they see \"This page is for facilitators.\" and no data", async () => {
    const calls = await mockApi({ [`GET ${LIST}`]: () => ({ status: 404, body: { message: "Not found." } }) });
    await openDashboard();
    await expect.poll(() => page.locator("#dashboard-denied").isVisible()).toBe(true);
    expect(await page.locator("#dashboard-denied").textContent()).toContain("This page is for facilitators.");
    expect(PHASE_3_TEXTS.facilitatorsOnly).toBe("This page is for facilitators.");
    expect(await page.locator("#dashboard").isVisible()).toBe(false);
    expect(await page.locator("#rows > li").count()).toBe(0);
    expect(await page.locator("#flag-list > li").count()).toBe(0);
    expect(await page.locator("#dashboard-loading").isVisible()).toBe(false);
    // It asks nothing more.
    await page.clock.runFor(30_000);
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${LIST}`]);
    await expectNoSideScroll();
  });

  it("sends a signed-out visitor to the sign-in page", async () => {
    await mockApi({
      [`GET ${LIST}`]: () => ({ status: 401, body: { message: "Please sign in." } }),
      "GET /api/me": () => ({ status: 401, body: { message: "Please sign in." } }),
    });
    await page.goto(`${origin}/facilitator/`);
    await page.waitForURL(`${origin}/`);
    await expect.poll(() => page.locator("#screen-email").isVisible()).toBe(true);
  });

  it("criterion 4: WHEN the page is 375 px wide THEN nothing scrolls sideways (long texts, an open conversation, every message shown)", async () => {
    const api = fakeFacilitatorApi([
      ...room(),
      participant("a-very-long-nickname", "group-with-a-long-name", {
        flags: [{ text: "x".repeat(400), reason: "y".repeat(300) }],
        build: { status: "failed", kind: "change", changeNumber: 4, stuck: false, retryRequested: true },
      }),
    ]);
    await mockApi(api.handlers);
    await openDashboard();
    await expectDashboard();
    await page.locator("#group-filter").selectOption("");
    await card("a-very-long-nickname").getByRole("button", { name: "View conversation" }).click();
    await card("ada").getByRole("button", { name: "Add $2" }).click();
    await expect.poll(() => card("ada").locator(".message").textContent()).toBe("Added $2 of AI budget. Budget now $7.00.");
    await expect.poll(() => card("a-very-long-nickname").locator(".conversation-log").isVisible()).toBe(true);
    await expectNoSideScroll();
    for (const id of ["#flags", "#rows", ".dashboard-filter"]) {
      const box = await page.locator(id).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(PHONE.width);
    }
  });

  it("criterion 5: WHEN the page polls THEN it does so every 5 seconds and stops while the tab is hidden", async () => {
    const api = fakeFacilitatorApi();
    await mockApi(api.handlers);
    await openDashboard();
    await expectDashboard();
    await settle();
    expect(api.state.lists).toBe(1);

    // Nothing before 5 s, then one read every 5 s; the page shows what each read says.
    await page.clock.runFor(4_900);
    await settle();
    expect(api.state.lists).toBe(1);
    await listAfter(100);
    expect(api.state.lists).toBe(2);
    api.state.rows.push(participant("fay", "g1"));
    await listAfter(5_000);
    expect(api.state.lists).toBe(3);
    await expect.poll(() => card("fay").count()).toBe(1);

    // A hidden tab stops it: a minute passes without a read.
    await setTabHidden(true);
    await page.clock.runFor(60_000);
    await settle();
    expect(api.state.lists).toBe(3);

    // Shown again: one read at once, then every 5 s again.
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === LIST);
    await setTabHidden(false);
    await answered;
    await settle();
    expect(api.state.lists).toBe(4);
    await page.clock.runFor(4_900);
    await settle();
    expect(api.state.lists).toBe(4);
    await listAfter(100);
    expect(api.state.lists).toBe(5);
  });

  it("keeps polling after a failed read and says so plainly", async () => {
    const api = fakeFacilitatorApi();
    let fail = false;
    const list = api.handlers[`GET ${LIST}`];
    api.handlers[`GET ${LIST}`] = (call) => (fail ? { status: 500, body: { message: "Something went wrong." } } : (list?.(call) ?? { status: 500 }));
    await mockApi(api.handlers);
    await openDashboard();
    await expectDashboard();
    fail = true;
    await listAfter(5_000);
    expect(await page.locator("#message-dashboard").textContent()).toBe(DASHBOARD_TEXTS.loadFailed);
    // The last list stays on screen.
    expect(await card("ada").count()).toBe(1);
    fail = false;
    await listAfter(5_000);
    expect(await page.locator("#message-dashboard").textContent()).toBe("");
  });

  it("Retry, Pause and Resume, Add $2 and View conversation call their routes and show the answers; 409 and 404 are shown plainly", async () => {
    const api = fakeFacilitatorApi();
    // Bo's stuck build finished meanwhile: Retry is refused (409).
    api.handlers[`POST ${LIST}/bo/retry`] = () => ({ status: 409, body: { message: "Only a failed build, or one building for over 15 minutes, can be retried." } });
    // Cy left the workshop meanwhile (404).
    api.handlers[`POST ${LIST}/cy/pause`] = () => ({ status: 404, body: { message: "Not found." } });
    const calls = await mockApi(api.handlers);
    await openDashboard();
    await expectDashboard();

    await card("ada").getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => card("ada").locator(".message").textContent()).toBe("Retry requested: the build starts again within a minute.");
    await card("bo").getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => card("bo").locator(".message").textContent()).toBe("Only a failed build, or one building for over 15 minutes, can be retried.");
    expect(await card("bo").locator(".message").getAttribute("data-tone")).toBe("error");

    await card("dee").getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => card("dee").getByRole("button", { name: "Resume" }).isVisible()).toBe(true);
    expect(await card("dee").locator(".badge").isVisible()).toBe(true);
    await card("dee").getByRole("button", { name: "Resume" }).click();
    await expect.poll(() => card("dee").getByRole("button", { name: "Pause" }).isVisible()).toBe(true);
    expect(await card("dee").locator(".message").textContent()).toBe("Resumed: the participant's messages and builds go ahead.");

    await card("cy").getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => card("cy").locator(".message").textContent()).toBe(DASHBOARD_TEXTS.gone);

    await card("ada").getByRole("button", { name: "Add $2" }).click();
    await expect.poll(() => card("ada").locator(".message").textContent()).toBe("Added $2 of AI budget. Budget now $7.00.");
    expect(await card("ada").locator(".participant-line.help").textContent()).toBe("AI $1.10 of $7.00 (+$2.00 added) · Changes 0 of 5");

    // The conversation log: text only (markup in a message is shown as typed), and it survives the next poll.
    await card("ada").getByRole("button", { name: "View conversation" }).click();
    const log = card("ada").locator(".conversation-log");
    await expect.poll(() => log.isVisible()).toBe(true);
    expect(await log.locator("li").allTextContents()).toEqual(["Participant, step clarifyA tracker for <b>our</b> runs", "AIWho will use it?"]);
    expect(await log.locator("b").count()).toBe(0);
    await listAfter(5_000);
    expect(await log.isVisible()).toBe(true);
    expect(await card("ada").locator(".participant-build").textContent()).toBe("Build: failed (Retry requested)");
    await card("ada").getByRole("button", { name: "Hide conversation" }).click();
    expect(await log.isVisible()).toBe(false);

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual([
      `${LIST}/ada/retry`,
      `${LIST}/bo/retry`,
      `${LIST}/dee/pause`,
      `${LIST}/dee/resume`,
      `${LIST}/cy/pause`,
      `${LIST}/ada/budget`,
    ]);
    expect(posts.every((c) => c.contentType === "application/json")).toBe(true);
    // A participant without a nickname has no action.
    const anonymous = page.locator("#rows > li", { has: page.locator(".participant-name", { hasText: DASHBOARD_TEXTS.noNickname }) });
    expect(await anonymous.locator(".participant-actions").isVisible()).toBe(false);
  });

  it("starts the group filter on the facilitator's own group, says where other flags are, and shows everyone on request", async () => {
    const api = fakeFacilitatorApi();
    const eli = api.state.rows.find((r) => r.nickname === "eli");
    if (eli) eli.flags = [{ text: "Another flagged message", reason: "Unusual." }];
    await mockApi(api.handlers);
    await openDashboard();
    await expectDashboard();
    expect(await page.locator("#group-filter").inputValue()).toBe("g1");
    expect(await page.locator("#group-filter option").allTextContents()).toEqual(["g1 (your group)", "g2", "Everyone"]);
    expect(await page.locator("#rows .participant-name").allTextContents()).toEqual(["ada", "bo", "cy", "dee", DASHBOARD_TEXTS.noNickname]);
    expect(await page.locator("#dashboard-count").textContent()).toBe("Showing 5 of 6 participants");
    expect(await page.locator("#flags-elsewhere").textContent()).toBe(otherGroupFlagsText(1));
    expect(await page.locator("#flag-list > li").count()).toBe(1);

    await page.locator("#group-filter").selectOption({ label: "Everyone" });
    expect(await page.locator("#rows .participant-name").allTextContents()).toEqual(["ada", "bo", "cy", "dee", "eli", DASHBOARD_TEXTS.noNickname]);
    expect(await page.locator("#flag-list > li").count()).toBe(2);
    expect(await page.locator("#flags-elsewhere").isVisible()).toBe(false);
    expect(await card("eli").locator(".participant-group").textContent()).toBe("Group g2");
    // The choice stays across polls.
    await listAfter(5_000);
    expect(await page.locator("#group-filter").inputValue()).toBe("");
  });

  it("starts the admin, whose group has no participants, on Everyone, and shows the global Stop", async () => {
    const api = fakeFacilitatorApi(room(), { role: "admin", group: "staff" });
    api.state.stopped = true;
    await mockApi(api.handlers);
    await openDashboard();
    await expectDashboard();
    expect(await page.locator("#group-filter").inputValue()).toBe("");
    expect(await page.locator("#rows > li").count()).toBe(6);
    expect(await page.locator("#dashboard-stopped").textContent()).toBe(DASHBOARD_TEXTS.workshopStopped);
    expect(await page.locator("#dashboard-stopped").isVisible()).toBe(true);
  });

  it("never shows an email address or a participant id (the API sends none; the page adds none)", async () => {
    await mockApi(fakeFacilitatorApi().handlers);
    await openDashboard();
    await expectDashboard();
    const text = (await page.locator("body").textContent()) ?? "";
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/participantId|p-\d/);
  });
});

describe("dashboard link on the workshop page (ticket 3.11)", () => {
  for (const [role, shown] of [["facilitator", true], ["admin", true], ["participant", false]] as const) {
    it(`${shown ? "shows" : "hides"} the Facilitator dashboard link for a${role === "admin" ? "n" : ""} ${role}`, async () => {
      await mockApi({
        "GET /api/me": () => ({ status: 200, body: { id: "p-1", nickname: "fran", role, group: "g1", step: "clarify" } }),
        "GET /api/conversation": () => ({ status: 200, body: { step: "clarify", state: "open", messages: [] } }),
      });
      await page.goto(origin);
      await expect.poll(() => page.locator("#screen-step").isVisible()).toBe(true);
      const link = page.locator("#dashboard-link");
      expect(await link.isVisible()).toBe(shown);
      if (shown) expect(await link.getAttribute("href")).toBe("/facilitator/");
      await expectNoSideScroll();
    });
  }
});

describe("dashboard screenshots (ticket 3.11)", () => {
  it("takes the 375 px and 1280 px screenshots: a flag alert, a highlighted row and a normal row", async () => {
    const target = SHOTS;
    if (target === undefined || target === "") return;
    mkdirSync(target, { recursive: true });
    for (const [viewport, name] of [[PHONE, "dashboard-375.png"], [LAPTOP, "dashboard-1280.png"]] as const) {
      await context.close();
      await openContext(viewport, 2);
      await mockApi(fakeFacilitatorApi().handlers);
      await openDashboard();
      await expectDashboard();
      await settle();
      await page.screenshot({ path: join(target, name), fullPage: true });
      await expectNoSideScroll(viewport.width);
    }
  }, 30_000);
});
