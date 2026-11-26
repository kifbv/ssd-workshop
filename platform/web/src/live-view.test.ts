import { describe, expect, it } from "vitest";
import { CHANGE_BUILD_REQUEST, PHASE_3_TEXTS } from "../../api/workshop/texts.js";
import { parseBuild, showsStepFour } from "./build-view.js";
import { parseConversation, sendResult, type ChatMessage } from "./chat.js";
import { MESSAGES } from "./flow.js";
import { CHANGE_LOOP_DIAGRAM, changeActionResult, isBuildRequest, proposalResult, stepFourMessages, stepFourView } from "./live-view.js";

const IDEAS = ["Add a weekly chart", "Let me delete a run", "Show my longest run"];

describe("step 4's conversation facts (ticket 3.8)", () => {
  const base = { step: "building", state: "open", messages: [] };

  it("reads the count and the cap only together, as whole numbers, the cap from 1", () => {
    expect(parseConversation({ ...base, changeRequestsUsed: 2, changeRequestsPerPerson: 5 })).toMatchObject({ changeRequestsUsed: 2, changeRequestsPerPerson: 5 });
    for (const [used, cap] of [[2, undefined], [undefined, 5], [-1, 5], [1.5, 5], ["2", 5], [2, 0]]) {
      const parsed = parseConversation({ ...base, changeRequestsUsed: used, changeRequestsPerPerson: cap });
      expect(parsed?.changeRequestsUsed).toBeUndefined();
      expect(parsed?.changeRequestsPerPerson).toBeUndefined();
    }
  });

  it("keeps at most three non-empty text suggestions and a proposed version from 1", () => {
    expect(parseConversation({ ...base, suggestions: [...IDEAS, "a fourth"] })?.suggestions).toEqual(IDEAS);
    expect(parseConversation({ ...base, suggestions: ["", 3, "ok", null] })?.suggestions).toEqual(["ok"]);
    expect(parseConversation({ ...base, suggestions: "x" })?.suggestions).toBeUndefined();
    expect(parseConversation({ ...base, proposedSpecVersion: 4 })?.proposedSpecVersion).toBe(4);
    expect(parseConversation({ ...base, proposedSpecVersion: 0 })?.proposedSpecVersion).toBeUndefined();
  });

  it("shows only the change conversation (step building)", () => {
    const messages: ChatMessage[] = [
      { id: "a", author: "participant", text: "idea", step: "clarify" },
      { id: "b", author: "participant", text: "spec", step: "spec" },
      { id: "c", author: "participant", text: "change", step: "building" },
      { id: "c-r", author: "assistant", text: "update", step: "building" },
    ];
    expect(stepFourMessages(messages).map((m) => m.id)).toEqual(["c", "c-r"]);
  });
});

describe("what step 4 shows (ticket 3.8)", () => {
  const proposal = { version: 3, text: "# T", whatChanges: ["one"] };

  it("shows the count, the ideas and the box with changes left and no proposal", () => {
    expect(stepFourView({ changeRequestsUsed: 1, changeRequestsPerPerson: 5, suggestions: IDEAS }, null, undefined)).toEqual({
      countText: "Changes left: 4 of 5",
      showForm: true,
      showSuggestions: true,
      showProposal: false,
      typingText: PHASE_3_TEXTS.writingChange,
    });
  });

  it("hides the ideas while a proposal is open, and shows the proposal only while it is the open one", () => {
    const open = stepFourView({ changeRequestsUsed: 1, changeRequestsPerPerson: 5, suggestions: IDEAS, proposedSpecVersion: 3 }, proposal, undefined);
    expect(open).toMatchObject({ showSuggestions: false, showProposal: true, showForm: true });
    const stale = stepFourView({ changeRequestsUsed: 1, changeRequestsPerPerson: 5, suggestions: IDEAS }, proposal, undefined);
    expect(stale).toMatchObject({ showSuggestions: true, showProposal: false });
  });

  it("WHEN every change is used THEN says so, with no box, no ideas and no proposal", () => {
    const view = stepFourView({ changeRequestsUsed: 5, changeRequestsPerPerson: 5, suggestions: IDEAS, proposedSpecVersion: 3 }, proposal, undefined);
    expect(view).toEqual({
      countText: "Changes left: 0 of 5",
      usedUpText: "You've used your 5 changes.",
      showForm: false,
      showSuggestions: false,
      showProposal: false,
      typingText: PHASE_3_TEXTS.writingChange,
    });
  });

  it("without a count (a failed budget read) keeps the box and shows no count", () => {
    expect(stepFourView({}, null, undefined)).toEqual({ showForm: true, showSuggestions: false, showProposal: false, typingText: PHASE_3_TEXTS.writingChange });
  });

  it("says the AI is checking while Build this change's request is in flight", () => {
    const request: ChatMessage = { id: "m", author: "participant", text: CHANGE_BUILD_REQUEST, status: "pending" };
    expect(isBuildRequest(request)).toBe(true);
    expect(isBuildRequest({ ...request, author: "assistant" })).toBe(false);
    expect(isBuildRequest({ ...request, text: "Add a chart" })).toBe(false);
    expect(stepFourView({}, null, request).typingText).toBe(PHASE_3_TEXTS.checkingChange);
  });
});

