// Ticket 3.24: the hand-off page's rules, without a browser (the page itself: app-sign-in.test.ts).
import { describe, expect, it } from "vitest";
import { APP_SIGN_IN_TEXTS, saveAsText } from "../../api/workshop/texts.js";
import { appAddress, appFromSearch, handOffAddress, meState, signInAddress, tokenState } from "./app-sign-in-view.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");

describe("the hand-off page's rules (ticket 3.24)", () => {
  it("takes the app from ?app= only when it is one nickname within the rules", () => {
    expect(appFromSearch("?app=Ada-42")).toBe("Ada-42");
    for (const bad of ["", "?app=", "?app=ab", "?app=a%20b", "?app=../x", "?app=ada&app=bob", "?app=" + "x".repeat(21), "?apps=ada", "?app=ad%C3%A9"]) {
      expect(appFromSearch(bad), bad).toBeUndefined();
    }
  });

  it("sends a token only to /apps/<the same nickname, lower-cased>/ in the fragment", () => {
    expect(appAddress("Ada-42", TOKEN)).toBe(`/apps/ada-42/#wt=${TOKEN}`);
    expect(appAddress("ada", "short")).toBeUndefined();
    expect(appAddress("https://evil.example/x", TOKEN)).toBeUndefined();
    expect(appAddress("//evil", TOKEN)).toBeUndefined();
  });

  it("goes through the workshop's sign-in and back", () => {
    expect(signInAddress("Ada")).toBe("/?app=Ada");
    expect(handOffAddress("Ada")).toBe("/app-sign-in/?app=Ada");
    expect(handOffAddress("//evil.example")).toBeUndefined();
    expect(saveAsText("ada", "Bob")).toBe("Save in ada's app as Bob?");
  });

  it("asks the question only of a signed-in person with a nickname", () => {
    const me = { id: "p", nickname: "Bob", role: "participant", group: "g", step: "clarify" };
    expect(meState({ status: 200, body: me })).toEqual({ kind: "ask", nickname: "Bob" });
    expect(meState({ status: 200, body: { ...me, nickname: null } })).toEqual({ kind: "no-nickname" });
    expect(meState({ status: 401, body: {} })).toEqual({ kind: "signed-out" });
    expect(meState({ status: 0, body: null })).toEqual({ kind: "show", message: APP_SIGN_IN_TEXTS.offline });
    expect(meState({ status: 500, body: null })).toEqual({ kind: "show", message: APP_SIGN_IN_TEXTS.failed });
  });

  it("opens the app only for a good answer about the same app; otherwise says why and goes nowhere", () => {
    expect(tokenState({ status: 200, body: { token: TOKEN, app: "ada", nickname: "Bob" } }, "Ada")).toEqual({ kind: "open", address: `/apps/ada/#wt=${TOKEN}` });
    expect(tokenState({ status: 200, body: { token: TOKEN, app: "bob" } }, "Ada")).toEqual({ kind: "show", message: APP_SIGN_IN_TEXTS.failed });
    expect(tokenState({ status: 200, body: { token: "x", app: "ada" } }, "Ada")).toEqual({ kind: "show", message: APP_SIGN_IN_TEXTS.failed });
    expect(tokenState({ status: 404, body: { message: "This app is not live." } }, "Ada")).toEqual({ kind: "not-live" });
    expect(tokenState({ status: 401, body: {} }, "Ada")).toEqual({ kind: "signed-out" });
    expect(tokenState({ status: 409, body: { reason: "no-nickname" } }, "Ada")).toEqual({ kind: "no-nickname" });
    expect(tokenState({ status: 429, body: { message: APP_SIGN_IN_TEXTS.tooMany } }, "Ada")).toEqual({ kind: "show", message: APP_SIGN_IN_TEXTS.tooMany });
    expect(tokenState({ status: 0, body: null }, "Ada")).toEqual({ kind: "show", message: APP_SIGN_IN_TEXTS.offline });
  });
});
