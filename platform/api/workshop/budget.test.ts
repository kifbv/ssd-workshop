// Ticket 3.3: the AI budget rule (spend compared with the budget plus extra budget, in dollars) as every AI call
// and build start checks it.
import { describe, expect, it } from "vitest";
import { BUDGET_REPLY, budgetOf, overBudget } from "./budget.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { PHASE_3_TEXTS } from "./texts.js";

const facts = (spentUsd: number, extraBudget = 0, aiBudgetUsd = 5) => ({
  settings: { ...DEFAULT_SETTINGS, aiBudgetUsd },
  limits: { extraBudget, paused: false, changeRequestsUsed: 0 },
  spentUsd,
});

describe("budgetOf (ticket 3.3)", () => {
  it("allows AI calls below the budget and stops them at or over it", () => {
    expect(budgetOf(facts(0))).toEqual({ budgetUsd: 5, spentUsd: 0, leftUsd: 5, reached: false });
    expect(budgetOf(facts(4.99999999)).reached).toBe(false);
    expect(budgetOf(facts(5))).toEqual({ budgetUsd: 5, spentUsd: 5, leftUsd: 0, reached: true });
    expect(budgetOf(facts(6.4))).toEqual({ budgetUsd: 5, spentUsd: 6.4, leftUsd: 0, reached: true });
  });

  it("adds the extra budget a facilitator granted", () => {
    expect(budgetOf(facts(5.2, 2))).toEqual({ budgetUsd: 7, spentUsd: 5.2, leftUsd: 1.8, reached: false });
    expect(budgetOf(facts(7, 2)).reached).toBe(true);
  });

  it("reads a budget of $0 as no AI at all", () => {
    expect(budgetOf(facts(0, 0, 0))).toEqual({ budgetUsd: 0, spentUsd: 0, leftUsd: 0, reached: true });
  });

  it("gives what is left in whole cents, rounded down, never below 0", () => {
    expect(budgetOf(facts(4.996)).leftUsd).toBe(0);
    expect(budgetOf(facts(4.996)).reached).toBe(false);
    expect(budgetOf(facts(4.3)).leftUsd).toBe(0.7);
    expect(budgetOf(facts(4.7)).leftUsd).toBe(0.3);
    expect(budgetOf(facts(1.234)).leftUsd).toBe(3.76);
    expect(budgetOf(facts(0.0001)).leftUsd).toBe(4.99);
  });

  it("WHEN the spend is present but negative, not a number or infinite THEN the budget reads as reached (fails closed)", () => {
    for (const broken of [-3, -0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(budgetOf(facts(broken)), String(broken)).toEqual({ budgetUsd: 5, spentUsd: 5, leftUsd: 0, reached: true });
      expect(overBudget(budgetOf(facts(broken)))).toBe(true);
    }
    expect(budgetOf(facts(Number.NaN, 2)).reached).toBe(true);
  });

  it("WHEN no spend was recorded (read as 0) THEN nothing is spent", () => {
    expect(budgetOf(facts(0))).toEqual({ budgetUsd: 5, spentUsd: 0, leftUsd: 5, reached: false });
  });

  it("counts the cost of calls already made in this job before the next one", () => {
    const budget = budgetOf(facts(4.9));
    expect(overBudget(budget)).toBe(false);
    expect(overBudget(budget, 0.05)).toBe(false);
    expect(overBudget(budget, 0.1)).toBe(true);
    expect(overBudget(budget, 0.2)).toBe(true);
    expect(overBudget(budgetOf(facts(5)), 0)).toBe(true);
  });

  it("answers with the brief's text, which names no amount, no other participant and no address", () => {
    expect(BUDGET_REPLY).toBe("You've used your AI budget for today. Your facilitator can add more.");
    expect(BUDGET_REPLY).toBe(PHASE_3_TEXTS.budgetReached);
    expect(BUDGET_REPLY).not.toMatch(/[0-9$@]/);
  });
});