describe("change answers (ticket 3.8)", () => {
  it("reads a proposal's What changes list (at most 5 non-empty lines)", () => {
    const body = { version: 3, text: "# T", approved: false, whatChanges: ["a", "", 4, "b", "c", "d", "e", "f"] };
    expect(proposalResult({ status: 200, body })).toEqual({ kind: "proposal", proposal: { version: 3, text: "# T", whatChanges: ["a", "b", "c", "d", "e"] } });
    expect(proposalResult({ status: 200, body: { version: 3, text: "# T" } })).toEqual({ kind: "proposal", proposal: { version: 3, text: "# T", whatChanges: [] } });
    expect(proposalResult({ status: 200, body: { version: "3", text: "# T" } })).toEqual({ kind: "show", message: MESSAGES.failed, tone: "error" });
    expect(proposalResult({ status: 404, body: {} })).toEqual({ kind: "none" });
    expect(proposalResult({ status: 401, body: {} })).toEqual({ kind: "signed-out" });
  });

  it("reads Build this change and Not this one's answers", () => {
    expect(changeActionResult({ status: 202, body: { id: "m", version: 3 } })).toEqual({ kind: "done" });
    expect(changeActionResult({ status: 200, body: { version: 3, discarded: true } })).toEqual({ kind: "done" });
    expect(changeActionResult({ status: 404, body: { message: "Not found." } })).toEqual({ kind: "gone" });
    expect(changeActionResult({ status: 409, body: { reason: "build-running", message: PHASE_3_TEXTS.changeWhileBuilding } })).toEqual({
      kind: "refused",
      reason: "build-running",
      message: PHASE_3_TEXTS.changeWhileBuilding,
    });
    expect(changeActionResult({ status: 409, body: { reason: "busy", message: "Please wait." } })).toEqual({ kind: "refused", message: "Please wait." });
    expect(changeActionResult({ status: 401, body: {} })).toEqual({ kind: "signed-out" });
    expect(changeActionResult({ status: 0, body: null })).toEqual({ kind: "show", message: MESSAGES.offline, tone: "error" });
  });

  it("reads a change request's 409 refusals with the API's words", () => {
    for (const reason of ["no-changes-left", "build-running", "not-live"]) {
      expect(sendResult({ status: 409, body: { reason, message: "words" } })).toEqual({ kind: "change-refused", reason, message: "words" });
    }
    expect(sendResult({ status: 409, body: { reason: "busy" } })).toEqual({ kind: "busy" });
  });
});

describe("change builds on the page (ticket 3.8)", () => {
  const live = { buildId: "b", status: "live", feed: [] };

  it("reads a change build's kind and number", () => {
    expect(parseBuild({ ...live, kind: "change", changeNumber: 2 })).toMatchObject({ kind: "change", changeNumber: 2 });
    expect(parseBuild({ ...live, kind: "change", changeNumber: 0 })?.changeNumber).toBeUndefined();
    expect(parseBuild({ ...live, kind: "first", changeNumber: 2 })).toEqual(live);
  });

  it("shows step 4 for a live build and a failed change build, step 3 for a failed first build", () => {
    expect(showsStepFour(parseBuild(live) ?? (live as never))).toBe(true);
    expect(showsStepFour(parseBuild({ ...live, status: "failed", kind: "change" }) ?? (live as never))).toBe(true);
    expect(showsStepFour(parseBuild({ ...live, status: "failed" }) ?? (live as never))).toBe(false);
    expect(showsStepFour(parseBuild({ ...live, status: "building", kind: "change" }) ?? (live as never))).toBe(false);
  });

  it("draws the change loop top to bottom in one column, with one arrow back to the next change", () => {
    const lines = CHANGE_LOOP_DIAGRAM.split("\n");
    expect(lines[0]).toBe("flowchart TD");
    expect(CHANGE_LOOP_DIAGRAM).toContain("|Build this change|");
    // Side branches make it wide (and its labels small on a phone): only the dotted "next change" arrow goes back.
    const edges = lines.slice(1).map((line) => /^\s*(\w+)\b.*?(-->|-\.->)(?:\|[^|]*\|)?\s*(\w+)/.exec(line));
    expect(edges.every((edge) => edge !== null)).toBe(true);
    const sources = edges.map((edge) => edge?.[1]);
    expect(new Set(sources).size).toBe(sources.length);
    expect(edges.filter((edge) => edge?.[2] === "-.->").map((edge) => edge?.[3])).toEqual(["you"]);
    expect(CHANGE_LOOP_DIAGRAM).not.toContain("Not this one");
    expect(CHANGE_LOOP_DIAGRAM).not.toContain("facilitator");
  });
});
