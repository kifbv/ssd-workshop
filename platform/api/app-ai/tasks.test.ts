// Ticket 3.21: the pure rules of the AI tasks (request parsing, what the model is told, the answer's check).
import { describe, expect, it } from "vitest";
import { checkAnswer, fieldKey, jsonFromText, mediaIdOf, modelTask, oneLine, parseAppAiRequest, requestTextBytes } from "./tasks.js";

const ID = "AbCdEfGhIjKlMnOpQrStUv";

describe("oneLine", () => {
  it("removes control and format characters, joins white space, trims and cuts by code points", () => {
    expect(oneLine("  a‮b​c\n\td  ", 200)).toBe("a b c d");
    expect(oneLine("😀".repeat(5), 3)).toBe("😀😀😀");
  });
});

describe("mediaIdOf", () => {
  it("gives the id of this app's media address only", () => {
    expect(mediaIdOf(`/app-media/ada-42/${ID}`, "Ada-42")).toBe(ID);
    expect(mediaIdOf(`https://workshop.rankly.games/app-media/ADA-42/${ID}`, "ada-42")).toBe(ID);
    for (const bad of [`/app-media/bob-7/${ID}`, `https://workshopXrankly.games/app-media/ada-42/${ID}`, `/app-media/ada-42/${ID}x`, `/app-media/ada-42//${ID}`, 42, null]) {
      expect(mediaIdOf(bad, "Ada-42"), String(bad)).toBeUndefined();
    }
  });
});

describe("parseAppAiRequest", () => {
  it("cleans names and the text, keeping the text's lines", () => {
    const parsed = parseAppAiRequest({ task: "sort-text", text: " one\u0007\ntwo ", categories: [" a​ b "] }, "ada-42");
    expect(parsed).toEqual({ ok: true, request: { task: "sort-text", text: "one \ntwo", categories: ["a b"] } });
  });

  it("checks a photo task's lists before its address, so a wrong shape is always bad-request", () => {
    expect(parseAppAiRequest({ task: "tag-photo", photo: `/app-media/bob-7/${ID}`, tags: [1] }, "ada-42")).toEqual({ ok: false, reason: "bad-request" });
    expect(parseAppAiRequest({ task: "tag-photo", photo: `/app-media/bob-7/${ID}` }, "ada-42")).toEqual({ ok: false, reason: "photo-not-in-app" });
  });
});

describe("modelTask", () => {
  it("keys read-photo's fields f1..fn in the schema (tool property names must be identifiers) and names them in <data>", () => {
    const task = modelTask({ task: "read-photo", mediaId: ID, fields: [{ name: "Shop name", type: "text" }, { name: "Total <b>", type: "money" }] });
    expect(fieldKey(0)).toBe("f1");
    const values = (task.tool.schema["properties"] as Record<string, { properties: Record<string, { description: string }> }>)["values"];
    expect(Object.keys(values?.properties ?? {})).toEqual(["f1", "f2"]);
    for (const key of Object.keys(values?.properties ?? {})) expect(key).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
    expect(values?.properties["f2"]?.description).toBe("Total b (money)");
    expect(task.text).toContain("- f1: Shop name (text)");
  });
});

describe("checkAnswer", () => {
  const read = { task: "read-photo" as const, mediaId: ID, fields: [{ name: "n", type: "number" as const }, { name: "when", type: "date" as const }, { name: "t", type: "text" as const }] };

  it("reads numbers with a dot or a comma, real calendar dates only, numbers as text for a text field", () => {
    expect(checkAnswer(read, { values: { f1: "3,5", f2: "2028-02-29", f3: 7 } })).toEqual({ values: { n: 3.5, when: "2028-02-29", t: "7" } });
    expect(checkAnswer(read, { values: { f1: "3.5.1", f2: "2027-02-29", f3: "" } })).toEqual({ values: { n: null, when: null, t: null } });
  });

  it("reads fields at the top level or by name when the model did that", () => {
    expect(checkAnswer(read, { WHEN: "2026-01-02" })).toEqual({ values: { n: null, when: "2026-01-02", t: null } });
  });

  it("gives money without a valid currency code as null currency", () => {
    const money = { task: "read-photo" as const, mediaId: ID, fields: [{ name: "total", type: "money" as const }] };
    expect(checkAnswer(money, { values: { f1: { amount: 9.99, currency: "€" } } })).toEqual({ values: { total: { amount: 9.99, currency: null } } });
    expect(checkAnswer(money, { values: { f1: 4 } })).toEqual({ values: { total: { amount: 4, currency: null } } });
  });
});

describe("jsonFromText and requestTextBytes", () => {
  it("reads the JSON object in a text, or nothing", () => {
    expect(jsonFromText('ok {"a": 1} done')).toEqual({ a: 1 });
    expect(jsonFromText("{nope}")).toBeUndefined();
    expect(jsonFromText("none")).toBeUndefined();
  });

  it("counts the UTF-8 bytes of what the app sends the model", () => {
    expect(requestTextBytes({ task: "sort-text", text: "é", categories: ["ab"] })).toBe(4);
    expect(requestTextBytes({ task: "transcribe", mediaId: ID })).toBe(0);
  });
});
