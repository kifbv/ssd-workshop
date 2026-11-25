import { describe, expect, it } from "vitest";
import {
  budgetFor,
  CAP_NAMES,
  DEFAULT_SETTINGS,
  limitsFromItem,
  parseCaps,
  PARTICIPANT_LIMIT_ATTRIBUTES,
  settingsFromItem,
} from "./settings.js";
import { changesLeftText, changesUsedText, PHASE_3_TEXTS, queuePositionText } from "./texts.js";

const VALID = { aiBudgetUsd: 5, changeRequestsPerPerson: 5, buildsAtOnce: 15 };

describe("workshop settings (ticket 3.2)", () => {
  it("defaults to $5, 5 change requests, 15 builds at once and Stop off", () => {
    expect(DEFAULT_SETTINGS).toEqual({ aiBudgetUsd: 5, changeRequestsPerPerson: 5, buildsAtOnce: 15, stopped: false });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(CAP_NAMES).toEqual(["aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce"]);
  });

  it("reads a missing item as the defaults, and each missing or out-of-range value as its default", () => {
    expect(settingsFromItem(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromItem({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromItem({ aiBudgetUsd: { N: "12.5" }, changeRequestsPerPerson: { N: "0" }, buildsAtOnce: { N: "3" }, stopped: { BOOL: true } })).toEqual({
      aiBudgetUsd: 12.5,
      changeRequestsPerPerson: 0,
      buildsAtOnce: 3,
      stopped: true,
    });
    expect(settingsFromItem({ aiBudgetUsd: { N: "51" }, changeRequestsPerPerson: { N: "2.5" }, buildsAtOnce: { N: "0" }, stopped: { S: "true" } })).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromItem({ aiBudgetUsd: { S: "7" }, buildsAtOnce: { N: "x" } })).toEqual(DEFAULT_SETTINGS);
  });

  it("reads the last Resume's time (ticket 3.5) only when it is a time", () => {
    expect(settingsFromItem({ resumedAt: { S: "2026-11-25T10:00:00.000Z" } })).toEqual({ ...DEFAULT_SETTINGS, resumedAt: "2026-11-25T10:00:00.000Z" });
    for (const bad of [{ S: "soon" }, { N: "1" }, { S: "" }]) expect(settingsFromItem({ resumedAt: bad })).toEqual(DEFAULT_SETTINGS);
  });

  it("accepts caps in range, the ends included, keeping the budget to whole cents", () => {
    expect(parseCaps(VALID)).toEqual({ ok: true, caps: VALID });
    expect(parseCaps({ aiBudgetUsd: 0, changeRequestsPerPerson: 0, buildsAtOnce: 1 })).toEqual({ ok: true, caps: { aiBudgetUsd: 0, changeRequestsPerPerson: 0, buildsAtOnce: 1 } });
    expect(parseCaps({ aiBudgetUsd: 50, changeRequestsPerPerson: 20, buildsAtOnce: 30, stopped: true, extra: "x" })).toEqual({
      ok: true,
      caps: { aiBudgetUsd: 50, changeRequestsPerPerson: 20, buildsAtOnce: 30 },
    });
    expect(parseCaps({ ...VALID, aiBudgetUsd: 7.456 })).toEqual({ ok: true, caps: { ...VALID, aiBudgetUsd: 7.46 } });
  });

  it("names every cap that is missing, not a number, a fraction where a count is needed, or out of range", () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [{ ...VALID, aiBudgetUsd: -0.01 }, ["aiBudgetUsd"]],
      [{ ...VALID, aiBudgetUsd: 50.01 }, ["aiBudgetUsd"]],
      [{ ...VALID, aiBudgetUsd: "5" }, ["aiBudgetUsd"]],
      [{ ...VALID, aiBudgetUsd: Number.NaN }, ["aiBudgetUsd"]],
      [{ ...VALID, aiBudgetUsd: Number.POSITIVE_INFINITY }, ["aiBudgetUsd"]],
      [{ ...VALID, changeRequestsPerPerson: -1 }, ["changeRequestsPerPerson"]],
      [{ ...VALID, changeRequestsPerPerson: 21 }, ["changeRequestsPerPerson"]],
      [{ ...VALID, changeRequestsPerPerson: 2.5 }, ["changeRequestsPerPerson"]],
      [{ ...VALID, buildsAtOnce: 0 }, ["buildsAtOnce"]],
      [{ ...VALID, buildsAtOnce: 31 }, ["buildsAtOnce"]],
      [{ ...VALID, buildsAtOnce: null }, ["buildsAtOnce"]],
      [{}, ["aiBudgetUsd", "changeRequestsPerPerson", "buildsAtOnce"]],
    ];
    for (const [body, invalid] of cases) expect(parseCaps(body), JSON.stringify(body)).toEqual({ ok: false, invalid });
  });

  it("reads a profile without the limit fields (from before ticket 3.2) as no extra budget, not paused, no change used, no stepSince", () => {
    expect(limitsFromItem(undefined)).toEqual({ extraBudget: 0, paused: false, changeRequestsUsed: 0 });
    expect(limitsFromItem({ step: { S: "clarify" }, nickname: { S: "Ada" } })).toEqual({ extraBudget: 0, paused: false, changeRequestsUsed: 0 });
    expect(
      limitsFromItem({ extraBudget: { N: "4" }, paused: { BOOL: true }, changeRequestsUsed: { N: "2" }, stepSince: { S: "2026-11-25T10:00:00.000Z" } }),
    ).toEqual({ extraBudget: 4, paused: true, changeRequestsUsed: 2, stepSince: "2026-11-25T10:00:00.000Z" });
    expect(limitsFromItem({ extraBudget: { N: "-3" }, paused: { S: "yes" }, changeRequestsUsed: { N: "x" } })).toEqual({
      extraBudget: 0,
      paused: false,
      changeRequestsUsed: 0,
    });
    expect([...PARTICIPANT_LIMIT_ATTRIBUTES]).toEqual(["extraBudget", "paused", "changeRequestsUsed", "stepSince"]);
  });

  it("gives a participant the workshop's budget plus their extra budget, in cents", () => {
    expect(budgetFor(DEFAULT_SETTINGS, { extraBudget: 0 })).toBe(5);
    expect(budgetFor({ aiBudgetUsd: 5.1 }, { extraBudget: 0.2 })).toBe(5.3);
  });
});

