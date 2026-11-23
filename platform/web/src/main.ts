// Sign-in screens (ticket 1.6): email, code, nickname, then the step screen. The rules for each
// API answer are in ./flow.ts; this file only wires them to the page.
//
// Personal data: the email address lives only in `pendingEmail` (memory) between asking for a
// code and checking it. It never goes into the URL, storage, a cookie or the console.
import {
  MESSAGES,
  codeRequestResult,
  isPlausibleEmail,
  meResult,
  nicknameResult,
  normalizeCode,
  screenFor,
  stepHeading,
  verifyResult,
  type ApiAnswer,
  type Me,
  type Screen,
  type Tone,
} from "./flow.js";

type ScreenName = Screen | "loading";

let pendingEmail: string | null = null;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element as T;
}

/** Same-origin JSON call; status 0 when there is no answer at all. */
async function call(method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<ApiAnswer> {
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

function say(screen: Screen, message: string, tone: Tone): void {
  const element = byId(`message-${screen}`);
  element.dataset["tone"] = tone;
  element.textContent = message;
}

function clearMessage(screen: Screen): void {
  byId(`message-${screen}`).textContent = "";
}

/** Shows one screen and moves the focus to its first field, or to its heading. */
function show(name: ScreenName, focusId?: string): void {
  for (const section of document.querySelectorAll<HTMLElement>("[data-screen]")) {
    section.hidden = section.id !== `screen-${name}`;
  }
  if (focusId) byId(focusId).focus();
}

/** Disables a button while its request runs and shows its waiting label. */
async function whileBusy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  const label = button.textContent ?? "";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = button.dataset["busyLabel"] ?? label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

function showEmail(message?: string, tone: Tone = "info"): void {
  if (message) say("email", message, tone);
  else clearMessage("email");
  show("email", "email-input");
}

function showMe(me: Me): void {
  if (screenFor(me) === "nickname") {
    clearMessage("nickname");
    show("nickname", "nickname-input");
    return;
  }
  byId("step-heading").textContent = stepHeading(me.step);
  byId("step-nickname").textContent = me.nickname ?? "";
  byId("step-intro").hidden = me.step !== "clarify";
  show("step", "step-heading");
}

/** Reads the person's own record and goes where it says; signed out goes to the email screen. */
async function goToOwnStep(onFailure: Screen): Promise<void> {
  const result = meResult(await call("GET", "/api/me"));
  if (result.kind === "me") showMe(result.me);
  else if (result.kind === "signed-out") showEmail(onFailure === "email" ? undefined : MESSAGES.signedOut);
  else {
    if (onFailure === "email") show("email", "email-input");
    say(onFailure, result.message, result.tone);
  }
}

async function requestCode(email: string): Promise<boolean> {
  const result = codeRequestResult(await call("POST", "/api/sign-in/code", { email }));
  if (result.kind === "sent") return true;
  say(pendingEmail === email ? "code" : "email", result.message, result.tone);
  return false;
}

function wire(): void {
  const emailForm = byId<HTMLFormElement>("email-form");
  const emailInput = byId<HTMLInputElement>("email-input");
  const codeForm = byId<HTMLFormElement>("code-form");
  const codeInput = byId<HTMLInputElement>("code-input");
  const nicknameForm = byId<HTMLFormElement>("nickname-form");
  const nicknameInput = byId<HTMLInputElement>("nickname-input");
  const resend = byId<HTMLButtonElement>("resend-button");
  const submitOf = (form: HTMLFormElement): HTMLButtonElement => form.querySelector("button[type=submit]") as HTMLButtonElement;

  emailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!isPlausibleEmail(email)) {
      say("email", MESSAGES.badEmail, "error");
      emailInput.focus();
      return;
    }
    clearMessage("email");
    void whileBusy(submitOf(emailForm), async () => {
      pendingEmail = null;
      if (!(await requestCode(email))) return;
      pendingEmail = email;
      codeInput.value = "";
      say("code", MESSAGES.neutral, "info");
      show("code", "code-input");
    });
  });

  codeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = pendingEmail;
    if (email === null) {
      showEmail();
      return;
    }
    const code = normalizeCode(codeInput.value);
    if (code === undefined) {
      say("code", MESSAGES.badCode, "error");
      codeInput.focus();
      return;
    }
    say("code", MESSAGES.checking, "info");
    void whileBusy(submitOf(codeForm), async () => {
      const result = verifyResult(await call("POST", "/api/sign-in/verify", { email, code }));
      if (result.kind === "show") {
        say("code", result.message, result.tone);
        codeInput.focus();
        return;
      }
      // Signed in: forget the address, then let GET /api/me say where to go.
      pendingEmail = null;
      emailInput.value = "";
      codeInput.value = "";
      await goToOwnStep("code");
    });
  });

  resend.addEventListener("click", () => {
    const email = pendingEmail;
    if (email === null) {
      showEmail();
      return;
    }
    void whileBusy(resend, async () => {
      if (await requestCode(email)) say("code", MESSAGES.neutral, "info");
    });
  });

  byId<HTMLButtonElement>("other-email-button").addEventListener("click", () => {
    pendingEmail = null;
    codeInput.value = "";
    showEmail();
  });

  nicknameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const nickname = nicknameInput.value.trim();
    clearMessage("nickname");
    void whileBusy(submitOf(nicknameForm), async () => {
      const result = nicknameResult(await call("POST", "/api/me/nickname", { nickname }));
      if (result.kind === "saved") showMe(result.me);
      else if (result.kind === "refresh") await goToOwnStep("nickname");
      else if (result.kind === "signed-out") showEmail(MESSAGES.signedOut);
      else {
        say("nickname", result.message, result.tone);
        nicknameInput.focus();
      }
    });
  });
}

wire();
show("loading");
// A returning person with a valid session goes straight to their step.
void goToOwnStep("email");
