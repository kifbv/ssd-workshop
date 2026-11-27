// workshop-data.js: stores the app's data on the workshop's data service, and handles the workshop's sign-in to save.
// Do not change this file: the workshop publishes its own current copy of it with every app. index.html loads it first,
// as the first script in <head>, with no defer or async: <script src="workshop-data.js"></script>.
// Use it from app.js:
//   const score = await workshopData.get("score");   // the stored value, or null when there is none
//   const info = await workshopData.getInfo("score"); // { value, updatedBy, updatedAt }: who saved it last (a nickname) and when
//   await workshopData.set("score", 42);              // any JSON value: number, text, list, object
//   await workshopData.remove("score");
//   const me = await workshopData.whoAmI();           // the visitor's workshop nickname once signed in to save, or null
//   workshopData.signInLink();                        // the address of the workshop's page that signs a visitor in to save
// Photos and voice recordings (each at most 4 MB; anyone with the app's address can see and hear them):
//   const address = await workshopData.savePhoto(file); // a File from <input type="file" accept="image/*">: shrunk to
//                                                       // 2,560 px at most, saved as a JPEG; answers the photo's address
//   const recording = await workshopData.recordVoice(); // call it from a click: records with the microphone, or opens
//                                                       // the phone's own recorder where the browser refuses the microphone
//   recording.stop();                                   // ends a microphone recording (it also ends by itself at 5 minutes)
//   const voice = await recording.done;                 // the recording's address, once it is saved
//   await workshopData.deleteMedia(address);            // deletes a photo or recording this app saved
// Keep each address in the app's data with the item it belongs to, and show it with <img src> or <audio controls src>.
// AI suggestions (each needs the sign-in and can be refused: AI switched off, or today's allowance spent; the error's
// message says which). Show them for the visitor to accept or change, never save them by themselves:
//   const tags = await workshopData.ai.tagPhoto(address);            // up to 5 suggested tags for a photo of this app
//   const picked = await workshopData.ai.tagPhoto(address, ["cat", "dog"]); // or those of these (up to 20) that fit
//   const values = await workshopData.ai.readPhoto(address, [{ name: "total", type: "money" }]); // up to 12 fields typed
//       // text, number, date or money: values.total is { amount: 12.4, currency: "EUR" } (a date is "2026-11-27"), or null
//   const topics = await workshopData.ai.sortText(text, ["Ideas", "News"]); // which of the categories (up to 20) fit a
//                                                                           // text of up to 2,000 characters
//   const said = await workshopData.ai.transcribe(voice); // { text, language } of a recording of this app (it asks
//                                                         // again by itself while the workshop is still working on it)
// Keys use letters, digits, dashes and underscores. Every visitor of the app shares the same data.
// Anyone can read. Saving needs the workshop's own sign-in: give the element that offers it (a button or a link
// reading "Sign in to save", next to where the app saves) the attribute data-workshop-sign-in. This file shows such
// elements to visitors who are not signed in, hides them once they are, and opens the sign-in in a new tab when one is
// pressed. A save refused for lack of sign-in shows them again, and a floating button of its own when none of them
// can be seen (none on the page, or only on another screen): put one by every form or button that saves, on every screen.
"use strict";

