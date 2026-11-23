// Step 2 (ticket 1.9): Mermaid's SVG made into a picture. Pure string work, unit tested without a
// browser; ./diagram.ts draws the diagram and ./main.ts shows it.
//
// The pages' Content-Security-Policy has `style-src 'self'`, and Mermaid styles its SVG with a <style>
// element and style attributes. While Mermaid draws (in a hidden part of the page), ./diagram.ts
// therefore turns its <style> element into an inert placeholder (STYLE_PLACEHOLDER_CLASS) and its style
// attributes into CSSOM writes, which the policy allows. The finished SVG is shown as an <img> from a
// `data:` URL (img-src allows `data:`): an image is its own document, where the styles apply and no
// script ever runs.

/** The class of the inert element that stands in for Mermaid's <style> while it draws. */
export const STYLE_PLACEHOLDER_CLASS = "ssd-diagram-style";

export interface DiagramPicture {
  /** A standalone SVG document with its styles. */
  svg: string;
  /** Its size in CSS pixels (from the viewBox). */
  width: number;
  height: number;
}

/**
 * Mermaid's SVG as a standalone picture: the placeholder back into a <style> element, and a fixed
 * width and height from the viewBox (Mermaid writes width="100%", which gives an image no size).
 * Undefined when the SVG has no usable viewBox.
 */
export function finishSvg(svg: string): DiagramPicture | undefined {
  const open = `<desc class="${STYLE_PLACEHOLDER_CLASS}">`;
  const start = svg.indexOf(open);
  const end = start < 0 ? -1 : svg.indexOf("</desc>", start);
  const withStyle =
    end < 0 ? svg : `${svg.slice(0, start)}<style>${svg.slice(start + open.length, end)}</style>${svg.slice(end + "</desc>".length)}`;
  const root = /<svg\b[^>]*>/.exec(withStyle);
  if (root === null) return undefined;
  const viewBox = /\bviewBox="([^"]+)"/.exec(root[0]);
  const numbers = (viewBox?.[1] ?? "").trim().split(/[\s,]+/).map(Number);
  const width = numbers[2];
  const height = numbers[3];
  if (numbers.length !== 4 || width === undefined || height === undefined || !(width > 0) || !(height > 0)) return undefined;
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const sized = root[0]
    .replace(/\s(width|height)="[^"]*"/g, "")
    .replace(/\sstyle="[^"]*"/, "")
    .replace(/^<svg\b/, `<svg width="${w}" height="${h}"`);
  return { svg: withStyle.replace(root[0], sized), width: w, height: h };
}

/** The picture as a `data:` URL for an <img>. */
export function pictureUrl(picture: DiagramPicture): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture.svg)}`;
}
