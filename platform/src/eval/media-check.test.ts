// Ticket 3.19: the build eval's media check (`exerciseMedia` in ./build.ts) on hand-written apps, in Playwright's
// Chromium under the apps' sandbox CSP with the eval's in-memory workshop: a photo gallery that uploads on Save, a voice
// app whose Record button opens the phone's recorder (Chromium refuses the microphone in the sandbox), and apps that
// get it wrong (a blob: preview never uploaded, a recording not kept in the data).
import { readFileSync } from "node:fs";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppFile } from "../../api/build/check.js";
import { exerciseMedia, launchBrowser } from "./build.js";
import { mediaProblem } from "./logic.js";

const CLIENT = readFileSync(new URL("../../../templates/basic/workshop-data.js", import.meta.url));
const file = (path: string, text: string | Uint8Array): AppFile => ({ path, kind: "file", bytes: typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text) });
const app = (body: string, script: string): AppFile[] => [
  file("index.html", `<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="workshop-data.js"></script><title>App</title><link rel="icon" href="data:,"><script src="app.js" defer></script></head><body>${body}<p id="status" role="status"></p></body></html>`),
  file("app.js", `"use strict";\nconst statusText = document.getElementById("status");\n${script}`),
  file("workshop-data.js", CLIENT),
];

const GALLERY = app(
  `<h1>Drawing Gallery</h1>
  <section><h2>Gallery</h2><label for="filter">Filter by tag</label><select id="filter"><option value="">All</option></select><div id="grid"></div></section>
  <section><h2>Add a photo</h2><form id="add">
    <label for="photo-input">Take a photo</label><input id="photo-input" type="file" accept="image/*" capture="environment">
    <label for="tags">Tags</label><input id="tags" type="text">
    <button type="submit">Save</button>
  </form><p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p></section>`,
  `let photos = [];
  const grid = document.getElementById("grid");
  function draw() {
    grid.textContent = "";
    for (const item of photos) { const img = document.createElement("img"); img.src = item.photo; img.alt = item.tags.join(", "); img.loading = "lazy"; grid.append(img); }
  }
  document.getElementById("add").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("photo-input");
    try {
      const address = await workshopData.savePhoto(input.files[0]);
      photos = [{ photo: address, tags: document.getElementById("tags").value.split(","), added: "2026-11-27" }, ...photos];
      await workshopData.set("gallery-v1", photos);
      draw();
    } catch (error) { statusText.textContent = error.message; }
  });
  workshopData.get("gallery-v1").then((stored) => { photos = stored || []; draw(); }, (error) => { statusText.textContent = error.message; });`,
);

const VOICE = app(
  `<h1>Voice Notes</h1><section><h2>Messages</h2><label for="topic-filter">Topic</label><select id="topic-filter"><option>All</option></select><ul id="list"></ul></section>
  <section><h2>Record</h2><button id="record" type="button">Record</button><p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p></section>`,
  `let recording = null;
  const button = document.getElementById("record");
  button.addEventListener("click", async () => {
    if (recording !== null) { recording.stop(); return; }
    try {
      recording = await workshopData.recordVoice();
      button.textContent = "Stop";
      const address = await recording.done;
      ${"/*KEEP*/"}
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "none"; audio.src = address;
      document.getElementById("list").append(audio);
    } catch (error) { statusText.textContent = error.message; } finally { recording = null; button.textContent = "Record"; }
  });`,
);