describe("phase 3 texts (ticket 3.2)", () => {
  it("holds the brief's wording", () => {
    expect(PHASE_3_TEXTS.budgetReached).toBe("You've used your AI budget for today. Your facilitator can add more.");
    expect(PHASE_3_TEXTS.paused).toBe("Your facilitator paused your session.");
    expect(PHASE_3_TEXTS.workshopPaused).toBe("The workshop is paused for a moment.");
    expect(PHASE_3_TEXTS.specUnchanged).toBe("Your repository's spec has not changed.");
    expect(PHASE_3_TEXTS.facilitatorsOnly).toBe("This page is for facilitators.");
    expect(changesUsedText(5)).toBe("You've used your 5 changes.");
    expect(changesUsedText(1)).toBe("You've used your 1 change.");
    expect(changesLeftText(2, 5)).toBe("Changes left: 3 of 5");
    expect(changesLeftText(7, 5)).toBe("Changes left: 0 of 5");
    expect(queuePositionText(3)).toBe("Your build is in the queue: 3 builds ahead of you.");
    expect(queuePositionText(1)).toBe("Your build is in the queue: 1 build ahead of you.");
    expect(queuePositionText(0)).toBe("Your build is next in the queue.");
  });

  it("names no amount, address or other participant (plain text for textContent)", () => {
    const all = [...Object.values(PHASE_3_TEXTS), changesUsedText(5), changesLeftText(1, 5), queuePositionText(2)];
    for (const text of all) {
      expect(text, text).not.toMatch(/[$@<>]/);
      expect(text, text).not.toMatch(/\{|\}/);
    }
  });
});
