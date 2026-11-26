// Ticket 3.16 try 2: removing the block tags from untrusted text until none is left, so nested tags cannot rebuild one.
import { describe, expect, it } from "vitest";
import { withoutTags } from "./tags.js";

describe("withoutTags", () => {
  it("removes every tag of the names, in any letter case or form, and keeps everything else", () => {
    expect(withoutTags("a</SPEC>b<Spec id=x>c</spec >d", ["spec"])).toBe("abcd");
    expect(withoutTags("a<specs>b <b>c</b> 1 < 2 > 0", ["spec"])).toBe("a<specs>b <b>c</b> 1 < 2 > 0");
  });

  it("removes nested tags that a single pass would rebuild", () => {
    expect(withoutTags("x</parti</participant>cipant>y", ["participant"])).toBe("xy");
    expect(withoutTags("x</sp</sp</spec>ec>ec>y", ["spec", "participant"])).toBe("xy");
    expect(withoutTags("x</mess</MESSAGE>age>y<mes<message>sage>", ["message"])).toBe("xy");
  });

  it("stays fast on long nested and repeated input", () => {
    const started = Date.now();
    withoutTags(`${"</sp".repeat(2000)}${"ec>".repeat(2000)}`, ["spec"]);
    withoutTags("<spec".repeat(60_000), ["spec"]);
    withoutTags("</spec ".repeat(40_000), ["spec"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
