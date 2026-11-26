import { describe, expect, it } from "vitest";
import { DASHBOARD_TEXTS, PHASE_3_TEXTS } from "../../api/workshop/texts.js";
import {
  DASHBOARD_POLL_INTERVAL_MS,
  EVERYONE,
  actionPath,
  actionResult,
  buildText,
  canRetry,
  conversationResult,
  groupsOf,
  initialFilter,
  listResult,
  logLabel,
  parseList,
  rowAlert,
  shownRows,
  stepText,
  usageText,
  type Row,
} from "./dashboard-view.js";

const row = (over: Partial<Row> = {}): Row => ({
  nickname: "ada",
  group: "g1",
  step: "building",
  minutesInStep: 4,
  build: null,
  spentUsd: 1.2,
  budgetUsd: 5,
  extraBudgetUsd: 0,
  changeRequestsUsed: 1,
  changeRequestsPerPerson: 5,
  paused: false,
  flags: [],
  ...over,
});
const building = (over: Partial<NonNullable<Row["build"]>> = {}): NonNullable<Row["build"]> => ({ status: "building", kind: "first", stuck: false, retryRequested: false, ...over });

describe("facilitator dashboard rules (ticket 3.11)", () => {
  it("polls every 5 seconds (the brief's answer)", () => {
    expect(DASHBOARD_POLL_INTERVAL_MS).toBe(5000);
  });

  it("reads the list as the API sends it (ticket 3.10's shape) and refuses anything else", () => {
    const body = {
      viewer: { role: "facilitator", group: "g1" },
      stopped: false,
      participants: [{ ...row({ build: building({ minutesBuilding: 3 }) }), stepSince: "2026-11-26T10:00:00.000Z", extra: 1 }],
    };
    const list = parseList(body);
    expect(list?.participants[0]?.build).toEqual({ status: "building", kind: "first", stuck: false, retryRequested: false, minutesBuilding: 3 });
    expect(list?.participants[0]).not.toHaveProperty("stepSince");
    expect(parseList({ ...body, viewer: null })).toBeUndefined();
    expect(parseList({ ...body, participants: [{ ...row(), spentUsd: "1" }] })).toBeUndefined();
    expect(parseList({ ...body, participants: [{ ...row(), build: { status: "odd" } }] })).toBeUndefined();
    expect(parseList({ ...body, participants: [{ ...row(), flags: [{ text: 1 }] }] })).toBeUndefined();
  });

  it("a participant's 404 means the page is for facilitators; 401 is signed out; anything else retries", () => {
    expect(listResult({ status: 404, body: { message: "Not found." } })).toEqual({ kind: "not-facilitator", message: PHASE_3_TEXTS.facilitatorsOnly });
    expect(PHASE_3_TEXTS.facilitatorsOnly).toBe("This page is for facilitators.");
    expect(listResult({ status: 401, body: {} })).toEqual({ kind: "signed-out" });
    expect(listResult({ status: 0, body: null })).toEqual({ kind: "error", message: DASHBOARD_TEXTS.offline });
    expect(listResult({ status: 500, body: {} })).toEqual({ kind: "error", message: DASHBOARD_TEXTS.loadFailed });
    expect(listResult({ status: 200, body: {} })).toEqual({ kind: "error", message: DASHBOARD_TEXTS.loadFailed });
  });

  it("highlights a failed build and one stuck in Build, and offers Retry only for those (what the API accepts)", () => {
    expect(rowAlert(row({ build: building({ status: "failed" }) }))).toBe("failed");
    expect(rowAlert(row({ build: building({ stuck: true }) }))).toBe("stuck");
    for (const build of [null, building(), building({ status: "live" }), building({ status: "queued" }), building({ status: "deploying" })]) {
      expect(rowAlert(row({ build }))).toBeNull();
      expect(canRetry(row({ build }))).toBe(false);
    }
    expect(canRetry(row({ build: building({ status: "failed" }) }))).toBe(true);
    expect(canRetry(row({ build: building({ stuck: true }) }))).toBe(true);
    expect(canRetry(row({ nickname: null, build: building({ status: "failed" }) }))).toBe(false);
  });

  it("says where each participant is, the build's state and the usage in words", () => {
    expect(stepText(row({ step: "clarify" }))).toBe("Step 1: Clarify, 4 min");
    expect(stepText(row({ step: "approved", minutesInStep: null }))).toBe("Step 3: Build, readiness check");
    expect(stepText(row({ build: building() }))).toBe("Step 3: Build, 4 min");
    expect(stepText(row({ build: building({ status: "live" }) }))).toBe("Step 4: Live, 4 min");
    expect(stepText(row({ build: building({ kind: "change", changeNumber: 2 }) }))).toBe("Step 4: Live, 4 min");
    expect(buildText(row({ build: building({ stuck: true, minutesBuilding: 17, retryRequested: true }) }))).toBe("Build: stuck, building for 17 min (Retry requested)");
    expect(buildText(row({ build: building({ status: "failed", kind: "change", changeNumber: 2 }) }))).toBe("Change 2: failed");
    expect(buildText(row())).toBe("");
    expect(usageText(row({ extraBudgetUsd: 2, budgetUsd: 7 }))).toBe("AI $1.20 of $7.00 (+$2.00 added) · Changes 1 of 5");
  });

  it("starts the filter on the viewer's group when it has participants, else Everyone; filters by exact group", () => {
    const rows = [row({ group: "g2" }), row({ nickname: "bo", group: "g1" }), row({ nickname: "cy", group: null })];
    const list = { viewer: { role: "facilitator", group: "g1" }, stopped: false, participants: rows };
    expect(initialFilter(list)).toBe("g1");
    expect(initialFilter({ ...list, viewer: { role: "admin", group: "staff" } })).toBe(EVERYONE);
    expect(groupsOf(rows)).toEqual(["g1", "g2"]);
    expect(shownRows(rows, "g1").map((r) => r.nickname)).toEqual(["bo"]);
    expect(shownRows(rows, EVERYONE)).toHaveLength(3);
  });

  it("turns each action's answer into a plain line: 409 and 404 included", () => {
    expect(actionResult({ status: 202, body: { message: "Retry requested." } }, "retry")).toMatchObject({ kind: "done", message: "Retry requested.", tone: "info" });
    expect(actionResult({ status: 200, body: { message: "Added $2 of AI budget.", budgetUsd: 7, extraBudgetUsd: 2 } }, "budget")).toMatchObject({
      kind: "done",
      message: "Added $2 of AI budget. Budget now $7.00.",
      budgetUsd: 7,
      extraBudgetUsd: 2,
    });
    expect(actionResult({ status: 200, body: { message: "Paused.", paused: true } }, "pause")).toMatchObject({ paused: true });
    expect(actionResult({ status: 409, body: { message: "Only a failed build..." } }, "retry")).toMatchObject({ kind: "done", tone: "error", settled: false });
    expect(actionResult({ status: 409, body: { message: "Decided meanwhile." } }, "approve")).toMatchObject({ kind: "done", tone: "error", settled: true });
    expect(actionResult({ status: 500, body: { message: "Approved, but..." } }, "approve")).toMatchObject({ kind: "done", tone: "error", settled: true });
    expect(actionResult({ status: 500, body: { message: "Something went wrong." } }, "retry")).toEqual({ kind: "error", message: DASHBOARD_TEXTS.actionFailed });
    expect(actionResult({ status: 404, body: {} }, "pause")).toEqual({ kind: "gone", message: DASHBOARD_TEXTS.gone });
    expect(actionResult({ status: 401, body: {} }, "pause")).toEqual({ kind: "signed-out" });
    expect(actionResult({ status: 0, body: null }, "pause")).toEqual({ kind: "error", message: DASHBOARD_TEXTS.actionOffline });
  });

  it("reads the conversation log, skipping malformed lines, and labels each line", () => {
    const result = conversationResult({
      status: 200,
      body: { nickname: "ada", messages: [{ author: "participant", step: "clarify", status: "flagged", text: "hi" }, { author: "assistant", text: "hello" }, { author: "x", text: "?" }] },
    });
    expect(result).toEqual({ kind: "log", lines: [{ author: "participant", step: "clarify", status: "flagged", text: "hi" }, { author: "assistant", text: "hello" }] });
    if (result.kind === "log") expect(result.lines.map(logLabel)).toEqual(["Participant, step clarify, flagged", "AI"]);
    expect(conversationResult({ status: 404, body: {} })).toEqual({ kind: "gone", message: DASHBOARD_TEXTS.gone });
  });

  it("names a participant by nickname in the route, encoded", () => {
    expect(actionPath("ada-1", "flag/approve")).toBe("/api/facilitator/participants/ada-1/flag/approve");
    expect(actionPath("a/b", "pause")).toBe("/api/facilitator/participants/a%2Fb/pause");
  });
});
