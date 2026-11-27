// Ticket 3.22: the build eval's AI check (`exerciseAi` in ./build.ts) on hand-written apps, in Playwright's Chromium under
// the apps' sandbox CSP with the eval's in-memory workshop and its stand-in AI route (fixed answers, no Bedrock): a gallery
// that fills the tags field with the suggested tags, an expense app that fills shop, date and total from the receipt, a
// gallery that asks from a "Suggest tags" button and one that shows the tags as chips to tap; and apps that get it wrong
// (saves the suggestion by itself, never asks the AI, asks but never shows the answer).
import { readFileSync } from "node:fs";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAppAiRequest } from "../../api/app-ai/tasks.js";
import type { AppFile } from "../../api/build/check.js";
import { callsAi, exerciseAi, launchBrowser, standInAnswer, STAND_IN_RECEIPT, STAND_IN_TAGS } from "./build.js";
import { aiProblem } from "./logic.js";

const CLIENT = readFileSync(new URL("../../../templates/basic/workshop-data.js", import.meta.url));
const file = (path: string, text: string | Uint8Array): AppFile => ({ path, kind: "file", bytes: typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text) });
const app = (body: string, script: string): AppFile[] => [
  file("index.html", `<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="workshop-data.js"></script><title>App</title><link rel="icon" href="data:,"><script src="app.js" defer></script></head><body>${body}<p id="status" role="status"></p></body></html>`),
  file("app.js", `"use strict";\nconst statusText = document.getElementById("status");\n${script}`),
  file("workshop-data.js", CLIENT),
];

const GALLERY_HTML = `<h1>Sketch Wall</h1><section><h2>Wall</h2><div id="grid"></div></section>
  <section><h2>Add a sketch</h2><form id="add">
    <label for="photo-input">Take a photo</label><input id="photo-input" type="file" accept="image/*" capture="environment">
    <label for="tags">Tags</label><input id="tags" type="text">
    <button type="submit">Save</button>
  </form><p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p></section>`;

/** The gallery's Save: the photo with the tags field's words. `AFTER_PHOTO` runs once the photo is saved. */
const gallery = (afterPhoto: string, extraHtml = "", extraScript = ""): AppFile[] =>
  app(
    GALLERY_HTML.replace("</form>", `${extraHtml}</form>`),
    `let sketches = [];
  let address = null;
  const tagsInput = document.getElementById("tags");
  const input = document.getElementById("photo-input");
  input.addEventListener("change", async () => {
    statusText.textContent = "Saving...";
    try {
      address = await workshopData.savePhoto(input.files[0]);
      input.value = "";
      statusText.textContent = "";
      ${afterPhoto}
    } catch (error) { statusText.textContent = error.message; }
  });
  document.getElementById("add").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      sketches = [{ photo: address, tags: tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean), added: "2026-11-27" }, ...sketches];
      await workshopData.set("sketches-v1", sketches);
      statusText.textContent = "Saved.";
    } catch (error) { statusText.textContent = error.message; }
  });
  ${extraScript}`,
  );

/** AGENTS.md rule 16's way: fill the empty tags field with the suggestion, show the message on a refusal. */
const SUGGEST = `statusText.textContent = "Suggesting tags...";
      try {
        const tags = await workshopData.ai.tagPhoto(address);
        if (tagsInput.value.trim() === "") tagsInput.value = tags.join(", ");
        statusText.textContent = "Suggested tags: keep, change or remove them, then press Save.";
      } catch (error) { statusText.textContent = error.message; }`;

const RECEIPTS = app(
  `<h1>Expense Log</h1><section><h2>Expenses</h2><ul id="list"></ul></section>
  <section><h2>Add an expense</h2><form id="add">
    <label for="photo-input">Photo of the receipt</label><input id="photo-input" type="file" accept="image/*" capture="environment">
    <label for="shop">Shop</label><input id="shop" type="text">
    <label for="date">Date</label><input id="date" type="date">
    <label for="total">Total</label><input id="total" type="number" step="0.01">
    <button type="submit">Save</button>
  </form><p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p></section>`,
  `let address = null;
  const input = document.getElementById("photo-input");
  input.addEventListener("change", async () => {
    try {
      address = await workshopData.savePhoto(input.files[0]);
      statusText.textContent = "Reading the receipt...";
      const values = await workshopData.ai.readPhoto(address, [{ name: "shop", type: "text" }, { name: "date", type: "date" }, { name: "total", type: "money" }]);
      if (values.shop !== null) document.getElementById("shop").value = values.shop;
      if (values.date !== null) document.getElementById("date").value = values.date;
      if (values.total !== null) document.getElementById("total").value = String(values.total.amount);
      statusText.textContent = "Check the values, then press Save.";
    } catch (error) { statusText.textContent = error.message; }
  });
  document.getElementById("add").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const expense = { photo: address, shop: document.getElementById("shop").value, date: document.getElementById("date").value, total: Number(document.getElementById("total").value), currency: "EUR" };
      await workshopData.set("expenses-v1", [expense]);
      statusText.textContent = "Saved.";
    } catch (error) { statusText.textContent = error.message; }
  });`,
);

const PASS = { button: true, helper: true, uploaded: true, called: true, shown: true, savedEarly: false, saved: true, errors: [] };

