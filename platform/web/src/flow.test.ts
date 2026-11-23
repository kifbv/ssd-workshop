import { describe, expect, it } from "vitest";
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
  type Me,
} from "./flow.js";

const me = (over: Partial<Me> = {}): Me => ({
  id: "p-1",
  nickname: "ada",
  role: "participant",
  group: "g1",
  step: "clarify",
  ...over,
});

describe("code request answers (POST /api/sign-in/code)", () => {
  it("treats every 202 the same, whatever the body says (criterion 6: no hint of who is listed)", () => {
    const listed = codeRequestResult({ status: 202, body: { message: "If this address is on the workshop list..." } });
    const notListed = codeRequestResult({ status: 202, body: { message: "something else entirely" } });
    expect(listed).toEqual({ kind: "sent" });
    expect(notListed).toEqual(listed);
  });

  it("shows a throttled request (429) as 'Please try again in a moment', not as an error", () => {
    expect(codeRequestResult({ status: 429, body: { message: "Too Many Requests" } })).toEqual({
      kind: "show",
      message: MESSAGES.retry,
      tone: "info",
    });
  });

  it("asks for a valid address on 400, says it cannot reach the site on a network failure, and is generic otherwise", () => {
    expect(codeRequestResult({ status: 400, body: null })).toEqual({ kind: "show", message: MESSAGES.badEmail, tone: "error" });
    expect(codeRequestResult({ status: 0, body: null })).toEqual({ kind: "show", message: MESSAGES.offline, tone: "error" });
    expect(codeRequestResult({ status: 503, body: null })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
  });

  it("has the same neutral wording as the API", () => {
    expect(MESSAGES.neutral).toBe(
      "If this address is on the workshop list, a sign-in code is on its way. It can take a minute; check your Junk folder too.",
    );
  });
});

describe("code check answers (POST /api/sign-in/verify)", () => {
  it("signs in on 200", () => {
    expect(verifyResult({ status: 200, body: { next: "nickname" } })).toEqual({ kind: "signed-in" });
  });

  it("shows the API's message on 401, 400 and 415, with a fallback", () => {
    expect(verifyResult({ status: 401, body: { message: "That code is not right or has expired. Ask for a new one." } })).toEqual({
      kind: "show",
      message: "That code is not right or has expired. Ask for a new one.",
      tone: "error",
    });
    expect(verifyResult({ status: 401, body: null })).toEqual({ kind: "show", message: MESSAGES.wrongCode, tone: "error" });
    expect(verifyResult({ status: 400, body: {} })).toEqual({ kind: "show", message: MESSAGES.badCode, tone: "error" });
    expect(verifyResult({ status: 415, body: { message: "Send the request as JSON." } })).toMatchObject({ message: "Send the request as JSON." });
  });

  it("shows a throttled check (429) as 'Please try again in a moment'", () => {
    expect(verifyResult({ status: 429, body: null })).toEqual({ kind: "show", message: MESSAGES.retry, tone: "info" });
  });

  it("ignores a message that is not a short string", () => {
    expect(verifyResult({ status: 401, body: { message: 42 } })).toMatchObject({ message: MESSAGES.wrongCode });
    expect(verifyResult({ status: 401, body: { message: "x".repeat(301) } })).toMatchObject({ message: MESSAGES.wrongCode });
  });
});

describe("own record (GET /api/me)", () => {
  it("returns the record on 200", () => {
    expect(meResult({ status: 200, body: me() })).toEqual({ kind: "me", me: me() });
    expect(meResult({ status: 200, body: me({ nickname: null, step: "nickname" }) })).toEqual({
      kind: "me",
      me: me({ nickname: null, step: "nickname" }),
    });
  });

  it("is signed out on 401", () => {
    expect(meResult({ status: 401, body: { message: "Please sign in." } })).toEqual({ kind: "signed-out" });
  });

  it("refuses a malformed record and reports failures", () => {
    expect(meResult({ status: 200, body: { id: "p-1" } })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
    expect(meResult({ status: 200, body: null })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
    expect(meResult({ status: 500, body: null })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
    expect(meResult({ status: 429, body: null })).toEqual({ kind: "show", message: MESSAGES.retry, tone: "info" });
    expect(meResult({ status: 0, body: null })).toEqual({ kind: "show", message: MESSAGES.offline, tone: "error" });
  });
});

describe("nickname answers (POST /api/me/nickname)", () => {
  it("saves on 200 with the returned record", () => {
    expect(nicknameResult({ status: 200, body: me() })).toEqual({ kind: "saved", me: me() });
  });

  it("re-reads the record on 409 already-set (or a 200 it cannot read)", () => {
    expect(nicknameResult({ status: 409, body: { reason: "already-set", message: "You already have a nickname." } })).toEqual({ kind: "refresh" });
    expect(nicknameResult({ status: 200, body: {} })).toEqual({ kind: "refresh" });
  });

  it("shows the API's reason message for rules, reserved and taken", () => {
    for (const [status, reason, message] of [
      [400, "rules", "A nickname has 3 to 20 letters, digits or dashes."],
      [400, "reserved", "That nickname is reserved. Please pick another one."],
      [409, "taken", "That nickname is already taken. Please pick another one."],
    ] as const) {
      expect(nicknameResult({ status, body: { reason, message } })).toEqual({ kind: "show", message, tone: "error" });
    }
    expect(nicknameResult({ status: 400, body: null })).toEqual({ kind: "show", message: MESSAGES.nicknameRules, tone: "error" });
  });

  it("is signed out on 401, and says 'try again in a moment' on 429", () => {
    expect(nicknameResult({ status: 401, body: null })).toEqual({ kind: "signed-out" });
    expect(nicknameResult({ status: 429, body: null })).toEqual({ kind: "show", message: MESSAGES.retry, tone: "info" });
  });
});

describe("where a signed-in person goes", () => {
  it("picks a nickname first, then the step they are at", () => {
    expect(screenFor(me({ nickname: null, step: "nickname" }))).toBe("nickname");
    expect(screenFor(me({ nickname: null, step: "clarify" }))).toBe("nickname");
    expect(screenFor(me({ step: "clarify" }))).toBe("step");
    expect(screenFor(me({ step: "spec" }))).toBe("step");
  });

  it("names step 1 Clarify", () => {
    expect(stepHeading("clarify")).toBe("Step 1: Clarify");
    expect(stepHeading("spec")).toBe("Welcome back");
  });
});

describe("input checks before calling the API", () => {
  it("accepts a plausible address and refuses obvious mistakes", () => {
    expect(isPlausibleEmail("ada@example.com")).toBe(true);
    expect(isPlausibleEmail(" ada@example.com ")).toBe(true);
    for (const bad of ["", "ada", "ada@", "@example.com", "ada @example.com", "ada@example", `${"a".repeat(320)}@example.com`]) {
      expect(isPlausibleEmail(bad), bad).toBe(false);
    }
  });

  it("takes a 6-digit code, spaces allowed", () => {
    expect(normalizeCode("123456")).toBe("123456");
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    for (const bad of ["", "12345", "1234567", "12345a", "١٢٣٤٥٦"]) expect(normalizeCode(bad), bad).toBeUndefined();
  });
});
