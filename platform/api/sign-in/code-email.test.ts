import { describe, expect, it } from "vitest";
import { CONFIGURATION_SET, FROM_HEADER, SENDER_ADDRESS } from "../settings.js";
import { CLOSING_LINE, REASON_LINE, VALIDITY_LINE, buildCodeEmail } from "./code-email.js";

describe("buildCodeEmail (ticket 1.4 criterion 4)", () => {
  const email = buildCodeEmail("042917");

  it("comes from \"SSD Workshop\" <ssd-workshop@rankly.games> through the workshop's configuration set", () => {
    expect(email.from).toBe('"SSD Workshop" <ssd-workshop@rankly.games>');
    expect(FROM_HEADER).toBe(email.from);
    expect(SENDER_ADDRESS).toBe("ssd-workshop@rankly.games");
    expect(CONFIGURATION_SET).toBe("ssd-workshop-email");
  });

  it("puts the code in the subject", () => {
    expect(email.subject).toBe("Your SSD Workshop sign-in code: 042917");
  });

  it("has a text and an HTML part, each with the code, the validity, the reason line and the facilitator line", () => {
    for (const part of [email.text, email.html]) {
      expect(part).toContain("042917");
      expect(part).toContain(VALIDITY_LINE);
      expect(part).toContain(REASON_LINE);
      expect(part).toContain(CLOSING_LINE);
    }
    expect(CLOSING_LINE).toBe("Questions? Ask your facilitator.");
    expect(VALIDITY_LINE).toBe("The code is valid for 10 minutes.");
    expect(REASON_LINE).toMatch(/^You get this email because someone asked to sign in to the SSD Workshop with this address\./);
  });

  it("has no Reply-To (nobody needs to reply; the sender receives no mail)", () => {
    expect(Object.keys(email).sort()).toEqual(["from", "html", "subject", "text"]);
    expect(JSON.stringify(email).toLowerCase()).not.toContain("reply-to");
  });

  it("keeps the HTML simple: no images, no links, no scripts, no external styles", () => {
    expect(email.html).toMatch(/^<!doctype html>/i);
    for (const banned of ["<img", "<a ", "href=", "src=", "<script", "<link", "http://", "https://"]) {
      expect(email.html.toLowerCase()).not.toContain(banned);
    }
  });

  it("refuses anything but six digits (the code is the only variable part)", () => {
    for (const bad of ["12345", "1234567", "12345a", "<b>12</b>", ""]) {
      expect(() => buildCodeEmail(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
