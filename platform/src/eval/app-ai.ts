// `npm run eval -- app-ai` (ticket 3.21): the AI task `read-photo` on synthetic receipts (made here, in Chromium, from
// made-up shops: no real person's data), through the same pure steps as the route (inspectMedia, modelTask,
// checkAnswer) and the real BedrockAppAiModel on Claude Haiku 4.5's EU profile. Shop, date and total must come back
// right. The scoring is pure and unit tested (app-ai.test.ts); runAppAiSuite calls Bedrock.
import type { Browser } from "playwright";
import { modelCost } from "../../api/app-ai/budget.js";
import type { AppAiModel } from "../../api/app-ai/ai.js";
import { checkAnswer, modelTask, type AppAiRequest, type TaskAnswer } from "../../api/app-ai/tasks.js";
import { inspectMedia } from "../../api/app-media/formats.js";

export interface ReceiptCase {
  name: string;
  /** What the receipt prints. */
  shop: string;
  printedDate: string;
  lines: [string, string][];
  printedTotal: string;
  /** What read-photo must give back. */
  expected: { shopIncludes: string; date: string; amount: number; currency: string };
}

/** Made-up shops and items (no real person or business data). */
export const RECEIPT_CASES: ReceiptCase[] = [
  {
    name: "German bakery receipt",
    shop: "Bäckerei Sonnenschein",
    printedDate: "14.11.2026 08:42",
    lines: [
      ["2 x Brezel", "2,40"],
      ["Roggenbrot 750 g", "4,20"],
      ["Apfelstrudel", "3,10"],
      ["Kaffee groß", "2,70"],
    ],
    printedTotal: "SUMME EUR 12,40",
    expected: { shopIncludes: "sonnenschein", date: "2026-11-14", amount: 12.4, currency: "EUR" },
  },
  {
    name: "French café receipt",
    shop: "Café des Lilas Bleus",
    printedDate: "03/10/2026 12:15",
    lines: [
      ["Croque-monsieur", "6,50"],
      ["Salade verte", "4,00"],
      ["Citronnade", "3,20"],
    ],
    printedTotal: "TOTAL TTC 13,70 €",
    expected: { shopIncludes: "lilas", date: "2026-10-03", amount: 13.7, currency: "EUR" },
  },
];

export const RECEIPT_FIELDS = [
  { name: "shop", type: "text" },
  { name: "date", type: "date" },
  { name: "total", type: "money" },
] as const;

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The receipt as a small HTML page (monospace, like a till roll). */
export function receiptHtml(receipt: ReceiptCase): string {
  const rows = receipt.lines.map(([item, price]) => `<tr><td>${escapeHtml(item)}</td><td class="p">${escapeHtml(price)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#ddd}
#r{width:340px;margin:20px;padding:24px 20px;background:#fff;font:16px/1.4 "DejaVu Sans Mono",monospace;color:#111}
h1{font-size:20px;text-align:center;margin:0 0 4px}.c{text-align:center;margin:0 0 12px}
table{width:100%;border-collapse:collapse}.p{text-align:right}.t{font-weight:bold;border-top:2px dashed #111;padding-top:8px;margin-top:8px}
</style></head><body><div id="r"><h1>${escapeHtml(receipt.shop)}</h1><p class="c">Hauptstraße 1 · Rue Imaginaire 2</p>
<p class="c">${escapeHtml(receipt.printedDate)}</p><table>${rows}</table><p class="t">${escapeHtml(receipt.printedTotal)}</p>
<p class="c">Merci · Danke</p></div></body></html>`;
}

export interface ReceiptResult {
  receipt: ReceiptCase;
  pass: boolean;
  detail: string;
  answer?: TaskAnswer | undefined;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Shop holds the expected name, the date is the receipt's, the total is the amount paid in euros. */
export function scoreReceipt(receipt: ReceiptCase, answer: TaskAnswer | undefined): { pass: boolean; detail: string } {
  if (answer === undefined || !("values" in answer)) return { pass: false, detail: "unusable answer (the route would answer 502)" };
  const values = answer.values;
  const problems: string[] = [];
  const shop = values["shop"];
  if (typeof shop !== "string" || !shop.toLowerCase().includes(receipt.expected.shopIncludes)) problems.push(`shop ${JSON.stringify(shop)}`);
  if (values["date"] !== receipt.expected.date) problems.push(`date ${JSON.stringify(values["date"])}`);
  const total = values["total"];
  const amountOk = typeof total === "object" && total !== null && Math.abs(total.amount - receipt.expected.amount) < 0.005;
  const currencyOk = typeof total === "object" && total !== null && total.currency === receipt.expected.currency;
  if (!amountOk || !currencyOk) problems.push(`total ${JSON.stringify(total)}`);
  return problems.length === 0 ? { pass: true, detail: "shop, date and total right" } : { pass: false, detail: problems.join("; ") };
}

export const formatReceiptResult = (result: ReceiptResult, index: number): string =>
  `${result.pass ? "PASS" : "FAIL"} ${index + 1}. ${result.receipt.name}: ${result.detail} | answer ${JSON.stringify(result.answer ?? null)} | ` +
  `${result.inputTokens} in, ${result.outputTokens} out, $${result.costUsd.toFixed(5)}`;

export function formatReceiptSummary(results: readonly ReceiptResult[]): string[] {
  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((n, r) => n + r.costUsd, 0);
  const input = results.reduce((n, r) => n + r.inputTokens, 0);
  const output = results.reduce((n, r) => n + r.outputTokens, 0);
  return [`${passed}/${results.length} receipts read right`, `Tokens: ${input} in, ${output} out; cost $${cost.toFixed(5)}`];
}

/** Draws the receipt in Chromium and photographs it as a JPEG (what the template's camera upload sends). */
export async function receiptPhoto(browser: Browser, receipt: ReceiptCase): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 420, height: 640 } });
  try {
    await page.setContent(receiptHtml(receipt));
    return await page.locator("#r").screenshot({ type: "jpeg", quality: 85 });
  } finally {
    await page.close();
  }
}

/** One receipt through the route's steps: the photo stripped as stored, the task's prompt and tool, the answer checked. */
export async function readReceipt(model: AppAiModel, receipt: ReceiptCase, photo: Buffer): Promise<ReceiptResult> {
  const found = inspectMedia(photo);
  if (found?.kind !== "jpeg") return { receipt, pass: false, detail: "the photo is not a JPEG the media API keeps", inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const request: Extract<AppAiRequest, { task: "read-photo" }> = { task: "read-photo", mediaId: "EvalReceipt00000000000", fields: RECEIPT_FIELDS.map((f) => ({ ...f })) };
  const task = modelTask(request);
  const reply = await model.answer({ system: task.system, text: task.text, tool: task.tool, photo: found.photo });
  const answer = checkAnswer(request, reply.input);
  return { receipt, answer, ...scoreReceipt(receipt, answer), inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costUsd: modelCost(reply.inputTokens, reply.outputTokens) };
}