describe("the build eval's stand-in AI route (ticket 3.22)", () => {
  it("WHEN a checked request reaches the stand-in THEN it answers the real route's shapes with fixed values", () => {
    const parse = (body: unknown) => {
      const parsed = parseAppAiRequest(body, "eval-app");
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.request;
    };
    const photo = "/app-media/eval-app/AbCdEfGhIjKlMnOpQrStUv";
    expect(standInAnswer(parse({ task: "tag-photo", photo }))).toEqual({ tags: STAND_IN_TAGS });
    expect(standInAnswer(parse({ task: "tag-photo", photo, tags: ["Portrait", "Pencil", "Ink"] }))).toEqual({ tags: ["Portrait", "Pencil"] });
    expect({ ...(standInAnswer(parse({ task: "read-photo", photo, fields: [{ name: "shop", type: "text" }, { name: "on", type: "date" }, { name: "sum", type: "money" }, { name: "n", type: "number" }] })).values as object) }).toEqual({
      shop: STAND_IN_RECEIPT.text,
      on: STAND_IN_RECEIPT.date,
      sum: { amount: STAND_IN_RECEIPT.amount, currency: STAND_IN_RECEIPT.currency },
      n: STAND_IN_RECEIPT.amount,
    });
    expect(standInAnswer(parse({ task: "sort-text", text: "hi", categories: ["Ideas", "News"] }))).toEqual({ categories: ["Ideas"] });
    expect(standInAnswer(parse({ task: "transcribe", recording: photo }))).toEqual({ text: "An idea for the next team lunch.", language: "en-US" });
  });
});

describe("the build eval's AI check (exerciseAi, ticket 3.22)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("WHEN a gallery fills the tags field with the suggested tags once the photo is saved, and saves on Save THEN the check passes", async () => {
    const check = await exerciseAi(browser, gallery(SUGGEST), "ai-tags");
    expect(check).toEqual({ kind: "ai-tags", ...PASS });
    expect(aiProblem(check)).toBeUndefined();
  }, 60_000);

  it("WHEN an expense app fills shop, date and total from the receipt and saves on Save THEN the check passes", async () => {
    const check = await exerciseAi(browser, RECEIPTS, "ai-receipt");
    expect(check).toEqual({ kind: "ai-receipt", ...PASS });
  }, 60_000);

  it("WHEN the suggestion comes from a \"Suggest tags\" button THEN the check presses it and passes", async () => {
    const files = gallery("", '<button id="suggest" type="button">Suggest tags</button>', `document.getElementById("suggest").addEventListener("click", async () => { ${SUGGEST} });`);
    expect(await exerciseAi(browser, files, "ai-tags")).toEqual({ kind: "ai-tags", ...PASS });
  }, 60_000);

  it("WHEN the suggested tags are chips the visitor taps to add THEN the check taps them, saves and passes", async () => {
    const files = gallery(
      `const tags = await workshopData.ai.tagPhoto(address);
      const chips = document.getElementById("chips");
      chips.textContent = "";
      for (const tag of tags) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.textContent = tag;
        chip.addEventListener("click", () => { tagsInput.value = (tagsInput.value ? tagsInput.value + ", " : "") + tag; chip.remove(); });
        chips.append(chip);
      }`,
      '<div id="chips" role="group" aria-label="Suggested tags"></div>',
    );
    expect(await exerciseAi(browser, files, "ai-tags")).toEqual({ kind: "ai-tags", ...PASS });
  }, 60_000);

  it("WHEN the app saves the suggestion by itself THEN the check fails on saving before acceptance", async () => {
    const files = gallery(`const tags = await workshopData.ai.tagPhoto(address);
      tagsInput.value = tags.join(", ");
      await workshopData.set("sketches-v1", [{ photo: address, tags: tags }]);`);
    const check = await exerciseAi(browser, files, "ai-tags");
    expect(check.savedEarly).toBe(true);
    expect(aiProblem(check)).toBe("the AI's suggestion was saved before the visitor accepted it");
  }, 60_000);

  it("WHEN the app's code calls a workshopData.ai helper THEN callsAi says so (the workshop's own client does not count)", () => {
    expect(callsAi(gallery(SUGGEST))).toBe(true);
    expect(callsAi(RECEIPTS)).toBe(true);
    expect(callsAi(gallery(""))).toBe(false);
  });

  it("WHEN the app never asks the AI THEN the check fails on the helper and on the AI request", async () => {
    const check = await exerciseAi(browser, gallery(""), "ai-tags");
    expect(check).toMatchObject({ helper: false, uploaded: true, called: false });
    expect(aiProblem(check)).toBe("the app's code does not call workshopData.ai.tagPhoto; the app did not ask the AI (tag-photo) for the picked photo");
  }, 60_000);

  it("WHEN the app asks the AI but keeps the answer out of sight THEN the check fails on showing it", async () => {
    const files = gallery(`window.hiddenTags = await workshopData.ai.tagPhoto(address);`);
    const check = await exerciseAi(browser, files, "ai-tags");
    expect(check).toMatchObject({ called: true, shown: false, savedEarly: false });
    expect(aiProblem(check)).toMatch(/^the AI's suggestion is not shown on the page/);
  }, 60_000);
});