(function () {
  // Taken before any other script of the page can run (this file is the page's first script), and the only ones used
  // with the sign-in: code that runs later cannot wrap them to see what is sent.
  const nativeFetch = window.fetch.bind(window);
  const replaceState = history.replaceState.bind(history);
  const replaceLocation = location.replace.bind(location);
  const openWindow = window.open.bind(window);
  const createObject = Object.create;
  const randomValues = crypto.getRandomValues.bind(crypto);
  const startPath = location.pathname;
  const startSearch = location.search;
  const startHash = location.hash;
  const startState = history.state;
  // Every address this file uses is absolute, built from the page's own server as it was at the start: a <base> element
  // added later by app code changes how relative addresses resolve, and must not send a save (or the sign-in) elsewhere.
  const startServer = location.protocol + "//" + location.host;

  const KEY = /^[A-Za-z0-9_-]+$/;
  const PASS = /^[A-Za-z0-9_-]{43}$/;
  const NICKNAME = /^[A-Za-z0-9-]{3,20}$/;
  const SIGN_IN = "[data-workshop-sign-in]";
  const SIGN_IN_TEXT = "Sign in to save";
  // Photos and voice recordings (ticket 3.19): the media service's limits and the messages shown before asking it.
  const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;
  const PHOTO_SIDE = 2560;
  const PHOTO_QUALITIES = [0.85, 0.7, 0.5];
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
  const RECORDING_MS = 5 * 60 * 1000;
  const RECORDING_BITS = 64000;
  const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
  const SIGN_IN_TO_SAVE = "Sign in to the workshop to save in this app.";
  const NO_PHOTO = "Choose a photo first.";
  const UNREADABLE_PHOTO = "This browser cannot read this photo. Try another photo, or take it again with the camera.";
  const TOO_BIG = "This file is too big: a photo or recording can be at most 4 MB.";
  const NO_RECORDING = "No recording was chosen.";
  const NOTHING_RECORDED = "Nothing was recorded. Please try again.";
  const NOT_OUR_MEDIA = "This is not the address of one of this app's photos or recordings.";
  const ODD_ANSWER = "The workshop answered something unexpected. Please try again.";
  const BROKEN_ID = "Something on this page stopped the upload. Please reload the page and try again.";
  // AI suggestions (ticket 3.22): the AI tasks' limits (ticket 3.21, platform/api/app-ai/tasks.ts), checked before asking.
  const AI_FIELD_TYPES = ["text", "number", "date", "money"];
  const AI_MAX_GIVEN_TAGS = 20;
  const AI_MAX_SUGGESTED_TAGS = 5;
  const AI_MAX_FIELDS = 12;
  const AI_MAX_CATEGORIES = 20;
  const AI_MAX_TEXT = 2000;
  const AI_MAX_NAME = 50;
  const AI_MAX_VALUE = 200;
  const AI_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const AI_CURRENCY = /^[A-Z]{3}$/;
  const AI_LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;
  // transcribe: while the workshop answers "still working" (202), ask again every 3 s, for at most 3 minutes in all.
  const TRANSCRIBE_EVERY_MS = 3000;
  const TRANSCRIBE_GIVE_UP_MS = 3 * 60 * 1000;
  const AI_TAGS_PROBLEM = "Give at most 20 tags to choose from, each 1 to 50 characters long and all different.";
  const AI_FIELDS_PROBLEM = "Ask for 1 to 12 fields, each with a name of 1 to 50 characters (all different) and a type: text, number, date or money.";
  const AI_CATEGORIES_PROBLEM = "Give 1 to 20 categories, each 1 to 50 characters long and all different.";
  const AI_TEXT_PROBLEM = "Give a text of 1 to 2,000 characters to sort.";
  const AI_BUSY = "Too many AI requests right now. Please try again in a minute.";
  const STILL_TRANSCRIBING = "The recording is still being turned into text. Please try again in a minute.";

  // The app lives at /apps/<nickname>/; its data at /api/apps/<nickname>/data/<key> on the same server.
  const appMatch = /^\/apps\/([^/]+)\//.exec(startPath);
  const app = appMatch ? appMatch[1] : null;
  const signInAddress = app === null ? null : startServer + "/app-sign-in/?app=" + encodeURIComponent(app);

  // What the workshop's sign-in hands over in the address (#wt=<token>): kept in memory only, never stored or shown.
  let pass = null;
  // The visitor's nickname, as the data service names the token's writer (never taken from the address).
  let nickname = null;

  function appName() {
    if (app === null) {
      throw new Error("This page is not running at its workshop address, so it cannot store data.");
    }
    return app;
  }

  function address(key) {
    const name = appName();
    if (typeof key !== "string" || !KEY.test(key)) {
      throw new Error("A key may only hold letters, digits, dashes and underscores.");
    }
    return startServer + "/api/apps/" + name + "/data/" + key;
  }

  // Reads the hand-off from the address once and removes it at once, keeping any other part after the #.
  function takeHandOff() {
    const parts = startHash.replace(/^#/, "").split("&");
    const rest = [];
    let found = false;
    for (const part of parts) {
      if (part.startsWith("wt=")) {
        found = true;
        if (PASS.test(part.slice(3))) pass = part.slice(3);
      } else if (part !== "") {
        rest.push(part);
      }
    }
    if (!found) return;
    const kept = rest.length > 0 ? "#" + rest.join("&") : "";
    try {
      replaceState(startState, "", startPath + startSearch + kept);
    } catch {
      // A browser that refuses: replace the part after the # instead (no new history entry).
      replaceLocation(kept === "" ? "#" : kept);
    }
  }

  function signInLink() {
    appName();
    return signInAddress;
  }

  // The floating sign-in button this file adds (made once, then reused), or null while there is none.
  let ownButton = null;

  // Shows the sign-in elements to a visitor who is not signed in to save, and hides them once signed in. The floating
  // button is shown only by signedOut(), when no other sign-in element can be seen.
  function showSignIn() {
    const signedIn = pass !== null;
    if (ownButton !== null && signedIn) ownButton.hidden = true;
    for (const element of document.querySelectorAll(SIGN_IN)) {
      if (element === ownButton) continue;
      if (element.textContent.trim() === "" && element.getAttribute("aria-label") === null) element.textContent = SIGN_IN_TEXT;
      if (element.tagName === "A" && signInAddress !== null) {
        element.href = signInAddress;
        element.target = "_blank";
        element.rel = "noopener";
      }
      element.hidden = signedIn;
    }
  }

  // Whether a visitor can see the element: laid out (not display: none, itself or through an ancestor such as a hidden
  // screen), not inside a closed <details> (outside its summary), not visibility: hidden and not transparent. Browsers
  // without checkVisibility get the layout, details and visibility checks.
  function canBeSeen(element) {
    // Every closed <details> around it must hold it in its own summary (nested ones too).
    let closed = element.closest("details:not([open])");
    while (closed !== null) {
      const summary = closed.querySelector(":scope > summary");
      if (summary === null || !summary.contains(element)) return false;
      const outer = closed.parentElement;
      closed = outer === null ? null : outer.closest("details:not([open])");
    }
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    }
    return element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== "hidden";
  }

  // The floating button for a visitor who sees no sign-in element: one for an app made before saving needed sign-in,
  // or one whose sign-in button sits on another screen than the one that saved. Made once, at the bottom right.
  function addSignInButton() {
    if (ownButton !== null) return ownButton;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = SIGN_IN_TEXT;
    button.setAttribute("data-workshop-sign-in", "");
    const look = button.style;
    look.position = "fixed";
    look.right = "1rem";
    look.bottom = "1rem";
    look.zIndex = "2147483647";
    look.minHeight = "2.75rem";
    look.padding = "0.5rem 1.25rem";
    look.border = "none";
    look.borderRadius = "0.5rem";
    look.font = "inherit";
    look.background = "#2f5bd3";
    look.color = "#ffffff";
    look.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.3)";
    ownButton = button;
    document.body.append(button);
    return button;
  }

  // A save, upload, delete or AI call refused for lack of sign-in: show the page's sign-in elements, and the floating
  // button when none of them can be seen where the visitor is.
  function signedOut() {
    pass = null;
    nickname = null;
    showSignIn();
    for (const element of document.querySelectorAll(SIGN_IN)) {
      if (element !== ownButton && canBeSeen(element)) return;
    }
    addSignInButton().hidden = false;
  }

  // Any sign-in element opens the workshop's sign-in page in a new tab (links too, wherever they point).
  document.addEventListener("click", function (event) {
    const target = event.target instanceof Element ? event.target.closest(SIGN_IN) : null;
    if (target === null) return;
    event.preventDefault();
    openWindow(signInLink(), "_blank", "noopener");
  });

  // The request's options, in objects without a prototype: nothing the page adds to Object.prototype is read with them.
  function requestOptions(method, signedIn) {
    const headers = createObject(null);
    headers.accept = "application/json";
    if (signedIn && pass !== null) headers.authorization = "Bearer " + pass;
    const options = createObject(null);
    options.method = method;
    options.credentials = "omit";
    options.headers = headers;
    return options;
  }

  // Sends a request, turning a failed connection into a plain message.
  async function reach(url, options) {
    try {
      return await nativeFetch(url, options);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("The data service could not be reached. Check the connection and try again.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  // The error for a refused request: the service's own message when it gives one (else `fallback`, when given). A refused
  // write offers the sign-in.
  async function refusal(response, write, fallback) {
    if (response.status === 404) {
      return new Error("This app is not live on the workshop yet, so it cannot load or save data.");
    }
    let message = fallback || "The data service answered with an error (" + response.status + ").";
    try {
      const body = await response.json();
      if (body && typeof body.message === "string") message = body.message;
    } catch {
      // Keep the general message.
    }
    // Not signed in to save (or the sign-in ended): offer the sign-in.
    if (response.status === 401 && write) signedOut();
    return new Error(message);
  }

  async function send(method, key, value, query) {
    const options = requestOptions(method, method !== "GET");
    if (method === "PUT") {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(value);
    }
    const response = await reach(address(key) + (query || ""), options);
    if (!response.ok) throw await refusal(response, method !== "GET");
    // A key with no value answers null.
    return method === "GET" ? response.json() : undefined;
  }

  // ---- Photos and voice recordings (ticket 3.19) ----

  // Uploading needs the sign-in: a visitor gets the sign-in offer at once, before anything is recorded or sent.
  function needSignIn() {
    if (pass !== null) return;
    signedOut();
    throw new Error(SIGN_IN_TO_SAVE);
  }

  // Where this app's files are served: the media service answers addresses under it.
  function mediaFolder() {
    return startServer + "/app-media/" + appName().toLowerCase() + "/";
  }

  // A new id for every upload, retries included (the media service never reuses one): 16 random bytes, base64url.
  function newMediaId() {
    const bytes = randomValues(new Uint8Array(16));
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
  }

  async function upload(body) {
    needSignIn();
    if (body.size > MAX_MEDIA_BYTES) throw new Error(TOO_BIG);
    const options = requestOptions("PUT", true);
    // The media service judges the bytes, never the declared type; this type keeps the body as it is on the way.
    options.headers["content-type"] = "application/octet-stream";
    options.body = body;
    // App code shares this page and could replace btoa or replace: never send an id that is not 22 base64url characters.
    const id = newMediaId();
    if (typeof id !== "string" || !MEDIA_ID.test(id)) throw new Error(BROKEN_ID);
    const response = await reach(startServer + "/api/apps/" + appName() + "/media/" + id, options);
    if (!response.ok) throw await refusal(response, true);
    let answer = null;
    try {
      answer = await response.json();
    } catch {
      // Checked below.
    }
    const folder = mediaFolder();
    if (!answer || typeof answer.address !== "string" || !answer.address.startsWith(folder) || !MEDIA_ID.test(answer.address.slice(folder.length))) {
      throw new Error(ODD_ANSWER);
    }
    return answer.address;
  }

  // A canvas of this size: an OffscreenCanvas where the browser draws on one, else a canvas element (never shown).
  function canvasOf(width, height) {
    if (typeof OffscreenCanvas === "function") {
      const offscreen = new OffscreenCanvas(width, height);
      const context = offscreen.getContext("2d");
      if (context) return { canvas: offscreen, context: context };
    }
    const element = document.createElement("canvas");
    element.width = width;
    element.height = height;
    return { canvas: element, context: element.getContext("2d") };
  }

  function jpegOf(canvas, quality) {
    if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: "image/jpeg", quality: quality });
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
  }

  // Decodes the photo (turned the way the camera held it), draws it at most PHOTO_SIDE pixels on its long side on a
  // white background, and encodes it as a JPEG under the size limit. No address is made for it (no blob: or data:).
  async function shrinkPhoto(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(UNREADABLE_PHOTO);
    }
    try {
      const scale = Math.min(1, PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const drawn = canvasOf(width, height);
      if (!drawn.context) throw new Error(UNREADABLE_PHOTO);
      drawn.context.fillStyle = "#ffffff";
      drawn.context.fillRect(0, 0, width, height);
      drawn.context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of PHOTO_QUALITIES) {
        const jpeg = await jpegOf(drawn.canvas, quality);
        if (!jpeg || jpeg.type !== "image/jpeg") throw new Error(UNREADABLE_PHOTO);
        if (jpeg.size <= MAX_MEDIA_BYTES) return jpeg;
      }
      throw new Error(TOO_BIG);
    } finally {
      bitmap.close();
    }
  }

  async function savePhoto(file) {
    if (!(file instanceof Blob)) throw new Error(NO_PHOTO);
    needSignIn();
    if (typeof createImageBitmap !== "function") throw new Error(UNREADABLE_PHOTO);
    return upload(await shrinkPhoto(file));
  }

  // A recording's handle: `done` is the promise of its address; `stop()` ends it and gives `done`. A failure nobody
  // waits for yet is not reported as an error of the page: the app sees it when it awaits `done` or `stop()`.
  function recordingOf(microphone, done, end) {
    done.catch(function () {});
    return Object.freeze({
      microphone: microphone,
      done: done,
      stop: function () {
        end();
        return done;
      },
    });
  }

  // Where the browser refuses the microphone (Chromium does in the apps' sandbox): the phone's own recorder, through a
  // file input. It opens only during a tap, so the app calls recordVoice() from a click.
  function recorderPicker() {
    let settle = null;
    const picked = new Promise(function (resolve, reject) {
      settle = { resolve: resolve, reject: reject };
    });
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.setAttribute("capture", "");
    input.hidden = true;
    const end = function (file) {
      input.remove();
      if (file) settle.resolve(file);
      else settle.reject(new Error(NO_RECORDING));
    };
    input.addEventListener("change", function () {
      end(input.files && input.files[0]);
    });
    input.addEventListener("cancel", function () {
      end(null);
    });
    document.body.append(input);
    input.click();
    return recordingOf(false, picked.then(upload), function () {
      end(null);
    });
  }

  function microphoneRecording(stream) {
    const stopTracks = function () {
      for (const track of stream.getTracks()) track.stop();
    };
    const type = RECORDING_TYPES.find(function (candidate) {
      return MediaRecorder.isTypeSupported(candidate);
    });
    const options = { audioBitsPerSecond: RECORDING_BITS };
    if (type) options.mimeType = type;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch {
      stopTracks();
      return null;
    }
    const chunks = [];
    recorder.addEventListener("dataavailable", function (event) {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    const stopped = new Promise(function (resolve, reject) {
      recorder.addEventListener("stop", resolve);
      recorder.addEventListener("error", function () {
        reject(new Error(NOTHING_RECORDED));
      });
    });
    let timer = null;
    const end = function () {
      clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
    };
    recorder.start();
    // A recording is at most 5 minutes: it stops (and saves) by itself then.
    timer = setTimeout(end, RECORDING_MS);
    const done = stopped
      .then(function () {
        stopTracks();
        const recording = new Blob(chunks, { type: recorder.mimeType || type || "" });
        if (recording.size === 0) throw new Error(NOTHING_RECORDED);
        return upload(recording);
      })
      .finally(stopTracks);
    return recordingOf(true, done, end);
  }

  async function recordVoice() {
    needSignIn();
    const devices = navigator.mediaDevices;
    if (devices && typeof devices.getUserMedia === "function" && typeof MediaRecorder === "function") {
      let stream = null;
      try {
        stream = await devices.getUserMedia({ audio: true });
      } catch {
        // Refused (the sandbox, or the visitor said no) or no microphone: the phone's own recorder instead.
      }
      const recording = stream === null ? null : microphoneRecording(stream);
      if (recording !== null) return recording;
    }
    return recorderPicker();
  }

  // The id of a photo or recording of this app from its address (as savePhoto and recording.done give it), or an error.
  function mediaIdOf(mediaAddress) {
    const folder = mediaFolder();
    const id = typeof mediaAddress === "string" && mediaAddress.startsWith(folder) ? mediaAddress.slice(folder.length) : "";
    if (!MEDIA_ID.test(id)) throw new Error(NOT_OUR_MEDIA);
    return id;
  }

  async function deleteMedia(mediaAddress) {
    const id = mediaIdOf(mediaAddress);
    needSignIn();
    const response = await reach(startServer + "/api/apps/" + appName() + "/media/" + id, requestOptions("DELETE", true));
    if (!response.ok) throw await refusal(response, true);
  }

  // ---- AI suggestions (ticket 3.22): the workshop's AI tasks for apps (ticket 3.21) ----

  // Characters as people count them (an emoji is one), as the AI tasks count them.
  function characters(text) {
    return Array.from(text).length;
  }

  // A tag, category or field name made one plain line, as the AI tasks clean it: the answer names it this way.
  function plainName(text) {
    return text
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  // A list of min..max names, each 1 to 50 characters once cleaned and all different (ignoring case), or `problem`.
  function nameList(list, min, max, problem) {
    if (!Array.isArray(list) || list.length < min || list.length > max) throw new Error(problem);
    const names = [];
    const seen = [];
    for (const item of list) {
      const name = typeof item === "string" ? plainName(item) : "";
      if (name === "" || characters(name) > AI_MAX_NAME || seen.includes(name.toLowerCase())) throw new Error(problem);
      seen.push(name.toLowerCase());
      names.push(name);
    }
    return names;
  }

  // The address the AI tasks take for a photo or recording of this app: its path on the workshop.
  function mediaPath(mediaAddress) {
    return "/app-media/" + appName().toLowerCase() + "/" + mediaIdOf(mediaAddress);
  }

  // Asks the AI tasks once, with the sign-in. Answers the parsed object and whether it was "still working" (202).
  async function askAi(body) {
    needSignIn();
    const options = requestOptions("POST", true);
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
    const response = await reach(startServer + "/api/apps/" + appName() + "/ai", options);
    if (!response.ok) throw await refusal(response, true, response.status === 429 ? AI_BUSY : undefined);
    let answer = null;
    try {
      answer = await response.json();
    } catch {
      // Checked below.
    }
    if (answer === null || typeof answer !== "object" || Array.isArray(answer) || (response.status !== 200 && response.status !== 202)) {
      throw new Error(ODD_ANSWER);
    }
    return { answer: answer, working: response.status === 202 };
  }

  // A list of different texts of at most 200 characters, at most `max` of them, each in `allowed` when given; else null.
  function textList(value, max, allowed) {
    if (!Array.isArray(value) || value.length > max) return null;
    const texts = [];
    for (const item of value) {
      if (typeof item !== "string" || item === "" || characters(item) > AI_MAX_VALUE || texts.includes(item)) return null;
      if (allowed !== null && !allowed.includes(item)) return null;
      texts.push(item);
    }
    return texts;
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  // One read-photo value of the asked type, copied; undefined when it does not fit (null stays null: not readable).
  function fieldValue(type, value) {
    if (value === null) return null;
    if (type === "text") return typeof value === "string" && value !== "" && characters(value) <= AI_MAX_VALUE ? value : undefined;
    if (type === "number") return finite(value) ? value : undefined;
    if (type === "date") return typeof value === "string" && AI_DATE.test(value) ? value : undefined;
    if (typeof value !== "object" || Array.isArray(value) || !finite(value.amount)) return undefined;
    if (Object.keys(value).some((key) => key !== "amount" && key !== "currency")) return undefined;
    const currency = value.currency === undefined ? null : value.currency;
    if (currency !== null && (typeof currency !== "string" || !AI_CURRENCY.test(currency))) return undefined;
    return { amount: value.amount, currency: currency };
  }

  async function tagPhoto(photo, tags) {
    const path = mediaPath(photo);
    const given = tags === undefined || tags === null ? [] : nameList(tags, 0, AI_MAX_GIVEN_TAGS, AI_TAGS_PROBLEM);
    const body = { task: "tag-photo", photo: path };
    if (given.length > 0) body.tags = given;
    const { answer } = await askAi(body);
    const picked = given.length > 0 ? textList(answer.tags, given.length, given) : textList(answer.tags, AI_MAX_SUGGESTED_TAGS, null);
    if (picked === null || Object.keys(answer).length !== 1) throw new Error(ODD_ANSWER);
    return picked;
  }

  async function readPhoto(photo, fields) {
    const path = mediaPath(photo);
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > AI_MAX_FIELDS) throw new Error(AI_FIELDS_PROBLEM);
    const types = fields.map(function (field) {
      const known = field !== null && typeof field === "object" && AI_FIELD_TYPES.includes(field.type);
      if (!known || Object.keys(field).some((key) => key !== "name" && key !== "type")) throw new Error(AI_FIELDS_PROBLEM);
      return field.type;
    });
    const names = nameList(
      fields.map((field) => field.name),
      1,
      AI_MAX_FIELDS,
      AI_FIELDS_PROBLEM,
    );
    const asked = names.map((name, i) => ({ name: name, type: types[i] }));
    const { answer } = await askAi({ task: "read-photo", photo: path, fields: asked });
    const values = answer.values;
    if (values === null || typeof values !== "object" || Array.isArray(values) || Object.keys(answer).length !== 1) throw new Error(ODD_ANSWER);
    if (Object.keys(values).length !== names.length) throw new Error(ODD_ANSWER);
    // No prototype: a field named __proto__ stays a field.
    const out = createObject(null);
    for (const [i, name] of names.entries()) {
      const value = Object.prototype.hasOwnProperty.call(values, name) ? fieldValue(types[i], values[name]) : undefined;
      if (value === undefined) throw new Error(ODD_ANSWER);
      out[name] = value;
    }
    return out;
  }

  async function sortText(text, categories) {
    if (typeof text !== "string" || text.trim() === "" || characters(text) > AI_MAX_TEXT) throw new Error(AI_TEXT_PROBLEM);
    const given = nameList(categories, 1, AI_MAX_CATEGORIES, AI_CATEGORIES_PROBLEM);
    const { answer } = await askAi({ task: "sort-text", text: text, categories: given });
    const picked = textList(answer.categories, given.length, given);
    if (picked === null || Object.keys(answer).length !== 1) throw new Error(ODD_ANSWER);
    return picked;
  }

  // Turns a recording into text. The first ask starts the work; while it runs (202) this asks again every 3 s, and gives
  // up after 3 minutes in all (the recording is at most 5 minutes; the workshop keeps working, a later ask gets the text).
  async function transcribe(recording) {
    const path = mediaPath(recording);
    needSignIn();
    const started = Date.now();
    for (;;) {
      const { answer, working } = await askAi({ task: "transcribe", recording: path });
      if (!working) {
        const language = answer.language === undefined ? null : answer.language;
        const fits = typeof answer.text === "string" && characters(answer.text) <= AI_MAX_TEXT && (language === null || (typeof language === "string" && AI_LANGUAGE.test(language)));
        if (!fits || Object.keys(answer).some((key) => key !== "text" && key !== "language")) throw new Error(ODD_ANSWER);
        return { text: answer.text, language: language };
      }
      if (answer.status !== "working") throw new Error(ODD_ANSWER);
      if (Date.now() - started + TRANSCRIBE_EVERY_MS > TRANSCRIBE_GIVE_UP_MS) throw new Error(STILL_TRANSCRIBING);
      await new Promise(function (resolve) {
        setTimeout(resolve, TRANSCRIBE_EVERY_MS);
      });
    }
  }

  // Asks the data service whose token this is (`?whoami=1`), once, when the page opens with one. Until it answers, and
  // when it cannot, whoAmI() gives null; saving still works with the token (a refused save signs the visitor out).
  async function confirmNickname() {
    if (pass === null || app === null) return;
    try {
      const response = await nativeFetch(startServer + "/api/apps/" + app + "/data/whoami?whoami=1", requestOptions("GET", true));
      if (!response.ok) return;
      const body = await response.json();
      if (body && typeof body.nickname === "string" && NICKNAME.test(body.nickname) && pass !== null) nickname = body.nickname;
    } catch {
      // Not confirmed: whoAmI() stays null.
    }
  }

  takeHandOff();
  const confirmed = confirmNickname();
  // This file runs before the page's body is read: the sign-in elements are there once it is.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showSignIn);
  else showSignIn();

  window.workshopData = Object.freeze({
    get: function (key) {
      return send("GET", key);
    },
    getInfo: async function (key) {
      const info = await send("GET", key, undefined, "?info=1");
      const known = info !== null && typeof info === "object";
      return {
        value: known && info.value !== undefined ? info.value : null,
        updatedBy: known && typeof info.updatedBy === "string" ? info.updatedBy : null,
        updatedAt: known && typeof info.updatedAt === "string" ? info.updatedAt : null,
      };
    },
    set: function (key, value) {
      if (value === undefined) return Promise.reject(new Error("There is no value to store."));
      return send("PUT", key, value);
    },
    remove: function (key) {
      return send("DELETE", key);
    },
    // A promise: the nickname the data service confirmed for the visitor's sign-in, or null (a visitor, or signed out).
    whoAmI: async function () {
      await confirmed;
      return pass === null ? null : nickname;
    },
    signInLink: signInLink,
    savePhoto: savePhoto,
    recordVoice: recordVoice,
    deleteMedia: deleteMedia,
    ai: Object.freeze({
      tagPhoto: tagPhoto,
      readPhoto: readPhoto,
      sortText: sortText,
      transcribe: transcribe,
    }),
  });
})();
