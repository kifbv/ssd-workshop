// Ticket 3.21: the AI tasks' budget arithmetic.
import { describe, expect, it } from "vitest";
import { MODELS } from "../settings.js";
import { MAX_TRANSCRIBE_SECONDS, modelCost, spentBudget, spentToday, transcribeCost, utcDay } from "./budget.js";

describe("budget", () => {
  it("prices Haiku 4.5 on its EU profile at $1.10 in and $5.50 out per million tokens", () => {
    expect(MODELS.appAi.modelId).toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(modelCost(1_000_000, 0)).toBe(1.1);
    expect(modelCost(0, 1_000_000)).toBe(5.5);
    expect(modelCost(-5, -5)).toBe(0);
  });

  it("prices Transcribe at $0.024 a minute, per second, at least 15 s, up to 305 s", () => {
    expect(transcribeCost(0)).toBe(0.006);
    expect(transcribeCost(60)).toBe(0.024);
    expect(transcribeCost(60.2)).toBeCloseTo((61 * 0.024) / 60, 10);
    expect(MAX_TRANSCRIBE_SECONDS).toBe(305);
  });

  it("counts a counter of today, 0 for an earlier day, the whole budget for a later day or a broken value", () => {
    expect(spentToday({ day: "2026-11-27", usd: 0.4 }, "2026-11-27", 1)).toBe(0.4);
    expect(spentToday({ day: "2026-11-26", usd: 9 }, "2026-11-27", 1)).toBe(0);
    expect(spentToday({ day: undefined, usd: 0 }, "2026-11-27", 1)).toBe(0);
    expect(spentToday({ day: "2026-11-28", usd: 0 }, "2026-11-27", 1)).toBe(1);
    expect(spentToday({ day: "2026-11-27", usd: -1 }, "2026-11-27", 1)).toBe(1);
  });

  it("names the app's budget first, then the workshop's", () => {
    const today = utcDay(new Date("2026-11-27T23:59:59Z"));
    expect(today).toBe("2026-11-27");
    expect(spentBudget({ app: { day: today, usd: 1 }, all: { day: today, usd: 10 } }, today)).toBe("app-budget");
    expect(spentBudget({ app: { day: today, usd: 0.99 }, all: { day: today, usd: 10 } }, today)).toBe("workshop-budget");
    expect(spentBudget({ app: { day: today, usd: 0.99 }, all: { day: today, usd: 9.99 } }, today)).toBeUndefined();
  });
});
