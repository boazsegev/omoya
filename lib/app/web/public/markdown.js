/**
 * public/markdown.js — a tiny, dependency-free Markdown → safe-HTML
 * renderer for the chat SPA. It escapes every source fragment before
 * composing known tags (no raw HTML injection): a small set of block
 * (fences, headings, lists, quotes, paragraphs, math) and inline (code,
 * bold, italic, links, math) constructs is recognized. Anything unrecognized
 * stays literal text. This is presentation sugar — the wire carries plain
 * Markdown; the Agent/library never sees HTML.
 */

import { findInlineMath, mathBlockAt, findCodeSpan } from "../../markdown/browser.js";

/** Convert arbitrary text to HTML-safe text by escaping ampersands, angle brackets, and double quotes.
 * @param {*} text Value converted with String().
 * @returns {string} Escaped text; no HTML is generated.
 */
const escapeHtml = (text) => String(text)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

/** Escape text for a quoted HTML attribute, including apostrophes.
 * @param {*} text Value converted with String() by escapeHtml.
 * @returns {string} Attribute-safe escaped text.
 */
const escapeAttr = (text) => escapeHtml(text).replaceAll("'", "&#39;");
// URLs arrive already escaped (inline() runs on escaped text): undo the
// entity layer once so an href is escaped exactly one time.
/** Re-escape an already escaped URL exactly once for an href attribute.
 * @param {string} escaped Previously HTML-escaped URL text.
 * @returns {string} Attribute-safe URL.
 */
const hrefOf = (escaped) => escapeAttr(escaped.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));

/** Render supported inline syntax on already HTML-escaped text; code spans are protected from other rules.
 * @param {string} escaped Input text already escaped for HTML.
 * @returns {string} Inline HTML; introduces only known tags and safe href attributes.
 */
function inlinePlain(escaped) {
  const spans = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, code) => { spans.push(`<code>${code}</code>`); return `\u0000${spans.length - 1}\u0000`; });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_m, text, url) => `<a href="${hrefOf(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g,
    (_m, lead, url) => `${lead}<a href="${hrefOf(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, index) => spans[Number(index)]);
}

/** Render a parsed math-tree node using only the renderer's known HTML elements.
 * @param {object} node Math node (symbol, fraction, sqrt, script, or children node).
 * @returns {string} Safe HTML representation; symbol values are escaped.
 */
function mathNode(node) {
  if (node.type === "symbol") return escapeHtml(node.value);
  if (node.type === "fraction") return `<span class="md-frac"><span>${mathNode(node.numerator)}</span><span>${mathNode(node.denominator)}</span></span>`;
  if (node.type === "sqrt") return `<span class="md-sqrt">√<span>${mathNode(node.body)}</span></span>`;
  if (node.type === "script") return `${mathNode(node.base)}<span class="md-scripts">${node.sup ? `<sup>${mathNode(node.sup)}</sup>` : ""}${node.sub ? `<sub>${mathNode(node.sub)}</sub>` : ""}</span>`;
  return (node.children ?? []).map(mathNode).join("");
}

/** Wrap a parsed math tree in accessible inline or display-math markup.
 * @param {string} source Original math source used for title and aria-label attributes.
 * @param {object} tree Parsed math tree passed to mathNode.
 * @param {boolean} [display=false] Whether to use the display-math CSS class.
 * @returns {string} HTML math span with escaped source attributes.
 */
function mathHtml(source, tree, display = false) {
  return `<span class="${display ? "md-math-block" : "md-math"}" title="${escapeAttr(source)}" role="math" aria-label="${escapeAttr(source)}">${mathNode(tree)}</span>`;
}

/** Render inline Markdown while protecting math and code spans from other inline rules.
 * @param {*} raw Source text, coerced to string; reserved sentinel characters are replaced.
 * @returns {string} Inline HTML with escaped source text and recognized constructs.
 */
function inline(raw) {
  let rest = String(raw).replaceAll("\u0000", "�").replaceAll("\u0001", "�").replaceAll("\u0002", "�");
  let protectedText = "";
  const mathTags = [];
  const codeTags = [];
  while (rest) {
    const math = findInlineMath(rest);
    const code = findCodeSpan(rest);
    if (!math || (code && code.index <= math.index)) {
      if (!code) { protectedText += rest; break; }
      protectedText += rest.slice(0, code.index) + `\u0002${codeTags.length}\u0002`;
      codeTags.push(`<code>${escapeHtml(code.text)}</code>`);
      rest = rest.slice(code.index + code.raw.length);
      continue;
    }
    protectedText += rest.slice(0, math.index) + `\u0001${mathTags.length}\u0001`;
    mathTags.push(mathHtml(math.raw, math.tree));
    rest = rest.slice(math.index + math.raw.length);
  }
  return inlinePlain(escapeHtml(protectedText))
    .replace(/\u0001(\d+)\u0001/g, (_match, index) => mathTags[Number(index)])
    .replace(/\u0002(\d+)\u0002/g, (_match, index) => codeTags[Number(index)]);
}

/** Escape diff-fence lines and wrap added, removed, and hunk lines in CSS spans.
 * @param {string[]} lines Diff body lines, without fence delimiters.
 * @returns {string} HTML lines joined with newline characters.
 */
