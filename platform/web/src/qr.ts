// Step 4 (ticket 2.11): the QR code that opens a live app on a phone, drawn in the page (no outside service, no
// network call). The encoding is qrcode-generator's (MIT, no dependencies); this file only turns its modules into
// the path of one SVG, which ./main.ts builds with createElementNS (no markup, no style attribute: the pages' CSP).

import qrcode from "qrcode-generator";

/** Light modules around the code, as the QR standard asks (4), so phone cameras find its edges. */
export const QR_MARGIN = 4;

/**
 * The dark (true) and light modules of `text` as a QR code: error correction level M, the smallest version that
 * holds it, the text as bytes (an app's address is plain ASCII, checked before it gets here).
 */
export function qrModules(text: string): boolean[][] {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => code.isDark(row, col)));
}

/** The SVG picture of `modules`: its side in modules (margin included) and one path holding every dark module. */
export function qrSvgPath(modules: boolean[][], margin: number = QR_MARGIN): { size: number; d: string } {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      // A run of dark modules on one row becomes one rectangle.
      const start = x;
      while (x < row.length && row[x]) x++;
      parts.push(`M${start + margin} ${y + margin}h${x - start}v1h-${x - start}z`);
    }
  });
  return { size: modules.length + 2 * margin, d: parts.join("") };
}
