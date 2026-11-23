// `npm run eval -- spec` (ticket 1.9): checks that a spec's Mermaid diagram parses and draws, with the
// page's own diagram.js (Mermaid) in Playwright's Chromium, the browser the page tests use. Mermaid
// cannot parse flowcharts in Node.js without a DOM, and this checks exactly what participants run.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { buildWeb } from "../../web/build.js";

export interface DiagramChecker {
  check(source: string): Promise<{ parses: boolean; draws: boolean }>;
  close(): Promise<void>;
}

export async function openDiagramChecker(): Promise<DiagramChecker> {
  const dir = buildWeb(mkdtempSync(join(tmpdir(), "ssd-workshop-eval-")));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><head></head><body></body></html>");
    await page.addStyleTag({ path: join(dir, "style.css") });
    await page.addScriptTag({ path: join(dir, "diagram.js") });
    return {
      check: (source) =>
        page.evaluate(async (src) => {
          const api = (globalThis as unknown as { ssdDiagram: { parse(s: string): Promise<boolean>; render(s: string): Promise<{ width: number; height: number }> } }).ssdDiagram;
          const parses = await api.parse(src);
          let draws = false;
          if (parses) {
            try {
              const picture = await api.render(src);
              draws = picture.width > 0 && picture.height > 0;
            } catch {
              draws = false;
            }
          }
          return { parses, draws };
        }, source),
      close: async () => {
        await browser.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
