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
// Keys use letters, digits, dashes and underscores. Every visitor of the app shares the same data.
// Anyone can read. Saving needs the workshop's own sign-in: give the element that offers it (a button or a link
// reading "Sign in to save", next to where the app saves) the attribute data-workshop-sign-in. This file shows such
// elements to visitors who are not signed in, hides them once they are, and opens the sign-in in a new tab when one is
// pressed. A save refused for lack of sign-in shows them again (or a button of its own when the page has none).
"use strict";

(function () {
  // Taken before any other script of the page can run (this file is the page's first script), and the only ones used
  // with the sign-in: code that runs later cannot wrap them to see what is sent.
  const nativeFetch = window.fetch.bind(window);
  const replaceState = history.replaceState.bind(history);
  const replaceLocation = location.replace.bind(location);
  const openWindow = window.open.bind(window);
  const createObject = Object.create;
  const startPath = location.pathname;
  const startSearch = location.search;
  const startHash = location.hash;
  const startState = history.state;

  const KEY = /^[A-Za-z0-9_-]+$/;
  const PASS = /^[A-Za-z0-9_-]{43}$/;
  const NICKNAME = /^[A-Za-z0-9-]{3,20}$/;
  const SIGN_IN = "[data-workshop-sign-in]";
  const SIGN_IN_TEXT = "Sign in to save";

  // The app lives at /apps/<nickname>/; its data at /api/apps/<nickname>/data/<key> on the same server.
  const appMatch = /^\/apps\/([^/]+)\//.exec(startPath);
  const app = appMatch ? appMatch[1] : null;
  const signInAddress = app === null ? null : "/app-sign-in/?app=" + encodeURIComponent(app);

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
    return "/api/apps/" + name + "/data/" + key;
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

  // Shows the sign-in elements to a visitor who is not signed in to save, and hides them once signed in.
  function showSignIn() {
    const signedIn = pass !== null;
    for (const element of document.querySelectorAll(SIGN_IN)) {
      if (element.textContent.trim() === "" && element.getAttribute("aria-label") === null) element.textContent = SIGN_IN_TEXT;
      if (element.tagName === "A" && signInAddress !== null) {
        element.href = signInAddress;
        element.target = "_blank";
        element.rel = "noopener";
      }
      element.hidden = signedIn;
    }
  }

  // A page with no sign-in element (an app made before saving needed sign-in) gets one of its own, at the bottom.
  function addSignInButton() {
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
    document.body.append(button);
  }

  function signedOut() {
    pass = null;
    nickname = null;
    if (document.querySelector(SIGN_IN) === null) addSignInButton();
    showSignIn();
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

  async function send(method, key, value, query) {
    const options = requestOptions(method, method !== "GET");
    if (method === "PUT") {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(value);
    }
    let response;
    try {
      response = await nativeFetch(address(key) + (query || ""), options);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("The data service could not be reached. Check the connection and try again.", {
          cause: error,
        });
      }
      throw error;
    }
    if (response.status === 404) {
      throw new Error("This app is not live on the workshop yet, so it cannot load or save data.");
    }
    if (!response.ok) {
      let message = "The data service answered with an error (" + response.status + ").";
      try {
        const body = await response.json();
        if (body && typeof body.message === "string") message = body.message;
      } catch {
        // Keep the general message.
      }
      // Not signed in to save (or the sign-in ended): offer the sign-in.
      if (response.status === 401 && method !== "GET") signedOut();
      throw new Error(message);
    }
    // A key with no value answers null.
    return method === "GET" ? response.json() : undefined;
  }

  // Asks the data service whose token this is (`?whoami=1`), once, when the page opens with one. Until it answers, and
  // when it cannot, whoAmI() gives null; saving still works with the token (a refused save signs the visitor out).
  async function confirmNickname() {
    if (pass === null || app === null) return;
    try {
      const response = await nativeFetch("/api/apps/" + app + "/data/whoami?whoami=1", requestOptions("GET", true));
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
  });
})();