describe("the build eval's media check (exerciseMedia)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("WHEN a gallery uploads the picked photo on Save, keeps its address in the data and shows it THEN the check passes", async () => {
    const check = await exerciseMedia(browser, GALLERY, "photo", []);
    expect(check).toEqual({ kind: "photo", button: true, uploaded: true, keptInData: true, shown: true, missingWords: [], errors: [] });
    expect(mediaProblem(check)).toBeUndefined();
  }, 60_000);

  it("WHEN the photo form is on a screen opened by a tab (live eval run 1: the Save button was hidden until then) THEN the check opens it first", async () => {
    const tabbed = GALLERY.map((f) => {
      const text = new TextDecoder().decode(f.bytes);
      if (f.path === "index.html") {
        return file("index.html", text.replace('<section><h2>Add a photo</h2>', '<button type="button" role="tab" id="open-add" aria-controls="screen-add">Add a photo</button><section id="screen-add" hidden><h2>Add a photo</h2>'));
      }
      if (f.path === "app.js") return file("app.js", `${text}\ndocument.getElementById("open-add").addEventListener("click", () => { document.getElementById("screen-add").hidden = false; });`);
      return f;
    });
    expect(new TextDecoder().decode(tabbed[0]?.bytes)).toContain('id="screen-add" hidden');
    const check = await exerciseMedia(browser, tabbed, "photo", []);
    expect(check).toEqual({ kind: "photo", button: true, uploaded: true, keptInData: true, shown: true, missingWords: [], errors: [] });
  }, 60_000);

  it("WHEN a voice app's Record button opens the phone's recorder and the recording is kept and played THEN the check passes", async () => {
    const files = VOICE.map((f) => (f.path === "app.js" ? file("app.js", new TextDecoder().decode(f.bytes).replace("/*KEEP*/", 'await workshopData.set("voice-v1", [{ voice: address, topic: "Ideas" }]);')) : f));
    const check = await exerciseMedia(browser, files, "voice", []);
    expect(check).toEqual({ kind: "voice", button: true, uploaded: true, keptInData: true, shown: true, missingWords: [], errors: [] });
  }, 60_000);

  it("WHEN the Record button sits on a screen opened by a \"Record\" tab and the list is drawn only when the app opens (live eval run 1) THEN the check presses the real button and looks again after a reload", async () => {
    const files = app(
      `<h1>Voice Notes</h1><nav role="tablist"><button type="button" role="tab" aria-controls="screen-record" id="tab-record">Record</button></nav>
      <section id="screen-messages"><h2>Messages</h2><label for="t">Topic</label><select id="t"><option>All</option></select><ul id="list"></ul></section>
      <section id="screen-record" hidden><h2>Record</h2><button id="record" type="button">Record</button>
      <p><button class="sign-in" type="button" data-workshop-sign-in hidden>Sign in to save</button></p></section>`,
      `document.getElementById("tab-record").addEventListener("click", () => { document.getElementById("screen-record").hidden = false; });
      let recording = null;
      document.getElementById("record").addEventListener("click", async () => {
        if (recording !== null) { recording.stop(); return; }
        try {
          recording = await workshopData.recordVoice();
          const address = await recording.done;
          await workshopData.set("voice-v1", [{ voice: address, topic: "Ideas" }]);
        } catch (error) { statusText.textContent = error.message; } finally { recording = null; }
      });
      workshopData.get("voice-v1").then((notes) => {
        for (const note of notes || []) { const audio = document.createElement("audio"); audio.controls = true; audio.preload = "none"; audio.src = note.voice; document.getElementById("list").append(audio); }
      }, (error) => { statusText.textContent = error.message; });`,
    );
    const check = await exerciseMedia(browser, files, "voice", []);
    expect(check).toEqual({ kind: "voice", button: true, uploaded: true, keptInData: true, shown: true, missingWords: [], errors: [] });
  }, 60_000);

  it("WHEN the recording is not kept in the data, or the photo is only previewed from a blob: address THEN the check says so", async () => {
    expect(mediaProblem(await exerciseMedia(browser, VOICE, "voice", []))).toBe("the recording's address was not saved in the data");
    const preview = app(
      `<h2>Tags</h2><input id="p" type="file" accept="image/*"><img id="i" alt="">`,
      `document.getElementById("p").addEventListener("change", () => { document.getElementById("i").src = URL.createObjectURL(document.getElementById("p").files[0]); });`,
    );
    const check = await exerciseMedia(browser, preview, "photo", []);
    expect(check.uploaded).toBe(false);
    expect(mediaProblem(check)).toMatch(/^the photo was not uploaded; 1 console error\(s\) while uploading: Loading the image 'blob:/);
    expect(mediaProblem(await exerciseMedia(browser, [file("index.html", "<!doctype html><title>x</title>"), file("workshop-data.js", CLIENT)], "voice", []))).toBe('no Record button; no label with "topic"');
  }, 120_000);
});
