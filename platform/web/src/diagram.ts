// Step 2 (ticket 1.9): draws a spec's Mermaid diagram. Built into its own script, diagram.js
// (Mermaid is large), which ./main.ts loads only when a spec is shown; it exposes `window.ssdDiagram`.
// The eval (`npm run eval -- spec`) loads the same script in Chromium to check that diagrams parse.
//
// Content-Security-Policy: see ./diagram-svg.ts. While Mermaid draws, its <style> element becomes an
// inert placeholder and its style attributes become CSSOM writes; `securityLevel: "loose"` skips
// Mermaid's final DOMPurify pass, whose parse of the SVG would report every style attribute as a
// policy violation. The SVG is then only ever shown as an <img> (no script runs in an image, and the
// policy still applies to the page), and the diagram source comes from the participant's own spec.
import mermaid from "mermaid";
import { finishSvg, STYLE_PLACEHOLDER_CLASS, type DiagramPicture } from "./diagram-svg.js";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The font Mermaid measures and draws with; the hidden drawing area uses it too (style.css). */
const FONT_FAMILY = "Arial, Helvetica, sans-serif";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "loose",
  theme: "default",
  fontFamily: FONT_FAMILY,
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: false },
});

let drawings = 0;

// While a diagram draws, these swaps apply to the whole page: other page code must not rely on
// `setAttribute("style", ...)` or creating a <style> element doing the usual thing in that window.
/** Runs `work` with Mermaid's inline styles made CSP-safe (see the file comment), then restores the DOM methods. */
async function withSafeStyles<T>(work: () => Promise<T>): Promise<T> {
  const setAttribute = Element.prototype.setAttribute;
  const createElement = document.createElement;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string): void {
    if (name.toLowerCase() === "style" && (this instanceof HTMLElement || this instanceof SVGElement)) {
      this.style.cssText = value;
      return;
    }
    setAttribute.call(this, name, value);
  };
  document.createElement = function (this: Document, tagName: string, options?: ElementCreationOptions): HTMLElement {
    if (tagName.toLowerCase() === "style") {
      const placeholder = this.createElementNS(SVG_NS, "desc");
      setAttribute.call(placeholder, "class", STYLE_PLACEHOLDER_CLASS);
      return placeholder as unknown as HTMLElement;
    }
    return createElement.call(this, tagName, options);
  } as typeof document.createElement;
  try {
    return await work();
  } finally {
    Element.prototype.setAttribute = setAttribute;
    document.createElement = createElement;
  }
}

/** True when Mermaid can parse the source. */
async function parse(source: string): Promise<boolean> {
  try {
    return (await mermaid.parse(source, { suppressErrors: true })) !== false;
  } catch {
    return false;
  }
}

/** The diagram as a picture; throws when Mermaid cannot draw it. */
async function render(source: string): Promise<DiagramPicture> {
  if (!(await parse(source))) throw new Error("the diagram does not parse");
  const host = document.createElement("div");
  host.className = "diagram-work";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  try {
    const id = `ssd-diagram-${++drawings}`;
    const { svg } = await withSafeStyles(() => mermaid.render(id, source, host));
    const picture = finishSvg(svg);
    if (picture === undefined) throw new Error("the diagram has no size");
    return picture;
  } finally {
    host.remove();
  }
}

export interface DiagramApi {
  parse(source: string): Promise<boolean>;
  render(source: string): Promise<DiagramPicture>;
}

(window as unknown as { ssdDiagram: DiagramApi }).ssdDiagram = { parse, render };
