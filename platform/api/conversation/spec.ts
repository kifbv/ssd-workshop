// Step 2, Spec (ticket 1.9): the spec's format, the system prompt that writes and changes it, and the
// checks the AI worker applies before it stores a new version. Pure TypeScript without Node.js or DOM
// APIs: the page (platform/web) uses parseSpec to show a spec, and the eval uses checkSpec.
//
// A spec is short Markdown:
//
//   # <App name>
//
//   ```mermaid
//   flowchart TD
//     ...
//   ```
//
//   ## What it does
//   ## Screens
//   ## Data it keeps
//
// The model writes a whole new version between a `<spec>` line and a `</spec>` line, after a short
// answer; an answer to a question has no such block, so the spec stays as it is.

// Ticket 3.20 (spec-v3): the shared rules say apps take or pick photos and record voice messages, kept by the workshop
// (up to 500 MB per app, beside 10 MB of other information, seen by everyone with the link), never videos.
export const SPEC_PROMPT_VERSION = "spec-v3";

/** The sections every spec has, in this order (criterion 1). */
export const SPEC_SECTIONS = ["What it does", "Screens", "Data it keeps"] as const;

/** A spec longer than this is refused (the prompt asks for about 300 words). */
export const MAX_SPEC_CHARS = 8000;

/**
 * The message Write my spec stores for the AI worker (ticket 1.9). The worker skips the guardrail
 * check for exactly this text at step 2: it is the platform's own words, so whoever sends it, nothing
 * else gets past the check.
 */
export const WRITE_SPEC_REQUEST = "Please write my spec.";

/** The answer shown when the model wrote a new version but no words around it. */
export const DEFAULT_SPEC_ANSWER = "Here is your spec. Ask me anything about it, or ask for a change.";

/**
 * The spec's format and rules, shared by the step 2 prompt and the change prompt (ticket 3.6, ./change.ts), so both
 * write the same shape (a change here moves both versions: `spec-v3` and `change-v3`, ticket 3.20).
 */
export const SPEC_FORMAT_AND_RULES = `The spec goes between a line that is exactly <spec> and a line that is exactly </spec>, in this format:
<spec>
# App name in a few words

\`\`\`mermaid
flowchart TD
  home[Home screen] -->|add a run| add[Add a run]
  add -->|saves| runs[(Runs)]
  runs -->|totals| home
\`\`\`

## What it does
Two to four short sentences: who it is for and what it helps them do.

## Screens
- Screen name: what the person sees and does there.

## Data it keeps
- Thing it keeps: the details kept for each one, in plain words.
</spec>

Rules for the spec:
- Exactly these parts, in this order: the title line, the diagram, then the headings "## What it does", "## Screens" and "## Data it keeps". No other headings.
- The app is one page in the browser: "screens" are the views of that page. Two to four screens.
- The diagram is a Mermaid flowchart that starts with "flowchart TD". It shows the screens as boxes (id[Label]) and the data the app keeps as cylinders (id[(Label)]), with arrows for how the person moves between screens and where data is saved or shown, each arrow with a short label (-->|label|). Four to ten boxes and cylinders in all. Ids are short lower-case words without spaces. Labels are plain words: no quotes, brackets, parentheses, colons, semicolons, ampersands, hashes or other symbols. No styles, classes, links, comments or subgraphs.
- Lists use "- " at the start of the line. No bold, italics, tables or code apart from the diagram.
- Plain English for people who are not developers: no technical words (database, API, framework, server). About 300 words at most.
- The app may show information from a free public service that needs no key (for example summaries and pictures from Wikipedia, film posters included, books and covers from Open Library, weather from Open-Meteo, exchange rates from Frankfurter, TV shows from TVMaze, facts about countries from REST Countries). When it does, name the information and its source in plain words where the app uses it (for example "movie posters and summaries from Wikipedia"), and say that the app shows a friendly message when the source does not answer. Never write web addresses, keys or technical words about it. Never use a service that needs a key, an account or a sign-in, or that costs money, and never send emails, texts or notifications.
- The app may take photos with the phone's camera or pick them from the phone, and record voice messages with the phone (up to 5 minutes each). The workshop keeps them with the app (up to 500 MB of photos and voice messages per app, beside up to 10 MB of other information), and everyone with the app's link can see and hear them. When the app keeps photos or voice messages, say so in "Data it keeps" with the details kept with each one (for example "- Drawings: the photo, its tags and the day it was added"), and say in "Screens" where they are taken or recorded. Never videos.
- Never invent personal data about real people, and never write code.`;

