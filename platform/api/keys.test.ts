import { describe, expect, it } from "vitest";
import {
  allowListKey,
  codeKey,
  codeRequestsKey,
  MESSAGE_PREFIX,
  messageKey,
  newParticipantId,
  nicknameKey,
  normalizeEmail,
  participantKey,
  sessionKey,
  usageKey,
  conversationKey,
  MESSAGE_ID_PATTERN,
  newMessageId,
  replyId,
  appDataKey,
  appDataUsageKey,
  appLiveKey,
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

  it("keys a nickname claim by the lower-cased nickname, so names that differ only in case collide", () => {
    expect(nicknameKey("Ada-42")).toEqual({ pk: "NICK#ada-42", sk: "NICK" });
    expect(nicknameKey("ADA-42")).toEqual(nicknameKey("ada-42"));
    expect(() => nicknameKey("")).toThrow();
    expect(() => nicknameKey("a#b")).toThrow();
  });

  it("makes participant ids from a random UUID, refusing one that holds #", () => {
    expect(newParticipantId(() => "3f1c2a9e-0000-4000-8000-000000000001")).toBe("3f1c2a9e-0000-4000-8000-000000000001");
    expect(() => newParticipantId(() => "a#b")).toThrow();
    expect(() => newParticipantId(() => "")).toThrow();
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

describe("conversation keys (ticket 1.7)", () => {
  const NOW = new Date("2026-11-23T10:00:00.000Z");

  it("makes time-sortable message ids from the clock and 8 random bytes", () => {
    const id = newMessageId(NOW, (n) => Buffer.alloc(n, 0xab));
    expect(id).toBe("2026-11-23T10:00:00.000Z-abababababababab");
    expect(id).toMatch(MESSAGE_ID_PATTERN);
    const later = newMessageId(new Date("2026-11-23T10:00:00.001Z"), (n) => Buffer.alloc(n, 0));
    expect([later, id].sort()).toEqual([id, later]);
    expect(() => newMessageId(NOW, () => Buffer.alloc(4))).toThrow(/length/);
  });

  it("refuses anything but a message id in the pattern", () => {
    for (const bad of ["", "x", "2026-11-23T10:00:00.000Z", "2026-11-23T10:00:00.000Z-ABABABABABABABAB", "2026-11-23T10:00:00.000Z-abababababababab-r"]) {
      expect(MESSAGE_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("sorts a reply right after its message and before the next message", () => {
    const first = newMessageId(NOW, (n) => Buffer.alloc(n, 0xff));
    const next = newMessageId(new Date("2026-11-23T10:00:00.001Z"), (n) => Buffer.alloc(n, 0));
    expect(replyId(first)).toBe(`${first}-r`);
    expect([next, replyId(first), first].sort()).toEqual([first, replyId(first), next]);
    expect(messageKey("p-1", replyId(first))).toEqual({ pk: "PARTICIPANT#p-1", sk: `MSG#${first}-r` });
  });

  it("keeps the conversation state in the participant's partition", () => {
    expect(conversationKey("p-1")).toEqual({ pk: "PARTICIPANT#p-1", sk: "CONVERSATION" });
    expect(() => conversationKey("a#b")).toThrow(/separator/);
  });
});

describe("app keys (ticket 2.4)", () => {
  it("keys the live marker by the lower-cased nickname in its own APP# partition", () => {
    expect(appLiveKey("Ada-42")).toEqual({ pk: "APP#ada-42", sk: "LIVE" });
  });

  it("keeps an app's values and totals in an APPDATA# partition, apart from the live marker", () => {
    expect(appDataKey("Ada-42", "High_score-1")).toEqual({ pk: "APPDATA#ada-42", sk: "DATA#High_score-1" });
    expect(appDataUsageKey("ADA-42")).toEqual({ pk: "APPDATA#ada-42", sk: "DATA_USAGE" });
    // `APP#*` (the live marker's partitions) never matches a data partition, and the reverse.
    expect(appDataKey("app", "k").pk.startsWith("APP#")).toBe(false);
    expect(appLiveKey("data").pk.startsWith("APPDATA#")).toBe(false);
  });

  it("refuses the key separator in a nickname or a key", () => {
    expect(() => appLiveKey("a#b")).toThrow(/separator/);
    expect(() => appDataKey("ada", "a#b")).toThrow(/separator/);
    expect(() => appDataUsageKey("")).toThrow(/empty/);
  });
});
