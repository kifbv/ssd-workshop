// The hand-off page for saving in apps (ticket 3.24), at /app-sign-in/?app=<nickname>: "Save in <app>'s app as <your
// nickname>?" and Continue, which asks POST /api/app-tokens for a token and opens /apps/<app>/#wt=<token>. A signed-out
// person is sent to the workshop's own sign-in (`/?app=<app>`), which brings them back here. The rules for each answer
// are in ./app-sign-in-view.ts; every text is set with `textContent`.
//
// The token is never stored, logged or shown: it goes only into the address the page opens (location.replace, so the
// hand-off page is not left behind in the history to be revisited).
import { APP_SIGN_IN_TEXTS, saveAsText } from "../../api/workshop/texts.js";
import { appFromSearch, meState, signInAddress, tokenState } from "./app-sign-in-view.js";
import type { ApiAnswer } from "./flow.js";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element as T;
}

/** Same-origin JSON call; status 0 when there is no answer at all. */
async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<ApiAnswer> {
  const init: RequestInit = { method, credentials: "same-origin", cache: "no-store" };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(path, init);
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

function say(message: string, tone: "info" | "error" = "error"): void {
  const target = byId("message-app-sign-in");
  target.dataset["tone"] = tone;
  target.textContent = message;
}

/** One of the page's states: only its own parts show. */
function showOnly(part: "ask" | "signin" | "home" | "none"): void {
  byId("app-sign-in-loading").hidden = true;
  byId("app-sign-in-ask").hidden = part !== "ask";
  byId("app-sign-in-signin").hidden = part !== "signin";
  byId("app-sign-in-home").hidden = part !== "home";
}

function notLive(): void {
  showOnly("none");
  say(APP_SIGN_IN_TEXTS.notLive);
}

function signedOut(app: string): void {
  byId<HTMLAnchorElement>("sign-in-link").href = signInAddress(app);
  showOnly("signin");
  say(APP_SIGN_IN_TEXTS.signInFirst, "info");
}

function noNickname(): void {
  showOnly("home");
  say(APP_SIGN_IN_TEXTS.noNickname, "info");
}

async function start(): Promise<void> {
  const app = appFromSearch(window.location.search);
  // Not a nickname: no app can have this name, so nothing is asked and nothing opens.
  if (app === undefined) {
    notLive();
    return;
  }
  const me = meState(await call("GET", "/api/me"));
  if (me.kind === "signed-out") return signedOut(app);
  if (me.kind === "no-nickname") return noNickname();
  if (me.kind === "show") {
    showOnly("none");
    say(me.message);
    return;
  }
  byId("app-sign-in-question").textContent = saveAsText(app, me.nickname);
  byId("app-sign-in-explainer").textContent = APP_SIGN_IN_TEXTS.explainer;
  showOnly("ask");
  const button = byId<HTMLButtonElement>("continue-button");
  button.focus();
  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true;
      say("", "info");
      const result = tokenState(await call("POST", "/api/app-tokens", { app }), app);
      if (result.kind === "open") {
        say(APP_SIGN_IN_TEXTS.opening, "info");
        window.location.replace(result.address);
        return;
      }
      button.disabled = false;
      if (result.kind === "not-live") notLive();
      else if (result.kind === "signed-out") signedOut(app);
      else if (result.kind === "no-nickname") noNickname();
      else say(result.message);
    })();
  });
}

void start();