export const SPEC_SYSTEM_PROMPT = `You are the friendly guide of a one-day workshop in which non-developers turn an idea into a small single-page web app. This is step 2, Spec: you write a short spec of the participant's app from the conversation so far, then explain it and change it as often as they like. When they are happy they press the "Approve spec" button, and the app is then built from the spec. The workshop builds and hosts the app; never discuss servers, hosting, programming languages, frameworks or code.

How to reply:
- When there is no current spec yet, write it now: one or two short sentences, then the whole spec.
- When the participant asks for a change (add, remove, rename, simplify, "make it...", "I'd like..."), make the change: one or two short sentences saying what you changed, then the whole new spec. Keep everything they did not ask to change exactly as it was.
- When the participant asks a question (what, why, how, explain, "what does ... mean"), answer it in plain language in no more than about 120 words, and do not write a spec: the spec stays as it is. If you are not sure whether they want a change, answer, then ask whether they would like it changed.
- If a change would make the app too big for a small single-page app, suggest a simpler version of it and ask whether that is fine, without writing a spec.
- Small details the conversation left open (units, sorting, wording, colours) get sensible defaults; mention a default only when it matters.

${SPEC_FORMAT_AND_RULES}`;

/** A model answer split into the words shown in the conversation and, when there is one, a new spec. */
export interface SpecAnswer {
  /** The words around the spec block, trimmed (may be empty). */
  answer: string;
  /** The new spec's Markdown, when the answer carries one. */
  spec?: string;
  /** True when a `<spec>` block was opened but never closed (cut off): the answer is unusable. */
  malformed: boolean;
}

/** Splits a model answer into its words and its `<spec>` block (the last one, if several). */
export function extractSpec(text: string): SpecAnswer {
  const open = /^[ \t]*<spec>[ \t]*$/gim;
  const close = /^[ \t]*<\/spec>[ \t]*$/gim;
  const opens = [...text.matchAll(open)];
  const lastOpen = opens.at(-1);
  if (lastOpen === undefined) {
    // A stray closing tag alone is just removed from the words.
    return { answer: text.replace(close, "").trim(), malformed: false };
  }
  const start = (lastOpen.index ?? 0) + lastOpen[0].length;
  close.lastIndex = start;
  const end = close.exec(text);
  if (end === null) return { answer: text.slice(0, lastOpen.index).trim(), malformed: true };
  const spec = stripOuterFence(text.slice(start, end.index).trim());
  const answer = `${text.slice(0, opens[0]?.index ?? 0)}\n${text.slice(end.index + end[0].length)}`.replace(open, "").replace(close, "").replace(/\n{3,}/g, "\n\n").trim();
  return { answer, spec, malformed: false };
}

/** A spec the model wrapped in a ```markdown fence as a whole, without that fence. */
function stripOuterFence(spec: string): string {
  const match = /^```(?:markdown|md)?[ \t]*\n([\s\S]*)\n```$/i.exec(spec);
  return match ? (match[1] ?? "").trim() : spec;
}

/** One section of a spec: its heading and its lines (blank lines kept, trimmed at both ends). */
export interface SpecSection {
  heading: string;
  lines: string[];
}

export interface ParsedSpec {
  title: string;
  /** The Mermaid source (without the fence), or "" when there is none. */
  diagram: string;
  sections: SpecSection[];
  /** How many ```mermaid blocks there were (a spec has exactly one). */
  diagramCount: number;
  /** Lines outside the title, the diagram and the sections (a spec has none). */
  strayLines: string[];
}

