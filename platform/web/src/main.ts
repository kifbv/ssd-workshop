// Sign-in screens (ticket 1.6): email, code, nickname, then the step screen; step 1, Clarify, and the
// step 2 screen (ticket 1.8). The rules for each API answer are in ./flow.ts and ./chat.ts; this
// file only wires them to the page.
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
  verifyResult,
  type ApiAnswer,
  type Me,
  type Screen,
  type Tone,
} from "./flow.js";
import {
  CHAT_TEXTS,
  POLL_INTERVAL_MS,
  WAITING_POLL_INTERVAL_MS,
  canWriteSpec,
  conversationResult,
  pollResult,
  sendResult,
  specOffered,
  stageOf,
  writeSpecResult,
  type ChatMessage,
} from "./chat.js";

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
  const screen = screenFor(me);
  if (screen === "nickname") {
    stopPolling();
    clearMessage("nickname");
    show("nickname", "nickname-input");
    return;
  }
  if (screen === "spec") {
    showSpec(me.nickname ?? "");
    return;
  }
  byId("step-nickname").textContent = me.nickname ?? "";
  clearMessage("step");
  show("step", "step-heading");
  void loadConversation();
}

function showSpec(nickname: string): void {
  stopPolling();
  byId("spec-nickname").textContent = nickname;
  clearMessage("spec");
  show("spec", "spec-heading");
}

// ---- Step 1, Clarify (ticket 1.8) ----

/** The conversation as shown, oldest first. */
let messages: ChatMessage[] = [];
/** The message in flight and how the page waits for it. */
let waiting: { id: string; mode: "pending" | "flagged" } | null = null;
let pollTimer: number | undefined;
/** Bumped whenever polling starts or stops, so an answer to an older poll is ignored. */
let pollRound = 0;
/** Bumped on every local change (a message sent), so a conversation read that started earlier is ignored. */
let localVersion = 0;

function stopPolling(): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  pollRound++;
  waiting = null;
}

/** Shows the conversation, the waiting state, the behind-the-scenes stage and Write my spec. */
function render(): void {
  const list = byId("chat");
  list.replaceChildren(
    ...messages.map((m) => {
      const item = document.createElement("li");
      item.className = "bubble";
      item.dataset["author"] = m.author;
      if (m.status !== undefined) item.dataset["status"] = m.status;
      item.textContent = m.text;
      return item;
    }),
  );
  byId("typing").hidden = waiting?.mode !== "pending";
  byId("waiting-notice").hidden = waiting?.mode !== "flagged";
  byId("behind-flow").dataset["stage"] = stageOf(waiting?.mode ?? "none", messages);
  byId<HTMLButtonElement>("chat-send").disabled = waiting !== null;
  const offer = byId("spec-offer");
  offer.hidden = !canWriteSpec(messages);
  const offered = specOffered(messages);
  offer.dataset["offered"] = String(offered);
  byId("spec-offer-text").textContent = offered ? CHAT_TEXTS.specOffered : CHAT_TEXTS.specAnytime;
  byId<HTMLButtonElement>("write-spec-button").disabled = waiting !== null;
}

/** Waits for the reply to message `id`: a poll every 2 seconds (10 while a facilitator decides). */
function startPolling(id: string, mode: "pending" | "flagged"): void {
  stopPolling();
  waiting = { id, mode };
  const round = pollRound;
  const schedule = (): void => {
    if (waiting === null) return;
    pollTimer = window.setTimeout(() => void pollOnce(id, round, schedule), waiting.mode === "flagged" ? WAITING_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
  };
  render();
  schedule();
}

async function pollOnce(id: string, round: number, schedule: () => void): Promise<void> {
  pollTimer = undefined;
  const result = pollResult(await call("GET", `/api/conversation/messages/${encodeURIComponent(id)}`));
  if (round !== pollRound || waiting === null) return;
  if (result.kind === "pending" || result.kind === "flagged") {
    waiting.mode = result.kind;
    setStatus(id, result.kind);
  } else if (result.kind === "answered") {
    setStatus(id, result.status);
    messages.push({ id: `${id}-r`, author: "assistant", text: result.reply });
    stopPolling();
    // The reload brings offersSpec and anything else the poll does not carry.
    await loadConversation();
    return;
  } else if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  } else if (result.kind === "lost") {
    stopPolling();
    await loadConversation();
    return;
  }
  render();
  schedule();
}

function setStatus(id: string, status: string): void {
  const message = messages.find((m) => m.id === id);
  if (message) message.status = status;
}

/** Reads the conversation so far (a page load, a reload, or after a reply) and resumes waiting if needed. */
async function loadConversation(): Promise<void> {
  const version = localVersion;
  const result = conversationResult(await call("GET", "/api/conversation"));
  // A message was sent while this read was on its way: the page already knows more than the answer.
  if (version !== localVersion) return;
  if (result.kind === "signed-out") {
    stopPolling();
    showEmail(MESSAGES.signedOut);
    return;
  }
  if (result.kind === "show") {
    say("step", result.message, result.tone);
    return;
  }
  const { conversation } = result;
  if (conversation.step !== "clarify") {
    await goToOwnStep("step");
    return;
  }
  messages = conversation.messages;
  stopPolling();
  const pending = conversation.pendingId;
  if (pending !== undefined) startPolling(pending, conversation.state === "waiting" ? "flagged" : "pending");
  else render();
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

  const chatForm = byId<HTMLFormElement>("chat-form");
  const chatInput = byId<HTMLTextAreaElement>("chat-input");
  const sendButton = byId<HTMLButtonElement>("chat-send");
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = chatInput.value.trim();
    if (text === "") {
      say("step", CHAT_TEXTS.empty, "error");
      chatInput.focus();
      return;
    }
    if (waiting !== null) return;
    clearMessage("step");
    void whileBusy(sendButton, async () => {
      const result = sendResult(await call("POST", "/api/conversation/messages", { text }));
      if (result.kind === "sent") {
        chatInput.value = "";
        localVersion++;
        messages.push({ id: result.id, author: "participant", text, status: "pending" });
        startPolling(result.id, "pending");
      } else if (result.kind === "busy" || result.kind === "waiting") {
        await loadConversation();
      } else if (result.kind === "no-nickname") {
        await goToOwnStep("step");
      } else if (result.kind === "signed-out") {
        showEmail(MESSAGES.signedOut);
      } else {
        say("step", result.message, result.tone);
      }
    }).finally(render);
  });

  const writeSpec = byId<HTMLButtonElement>("write-spec-button");
  writeSpec.addEventListener("click", () => {
    clearMessage("step");
    void whileBusy(writeSpec, async () => {
      const result = writeSpecResult(await call("POST", "/api/conversation/step", { step: "spec" }));
      if (result.kind === "moved") showSpec(byId("step-nickname").textContent ?? "");
      else if (result.kind === "signed-out") showEmail(MESSAGES.signedOut);
      else say("step", result.message, result.tone);
    }).finally(() => {
      if (!byId("screen-step").hidden) render();
    });
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
