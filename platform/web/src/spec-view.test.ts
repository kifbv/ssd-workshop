// Ticket 1.9: the step 2 page's rules (spec-view.ts) and the diagram picture (diagram-svg.ts).
import { describe, expect, it } from "vitest";
import { finishSvg, pictureUrl, STYLE_PLACEHOLDER_CLASS } from "./diagram-svg.js";
import { MESSAGES } from "./flow.js";
import { approveResult, specBlocks, specResult, specView, stepTwoMessages } from "./spec-view.js";
import { parseConversation, sendResult } from "./chat.js";

const SPEC = `# Run **log**

\`\`\`mermaid
flowchart TD
  home[Home] -->|saves| runs[(Runs)]
\`\`\`

## What it does
A log of your runs
that shows the weekly total.

Second paragraph.

## Screens
- Home: the **total**.
- Add a run: date and
  distance.

## Data it keeps
1. Runs: date and distance.`;

describe("specView and specBlocks", () => {
  it("shows the title, the diagram source, and each section as paragraphs and lists, without Markdown marks", () => {
    expect(specView(SPEC)).toEqual({
      title: "Run log",
      diagram: "flowchart TD\n  home[Home] -->|saves| runs[(Runs)]",
      sections: [
        { heading: "What it does", blocks: [{ kind: "paragraph", text: "A log of your runs that shows the weekly total." }, { kind: "paragraph", text: "Second paragraph." }] },
        { heading: "Screens", blocks: [{ kind: "list", items: ["Home: the total.", "Add a run: date and distance."] }] },
        { heading: "Data it keeps", blocks: [{ kind: "list", items: ["Runs: date and distance."] }] },
      ],
    });
    expect(specBlocks(["Intro", "- a", "- b", "after"])).toEqual([
      { kind: "paragraph", text: "Intro" },
      { kind: "list", items: ["a", "b"] },
      { kind: "paragraph", text: "after" },
    ]);
  });
});

describe("API answers", () => {
  it("reads a spec version, none yet (404), a sign-out and failures", () => {
    expect(specResult({ status: 200, body: { version: 2, text: SPEC, createdAt: "x", approved: true } })).toEqual({ kind: "spec", spec: { version: 2, text: SPEC, approved: true } });
    expect(specResult({ status: 200, body: { version: 0, text: SPEC } })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
    expect(specResult({ status: 404, body: { message: "Not found." } })).toEqual({ kind: "none" });
    expect(specResult({ status: 401, body: {} })).toEqual({ kind: "signed-out" });
    expect(specResult({ status: 0, body: null })).toEqual({ kind: "show", message: MESSAGES.offline, tone: "error" });
  });

  it("reads Approve spec's answers: approved, a refusal with its reason, a sign-out", () => {
    expect(approveResult({ status: 200, body: { step: "approved", version: 2 } })).toEqual({ kind: "approved" });
    expect(approveResult({ status: 409, body: { reason: "stale", message: "There is a newer version." } })).toEqual({ kind: "refused", message: "There is a newer version." });
    expect(approveResult({ status: 401, body: {} })).toEqual({ kind: "signed-out" });
    expect(approveResult({ status: 429, body: {} })).toEqual({ kind: "show", message: MESSAGES.retry, tone: "info" });
    expect(sendResult({ status: 409, body: { reason: "approved", message: "x" } })).toEqual({ kind: "approved" });
  });

  it("reads the conversation's steps and spec versions, and keeps step 2's messages for step 2", () => {
    const conversation = parseConversation({
      step: "spec",
      state: "open",
      latestSpecVersion: 2,
      approvedSpecVersion: "2",
      messages: [
        { id: "a", author: "participant", text: "idea", status: "done", step: "clarify" },
        { id: "a-r", author: "assistant", text: "Who?", step: "clarify" },
        { id: "b", author: "participant", text: "Please write my spec.", status: "done", step: "spec" },
        { id: "b-r", author: "assistant", text: "Here.", step: "spec", specVersion: 1 },
      ],
    });
    expect(conversation).toMatchObject({ step: "spec", latestSpecVersion: 2 });
    expect(conversation?.approvedSpecVersion).toBeUndefined();
    expect(stepTwoMessages(conversation?.messages ?? []).map((m) => m.id)).toEqual(["b", "b-r"]);
    expect(conversation?.messages[3]).toEqual({ id: "b-r", author: "assistant", text: "Here.", step: "spec", specVersion: 1 });
  });
});

describe("finishSvg", () => {
  const svg = `<svg id="d1" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 202.9px;" viewBox="4.5 4 202.95 544.7"><desc class="${STYLE_PLACEHOLDER_CLASS}">#d1{font-size:16px;} .a&gt;.b{fill:red;}</desc><g><desc>a node</desc></g></svg>`;

  it("turns the style placeholder back into a style element and gives the picture its size", () => {
    const picture = finishSvg(svg);
    expect(picture).toEqual({
      svg: '<svg width="203" height="545" id="d1" xmlns="http://www.w3.org/2000/svg" class="flowchart" viewBox="4.5 4 202.95 544.7"><style>#d1{font-size:16px;} .a&gt;.b{fill:red;}</style><g><desc>a node</desc></g></svg>',
      width: 203,
      height: 545,
    });
    expect(pictureUrl(must(picture))).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(must(picture).svg)}`);
  });

  it("refuses an SVG without a usable viewBox", () => {
    expect(finishSvg("<p>no</p>")).toBeUndefined();
    expect(finishSvg('<svg viewBox="0 0 0 10"></svg>')).toBeUndefined();
    expect(finishSvg('<svg viewBox="0 0 x 10"></svg>')).toBeUndefined();
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}
