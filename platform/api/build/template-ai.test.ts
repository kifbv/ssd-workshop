// Ticket 3.22: the AI helpers of templates/basic/workshop-data.js (ai.tagPhoto, ai.readPhoto, ai.sortText, ai.transcribe),
// in Playwright's Chromium under the apps' REAL sandbox CSP (opaque origin), against the REAL AI route of ticket 3.21
// (`handleAppAiRequest`) behind a local server, with its in-memory store, media bucket, model and Transcribe
// (platform/api/app-ai/fakes.ts): the route's own parser judges what the helpers send, and its own answers come back.
// - Criterion 1: each helper sends the documented request (with the sign-in, to the workshop only, even after app code
//   adds a <base> to another server) and returns the parsed answer; transcribe asks again every 3 s while the route
//   answers 202, and gives up after 3 minutes.
// - Criterion 2: a refusal (AI switched off, the app's, the person's or the workshop's allowance spent, the sign-in
//   ended) reaches the app as an error carrying the route's message, and AGENTS.md rule 16's example (run as written
//   there) shows it; the visitor can still type the tags and save.
// - A wrong answer shape is refused with a plain message; arguments outside the route's limits are refused unsent.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPS_CONTENT_SECURITY_POLICY } from "../../../infra/lib/config.js";
import { APP_AI_PATH, handleAppAiRequest, type ModelCall } from "../app-ai/ai.js";
import { APP_AI_DAILY_BUDGET_USD, utcDay, WRITER_AI_DAILY_BUDGET_USD, ALL_APPS_AI_DAILY_BUDGET_USD } from "../app-ai/budget.js";
import { FakeAppAiModel, FakeAppAiStore, FakeMediaReader, FakeTranscriber } from "../app-ai/fakes.js";
import { MAX_CATEGORIES, MAX_FIELDS, MAX_GIVEN_TAGS, MAX_NAME_CHARACTERS, MAX_TEXT_CHARACTERS } from "../app-ai/tasks.js";
import { jpegOfSize, webmOfSize } from "../app-media/fixtures.js";
import { mediaKey } from "../app-media/media.js";
import { hashAppToken } from "../app-token/token.js";
import type { HttpRequest } from "../http.js";
import { APP_AI_TEXTS, APP_SIGN_IN_TEXTS } from "../workshop/texts.js";

const CLIENT = readFileSync(fileURLToPath(new URL("../../../templates/basic/workshop-data.js", import.meta.url)), "utf8");
const AGENTS = readFileSync(fileURLToPath(new URL("../../../templates/basic/AGENTS.md", import.meta.url)), "utf8");
const NICKNAME = "test-nick";
const TOKEN = Buffer.alloc(32, 9).toString("base64url");
const HAND_OFF = `#wt=${TOKEN}`;
const PHOTO_ID = "PhOtOpHoToPhOtOpHoTo01";
const VOICE_ID = "VoIcEvOiCeVoIcEvOiCe01";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE", "access-control-allow-headers": "content-type, accept, authorization" };
const LOGGED = (status: number) => `Failed to load resource: the server responded with a status of ${status}`;
const ODD_ANSWER = "The workshop answered something unexpected. Please try again.";

/** AGENTS.md rule 16's example, run as written there: its first code block after "16. AI suggestions". */
const RULE_EXAMPLE = /^16\. AI suggestions[\s\S]*?```js\n([\s\S]*?)```/m.exec(AGENTS)?.[1] ?? "";

/** A small app written the way AGENTS.md rule 16 asks: Suggest tags fills the field, Save saves what it holds. */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <script src="workshop-data.js"></script>
    <title>AI test</title>
    <link rel="icon" href="data:,">
    <script src="app.js" defer></script>
  </head>
  <body>
    <label for="tags">Tags</label>
    <input id="tags" type="text">
    <button id="suggest" type="button">Suggest tags</button>
    <button id="save" type="button">Save</button>
    <p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p>
    <p id="status" role="status"></p>
  </body>
