// Ticket 3.24 try 2: an app opens the hand-off page /app-sign-in in a new tab, and that tab must be a normal page
// that sees the workshop's session. A tab an app opens inherits the app's sandbox unless the apps' CSP says
// `allow-popups-to-escape-sandbox`: then it would run in an opaque origin, its `GET /api/me` would go out without the
// session cookie, and the page would ask a signed-in participant to sign in.
//
// One local HTTPS server (a certificate made in memory, like the live site's `__Host-` Secure cookie needs) serves, on
// one origin as CloudFront does: an app page under the apps' REAL Content-Security-Policy with a link (target _blank)
// and a button that calls `window.open`; the built hand-off page under the pages' real CSP; and `GET /api/me`, which
// answers only when the session cookie arrives. The browser holds the session cookie exactly as sign-in sets it
// (HttpOnly, Secure, SameSite=Strict). A control serves the same app under the CSP without the new keyword and shows
// the old behaviour (no cookie, the page asks to sign in), so the test proves the keyword is what makes it work.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPS_CONTENT_SECURITY_POLICY, PAGES_CONTENT_SECURITY_POLICY } from "../../infra/lib/config.js";
import { selfSignedCertificate } from "../api/build/test-certificate.js";
import { SESSION_COOKIE } from "../api/session/session.js";
import { buildWeb } from "./build.js";
import { MESSAGES } from "./src/flow.js";

const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const SESSION = Buffer.alloc(32, 5).toString("base64url");
const BOB = { id: "p-bob", nickname: "Bob", role: "participant", group: "g1", step: "clarify" };
/** The apps' CSP before ticket 3.24 try 2 (the control). */
const OFFLINE = MESSAGES.offline;
const OLD_APPS_CSP = APPS_CONTENT_SECURITY_POLICY.replace(" allow-popups-to-escape-sandbox", "");

const APP_PAGE = `<!doctype html><title>Ada's app</title>
<a id="link" href="/app-sign-in/?app=ada" target="_blank">Sign in to save</a>
<button id="open" type="button">Sign in to save (window.open)</button>
<script src="open.js" defer></script>`;
// The app keeps the handle `window.open` gives, so the test can try to reach into the tab from the app.
const APP_SCRIPT = `document.getElementById("open").addEventListener("click", () => { window.handOff = window.open("/app-sign-in/?app=ada", "_blank"); });`;

let dir: string;
let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
/** Each `GET /api/me`: whether the session cookie came with it, and the Origin header (an opaque origin sends "null"). */
let meCalls: { cookie: boolean; origin: string | undefined }[];

beforeAll(async () => {
  dir = buildWeb(mkdtempSync(join(tmpdir(), "ssd-workshop-app-sign-in-popup-")));
  server = createServer(selfSignedCertificate(), (request, response) => {
    const path = new URL(request.url ?? "/", "https://localhost").pathname;
    if (path === "/api/me") {
      const cookie = (request.headers.cookie ?? "").split(";").some((c) => c.trim() === `${SESSION_COOKIE}=${SESSION}`);
      meCalls.push({ cookie, origin: request.headers.origin });
      response.writeHead(cookie ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(cookie ? BOB : { message: "Please sign in." }));
      return;
    }
    const app = /^\/(apps|apps-old)\/ada\/(open\.js)?$/.exec(path);
    if (app) {
      const csp = app[1] === "apps" ? APPS_CONTENT_SECURITY_POLICY : OLD_APPS_CSP;
      response.writeHead(200, { "content-type": app[2] ? "text/javascript" : "text/html", "content-security-policy": csp });
      response.end(app[2] ? APP_SCRIPT : APP_PAGE);
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
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  meCalls = [];
  context = await browser.newContext({ viewport: { width: 375, height: 667 }, ignoreHTTPSErrors: true });
  // The session cookie as sign-in sets it (`sessionCookie`): HttpOnly, Secure, SameSite=Strict, host-only, Path=/.
  await context.addCookies([{ name: SESSION_COOKIE, value: SESSION, url: `${origin}/`, httpOnly: true, secure: true, sameSite: "Strict" }]);
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
});

afterEach(async () => {
  await context.close();
});

/** Opens the app under `/<folder>/ada/`, opens the hand-off tab the way `how` says, and gives the new tab. */
async function openHandOff(folder: "apps" | "apps-old", how: "link" | "window.open"): Promise<Page> {
  await page.goto(`${origin}/${folder}/ada/`);
  // The app really is sandboxed (opaque origin), whatever the keyword.
  expect(await page.evaluate(() => window.origin)).toBe("null");
  const [popup] = await Promise.all([context.waitForEvent("page"), page.locator(how === "link" ? "#link" : "#open").click()]);
  await popup.waitForLoadState();
  return popup;
}

describe("the hand-off page opened from a sandboxed app (ticket 3.24 try 2, apps' CSP `allow-popups-to-escape-sandbox`)", () => {
  for (const how of ["link", "window.open"] as const) {
    it(`WHEN an app opens /app-sign-in?app=<nick> (${how}) THEN the new tab is not opaque: GET /api/me goes same-origin with the session cookie and the page asks the question`, async () => {
      const popup = await openHandOff("apps", how);
      expect(popup.url()).toBe(`${origin}/app-sign-in/?app=ada`);
      await expect.poll(() => popup.locator("#app-sign-in-question").textContent()).toBe("Save in ada's app as Bob?");
      expect(await popup.evaluate(() => window.origin)).toBe(origin);
      expect(meCalls.length).toBeGreaterThan(0);
      // Same-origin fetch: the cookie came, and no opaque `Origin: null`.
      for (const call of meCalls) expect(call).toMatchObject({ cookie: true });
      expect(meCalls.map((c) => c.origin)).not.toContain("null");
      // The app still cannot reach into the tab it opened (it stays sandboxed in its opaque origin): tried for real.
      expect(await page.evaluate(() => window.origin)).toBe("null");
      if (how === "window.open") {
        // From the app, with the handle `window.open` returned: reading the tab's document or address is refused.
        const tries = await page.evaluate(() => {
          const tab = (window as unknown as { handOff?: Window | null }).handOff;
          if (tab === undefined || tab === null) return ["no handle"];
          return [() => tab.document.title, () => tab.location.href, () => tab.localStorage.length].map((read) => {
            try {
              read();
              return "read";
            } catch (error) {
              return (error as Error).name;
            }
          });
        });
        expect(tries).toEqual(["SecurityError", "SecurityError", "SecurityError"]);
      } else {
        // A `target="_blank"` link opens without an opener (Chromium's implied `noopener`): the app holds no handle at
        // all, and the tab has no way back to the app.
        expect(await popup.evaluate(() => window.opener)).toBeNull();
      }
    });
  }

  it("control: WHEN the app is served with the old CSP (no `allow-popups-to-escape-sandbox`) THEN the tab is opaque, GET /api/me goes cross-origin without the cookie and the participant never gets the question", async () => {
    const popup = await openHandOff("apps-old", "link");
    // The opaque tab's call is cross-origin (`Origin: null`), without the cookie, and its answer is unreadable (no CORS).
    await expect.poll(() => popup.locator("#message-app-sign-in").textContent()).toBe(OFFLINE);
    expect(await popup.evaluate(() => window.origin)).toBe("null");
    expect(await popup.locator("#app-sign-in-ask").isHidden()).toBe(true);
    expect(meCalls).toEqual([{ cookie: false, origin: "null" }]);
  });
});
