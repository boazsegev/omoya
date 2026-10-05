/** Shared decorative brand mark used by shell and transcript. */
import { el, SVG_NS } from "./dom.js";
export function brandWordmark(word = "Omoya") {
  const o = el("span", "wordmark-o");
  o.append(el("span", "wordmark-o-text", word[0]));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "wordmark-mark");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", "256"); ring.setAttribute("cy", "256"); ring.setAttribute("r", "142");
  const glyph = document.createElementNS(SVG_NS, "path");
  glyph.setAttribute("d", "M218 207 274 256 218 305 M282 305h38");
  glyph.setAttribute("stroke-linecap", "round"); glyph.setAttribute("stroke-linejoin", "round");
  svg.append(ring, glyph);
  o.append(svg);
  const wordmark = el("span", "wordmark");
  wordmark.append(o, document.createTextNode(word.slice(1)));
  return wordmark;
}