</html>`;

const APP = `"use strict";
const tagsInput = document.getElementById("tags");
const statusText = document.getElementById("status");
document.getElementById("suggest").addEventListener("click", async () => {
  const address = window.photoAddress;
${RULE_EXAMPLE}
});
document.getElementById("save").addEventListener("click", async () => {
  try {
    await workshopData.set("gallery-v1", [{ photo: window.photoAddress, tags: tagsInput.value.split(",").map((tag) => tag.trim()).filter(Boolean) }]);
    statusText.textContent = "Saved.";
  } catch (error) {
    statusText.textContent = error.message;
  }
});`;

/** One request the AI route received, with what it answered. */
interface AiCall {
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  origin: string | undefined;
  body: unknown;
  status: number;
}

let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: string[];
let allowed: string[];
let calls: AiCall[];
let dataWrites: { path: string; body: string }[];
let store: FakeAppAiStore;
let model: FakeAppAiModel;
let transcriber: FakeTranscriber;
let media: FakeMediaReader;
/** The route's clock runs ahead of real time by what its Transcribe waits slept (no real waiting in the tests). */
let offset: number;
/** When set, the next AI request is answered with this instead of the route (a wrong answer shape). */
let answerNext: { status: number; body: string } | undefined;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

/** The model's answers, by the tool the route asked for (read-photo's fields come as f1..fn). */
function answerFor(call: ModelCall) {
  const input =
    call.tool.name === "suggest_tags"
      ? { tags: ["cat", "drawing"] }
      : call.tool.name === "pick_tags"
        ? { tags: ["Pencil"] }
        : call.tool.name === "give_fields"
          ? { values: { f1: "Bäckerei Sonnenschein", f2: "2026-11-14", f3: { amount: 12.4, currency: "EUR" }, f4: 3 } }
          : { categories: ["Ideas"] };
  return { input, text: "", inputTokens: 1500, outputTokens: 60 };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { ...CORS, "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === `/apps/${NICKNAME}/`) {
        response.writeHead(200, { "content-type": "text/html", "content-security-policy": APPS_CONTENT_SECURITY_POLICY });
        response.end(PAGE);
        return;
      }
      if (path === `/apps/${NICKNAME}/workshop-data.js` || path === `/apps/${NICKNAME}/app.js`) {
        response.writeHead(200, { "content-type": "text/javascript", "content-security-policy": APPS_CONTENT_SECURITY_POLICY, "x-content-type-options": "nosniff" });
        response.end(path.endsWith("app.js") ? APP : CLIENT);
        return;
      }
      if (path === `/api/apps/${NICKNAME}/data/whoami`) {
        if (request.method === "OPTIONS") return json(204, "");
        if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: APP_SIGN_IN_TEXTS.signInToSave });
        return json(200, { nickname: "Bob" });
      }
      if (path.startsWith(`/api/apps/${NICKNAME}/data/`)) {
        if (request.method === "OPTIONS") return json(204, "");
        dataWrites.push({ path, body: await readBody(request) });
        response.writeHead(204, CORS);
        response.end();
        return;
      }
      if (path === `/api/apps/${NICKNAME}/ai`) {
        const text = await readBody(request);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        const call: AiCall = {
          method: request.method ?? "",
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          origin: request.headers.origin,
          body,
          status: 0,
        };
        if (request.method !== "OPTIONS") calls.push(call);
        if (answerNext !== undefined && request.method === "POST") {
          const odd = answerNext;
          answerNext = undefined;
          call.status = odd.status;
          response.writeHead(odd.status, { "access-control-allow-origin": "*", "content-type": "application/json" });
          response.end(odd.body);
          return;
        }
        // The request as API Gateway (payload 2.0) hands it over: lower-cased headers.
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers[name] = value;
        const event: HttpRequest = { routeKey: `${request.method ?? ""} ${APP_AI_PATH}`, pathParameters: { nickname: NICKNAME }, headers, ...(text === "" ? {} : { body: text }) };
        const answer = await handleAppAiRequest(event, {
          store,
          tokens: store.tokens,
          media,
          model,
          transcriber,
          now: () => new Date(Date.now() + offset),
          log: () => undefined,
          pause: async () => undefined,
          sleep: async (ms) => {
            offset += ms;
          },
        });
        call.status = answer.statusCode;
        response.writeHead(answer.statusCode, answer.headers as Record<string, string>);
        response.end(answer.body ?? "");
        return;
      }
      response.writeHead(404).end();
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
  store = new FakeAppAiStore();
  store.live.add(NICKNAME);
  store.tokens.tokens.set(hashAppToken(TOKEN), { app: NICKNAME, nickname: "Bob", expiresAt: Math.floor(Date.now() / 1000) + 86400 });
  media = new FakeMediaReader();
  media.objects.set(mediaKey(NICKNAME, PHOTO_ID), jpegOfSize(200_000));
  media.objects.set(mediaKey(NICKNAME, VOICE_ID), webmOfSize(50_000, ["A_OPUS"], "webm", 10));
  model = new FakeAppAiModel();
  model.next = answerFor;
  transcriber = new FakeTranscriber();
  transcriber.looksToFinish = 0;
  transcriber.transcriptText = "An idea for the next team lunch.";
  transcriber.language = "en-US";
  offset = 0;
  answerNext = undefined;
  calls = [];
  dataWrites = [];
  errors = [];
  allowed = [];
  context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("console", (message) => {
    if (message.type() === "error" && !allowed.some((line) => message.text().startsWith(line))) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(`window.violations = []; document.addEventListener("securitypolicyviolation", (event) => window.violations.push(event.effectiveDirective + " " + event.blockedURI));`);
});

afterEach(async () => {
  await context.close();
});

const photoAddress = (): string => `${origin}/app-media/${NICKNAME}/${PHOTO_ID}`;
const voiceAddress = (): string => `${origin}/app-media/${NICKNAME}/${VOICE_ID}`;
const statusText = () => page.locator("#status").textContent();

/** Opens the app under the sandbox CSP (signed in unless `hash` is empty), waits until whoAmI() settled. */
async function openApp(hash = HAND_OFF): Promise<void> {
  const response = await page.goto(`${origin}/apps/${NICKNAME}/${hash}`);
  expect(response?.headers()["content-security-policy"]).toBe(APPS_CONTENT_SECURITY_POLICY);
  expect(await page.evaluate<string>("window.origin")).toBe("null");
  await page.evaluate("workshopData.whoAmI()");
  await page.evaluate(`window.photoAddress = ${JSON.stringify(photoAddress())}`);
}

/** App code adds a <base> to another server (3.25's rule for every request the client makes); answers what reached it. */
async function baseElsewhere(): Promise<string[]> {
  const elsewhere: string[] = [];
  await page.route("https://evil.example/**", (route) => {
    elsewhere.push(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });
  await page.evaluate(`(() => { const base = document.createElement("base"); base.href = "https://evil.example/"; document.head.append(base); })()`);
  return elsewhere;
}

/** Runs `expression` (a promise) in the page: its value, or the error's message. */
const outcome = (expression: string): Promise<{ value?: unknown; error?: string }> =>
  page.evaluate(`(${expression}).then((value) => ({ value: JSON.parse(JSON.stringify(value)) }), (error) => ({ error: error.message }))`);

describe("criterion 1: each AI helper sends the documented request and returns the parsed answer (ticket 3.22)", () => {
  it("WHEN the app calls tagPhoto, readPhoto, sortText and transcribe under the sandbox CSP, after adding a <base> elsewhere THEN the route gets each documented request with the sign-in and each answer comes back parsed", async () => {
    await openApp();
    const elsewhere = await baseElsewhere();
    const photo = JSON.stringify(photoAddress());
    const voice = JSON.stringify(voiceAddress());

    expect(await outcome(`workshopData.ai.tagPhoto(${photo})`)).toEqual({ value: ["cat", "drawing"] });
    expect(await outcome(`workshopData.ai.tagPhoto(${photo}, ["Portrait", " Pencil "])`)).toEqual({ value: ["Pencil"] });
    expect(
      await outcome(`workshopData.ai.readPhoto(${photo}, [{ name: "shop", type: "text" }, { name: "date", type: "date" }, { name: "total", type: "money" }, { name: "items", type: "number" }])`),
    ).toEqual({ value: { shop: "Bäckerei Sonnenschein", date: "2026-11-14", total: { amount: 12.4, currency: "EUR" }, items: 3 } });
    expect(await outcome(`workshopData.ai.sortText("Let us try a picnic next week.", ["Ideas", "Questions", "News"])`)).toEqual({ value: ["Ideas"] });
    expect(await outcome(`workshopData.ai.transcribe(${voice})`)).toEqual({ value: { text: "An idea for the next team lunch.", language: "en-US" } });

    const path = `/app-media/${NICKNAME}/`;
    expect(calls.map((call) => call.body)).toEqual([
      { task: "tag-photo", photo: `${path}${PHOTO_ID}` },
      { task: "tag-photo", photo: `${path}${PHOTO_ID}`, tags: ["Portrait", "Pencil"] },
      {
        task: "read-photo",
        photo: `${path}${PHOTO_ID}`,
        fields: [
          { name: "shop", type: "text" },
          { name: "date", type: "date" },
          { name: "total", type: "money" },
          { name: "items", type: "number" },
        ],
      },
      { task: "sort-text", text: "Let us try a picnic next week.", categories: ["Ideas", "Questions", "News"] },
      { task: "transcribe", recording: `${path}${VOICE_ID}` },
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({ method: "POST", authorization: `Bearer ${TOKEN}`, contentType: "application/json", origin: "null", status: 200 });
    }
    // The route itself ran each task: the photo went to the model with the photo tasks, the recording to Transcribe.
    expect(model.calls.map((call) => [call.tool.name, call.photo !== undefined])).toEqual([
      ["suggest_tags", true],
      ["pick_tags", true],
      ["give_fields", true],
      ["pick_categories", false],
    ]);
    expect(transcriber.calls.some((call) => call.startsWith("start "))).toBe(true);
    expect(elsewhere).toEqual([]);
    expect(await page.evaluate<string[]>("window.violations")).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("WHEN the arguments are at the route's limits THEN the route accepts them (20 tags, 12 fields, 2,000 characters, 20 categories, 50-character names)", async () => {
    await openApp();
    const names = (n: number, prefix: string) => JSON.stringify(Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`.padEnd(MAX_NAME_CHARACTERS, "x")));
    model.next = (call) =>
      call.tool.name === "pick_tags" ? { input: { tags: [] }, text: "", inputTokens: 1, outputTokens: 1 } : call.tool.name === "pick_categories" ? { input: { categories: [] }, text: "", inputTokens: 1, outputTokens: 1 } : { input: { values: { f1: "x" } }, text: "", inputTokens: 1, outputTokens: 1 };
    expect(await outcome(`workshopData.ai.tagPhoto(${JSON.stringify(photoAddress())}, ${names(MAX_GIVEN_TAGS, "tag")})`)).toEqual({ value: [] });
    const fields = JSON.stringify(Array.from({ length: MAX_FIELDS }, (_, i) => ({ name: `field ${i + 1}`, type: "text" })));
    const read = await outcome(`workshopData.ai.readPhoto(${JSON.stringify(photoAddress())}, ${fields})`);
    expect(Object.keys((read.value ?? {}) as object)).toHaveLength(MAX_FIELDS);
    // Emoji count as one character each, as the route counts them.
    expect(await outcome(`workshopData.ai.sortText(${JSON.stringify("é🙂".repeat(MAX_TEXT_CHARACTERS / 2))}, ${names(MAX_CATEGORIES, "topic")})`)).toEqual({ value: [] });
    expect(calls.map((call) => call.status)).toEqual([200, 200, 200]);
    expect(errors).toEqual([]);
  });

  it("WHEN the arguments are outside the route's limits, or the address is not one of this app's files THEN a plain message comes back and nothing is sent", async () => {
    await openApp();
    const photo = JSON.stringify(photoAddress());
    const many = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `name ${i + 1}`));
    const cases: [string, string][] = [
      [`workshopData.ai.tagPhoto("https://evil.example/app-media/${NICKNAME}/${PHOTO_ID}")`, "This is not the address of one of this app's photos or recordings."],
      [`workshopData.ai.tagPhoto(${JSON.stringify(`${origin}/app-media/someone-else/${PHOTO_ID}`)})`, "This is not the address of one of this app's photos or recordings."],
      [`workshopData.ai.tagPhoto("/app-media/${NICKNAME}/short")`, "This is not the address of one of this app's photos or recordings."],
      [`workshopData.ai.transcribe(42)`, "This is not the address of one of this app's photos or recordings."],
      [`workshopData.ai.tagPhoto(${photo}, ${many(MAX_GIVEN_TAGS + 1)})`, "Give at most 20 tags to choose from, each 1 to 50 characters long and all different."],
      [`workshopData.ai.tagPhoto(${photo}, ["cat", "Cat"])`, "Give at most 20 tags to choose from, each 1 to 50 characters long and all different."],
      [`workshopData.ai.tagPhoto(${photo}, ["${"x".repeat(MAX_NAME_CHARACTERS + 1)}"])`, "Give at most 20 tags to choose from, each 1 to 50 characters long and all different."],
      [`workshopData.ai.tagPhoto(${photo}, "cat")`, "Give at most 20 tags to choose from, each 1 to 50 characters long and all different."],
      [`workshopData.ai.readPhoto(${photo}, [])`, "Ask for 1 to 12 fields, each with a name of 1 to 50 characters (all different) and a type: text, number, date or money."],
      [`workshopData.ai.readPhoto(${photo}, ${JSON.stringify(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({ name: `f${i}`, type: "text" })))})`, "Ask for 1 to 12 fields, each with a name of 1 to 50 characters (all different) and a type: text, number, date or money."],
      [`workshopData.ai.readPhoto(${photo}, [{ name: "total", type: "price" }])`, "Ask for 1 to 12 fields, each with a name of 1 to 50 characters (all different) and a type: text, number, date or money."],
      [`workshopData.ai.readPhoto(${photo}, [{ name: "total", type: "money", prompt: "x" }])`, "Ask for 1 to 12 fields, each with a name of 1 to 50 characters (all different) and a type: text, number, date or money."],
      [`workshopData.ai.readPhoto(${photo}, [{ name: " ", type: "text" }])`, "Ask for 1 to 12 fields, each with a name of 1 to 50 characters (all different) and a type: text, number, date or money."],
      [`workshopData.ai.sortText("", ["Ideas"])`, "Give a text of 1 to 2,000 characters to sort."],
      [`workshopData.ai.sortText(${JSON.stringify("x".repeat(MAX_TEXT_CHARACTERS + 1))}, ["Ideas"])`, "Give a text of 1 to 2,000 characters to sort."],
      [`workshopData.ai.sortText("hello", [])`, "Give 1 to 20 categories, each 1 to 50 characters long and all different."],
      [`workshopData.ai.sortText("hello", ${many(MAX_CATEGORIES + 1)})`, "Give 1 to 20 categories, each 1 to 50 characters long and all different."],
    ];
    for (const [expression, message] of cases) expect(await outcome(expression), expression).toEqual({ error: message });
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("WHEN the route answers 202 (still working) THEN transcribe asks again every 3 seconds until the text comes, and gives up with a plain message after 3 minutes", async () => {
    // The job runs until the test ends it, before the fourth ask.
    transcriber.looksToFinish = 10_000;
    await page.clock.install();
    await openApp();
    const now = await page.evaluate<number>("Date.now()");
    await page.clock.pauseAt(now + 1000);
    await page.evaluate(`window.said = undefined; workshopData.ai.transcribe(${JSON.stringify(voiceAddress())}).then((value) => { window.said = value; }, (error) => { window.said = error.message; }); undefined`);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]?.status).toBe(202);
    for (const n of [2, 3, 4]) {
      if (n === 4) {
        for (const job of transcriber.jobs.values()) {
          job.looksLeft = 0;
          transcriber.results.set(job.outputKey, transcriber.transcriptText);
        }
      }
      // Not before 3 s.
      await page.clock.runFor(2_900);
      await page.waitForTimeout(100);
      expect(calls.length).toBe(n - 1);
      await page.clock.runFor(100);
      await expect.poll(() => calls.length).toBe(n);
      await expect.poll(() => calls[n - 1]?.status).not.toBe(0);
    }
    expect(calls.map((call) => call.status)).toEqual([202, 202, 202, 200]);
    await expect.poll(() => page.evaluate<unknown>("window.said")).toEqual({ text: "An idea for the next team lunch.", language: "en-US" });
    expect(new Set(calls.map((call) => JSON.stringify(call.body)))).toEqual(new Set([JSON.stringify({ task: "transcribe", recording: `/app-media/${NICKNAME}/${VOICE_ID}` })]));

    // A job that never ends: 3 minutes of asking, then the message (the first ask at 0 s, then one every 3 s up to 180 s).
    calls = [];
    transcriber.looksToFinish = 10_000;
    transcriber.jobs.clear();
    await page.evaluate(`window.said = undefined; workshopData.ai.transcribe(${JSON.stringify(voiceAddress())}).then((value) => { window.said = value; }, (error) => { window.said = error.message; }); undefined`);
    for (let n = 1; n <= 61; n += 1) {
      await expect.poll(() => calls.length).toBe(n);
      await expect.poll(() => calls[n - 1]?.status).toBe(202);
      await page.waitForTimeout(20);
      await page.clock.runFor(3_000);
    }
    await expect.poll(() => page.evaluate<unknown>("window.said")).toBe("The recording is still being turned into text. Please try again in a minute.");
    await page.clock.runFor(10_000);
    await page.waitForTimeout(200);
    expect(calls).toHaveLength(61);
    expect(errors).toEqual([]);
  }, 60_000);

  it("WHEN the answer has a wrong shape THEN the helper refuses it with a plain message", async () => {
    await openApp();
    const photo = JSON.stringify(photoAddress());
    const receipt = `[{ name: "shop", type: "text" }, { name: "date", type: "date" }, { name: "total", type: "money" }]`;
    const cases: [string, number, unknown][] = [
      [`workshopData.ai.tagPhoto(${photo})`, 200, { tags: "cat" }],
      [`workshopData.ai.tagPhoto(${photo})`, 200, { tags: ["a", "b", "c", "d", "e", "f"] }],
      [`workshopData.ai.tagPhoto(${photo})`, 200, { tags: [42] }],
      [`workshopData.ai.tagPhoto(${photo})`, 200, { tags: ["x".repeat(201)] }],
      [`workshopData.ai.tagPhoto(${photo})`, 200, { tags: ["cat"], html: "<b>" }],
      [`workshopData.ai.tagPhoto(${photo}, ["Portrait", "Pencil"])`, 200, { tags: ["Crayon"] }],
      [`workshopData.ai.tagPhoto(${photo})`, 202, { status: "working" }],
      [`workshopData.ai.readPhoto(${photo}, ${receipt})`, 200, { values: { shop: "A", date: "2026-11-14" } }],
      [`workshopData.ai.readPhoto(${photo}, ${receipt})`, 200, { values: { shop: "A", date: "14.11.2026", total: null } }],
      [`workshopData.ai.readPhoto(${photo}, ${receipt})`, 200, { values: { shop: "A", date: null, total: { amount: "12.40", currency: "EUR" } } }],
      [`workshopData.ai.readPhoto(${photo}, ${receipt})`, 200, { values: { shop: "A", date: null, total: { amount: 12.4, currency: "euro" } } }],
      [`workshopData.ai.readPhoto(${photo}, ${receipt})`, 200, { values: { shop: 7, date: null, total: null } }],
      [`workshopData.ai.readPhoto(${photo}, ${receipt})`, 200, { values: { shop: "A", date: null, total: null, extra: "x" } }],
      [`workshopData.ai.readPhoto(${photo}, ${receipt})`, 200, { shop: "A", date: null, total: null }],
      [`workshopData.ai.sortText("hello", ["Ideas", "News"])`, 200, { categories: ["Gossip"] }],
      [`workshopData.ai.sortText("hello", ["Ideas", "News"])`, 200, { categories: ["Ideas", "Ideas"] }],
      [`workshopData.ai.transcribe(${JSON.stringify(voiceAddress())})`, 200, { text: 42, language: "en-US" }],
      [`workshopData.ai.transcribe(${JSON.stringify(voiceAddress())})`, 200, { text: "hi", language: "<script>" }],
      [`workshopData.ai.transcribe(${JSON.stringify(voiceAddress())})`, 202, { status: "done" }],
      [`workshopData.ai.sortText("hello", ["Ideas"])`, 200, "not json"],
    ];
    for (const [expression, status, body] of cases) {
      answerNext = { status, body: body === "not json" ? "<html>" : JSON.stringify(body) };
      expect(await outcome(expression), `${expression} answered ${JSON.stringify(body)}`).toEqual({ error: ODD_ANSWER });
    }
    expect(calls).toHaveLength(cases.length);
    expect(errors).toEqual([]);
  });
});

