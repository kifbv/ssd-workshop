// Ticket 1.9 (Step 2: Spec and approval): the spec's format, the step 2 answers, the spec and approve
// routes, and the end of changes after approval.
import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../http.js";
import { SESSION_COOKIE } from "../session/session.js";
import { MODEL_ID } from "../settings.js";
import { answerMessage, readSpecAnswer, SPEC_MAX_TOKENS } from "./answer.js";
import {
  APPROVE_ROUTE,
  handleConversationRequest,
  HISTORY_ROUTE,
  MESSAGES,
  parseVersion,
  SEND_ROUTE,
  SPEC_ROUTE,
  STEP_ROUTE,
  type ConversationDeps,
  type ConversationLogEntry,
} from "./conversation.js";
import { FakeBuildQueue, FakeConversationTable, FakeModel, FakeQueue, verdictReply } from "./fakes.js";
import {
  checkSpec,
  DEFAULT_SPEC_ANSWER,
  extractSpec,
  parseSpec,
  SPEC_PROMPT_VERSION,
  SPEC_SECTIONS,
  SPEC_SYSTEM_PROMPT,
  specSystemPrompt,
  WRITE_SPEC_REQUEST,
} from "./spec.js";
import { FAILURE_REPLY, jobBody, parseJob, STALE_PENDING_SECONDS } from "./state.js";
import { processJob, type WorkerDeps } from "./worker.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

export const SPEC_V1 = `# Run log

\`\`\`mermaid
flowchart TD
  home[Home] -->|add a run| add[Add a run]
  add -->|saves| runs[(Runs)]
  runs -->|weekly total| home
\`\`\`

## What it does
A log of your runs that shows this week's total distance.

## Screens
- Home: this week's total and the list of runs.
- Add a run: date, distance and time.

## Data it keeps
- Runs: date, distance in km and time.`;

export const SPEC_V2 = SPEC_V1.replace("- Add a run: date, distance and time.", "- Add a run: date, distance and time.\n- Longest run: your longest run so far.");

const specAnswer = (words: string, spec: string) => `${words}\n<spec>\n${spec}\n</spec>`;

