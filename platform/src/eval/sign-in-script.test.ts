// Ticket 3.25 try 2 (checker, finding D): the build eval's sign-in check counts only sign-in elements a visitor really
// sees, in Playwright's Chromium (the script runs in the page there). Try 3: "sees" once the app shows the part it is
// in, however the app hides that part (attribute or CSS), never one the app hides itself.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGN_IN_SCRIPT } from "./logic.js";

describe("SIGN_IN_SCRIPT (the build eval's sign-in check)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 375, height: 740 } });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const count = async (body: string) => {
    await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
    return page.evaluate<{ shown: number; visible: number }>(SIGN_IN_SCRIPT);
  };
  const BUTTON = '<button type="button" data-workshop-sign-in>Sign in to save</button>';

  it("counts a sign-in button a visitor sees, and marks it for the click", async () => {
    expect(await count(`<main><p>${BUTTON}</p></main>`)).toEqual({ shown: 1, visible: 1 });
    expect(await page.locator("[data-eval-sign-in]").count()).toBe(1);
    expect(await count('<a href="#" data-workshop-sign-in aria-label="Sign in to save">→</a>')).toEqual({ shown: 1, visible: 1 });
  });

  it("counts one in a section the app shows later (an ancestor's hidden attribute) as shown, not visible: nothing to press yet", async () => {
    expect(await count(`<section hidden><div hidden><p>${BUTTON}</p></div></section>`)).toEqual({ shown: 1, visible: 0 });
    expect(await page.locator("[data-eval-sign-in]").count()).toBe(0);
  });

  // Try 3: apps also switch screens with CSS classes (live eval: `<section class="screen hidden">` with
  // `.screen.hidden { display: none }`); the button is still there for the visitor once that screen is open.
  it("counts one inside an ancestor hidden by CSS (display:none, visibility:hidden, opacity 0) as shown, not visible", async () => {
    for (const body of [
      `<style>.screen.hidden{display:none}</style><section class="screen hidden"><h2>Add</h2>${BUTTON}</section>`,
      `<div style="display:none">${BUTTON}</div>`,
      `<section hidden><div style="display:none">${BUTTON}</div></section>`,
      `<section hidden style="opacity:0">${BUTTON}</section>`,
      `<div style="visibility:hidden">${BUTTON}</div>`,
      `<div style="opacity:0">${BUTTON}</div>`,
    ]) {
      expect(await count(body), body).toEqual({ shown: 1, visible: 0 });
      expect(await page.locator("[data-eval-sign-in]").count(), body).toBe(0);
    }
  });

  it("does not count one hidden by its own hidden attribute or its own styles (display:none, visibility:hidden, opacity 0)", async () => {
    for (const body of [
      BUTTON.replace("data-workshop-sign-in", "data-workshop-sign-in hidden"),
      BUTTON.replace("data-workshop-sign-in", 'data-workshop-sign-in style="display:none"'),
      BUTTON.replace("data-workshop-sign-in", 'data-workshop-sign-in style="visibility:hidden"'),
      BUTTON.replace("data-workshop-sign-in", 'data-workshop-sign-in style="opacity:0"'),
      `<style>.sign-in{display:none}</style>${BUTTON.replace("<button", '<button class="sign-in"')}`,
      `<div style="visibility:hidden"><p style="visibility:visible"><button type="button" data-workshop-sign-in style="visibility:hidden">Sign in to save</button></p></div>`,
    ]) {
      expect(await count(body), body).toEqual({ shown: 0, visible: 0 });
      expect(await page.locator("[data-eval-sign-in]").count(), body).toBe(0);
    }
  });

  it("presses one really visible on load, not an earlier one inside a hidden screen", async () => {
    expect(await count(`<section class="x" style="display:none">${BUTTON}</section><main>${BUTTON.replace("Sign in to save", "Sign in to save here")}</main>`)).toEqual({ shown: 2, visible: 1 });
    expect(await page.locator("[data-eval-sign-in]").textContent()).toBe("Sign in to save here");
  });

  it("does not count one that does not read Sign in", async () => {
    expect(await count('<button type="button" data-workshop-sign-in>Save</button>')).toEqual({ shown: 0, visible: 0 });
  });

  it("counts a shown one that takes no room as shown, not visible (nothing to press)", async () => {
    expect(await count(`<div style="width:0;height:0;overflow:hidden"><span data-workshop-sign-in style="display:inline-block;width:0;height:0;overflow:hidden">Sign in</span></div>`)).toEqual({ shown: 1, visible: 0 });
  });
});