describe("criterion 2: a refusal carries the route's message, and the app shows it (ticket 3.22)", () => {
  const today = () => utcDay(new Date());

  it("WHEN the app uses AGENTS.md rule 16's example and the AI answers THEN the suggestion fills the field, nothing is saved until Save, and Save saves it", async () => {
    expect(RULE_EXAMPLE).toContain("workshopData.ai.tagPhoto(address)");
    expect(RULE_EXAMPLE).not.toContain("innerHTML");
    await openApp();
    await page.click("#suggest");
    await expect.poll(statusText).toBe("Suggested tags: keep, change or remove them, then press Save.");
    expect(await page.inputValue("#tags")).toBe("cat, drawing");
    expect(dataWrites).toEqual([]);
    await page.fill("#tags", "cat, crayon");
    await page.click("#save");
    await expect.poll(statusText).toBe("Saved.");
    expect(dataWrites.map((write) => JSON.parse(write.body) as unknown)).toEqual([[{ photo: photoAddress(), tags: ["cat", "crayon"] }]]);
    expect(errors).toEqual([]);
  });

  it("WHEN AI is switched off, or the app's, the person's or the workshop's allowance is spent THEN the app shows the route's message, and the visitor can still type the tags and save", async () => {
    const refusals: [string, () => void, number, string][] = [
      ["switched off", () => (store.settings = { ...store.settings, appAiEnabled: false }), 503, APP_AI_TEXTS.switchedOff],
      ["global Stop", () => (store.settings = { ...store.settings, appAiEnabled: true, stopped: true }), 503, APP_AI_TEXTS.switchedOff],
      ["app's $1", () => store.apps.set(NICKNAME, { day: today(), usd: APP_AI_DAILY_BUDGET_USD }), 429, APP_AI_TEXTS.appBudget],
      ["person's $1", () => store.writers.set("bob", { day: today(), usd: WRITER_AI_DAILY_BUDGET_USD }), 429, APP_AI_TEXTS.writerBudget],
      ["workshop's $10", () => (store.all = { day: today(), usd: ALL_APPS_AI_DAILY_BUDGET_USD }), 429, APP_AI_TEXTS.workshopBudget],
    ];
    allowed.push(LOGGED(503), LOGGED(429));
    for (const [name, refuse, status, message] of refusals) {
      store.settings = { ...store.settings, appAiEnabled: true, stopped: false };
      store.apps.clear();
      store.writers.clear();
      store.all = { day: undefined, usd: 0 };
      refuse();
      calls = [];
      dataWrites = [];
      // A goto that changes only the fragment does not reload the page.
      await page.goto("about:blank");
      await openApp();
      await page.click("#suggest");
      await expect.poll(statusText, { message: name }).toBe(message);
      expect(calls.map((call) => call.status), name).toEqual([status]);
      expect(model.calls, name).toEqual([]);
      expect(await page.inputValue("#tags"), name).toBe("");
      // Everything works without AI: the visitor types the tags and saves.
      await page.fill("#tags", "cat");
      await page.click("#save");
      await expect.poll(statusText, { message: name }).toBe("Saved.");
      expect(dataWrites, name).toHaveLength(1);
    }
    // The helper's error itself carries the message.
    store.settings = { ...store.settings, appAiEnabled: false };
    expect(await outcome(`workshopData.ai.sortText("hello", ["Ideas"])`)).toEqual({ error: APP_AI_TEXTS.switchedOff });
    expect(errors).toEqual([]);
  });

  it("WHEN a 429 carries no message (the firewall's rate rule) THEN the helper says to try again in a minute", async () => {
    allowed.push(LOGGED(429));
    await openApp();
    answerNext = { status: 429, body: "" };
    expect(await outcome(`workshopData.ai.tagPhoto(${JSON.stringify(photoAddress())})`)).toEqual({ error: "Too many AI requests right now. Please try again in a minute." });
    expect(errors).toEqual([]);
  });

  it("WHEN the sign-in has ended (the route answers 401) THEN its message shows and the sign-in button comes back; a visitor gets the message without anything sent", async () => {
    allowed.push(LOGGED(401));
    await openApp();
    expect(await page.locator("[data-workshop-sign-in]").isHidden()).toBe(true);
    store.tokens.tokens.clear();
    await page.click("#suggest");
    await expect.poll(statusText).toBe(APP_SIGN_IN_TEXTS.signInToSave);
    expect(calls.map((call) => call.status)).toEqual([401]);
    expect(await page.getByRole("button", { name: "Sign in to save" }).isVisible()).toBe(true);

    calls = [];
    await page.goto("about:blank");
    await openApp("");
    await page.click("#suggest");
    await expect.poll(statusText).toBe(APP_SIGN_IN_TEXTS.signInToSave);
    expect(await outcome(`workshopData.ai.transcribe(${JSON.stringify(voiceAddress())})`)).toEqual({ error: APP_SIGN_IN_TEXTS.signInToSave });
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });
});
