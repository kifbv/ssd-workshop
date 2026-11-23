// Sign-in screens (ticket 1.6): what each API answer means for the page, as pure functions so
// every rule is unit tested without a browser. The DOM wiring is in ./main.ts.
//
// Personal data: nothing here stores, logs or returns the email address.

/** A finished API call: the HTTP status (0 when the request never got an answer) and the JSON body. */
export interface ApiAnswer {
  status: number;
  body: unknown;
}

/** `GET /api/me`: the signed-in person's own record. */
export interface Me {
  id: string;
  nickname: string | null;
  role: string;
  group: string;
  step: string;
}

export type Screen = "email" | "code" | "nickname" | "step" | "spec";
export type Tone = "info" | "error";

/** A message for the current screen. */
export interface Show {
  kind: "show";
  message: string;
  tone: Tone;
}

export const MESSAGES = {
  /** The same words as the API's neutral answer (platform/api/sign-in/code-request.ts). */
  neutral:
    "If this address is on the workshop list, a sign-in code is on its way. It can take a minute; check your Junk folder too.",
  retry: "Please try again in a moment.",
  failed: "Something went wrong. Please try again in a moment.",
  offline: "We couldn't reach the workshop. Check your connection and try again.",
  badEmail: "Please enter a valid email address.",
  badCode: "Please enter the 6-digit code from the email.",
  wrongCode: "That code is not right or has expired. Ask for a new one.",
  checking: "Checking your code. This takes a few seconds.",
  signedOut: "Please sign in again.",
  nicknameRules: "A nickname has 3 to 20 letters, digits or dashes.",
} as const;

const show = (message: string, tone: Tone = "error"): Show => ({ kind: "show", message, tone });

/** Answers every route shares: throttled, unreachable, anything unexpected. */
function common(answer: ApiAnswer): Show {
  if (answer.status === 429) return show(MESSAGES.retry, "info");
  if (answer.status === 0) return show(MESSAGES.offline);
  return show(MESSAGES.failed);
}

/** The API's own `message`, when it is a short string (shown as text, never as markup). */
export function messageOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const message = (body as Record<string, unknown>)["message"];
  return typeof message === "string" && message.length > 0 && message.length <= 300 ? message : undefined;
}

function reasonOf(body: unknown): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)["reason"] : undefined;
}

/** A record from `GET /api/me` (or the nickname route), or undefined when it is not one. */
export function parseMe(body: unknown): Me | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const { id, nickname, role, group, step } = b;
  if (typeof id !== "string" || typeof role !== "string" || typeof group !== "string" || typeof step !== "string") {
    return undefined;
  }
  if (nickname !== null && typeof nickname !== "string") return undefined;
  return { id, nickname, role, group, step };
}

/**
 * `POST /api/sign-in/code`. Every 202 is the same, whatever its body: the page always shows its
 * own copy of the neutral message, so it can never tell a listed address from another one.
 */
export function codeRequestResult(answer: ApiAnswer): { kind: "sent" } | Show {
  if (answer.status === 202 || answer.status === 200) return { kind: "sent" };
  if (answer.status === 400) return show(MESSAGES.badEmail);
  return common(answer);
}

/** `POST /api/sign-in/verify` (answers take about 3 seconds by design). */
export function verifyResult(answer: ApiAnswer): { kind: "signed-in" } | Show {
  if (answer.status === 200) return { kind: "signed-in" };
  if (answer.status === 401) return show(messageOf(answer.body) ?? MESSAGES.wrongCode);
  if (answer.status === 400 || answer.status === 415) return show(messageOf(answer.body) ?? MESSAGES.badCode);
  return common(answer);
}

/** `GET /api/me`: the source of truth for where a signed-in person goes. */
export function meResult(answer: ApiAnswer): { kind: "me"; me: Me } | { kind: "signed-out" } | Show {
  if (answer.status === 200) {
    const me = parseMe(answer.body);
    return me ? { kind: "me", me } : show(MESSAGES.failed);
  }
  if (answer.status === 401) return { kind: "signed-out" };
  return common(answer);
}

/** `POST /api/me/nickname`. */
export function nicknameResult(
  answer: ApiAnswer,
): { kind: "saved"; me: Me } | { kind: "refresh" } | { kind: "signed-out" } | Show {
  if (answer.status === 200) {
    const me = parseMe(answer.body);
    return me ? { kind: "saved", me } : { kind: "refresh" };
  }
  if (answer.status === 409 && reasonOf(answer.body) === "already-set") return { kind: "refresh" };
  if (answer.status === 400 || answer.status === 409) return show(messageOf(answer.body) ?? MESSAGES.nicknameRules);
  if (answer.status === 401) return { kind: "signed-out" };
  return common(answer);
}

/**
 * A person without a nickname picks one first; at step 1 they go to the Clarify screen (`step`),
 * after Write my spec to the step 2 screen (`spec`, ticket 1.8; ticket 1.9 fills it in).
 */
export function screenFor(me: Me): "nickname" | "step" | "spec" {
  if (me.nickname === null || me.step === "nickname") return "nickname";
  return me.step === "clarify" ? "step" : "spec";
}

/** A quick check before asking for a code; the API applies the full rule. */
export function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** The 6-digit code without spaces, or undefined. */
export function normalizeCode(value: string): string | undefined {
  const code = value.replace(/\s+/g, "");
  return /^[0-9]{6}$/.test(code) ? code : undefined;
}