describe("the spec format (criterion 1)", () => {
  it("accepts a spec with a title, one flowchart and the three sections in order", () => {
    expect(SPEC_SECTIONS).toEqual(["What it does", "Screens", "Data it keeps"]);
    expect(checkSpec(SPEC_V1)).toEqual([]);
    expect(parseSpec(SPEC_V1)).toMatchObject({
      title: "Run log",
      diagram: expect.stringMatching(/^flowchart TD\n {2}home\[Home\]/) as unknown,
      diagramCount: 1,
      sections: [
        { heading: "What it does", lines: ["A log of your runs that shows this week's total distance."] },
        { heading: "Screens", lines: ["- Home: this week's total and the list of runs.", "- Add a run: date, distance and time."] },
        { heading: "Data it keeps", lines: ["- Runs: date, distance in km and time."] },
      ],
      strayLines: [],
    });
  });

  it("names what is missing or wrong", () => {
    expect(checkSpec("")).toEqual(["the spec is empty"]);
    expect(checkSpec(SPEC_V1.replace("# Run log", ""))).toContain("no title line (# App name)");
    const noDiagram = SPEC_V1.replace(/```mermaid[\s\S]*?```/, "");
    expect(checkSpec(noDiagram)).toContain("0 Mermaid diagrams (expected 1)");
    expect(checkSpec(`${SPEC_V1}\n\n\`\`\`mermaid\nflowchart TD\n a --> b\n\`\`\``)).toContain("2 Mermaid diagrams (expected 1)");
    expect(checkSpec(SPEC_V1.replace("flowchart TD", "sequenceDiagram"))).toContain("the diagram is not a flowchart");
    expect(checkSpec(SPEC_V1.replace("## Screens", "## Pages")).join()).toContain("sections are");
    expect(checkSpec(SPEC_V1.replace("## Data it keeps\n- Runs: date, distance in km and time.", "## Data it keeps\n"))).toContain('the section "Data it keeps" is empty');
    expect(checkSpec(`${SPEC_V1}\n\n## Extra\nmore`).join()).toContain("sections are");
    expect(checkSpec(SPEC_V1.replace("# Run log", "# Run log\nSome words before the sections."))).toContain("text before the first section");
    expect(checkSpec(SPEC_V1.replace(/```\n\n## What/, "\n## What")).join()).toContain("Mermaid diagrams");
    expect(checkSpec(SPEC_V1 + "x".repeat(8000))).toContain("longer than 8000 characters");
    for (const line of ["click home href \"https://example.com\"", "  click home callback", "href home \"x\"", "call home()"]) {
      expect(checkSpec(SPEC_V1.replace("flowchart TD", `flowchart TD\n${line}`))).toContain("the diagram has a link or click line");
    }
  });

  it("splits an answer into its words and the spec block, and spots a cut-off block", () => {
    expect(extractSpec(specAnswer("Here is your spec.", SPEC_V1))).toEqual({ answer: "Here is your spec.", spec: SPEC_V1, malformed: false });
    expect(extractSpec("Screens are the views of your page.")).toEqual({ answer: "Screens are the views of your page.", malformed: false });
    expect(extractSpec(`I added it.\n<spec>\n${SPEC_V1}`)).toEqual({ answer: "I added it.", malformed: true });
    // A fenced spec inside the tags, words after the block, and two blocks (the last one counts).
    expect(extractSpec(`Done.\n<spec>\n\`\`\`markdown\n${SPEC_V1}\n\`\`\`\n</spec>\nAnything else?`)).toEqual({ answer: "Done.\n\nAnything else?", spec: SPEC_V1, malformed: false });
    expect(extractSpec(`A\n<spec>\nold\n</spec>\nB\n<spec>\n${SPEC_V2}\n</spec>`).spec).toBe(SPEC_V2);
  });

  it("asks for the format, the diagram and question-versus-change in the prompt, with the current spec", () => {
    expect(SPEC_PROMPT_VERSION).toBe("spec-v2");
    // Ticket 2.14: an outside source is named in plain words, never with an address or a key.
    expect(SPEC_SYSTEM_PROMPT).toContain('name the information and its source in plain words where the app uses it (for example "movie posters and summaries from Wikipedia")');
    expect(SPEC_SYSTEM_PROMPT).toContain("Never write web addresses, keys or technical words about it.");
    for (const part of ["## What it does", "## Screens", "## Data it keeps", "flowchart TD", "do not write a spec: the spec stays as it is", '"Approve spec"']) {
      expect(SPEC_SYSTEM_PROMPT).toContain(part);
    }
    expect(specSystemPrompt(undefined)).toContain("There is no current spec yet");
    expect(specSystemPrompt(SPEC_V1)).toContain(`<current_spec>\n${SPEC_V1}\n</current_spec>`);
  });

  it("reads a step 2 answer: a checked new spec, the words alone, or an error", () => {
    expect(readSpecAnswer(specAnswer("Here you go.", SPEC_V1), undefined)).toEqual({ text: "Here you go.", spec: SPEC_V1 });
    expect(readSpecAnswer(`<spec>\n${SPEC_V1}\n</spec>`, undefined)).toEqual({ text: DEFAULT_SPEC_ANSWER, spec: SPEC_V1 });
    expect(readSpecAnswer("It keeps your runs.", SPEC_V1)).toEqual({ text: "It keeps your runs." });
    expect(() => readSpecAnswer("It keeps your runs.", undefined)).toThrow(expect.objectContaining({ name: "MissingSpec" }) as Error);
    expect(() => readSpecAnswer(specAnswer("x", SPEC_V1.replace("## Screens", "## Pages")), SPEC_V1)).toThrow(expect.objectContaining({ name: "MalformedSpec" }) as Error);
    expect(() => readSpecAnswer(`x\n<spec>\n${SPEC_V1}`, SPEC_V1)).toThrow(expect.objectContaining({ name: "MalformedSpec" }) as Error);
  });

  it("sends the spec prompt with the current spec and a larger token limit", async () => {
    const model = new FakeModel([{ text: "Screens are views.", inputTokens: 5, outputTokens: 5 }]);
    const answer = await answerMessage(model, "spec", [{ question: "a run log", answer: "Who for?" }], "What is a screen?", undefined, SPEC_V1);
    expect(answer).toMatchObject({ text: "Screens are views.", promptVersion: "spec-v2", offersSpec: false, historyCount: 2 });
    expect(answer.spec).toBeUndefined();
    expect(model.requests[0]).toMatchObject({ maxTokens: SPEC_MAX_TOKENS, system: specSystemPrompt(SPEC_V1) });
  });

  it("reads a version from the query string only as a plain whole number from 1 to 9999", () => {
    expect(parseVersion("1")).toBe(1);
    expect(parseVersion("9999")).toBe(9999);
    for (const bad of [undefined, "", "0", "01", "1.5", "-1", "10000", "1e2", " 1", "x"]) expect(parseVersion(bad), String(bad)).toBeUndefined();
  });
});

const START = new Date("2026-11-23T10:00:00.000Z");
const START_S = START.getTime() / 1000;
const token = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const MINE = token(1);
const THEIRS = token(2);
const cookie = (t: string) => [`${SESSION_COOKIE}=${t}`];
const json = (res: HttpResponse): Record<string, unknown> => JSON.parse(res.body ?? "") as Record<string, unknown>;
const send = (text: string, t: string = MINE): HttpRequest => ({
  routeKey: SEND_ROUTE,
  cookies: cookie(t),
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
const writeSpec = (t: string = MINE): HttpRequest => ({
  routeKey: STEP_ROUTE,
  cookies: cookie(t),
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ step: "spec" }),
});
const getSpec = (t: string = MINE, version?: string): HttpRequest => ({
  routeKey: SPEC_ROUTE,
  cookies: cookie(t),
  ...(version === undefined ? {} : { queryStringParameters: { version } }),
});
const approve = (version: unknown, t: string = MINE, contentType = "application/json"): HttpRequest => ({
  routeKey: APPROVE_ROUTE,
  cookies: cookie(t),
  headers: { "content-type": contentType },
  body: JSON.stringify({ version }),
});
const historyOf = (t: string = MINE): HttpRequest => ({ routeKey: HISTORY_ROUTE, cookies: cookie(t) });

/** Ada and Bob, both at step 1 with one answered exchange. */
async function setup() {
  const table = new FakeConversationTable();
  table.addParticipant("me-1", "Ada", MINE, START_S + 3600);
  table.addParticipant("other-2", "Bob", THEIRS, START_S + 3600);
  const queue = new FakeQueue();
  const model = new FakeModel();
  let clock = START;
  let counter = 0;
  const logs: ConversationLogEntry[] = [];
  const deps: ConversationDeps = { sessions: table, store: table, queue, now: () => clock, randomBytes: (n) => Buffer.alloc(n, ++counter), log: (e) => logs.push(e) };
  const workerDeps: WorkerDeps = { store: table, model, modelId: MODEL_ID, builds: new FakeBuildQueue(), held: queue, now: () => clock, log: () => undefined, sleep: async () => undefined };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  const drain = async () => {
    while (queue.sent.length > 0) await processJob(parseJob(jobBody(must(queue.sent.shift()))), workerDeps);
    advance(5);
  };
  const call = (request: HttpRequest) => handleConversationRequest(request, deps);
  for (const t of [MINE, THEIRS]) {
    await call(send(t === MINE ? "a run log for me" : "a kite flying diary", t));
    model.push(verdictReply("on-path"), { text: "Who is it for?", inputTokens: 10, outputTokens: 10 });
    await drain();
  }
  /** Writes the first spec for `t` with the model's `reply`. */
  const firstSpec = async (reply = specAnswer("Here is your spec.", SPEC_V1), t = MINE) => {
    const res = await call(writeSpec(t));
    model.push({ text: reply, inputTokens: 1000, outputTokens: 600 });
    await drain();
    return res;
  };
  /** Sends a step 2 message and lets the worker answer it with `reply` (after an on-path verdict). */
  const ask = async (text: string, reply: string, t = MINE) => {
    const res = await call(send(text, t));
    model.push(verdictReply("on-path"), { text: reply, inputTokens: 1200, outputTokens: 300 });
    await drain();
    return res;
  };
  return { table, queue, model, logs, call, drain, advance, firstSpec, ask };
}

describe("criterion 1 and 2: the spec is written, explained and changed", () => {
  it("WHEN Write my spec is pressed THEN the AI writes version 1 from the conversation, without a guardrail call for the platform's own request", async () => {
    const s = await setup();
    const res = await s.firstSpec();
    expect(json(res)).toEqual({ step: "spec", id: expect.any(String) as unknown });
    const id = json(res)["id"] as string;
    // The stored request is the platform's own text, at step 2.
    expect(s.table.messages.get("me-1")?.get(id)).toMatchObject({ text: WRITE_SPEC_REQUEST, step: "spec", status: "done" });
    // One model call only (no guardrail check), with the spec prompt and the clarify exchange as history.
    const request = must(s.model.requests.at(-1));
    expect(request.system).toBe(specSystemPrompt(undefined));
    expect(request.messages.map((m) => m.text)).toEqual(["a run log for me", "Who is it for?", WRITE_SPEC_REQUEST]);
    expect(s.model.requests).toHaveLength(5);
    expect(s.table.specs.get("me-1")).toEqual([{ version: 1, text: SPEC_V1, messageId: id, createdAt: expect.any(String) as unknown }]);
    expect(s.table.replies.get("me-1")?.get(id)).toMatchObject({ text: "Here is your spec.", specVersion: 1, promptVersion: "spec-v2" });
    // The spec is never kept in the reply's text, so it never goes back to the model as history.
    expect(s.table.replies.get("me-1")?.get(id)?.text).not.toContain("flowchart");

    const spec = await s.call(getSpec());
    expect(spec.statusCode).toBe(200);
    expect(spec.headers).toMatchObject({ "cache-control": "no-store" });
    expect(json(spec)).toEqual({ version: 1, text: SPEC_V1, createdAt: expect.any(String) as unknown, approved: false });
    const history = json(await s.call(historyOf()));
    expect(history).toMatchObject({ step: "spec", latestSpecVersion: 1 });
    expect((history["messages"] as unknown[]).slice(-2)).toEqual([
      { id, author: "participant", text: WRITE_SPEC_REQUEST, step: "spec", status: "done" },
      { id: `${id}-r`, author: "assistant", text: "Here is your spec.", step: "spec", specVersion: 1 },
    ]);
    // Pressed again with a spec there: nothing more is asked for.
    expect(json(await s.call(writeSpec()))).toEqual({ step: "spec" });
    expect(s.queue.sent).toEqual([]);
  });

  it("WHEN the participant asks a question THEN the AI answers without changing the spec, and WHEN they ask for a change THEN a new version is saved and shown", async () => {
    const s = await setup();
    await s.firstSpec();
    await s.ask("What does the arrow from Runs to Home mean?", "It means Home shows the total of your saved runs.");
    expect(s.table.specs.get("me-1")).toHaveLength(1);
    // The model saw the current spec and the conversation, without any spec text in the history.
    const question = must(s.model.requests.at(-1));
    expect(question.system).toBe(specSystemPrompt(SPEC_V1));
    expect(JSON.stringify(question.messages)).not.toContain("flowchart");
    expect(json(await s.call(getSpec()))).toMatchObject({ version: 1, text: SPEC_V1 });

    await s.ask("Please add a screen with my longest run.", specAnswer("I added a Longest run screen.", SPEC_V2));
    expect(s.table.specs.get("me-1")?.map((v) => v.version)).toEqual([1, 2]);
    expect(json(await s.call(getSpec()))).toMatchObject({ version: 2, text: SPEC_V2 });
    // Every version is kept.
    expect(json(await s.call(getSpec(MINE, "1")))).toMatchObject({ version: 1, text: SPEC_V1 });
    const history = json(await s.call(historyOf()));
    expect(history["latestSpecVersion"]).toBe(2);
    expect((history["messages"] as { text: string; specVersion?: number }[]).at(-1)).toMatchObject({ text: "I added a Longest run screen.", specVersion: 2 });
  });

  it("checks a change request with the guardrail like any message: a decline changes nothing", async () => {
    const s = await setup();
    await s.firstSpec();
    await s.call(send("Make it scrape my colleagues' profiles."));
    s.model.push(verdictReply("decline", "a habit tracker"));
    await s.drain();
    expect(s.table.specs.get("me-1")).toHaveLength(1);
    expect(s.model.requests.at(-1)?.system).not.toContain("current_spec");
  });

  it("ends a message whose new spec has the wrong shape or is cut off as failed, keeping the spec", async () => {
    const s = await setup();
    await s.firstSpec();
    for (const reply of [specAnswer("Changed.", SPEC_V2.replace("## Screens", "## Pages")), `Changed.\n<spec>\n${SPEC_V2}`]) {
      const res = await s.ask("Add a longest run screen.", reply);
      const id = json(res)["id"] as string;
      expect(s.table.messages.get("me-1")?.get(id)?.status).toBe("failed");
      expect(s.table.replies.get("me-1")?.get(id)?.text).toBe(FAILURE_REPLY);
    }
    expect(s.table.specs.get("me-1")).toHaveLength(1);
  });

  it("WHEN the first spec cannot be written THEN the message fails, and Write my spec asks again", async () => {
    const s = await setup();
    const res = await s.firstSpec("I need to know more first.");
    expect(s.table.messages.get("me-1")?.get(json(res)["id"] as string)?.status).toBe("failed");
    expect(s.table.specs.get("me-1")).toBeUndefined();
    expect((await s.call(getSpec())).statusCode).toBe(404);
    // Pressed again: a new request goes to the worker.
    const again = await s.firstSpec();
    expect(json(again)["id"]).toEqual(expect.any(String));
    expect(s.table.specs.get("me-1")?.map((v) => v.version)).toEqual([1]);
  });

  it("asks only once while the first spec is being written (a second press finds it in flight)", async () => {
    const s = await setup();
    const first = await s.call(writeSpec());
    const second = await s.call(writeSpec());
    expect(json(first)["id"]).toEqual(expect.any(String));
    expect(json(second)).toEqual({ step: "spec" });
    expect(s.queue.sent).toHaveLength(1);
  });
});

describe("criterion 4: Approve spec", () => {
  it("WHEN the participant presses Approve spec THEN the version is stored as approved, the step becomes approved, and change requests are refused", async () => {
    const s = await setup();
    await s.firstSpec();
    await s.ask("Add a longest run screen.", specAnswer("Added.", SPEC_V2));
    const res = await s.call(approve(2));
    expect(res.statusCode).toBe(200);
    // Ticket 2.7: the answer also carries the id of the readiness request, the one job the approval queued.
    expect(json(res)).toEqual({ step: "approved", version: 2, id: expect.any(String) as unknown });
    const readinessJob = { participantId: "me-1", messageId: json(res)["id"] };
    expect(s.table.profiles.get("me-1")?.step).toBe("approved");
    expect(s.table.conversations.get("me-1")).toMatchObject({ approvedSpecVersion: 2, latestSpecVersion: 2 });
    expect(s.table.specs.get("me-1")?.map((v) => v.approvedAt !== undefined)).toEqual([false, true]);
    expect(json(await s.call(getSpec()))).toMatchObject({ version: 2, approved: true });
    expect(json(await s.call(historyOf()))).toMatchObject({ step: "approved", latestSpecVersion: 2, approvedSpecVersion: 2 });
    expect(s.logs.at(-3)).toEqual({ event: "conversation", route: "approve", outcome: "ok" });

    // Further change requests are refused, by the route and by the store's own condition.
    const refused = await s.call(send("Add a monthly total."));
    expect(refused.statusCode).toBe(409);
    expect(json(refused)).toEqual({ reason: "approved", message: MESSAGES.approved });
    expect(await s.table.createMessage("me-1", { id: "x", step: "spec", text: "sneaky", createdAt: "x", nowSeconds: START_S })).toBe("approved");
    expect(s.queue.sent).toEqual([readinessJob]);
    expect(json(await s.call(writeSpec()))).toEqual({ reason: "wrong-step", message: MESSAGES["wrong-step"] });
    // A second press with the same version is fine; another version is refused.
    expect((await s.call(approve(2))).statusCode).toBe(200);
    expect(json(await s.call(approve(1)))).toEqual({ reason: "approved", message: MESSAGES.approved });
    expect(s.table.specs.get("me-1")).toHaveLength(2);
  });

  it("refuses an older version (stale), no spec yet, a message in flight (busy) or waiting for a facilitator", async () => {
    const s = await setup();
    expect(json(await s.call(approve(1)))).toEqual({ reason: "no-spec", message: MESSAGES["no-spec"] });
    await s.call(writeSpec());
    expect(json(await s.call(approve(1)))).toMatchObject({ reason: "no-spec" });
    s.model.push({ text: specAnswer("Here.", SPEC_V1), inputTokens: 1, outputTokens: 1 });
    await s.drain();
    await s.ask("Add a longest run screen.", specAnswer("Added.", SPEC_V2));
    expect(json(await s.call(approve(1)))).toEqual({ reason: "stale", message: MESSAGES.stale });
    await s.call(send("What is a screen?"));
    expect(json(await s.call(approve(2)))).toEqual({ reason: "busy", message: MESSAGES.busy });
    s.model.push(verdictReply("flag", "", "unsure"));
    await s.drain();
    expect(json(await s.call(approve(2)))).toEqual({ reason: "waiting", message: MESSAGES.waiting });
    expect(s.table.profiles.get("me-1")?.step).toBe("spec");
  });

  it("lets a stale pending message go, so its late answer can no longer change the approved spec", async () => {
    const s = await setup();
    await s.firstSpec();
    await s.call(send("Add a longest run screen."));
    const job = must(s.queue.sent.shift());
    s.advance(STALE_PENDING_SECONDS + 1);
    expect((await s.call(approve(1))).statusCode).toBe(200);
    // The late job (still running when it went stale) tries to finish: the message is no longer in flight.
    const late = await s.table.finish(
      "me-1",
      job.messageId,
      { kind: "done", reply: "Added.", answer: { prompt: "x", modelId: MODEL_ID, promptVersion: "spec-v1", historyCount: 0, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }, spec: { version: 2, text: SPEC_V2 } },
      "pending",
      "x",
    );
    expect(late).toBe(false);
    expect(s.table.specs.get("me-1")).toHaveLength(1);
  });

  it("checks the body and the content type", async () => {
    const s = await setup();
    await s.firstSpec();
    for (const version of [undefined, "1", 0, 1.5, -1, 10_000, null]) {
      const res = await s.call(approve(version));
      expect(res.statusCode, String(version)).toBe(400);
      expect(json(res)).toEqual({ message: MESSAGES["invalid-approve"] });
    }
    expect((await s.call(approve(1, MINE, "text/plain"))).statusCode).toBe(415);
    expect(s.table.profiles.get("me-1")?.step).toBe("spec");
  });
});

describe("criterion 5: another participant's spec is not found", () => {
  it("WHEN a participant asks for another participant's spec THEN the API answers not found; without a session 401", async () => {
    const s = await setup();
    await s.firstSpec();
    // Bob has no spec of his own: Ada's version 1 is simply not there for him, by any route.
    for (const req of [getSpec(THEIRS), getSpec(THEIRS, "1")]) {
      const res = await s.call(req);
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ message: "Not found." });
    }
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "spec", outcome: "not-found" });
    expect(json(await s.call(approve(1, THEIRS)))).toMatchObject({ reason: "no-spec" });
    expect(s.table.profiles.get("me-1")?.step).toBe("spec");
    // Bob's own spec is his, and Ada still sees only hers.
    await s.firstSpec(specAnswer("Here.", SPEC_V2), THEIRS);
    expect(json(await s.call(getSpec(THEIRS)))).toMatchObject({ version: 1, text: SPEC_V2 });
    expect(json(await s.call(getSpec()))).toMatchObject({ version: 1, text: SPEC_V1 });
    expect((await s.call(getSpec(MINE, "2"))).statusCode).toBe(404);
    expect((await s.call(getSpec(MINE, "../1"))).statusCode).toBe(404);
    for (const req of [getSpec(token(9)), { routeKey: SPEC_ROUTE }, approve(1, token(9)), { routeKey: APPROVE_ROUTE, headers: { "content-type": "application/json" }, body: '{"version":1}' }]) {
      expect((await s.call(req)).statusCode).toBe(401);
    }
  });

  it("answers a table failure 500 without details", async () => {
    const s = await setup();
    s.table.conversationFailOn = "getLatestSpec";
    expect((await s.call(getSpec())).statusCode).toBe(500);
    expect(s.logs.at(-1)).toEqual({ event: "conversation", route: "spec", outcome: "failed", error: "InternalServerError" });
  });
});
