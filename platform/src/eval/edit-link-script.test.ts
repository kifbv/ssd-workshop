// Ticket 3.28 (replaces 3.25's sign-in script test): the build eval's edit-link check, in Playwright's Chromium.
// - The in-page scripts: which controls count as saving controls a visitor sees (SAVING_CONTROLS_SCRIPT), which open a
//   spec's screens (SCREEN_OPENERS_SCRIPT), and the fill-and-save helper (FILL_AND_MARK_SAVE_SCRIPT).
// - `exerciseEditLink` on hand-written apps under the apps' sandbox CSP with the eval's in-memory workshop and the real
//   workshop-data.js: an app written as AGENTS.md rule 6 asks passes; apps that show a saving control to a visitor (on
//   another screen, or on each saved item), save when the page opens, or cannot save with the edit link, fail.
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppFile } from "../../api/build/check.js";
import { exerciseEditLink, launchBrowser, withoutOutsideFailures } from "./build.js";
import { editLinkProblem, FILL_AND_MARK_SAVE_SCRIPT, SAVING_CONTROLS_SCRIPT, SCREEN_OPENERS_SCRIPT, SEARCH_BUTTON_SCRIPT } from "./logic.js";

describe("the edit-link check's scripts", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 375, height: 740 } });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const SCREENS = ["Watchlist", "Add a film", "Watched"];
  const controls = async (body: string): Promise<string[]> => {
    await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
    return page.evaluate<string[]>(`${SAVING_CONTROLS_SCRIPT}(${JSON.stringify(SCREENS)})`);
  };

  it("SAVING_CONTROLS_SCRIPT counts visible saving buttons and photo inputs, by their words", async () => {
    expect(await controls('<button type="button">Save</button><button>Add to watchlist</button><input type="submit" value="Post"><button aria-label="Delete Casablanca">×</button><span role="button">★</span>')).toEqual([
      "Save",
      "Add to watchlist",
      "Post",
      "× Delete Casablanca",
      "★",
    ]);
    // A photo input hidden by its class, behind a visible label, counts.
    expect(await controls('<label for="p">Take a photo</label><input id="p" type="file" accept="image/*" style="position:absolute;width:1px;height:1px;opacity:0">')).toEqual(["file input (Take a photo)"]);
  });

  it("SAVING_CONTROLS_SCRIPT leaves out what a visitor cannot see, screen tabs, other buttons and old sign-in elements", async () => {
    for (const body of [
      '<button hidden>Save</button>',
      '<section hidden><button>Save</button></section>',
      '<div style="display:none"><button>Add</button></div>',
      '<style>.view-only .edit-only{display:none !important}</style><div class="view-only"><form class="edit-only"><button>Save</button></form></div>',
      '<button style="visibility:hidden">Delete</button>',
      '<button style="opacity:0">Delete</button>',
      '<input type="file" hidden><label>Take a photo</label>',
      '<nav><button>Add a film</button></nav><button role="tab">Add</button><button aria-controls="x">Add</button><button>Watched</button><button>Add a film</button>',
      '<button>Search</button><button>Show more</button><button>Filter by tag</button>',
      '<button data-workshop-sign-in>Sign in to save</button>',
    ]) {
      expect(await controls(body), body).toEqual([]);
    }
  });

  it("SCREEN_OPENERS_SCRIPT marks the visible control named after each screen, exactly before partly", async () => {
    await page.setContent('<!doctype html><button>Watchlist</button><div role="tablist"><button role="tab">+ Add a film</button></div><button hidden>Watched</button><button>Watched list</button>');
    expect(await page.evaluate<number>(`${SCREEN_OPENERS_SCRIPT}(${JSON.stringify(SCREENS)})`)).toBe(2);
    expect(await page.locator('[data-eval-opener="0"]').textContent()).toBe("Watchlist");
    expect(await page.locator('[data-eval-opener="1"]').textContent()).toBe("+ Add a film");
    expect(await page.locator('[data-eval-opener="2"]').count()).toBe(0);
  });

  it("SEARCH_BUTTON_SCRIPT marks the visible Search button, never a screen tab holding \"find\" (live eval run 1)", async () => {
    await page.setContent('<!doctype html><nav role="tablist"><button role="tab" aria-controls="f">Find a film</button></nav><button hidden>Search</button><button>Search</button>');
    expect(await page.evaluate<boolean>(`${SEARCH_BUTTON_SCRIPT}(${JSON.stringify(["Find a film"])})`)).toBe(true);
    expect(await page.locator("[data-eval-search]").count()).toBe(1);
    expect(await page.locator("[data-eval-search]").getAttribute("role")).toBeNull();
    await page.setContent('<!doctype html><nav role="tablist"><button role="tab">Find a film</button></nav>');
    expect(await page.evaluate<boolean>(`${SEARCH_BUTTON_SCRIPT}(${JSON.stringify(["Find a film"])})`)).toBe(false);
  });

  it("FILL_AND_MARK_SAVE_SCRIPT fills empty visible fields within their limits and marks Save before Add", async () => {
    await page.setContent(`<!doctype html><form>
      <label for="t">Title</label><input id="t">
      <label for="y">Year</label><input id="y" type="number" min="1888" max="2030">
      <label for="d">Distance (km)</label><input id="d" type="text">
      <input id="when" type="date"><input id="kept" value="mine"><input id="h" hidden>
      <select id="s"><option value="">Choose</option><option value="ideas">Ideas</option></select>
      <select id="f" aria-label="Filter"><option value="">All</option><option value="x">x</option></select>
      <input type="radio" name="stars" value="1"><input type="radio" name="stars" value="2">
      <button type="button">Add another</button><button type="submit">Save</button></form><button>Watched</button>`);
    expect(await page.evaluate<boolean>(`${FILL_AND_MARK_SAVE_SCRIPT}(${JSON.stringify(SCREENS)})`)).toBe(true);
    expect(await page.evaluate<unknown>(`["t", "y", "d", "when", "kept", "h", "s", "f"].map((id) => document.getElementById(id).value)`)).toEqual([
      "Casablanca",
      "1942",
      "5",
      "2026-11-27",
      "mine",
      "",
      "ideas",
      "",
    ]);
    expect(await page.evaluate<unknown>(`document.querySelector("input[name=stars]:checked").value`)).toBe("1");
    expect(await page.locator("[data-eval-save]").textContent()).toBe("Save");
    // Without a Save: an Add; a screen tab never.
    await page.setContent('<!doctype html><button>Watched</button><button>Add</button>');
    expect(await page.evaluate<boolean>(`${FILL_AND_MARK_SAVE_SCRIPT}(${JSON.stringify(SCREENS)})`)).toBe(true);
    expect(await page.locator("[data-eval-save]").textContent()).toBe("Add");
    await page.setContent('<!doctype html><button>Watched</button><button>Search</button>');
    expect(await page.evaluate<boolean>(`${FILL_AND_MARK_SAVE_SCRIPT}(${JSON.stringify(SCREENS)})`)).toBe(false);
  });
});