const trimBlank = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
};

/** Reads a spec's parts, whatever its shape (checkSpec says whether the shape is right). */
export function parseSpec(markdown: string): ParsedSpec {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  let diagram = "";
  let diagramCount = 0;
  const sections: SpecSection[] = [];
  const strayLines: string[] = [];
  let fence: { mermaid: boolean; lines: string[] } | undefined;
  for (const line of lines) {
    if (fence !== undefined) {
      if (/^\s*```\s*$/.test(line)) {
        if (fence.mermaid && diagramCount === 1) diagram = fence.lines.join("\n").trim();
        else if (!fence.mermaid) (sections.at(-1)?.lines ?? strayLines).push(...fence.lines);
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const fenceStart = /^\s*```\s*([A-Za-z]*)\s*$/.exec(line);
    if (fenceStart) {
      const mermaid = (fenceStart[1] ?? "").toLowerCase() === "mermaid";
      if (mermaid) diagramCount++;
      fence = { mermaid, lines: [] };
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const text = heading[2] ?? "";
      if ((heading[1] ?? "").length === 1 && title === "" && sections.length === 0) title = text;
      else sections.push({ heading: text, lines: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current) current.lines.push(line);
    else if (line.trim() !== "") strayLines.push(line);
  }
  // An unclosed fence: its lines are not a diagram.
  if (fence !== undefined && !fence.mermaid) (sections.at(-1)?.lines ?? strayLines).push(...fence.lines);
  if (fence?.mermaid === true && diagramCount === 1) diagramCount = 0;
  return { title, diagram, diagramCount, sections: sections.map((s) => ({ heading: s.heading, lines: trimBlank(s.lines) })), strayLines };
}

/**
 * What is wrong with a spec's shape (criterion 1): an empty list when it has a title, exactly one
 * Mermaid flowchart, and exactly the sections "What it does", "Screens" and "Data it keeps", in that
 * order, none of them empty. Whether the diagram parses is checked by Mermaid itself (the page and
 * `npm run eval -- spec`).
 */
export function checkSpec(markdown: string): string[] {
  const problems: string[] = [];
  if (markdown.trim() === "") return ["the spec is empty"];
  if (markdown.length > MAX_SPEC_CHARS) problems.push(`longer than ${MAX_SPEC_CHARS} characters`);
  const spec = parseSpec(markdown);
  if (spec.title.trim() === "") problems.push("no title line (# App name)");
  if (spec.diagramCount !== 1) problems.push(`${spec.diagramCount} Mermaid diagrams (expected 1)`);
  else if (!/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/.test(spec.diagram)) problems.push("the diagram is not a flowchart");
  // Links and click handlers are never needed and Mermaid draws in "loose" mode (decisions.md (1.9)).
  else if (/^\s*(click|href|call)\b/m.test(spec.diagram)) problems.push("the diagram has a link or click line");
  const headings = spec.sections.map((s) => s.heading.toLowerCase());
  const expected = SPEC_SECTIONS.map((s) => s.toLowerCase());
  if (headings.join("|") !== expected.join("|")) problems.push(`sections are ${JSON.stringify(spec.sections.map((s) => s.heading))} (expected ${JSON.stringify(SPEC_SECTIONS)})`);
  for (const section of spec.sections) {
    if (section.lines.every((l) => l.trim() === "")) problems.push(`the section "${section.heading}" is empty`);
  }
  if (spec.strayLines.length > 0) problems.push("text before the first section");
  return problems;
}

/** The system prompt for step 2, with the current spec (or the note that there is none yet). */
export function specSystemPrompt(currentSpec: string | undefined): string {
  const current =
    currentSpec === undefined
      ? "There is no current spec yet: write the first version now."
      : `The current spec (the participant sees it on the page):\n<current_spec>\n${currentSpec}\n</current_spec>`;
  return `${SPEC_SYSTEM_PROMPT}\n\n${current}`;
}
