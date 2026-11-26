// The hand-off page for saving in apps (ticket 3.24), `/app-sign-in/?app=<nickname>`: what each API answer means for
// the page, as pure functions so every rule is unit tested without a browser. The DOM wiring is in ./app-sign-in.ts.
//
// The token is never stored, logged or shown: it only goes into the one address the page opens next,
// `/apps/<the same nickname, lower-cased>/#wt=<token>&wn=<the writer's nickname>` (the fragment never reaches a server
// or a log). Ticket 3.25: the writer's nickname goes with it, so the app's `workshopData.whoAmI()` can name the visitor.
import { APP_SIGN_IN_TEXTS } from "../../api/workshop/texts.js";
import { messageOf, parseMe, type ApiAnswer, type Me } from "./flow.js";

/** The nickname rules (ticket 1.5): an `app` outside them can never be an app. */
const APP_PATTERN = /^[A-Za-z0-9-]{3,20}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The app named by the page's query (`?app=<nickname>`), or undefined when it is missing, repeated or not a nickname. */
export function appFromSearch(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll("app");
  const app = values.length === 1 ? values[0] : undefined;
  return app !== undefined && APP_PATTERN.test(app) ? app : undefined;
}

/** Where the page sends a signed-out person: the workshop's own sign-in, which comes back here afterwards. */
export function signInAddress(app: string): string {
  return `/?app=${encodeURIComponent(app)}`;
}

/** The hand-off page for an app, where the workshop page returns after signing in. */
export function handOffAddress(app: string): string | undefined {
  return APP_PATTERN.test(app) ? `/app-sign-in/?app=${encodeURIComponent(app)}` : undefined;
}

/**
 * The only address a token is ever sent to: the same app, lower-cased (as /apps/ serves it), the token and (ticket 3.25)
 * the writer's nickname, a public name, in the fragment.
 */
export function appAddress(app: string, token: string, nickname: string): string | undefined {
  if (!APP_PATTERN.test(app) || !TOKEN_PATTERN.test(token) || !APP_PATTERN.test(nickname)) return undefined;
  return `/apps/${app.toLowerCase()}/#wt=${token}&wn=${nickname}`;
}

export type MeState = { kind: "ask"; nickname: string } | { kind: "signed-out" } | { kind: "no-nickname" } | { kind: "show"; message: string };

/** `GET /api/me`: ask the question when the person has a nickname. */
export function meState(answer: ApiAnswer): MeState {
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 200) {
    const me: Me | undefined = parseMe(answer.body);
    if (me === undefined) return { kind: "show", message: APP_SIGN_IN_TEXTS.failed };
    return me.nickname === null ? { kind: "no-nickname" } : { kind: "ask", nickname: me.nickname };
  }
  return { kind: "show", message: answer.status === 0 ? APP_SIGN_IN_TEXTS.offline : APP_SIGN_IN_TEXTS.failed };
}

export type TokenState =
  | { kind: "open"; address: string }
  | { kind: "not-live" }
  | { kind: "signed-out" }
  | { kind: "no-nickname" }
  | { kind: "show"; message: string };

/** `POST /api/app-tokens`: open the app with its token, or say why not (and go nowhere). */
export function tokenState(answer: ApiAnswer, app: string): TokenState {
  if (answer.status === 200 && answer.body !== null && typeof answer.body === "object") {
    const body = answer.body as Record<string, unknown>;
    // The answer must be for the app this page asked for; else nothing is opened.
    const address =
      typeof body["token"] === "string" && typeof body["nickname"] === "string" && body["app"] === app.toLowerCase()
        ? appAddress(app, body["token"], body["nickname"])
        : undefined;
    return address === undefined ? { kind: "show", message: APP_SIGN_IN_TEXTS.failed } : { kind: "open", address };
  }
  if (answer.status === 404) return { kind: "not-live" };
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 409 && (answer.body as Record<string, unknown> | null)?.["reason"] === "no-nickname") return { kind: "no-nickname" };
  if (answer.status === 0) return { kind: "show", message: APP_SIGN_IN_TEXTS.offline };
  return { kind: "show", message: messageOf(answer.body) ?? APP_SIGN_IN_TEXTS.failed };
}