describe("exerciseEditLink (the build eval's edit-link check) on hand-written apps", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const CLIENT = readFileSync(new URL("../../../templates/basic/workshop-data.js", import.meta.url));
  const file = (path: string, text: string | Uint8Array): AppFile => ({ path, kind: "file", bytes: typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text) });
  const SCREENS = ["Watchlist", "Add a film"];
  const STYLE = ".view-only .edit-only { display: none !important; }\n.view-only-note { display: none; }\n.view-only .view-only-note { display: block; }\n";

  /**
   * A watchlist app as AGENTS.md rule 6 asks: two screens switched by tabs, an Add a film form with a Save button, a
   * Delete button on each film; `options` breaks it one way.
   */
  const watchlist = (options: { formShown?: boolean; deleteShown?: boolean; saveOnOpen?: boolean; noSave?: boolean } = {}): AppFile[] => [
    file(
      "index.html",
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="workshop-data.js"></script><title>Movie Watchlist</title><link rel="icon" href="data:,"><link rel="stylesheet" href="style.css"><script src="app.js" defer></script></head><body>
      <h1>Movie Watchlist</h1>
      <div role="tablist"><button role="tab" id="tab-list" type="button">Watchlist</button><button role="tab" id="tab-add" type="button">Add a film</button></div>
      <section id="list"><h2>Watchlist</h2><ul id="films"></ul><p class="view-only-note">View only</p></section>
      <section id="add" hidden><h2>Add a film</h2><form id="form" class="${options.formShown ? "" : "edit-only"}">
        <label for="title">Title</label><input id="title" required>
        <label for="year">Year</label><input id="year" type="number" min="1888" max="2030" required>
        <button type="submit">${options.noSave ? "Keep" : "Save"}</button></form></section>
      <p id="status" role="status"></p></body></html>`,
    ),
    file("style.css", STYLE),
    file(
      "app.js",
      `"use strict";
      if (!workshopData.canSave()) document.body.classList.add("view-only");
      const status = document.getElementById("status");
      let films = [];
      const draw = () => {
        const list = document.getElementById("films");
        list.textContent = "";
        for (const film of films) {
          const item = document.createElement("li");
          item.textContent = film.title + " (" + film.year + ") ";
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete";
          ${options.deleteShown ? "" : 'remove.className = "edit-only";'}
          remove.addEventListener("click", async () => { films = films.filter((f) => f !== film); try { await workshopData.set("films-v1", films); draw(); } catch (e) { status.textContent = e.message; } });
          item.append(remove);
          list.append(item);
        }
      };
      const show = (name) => { document.getElementById("list").hidden = name !== "list"; document.getElementById("add").hidden = name !== "add"; };
      document.getElementById("tab-list").addEventListener("click", () => show("list"));
      document.getElementById("tab-add").addEventListener("click", () => show("add"));
      document.getElementById("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (${options.noSave ? "true" : "false"}) return;
        films.push({ title: document.getElementById("title").value, year: Number(document.getElementById("year").value) });
        try { await workshopData.set("films-v1", films); status.textContent = "Saved."; draw(); show("list"); } catch (e) { status.textContent = e.message; }
      });
      (async () => {
        try { films = (await workshopData.get("films-v1")) || []; draw(); } catch (e) { status.textContent = e.message; }
        ${options.saveOnOpen ? 'try { await workshopData.set("visits-v1", 1); } catch (e) { status.textContent = e.message; }' : ""}
      })();`,
    ),
    file("workshop-data.js", CLIENT),
  ];

  it("WHEN the app hides its saving controls without the edit link and saves with it THEN the check passes", async () => {
    const check = await exerciseEditLink(browser, watchlist(), SCREENS, true);
    expect(check).toEqual({
      editorCanSave: true,
      editorControls: 1,
      savedOnOpen: 0,
      saved: true,
      editorOverflow: 0,
      editorErrors: [],
      visitorCanSave: false,
      visitorControls: [],
      visitorRefused: false,
    });
    expect(editLinkProblem(check)).toBeUndefined();
  }, 60_000);

  it("WHEN a visitor sees the form on another screen, or a Delete button on each saved film THEN the check fails, naming them", async () => {
    const form = await exerciseEditLink(browser, watchlist({ formShown: true }), SCREENS, true);
    expect(form.visitorControls).toEqual(["Save"]);
    expect(editLinkProblem(form)).toBe("a visitor without the edit link sees saving controls: Save");
    const remove = await exerciseEditLink(browser, watchlist({ deleteShown: true }), SCREENS, true);
    expect(remove.saved).toBe(true);
    expect(remove.visitorControls).toEqual(["Delete"]);
  }, 60_000);

  it("WHEN the app saves when the page opens THEN the check fails (with the edit link it wrote; without it, the refusal showed)", async () => {
    const check = await exerciseEditLink(browser, watchlist({ saveOnOpen: true }), SCREENS, true);
    expect(check.savedOnOpen).toBe(1);
    expect(check.visitorRefused).toBe(true);
    expect(editLinkProblem(check)).toMatch(/^saves when the page opens \(1 write\(s\) before anyone did anything\); .*"This link is view only\."/);
  }, 60_000);

  it("WHEN the app shows its Add button only after a search (a film found first) THEN the check searches, adds and passes", async () => {
    const files: AppFile[] = [
      file(
        "index.html",
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="workshop-data.js"></script><title>Film Finder</title><link rel="icon" href="data:,"><link rel="stylesheet" href="style.css"><script src="app.js" defer></script></head><body>
        <h1>Film Finder</h1><nav role="tablist"><button role="tab" aria-controls="find" type="button">Find a film</button></nav>
        <section id="find"><div class="edit-only"><label for="q">Title</label><input id="q"><button id="go" type="button">Search</button></div>
        <div id="result" hidden><h2 id="found"></h2><button id="add" class="edit-only" type="button">Add to watchlist</button></div></section>
        <p id="status" role="status"></p></body></html>`,
      ),
      file("style.css", STYLE),
      file(
        "app.js",
        `"use strict";
        if (!workshopData.canSave()) document.body.classList.add("view-only");
        document.getElementById("go").addEventListener("click", () => {
          document.getElementById("found").textContent = document.getElementById("q").value;
          document.getElementById("result").hidden = false;
        });
        document.getElementById("add").addEventListener("click", async () => {
          try { await workshopData.set("films-v1", [document.getElementById("found").textContent]); } catch (e) { document.getElementById("status").textContent = e.message; }
        });`,
      ),
      file("workshop-data.js", CLIENT),
    ];
    const check = await exerciseEditLink(browser, files, ["Find a film"], true);
    expect(check.saved).toBe(true);
    expect(editLinkProblem(check)).toBeUndefined();
  }, 60_000);

  it("WHEN pressing the app's saving button saves nothing THEN the check fails; a media or AI case is not asked to save here", async () => {
    const check = await exerciseEditLink(browser, watchlist({ noSave: true }), SCREENS, true);
    expect(check.saved).toBe(false);
    expect(editLinkProblem(check)).toBe("no saving control (Save, Add, photo or Record button) with the edit link; with the edit link, filling the fields and pressing Save or Add saved nothing");
    expect((await exerciseEditLink(browser, watchlist(), SCREENS, false)).saved).toBeUndefined();
  }, 60_000);
});

describe("withoutOutsideFailures (ticket 3.28, live eval run 2)", () => {
  it("drops an outside service's CORS line and one ERR_FAILED line per failed outside request, keeping the app's own errors", () => {
    const cors = "Access to fetch at 'https://en.wikipedia.org/api/rest_v1/page/summary/Casablanca' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.";
    const own = "Access to fetch at 'https://workshop.test/api/apps/eval-app/data/x' from origin 'null' has been blocked by CORS policy: ...";
    const failed = "Failed to load resource: net::ERR_FAILED";
    expect(withoutOutsideFailures([cors, failed, "Uncaught TypeError: x is not a function", own, failed], 1)).toEqual(["Uncaught TypeError: x is not a function", own, failed]);
    expect(withoutOutsideFailures([failed], 0)).toEqual([failed]);
  });
});
