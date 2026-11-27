// Ticket 3.21: the app-ai eval's scoring and receipts (no model call).
import { describe, expect, it } from "vitest";
import { parseEvalArgs } from "./logic.js";
import { RECEIPT_CASES, receiptHtml, scoreReceipt, type ReceiptCase } from "./app-ai.js";

const FIRST = RECEIPT_CASES[0] as ReceiptCase;

describe("app-ai eval", () => {
  it("is a suite that takes no arguments", () => {
    expect(parseEvalArgs(["app-ai"])).toEqual({ suite: "app-ai" });
    expect(parseEvalArgs(["app-ai", "x"])).toEqual({ error: "app-ai takes no arguments" });
  });

  it("prints each receipt's shop, date and total, escaped", () => {
    for (const receipt of RECEIPT_CASES) {
      const html = receiptHtml(receipt);
      expect(html).toContain(receipt.shop);
      expect(html).toContain(receipt.printedTotal);
    }
    expect(receiptHtml({ ...FIRST, shop: "<b>x</b>" })).not.toContain("<b>x</b>");
  });

  it("passes only a right shop, date and euro total", () => {
    const receipt = FIRST;
    const right = { values: { shop: "Bäckerei Sonnenschein", date: "2026-11-14", total: { amount: 12.4, currency: "EUR" } } };
    expect(scoreReceipt(receipt, right).pass).toBe(true);
    expect(scoreReceipt(receipt, { values: { ...right.values, date: "2026-11-15" } }).detail).toContain("date");
    expect(scoreReceipt(receipt, { values: { ...right.values, total: { amount: 12.4, currency: null } } }).detail).toContain("total");
    expect(scoreReceipt(receipt, { values: { ...right.values, total: { amount: 2.7, currency: "EUR" } } }).pass).toBe(false);
    expect(scoreReceipt(receipt, { values: { ...right.values, shop: null } }).pass).toBe(false);
    expect(scoreReceipt(receipt, undefined).pass).toBe(false);
    expect(scoreReceipt(receipt, { tags: [] }).pass).toBe(false);
  });
});
