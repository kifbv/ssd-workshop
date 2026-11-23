// Step 2, Spec (ticket 1.9): what the spec and approve API answers mean for the page, and how a spec's
// Markdown becomes blocks of text, as pure functions so every rule is unit tested without a browser.
// The DOM wiring is in ./main.ts; the diagram is drawn by ./diagram.ts.
import { parseSpec } from "../../api/conversation/spec.js";
import { isVersion, type ChatMessage } from "./chat.js";
import { MESSAGES, messageOf, type ApiAnswer, type Show, type Tone } from "./flow.js";

/** A spec version as `GET /api/conversation/spec` returns it. */
export interface SpecVersion {
  version: number;
  text: string;
  approved: boolean;
}

export const SPEC_TEXTS = {
  writing: "The AI is writing your spec…",
  answering: "The AI is writing…",
  notYet: "Your spec is not written yet. Press the button to ask the AI for it.",
  approveHint: "Happy with it? Approve your spec. You can still ask questions or ask for changes until you do.",
  approved: "Spec approved. Next comes the build: the AI turns this spec into your app. Your facilitator will tell you when the build starts.",
  drawing: "Drawing the diagram…",
  noDiagram: "The diagram could not be drawn. Ask the AI to fix it, or read it as text below.",
  diagramText: "Diagram as text",
  empty: "Please write a message first.",
  seeVersion: (version: number): string => `See version ${version} of the spec`,
} as const;

const show = (message: string, tone: Tone = "error"): Show => ({ kind: "show", message, tone });

function common(answer: ApiAnswer): Show {
  if (answer.status === 429) return show(MESSAGES.retry, "info");
  if (answer.status === 0) return show(MESSAGES.offline);
  return show(MESSAGES.failed);
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** `GET /api/conversation/spec`: a version, none yet (404), signed out, or a message. */
export function specResult(answer: ApiAnswer): { kind: "spec"; spec: SpecVersion } | { kind: "none" } | { kind: "signed-out" } | Show {
  if (answer.status === 200) {
    const b = record(answer.body);
    const version = b?.["version"];
    const text = b?.["text"];
    if (isVersion(version) && typeof text === "string") return { kind: "spec", spec: { version, text, approved: b?.["approved"] === true } };
    return show(MESSAGES.failed);
  }
  if (answer.status === 404) return { kind: "none" };
  if (answer.status === 401) return { kind: "signed-out" };
  return common(answer);
}

/** `POST /api/conversation/spec/approve`. A refusal re-reads the conversation (it says what changed). */
export function approveResult(answer: ApiAnswer): { kind: "approved" } | { kind: "refused"; message: string } | { kind: "signed-out" } | Show {
  if (answer.status === 200) return { kind: "approved" };
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === 409) return { kind: "refused", message: messageOf(answer.body) ?? MESSAGES.failed };
  if (answer.status === 400) return show(messageOf(answer.body) ?? MESSAGES.failed);
  return common(answer);
}

/** The messages step 2 shows: its own (step 1's stay on step 1). */
export function stepTwoMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.step === "spec" || m.step === "approved");
}

/** A block of a spec section: a paragraph or a list. */
export type SpecBlock = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

/** Markdown emphasis and code marks, which the page shows as plain text. */
const plain = (text: string): string => text.replace(/\*\*|__|`/g, "").trim();

/** A section's lines as paragraphs (lines joined until a blank line) and lists ("- ", "* " or "1. " lines). */
export function specBlocks(lines: readonly string[]): SpecBlock[] {
  const blocks: SpecBlock[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: plain(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const line of lines) {
    const item = /^\s*(?:[-*+]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const last = blocks.at(-1);
      const text = plain(item[1] ?? "");
      if (last?.kind === "list") last.items.push(text);
      else blocks.push({ kind: "list", items: [text] });
    } else if (line.trim() === "") {
      flush();
    } else {
      const last = blocks.at(-1);
      // A wrapped list item continues the item.
      if (paragraph.length === 0 && last?.kind === "list" && /^\s{2,}\S/.test(line)) last.items[last.items.length - 1] += ` ${plain(line)}`;
      else paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** A spec as the page shows it: its title, its diagram source, and its sections as blocks. */
export function specView(text: string): { title: string; diagram: string; sections: { heading: string; blocks: SpecBlock[] }[] } {
  const spec = parseSpec(text);
  return {
    title: plain(spec.title),
    diagram: spec.diagram,
    sections: spec.sections.map((s) => ({ heading: plain(s.heading), blocks: specBlocks(s.lines) })),
  };
}