function diffBody(lines) {
  return lines.map((line) => {
    const text = escapeHtml(line);
    if (/^(\+\+\+|---)\s/.test(line)) return `<span class="diff-hunk">${text}</span>`;
    if (line.startsWith("+")) return `<span class="diff-add">${text}</span>`;
    if (line.startsWith("-")) return `<span class="diff-remove">${text}</span>`;
    if (line.startsWith("@@")) return `<span class="diff-hunk">${text}</span>`;
    return text;
  }).join("\n");
}

/** Render supported Markdown constructs as HTML composed of escaped text and known tags.
 * @param {*} source Markdown input; null and undefined become an empty string, other values are stringified.
 * @returns {string} Rendered HTML (may contain paragraph, list, table, math, and code markup).
 */
export function renderMarkdown(source) {
  const lines = String(source ?? "").replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null; // "ul" | "ol" | null
  let inFence = false;
  let fenceLang = "";
  let fenceBody = [];

  /** Split a Markdown table row into trimmed cells, honoring escaped pipe characters.
   * @param {string} line Source row.
   * @returns {string[]} Cell contents with escaped pipes unescaped.
   */
  const cells = (line) => {
    const trimmed = line.trim();
    const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
    const source = body.endsWith("|") ? body.slice(0, -1) : body;
    return source.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
  };
  /** Parse a table separator row into per-column alignment values.
   * @param {string} line Candidate separator row.
   * @param {number} count Required number of columns.
   * @returns {(string|null)[]|null} Alignment names (left, right, center, or null), or null if invalid.
   */
  const alignments = (line, count) => {
    const values = cells(line);
    if (values.length !== count || !values.every((value) => /^:?-{3,}:?$/.test(value))) return null;
    return values.map((value) => value.startsWith(":") && value.endsWith(":") ? "center" : value.startsWith(":") ? "left" : value.endsWith(":") ? "right" : null);
  };
  /** Render table headers and body rows using inline Markdown cell rendering.
   * @param {string[]} header Header cell values.
   * @param {(string|null)[]} align Per-column alignment names or null values.
   * @param {string[][]} rows Body rows of cell values.
   * @returns {string} HTML table wrapped for overflow handling.
   */
  const table = (header, align, rows) => {
    // A class, not a style attribute: the SPA's CSP forbids inline styles.
    /** Render one table cell with optional alignment class and inline content.
     * @param {string} tag Cell tag name (th or td).
     * @param {string} value Cell source text.
     * @param {number} index Column index used to select alignment.
     * @returns {string} Rendered cell HTML.
     */
    const cell = (tag, value, index) => `<${tag}${align[index] ? ` class="align-${align[index]}"` : ""}>${inline(value)}</${tag}>`;
    return `<div class="md-table-wrap"><table><thead><tr>${header.map((value, index) => cell("th", value, index)).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => cell("td", value, index)).join("")}</tr>`).join("")}</tbody></table></div>`;
  };

  /** Emit the pending paragraph, converting embedded newlines to line breaks, then clear it.
   * @returns {void}
   */
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join("\n")).replaceAll("\n", "<br>")}</p>`);
    paragraph = [];
  };
  /** Close the currently open list, if any, and clear list state.
   * @returns {void}
   */
  const flushList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };
  /** Ensure the requested list kind is open, closing pending paragraph/other list as needed.
   * @param {"ul"|"ol"} kind HTML unordered or ordered list kind.
   * @returns {void}
   */
  const openList = (kind) => {
    if (list === kind) return;
    flushParagraph(); flushList();
    html.push(`<${kind}>`);
    list = kind;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*```([\w+#.-]*)\s*$/);
    if (fenceMatch && (!inFence || fenceMatch[1] === "")) {
      if (inFence) {
        const body = /^(diff|patch)$/i.test(fenceLang) ? diffBody(fenceBody) : escapeHtml(fenceBody.join("\n"));
        html.push(`<pre class="md-code"${fenceLang ? ` data-lang="${escapeAttr(fenceLang)}"` : ""}><code>${body}</code></pre>`);
        inFence = false; fenceLang = ""; fenceBody = [];
      } else {
        flushParagraph(); flushList();
        inFence = true; fenceLang = fenceMatch[1] || ""; fenceBody = [];
      }
      continue;
    }
    if (inFence) { fenceBody.push(line); continue; }

    const header = cells(line);
    const align = line.includes("|") && index + 1 < lines.length ? alignments(lines[index + 1], header.length) : null;
    if (align) {
      flushParagraph(); flushList();
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const row = cells(lines[index]);
        if (row.length !== header.length) break;
        rows.push(row); index++;
      }
      html.push(table(header, align, rows));
      index--;
      continue;
    }

    const math = mathBlockAt(lines, index);
    if (math) {
      flushParagraph(); flushList();
      html.push(mathHtml(math.source, math.tree, true));
      index = math.end;
      continue;
    }
    if (/^\s*$/.test(line)) { flushParagraph(); flushList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushParagraph(); flushList(); html.push("<hr>"); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph(); flushList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) {
      openList("ul");
      const task = unordered[1].match(/^\[([ xX])\]\s+(.*)$/);
      html.push(task ? `<li class="task${task[1] === " " ? "" : " done"}">${inline(task[2])}</li>` : `<li>${inline(unordered[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) { openList("ol"); html.push(`<li>${inline(ordered[1])}</li>`); continue; }

    flushList();
    paragraph.push(line);
  }
  if (inFence) html.push(`<pre class="md-code"${fenceLang ? ` data-lang="${escapeAttr(fenceLang)}"` : ""}><code>${escapeHtml(fenceBody.join("\n"))}</code></pre>`);
  flushParagraph(); flushList();
  return html.join("\n");
}
