// Ticket 2.11: the QR code's modules and its SVG path, decoded with jsQR (a decoder independent of the encoder).
// jsqr is CommonJS: the default import is its module, whose `default` is the decoder (in Node.js and in vitest).
import jsQRModule from "jsqr";
import { describe, expect, it } from "vitest";
import { QR_MARGIN, qrModules, qrSvgPath } from "./qr.js";

const jsQR = jsQRModule.default;

const APP_URL = "https://workshop.rankly.games/apps/ada-l/";
const LONGEST_APP_URL = `https://workshop.rankly.games/apps/${"a".repeat(20)}/`;

/** Paints `modules` (quiet zone included) as RGBA pixels, `scale` pixels per module: black on white. */
function pixels(modules: boolean[][], scale = 4): { data: Uint8ClampedArray; side: number } {
  const size = modules.length + 2 * QR_MARGIN;
  const side = size * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + QR_MARGIN) * scale + dy) * side + (x + QR_MARGIN) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }),
  );
  return { data, side };
}

/** Reads the dark modules back out of a path made by qrSvgPath (only `M x y h n v1 h-n z` rectangles). */
function modulesFromPath(d: string, count: number, margin: number): boolean[][] {
  const grid = Array.from({ length: count }, () => Array.from({ length: count }, () => false));
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, w, back] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    expect(back).toBe(w);
    for (let i = 0; i < w; i++) {
      const row = grid[y - margin];
      expect(row?.[x - margin + i]).toBe(false);
      if (row) row[x - margin + i] = true;
    }
  }
  return grid;
}

describe("QR code (ticket 2.11)", () => {
  it.each([APP_URL, LONGEST_APP_URL])("WHEN the QR code for %s is decoded THEN it gives exactly that address", (url) => {
    const modules = qrModules(url);
    expect(modules.length).toBeGreaterThanOrEqual(21);
    expect(modules.every((row) => row.length === modules.length)).toBe(true);
    const { data, side } = pixels(modules);
    expect(jsQR(data, side, side)?.data).toBe(url);
  });

  it("draws every dark module, and only those, in one path inside the quiet zone", () => {
    const modules = qrModules(APP_URL);
    const { size, d } = qrSvgPath(modules);
    expect(size).toBe(modules.length + 2 * QR_MARGIN);
    expect(d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    expect(modulesFromPath(d, modules.length, QR_MARGIN)).toEqual(modules);
  });

  it("joins a row's run of dark modules into one rectangle", () => {
    expect(qrSvgPath([[true, true, false], [false, false, false], [false, true, true]], 1)).toEqual({ size: 5, d: "M1 1h2v1h-2zM2 3h2v1h-2z" });
  });
});
