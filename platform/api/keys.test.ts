import { describe, expect, it } from "vitest";
import {
  allowListKey,
  codeKey,
  codeRequestsKey,
  MESSAGE_PREFIX,
  messageKey,
  normalizeEmail,
  participantKey,
  sessionKey,
  usageKey,
} from "./keys.js";

describe("normalizeEmail", () => {
  it("trims and lower-cases an address", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM \n")).toBe("jane.doe@example.com");
  });

  it("refuses an empty address", () => {
    expect(() => normalizeEmail("   ")).toThrow(/empty/);
  });
});

describe("item keys", () => {
  it("keys the allow-list entry and the code by the normalized email, so both share one partition", () => {
    expect(allowListKey("Jane@Example.com")).toEqual({ pk: "EMAIL#jane@example.com", sk: "ALLOW" });
    expect(codeKey(" jane@example.com")).toEqual({ pk: "EMAIL#jane@example.com", sk: "CODE" });
    expect(codeRequestsKey("JANE@example.com")).toEqual({ pk: "EMAIL#jane@example.com", sk: "CODE_REQUESTS" });
  });

  it("keys a session by its token hash", () => {
    expect(sessionKey("ab12")).toEqual({ pk: "SESSION#ab12", sk: "SESSION" });
  });

  it("keeps a participant's profile, messages and usage in the participant's partition", () => {
    expect(participantKey("p1")).toEqual({ pk: "PARTICIPANT#p1", sk: "PROFILE" });
    expect(usageKey("p1")).toEqual({ pk: "PARTICIPANT#p1", sk: "USAGE" });
    expect(messageKey("p1", "2026-11-23T10:00:00.000Z-x7")).toEqual({
      pk: "PARTICIPANT#p1",
      sk: "MSG#2026-11-23T10:00:00.000Z-x7",
    });
    expect(messageKey("p1", "m").sk.startsWith(MESSAGE_PREFIX)).toBe(true);
  });

  it("refuses an empty id or an id holding the # separator (keys must not collide)", () => {
    for (const bad of ["", "a#b"]) {
      expect(() => sessionKey(bad), JSON.stringify(bad)).toThrow();
      expect(() => participantKey(bad), JSON.stringify(bad)).toThrow();
      expect(() => usageKey(bad), JSON.stringify(bad)).toThrow();
      expect(() => messageKey(bad, "m"), JSON.stringify(bad)).toThrow();
      expect(() => messageKey("p1", bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => allowListKey("a#b@example.com")).toThrow();
  });

  it("never puts the email address in an error message (personal data)", () => {
    try {
      allowListKey("secret#person@example.com");
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("secret");
      expect(String(e)).not.toContain("example.com");
    }
  });
});
