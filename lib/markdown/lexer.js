/**
 * lib/markdown/lexer.js — the builtin BLOCK lexer (private to
 * Markdown): whole text -> marked-shaped block tokens, driven by
 * the single-line classifier (lib/markdown/line.js). This is the
 * fallback engine when `marked` doesn't resolve.
 *
 * Chat-text semantics (the same convention the terminal's line-by-line
 * view uses, and marked's `breaks: true`): every source line breaks —
 * consecutive prose lines are ONE token each, never merged into a
 * wrapped paragraph; consecutive list lines group into one list token
 * (items keep their source indent + marker); consecutive quote lines
 * group into one blockquote token (a paragraph per line); a fenced
 * block is one code token (the fence markers themselves are NOT
 * tokens — re-synthesizing them is the renderer's choice). Blank
 * lines are "space" tokens, so blocks join with exactly ONE "\n".
 */

import { classifyLine } from "./line.js";
import { parseInline, spansToTokens } from "./inline.js";

const inlineTokens = (text) => spansToTokens(parseInline(text));

function cells(line) {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const source = body.endsWith("|") ? body.slice(0, -1) : body;
  const out = []; let cell = ""; let escaped = false;
  for (const char of source) {
    if (escaped) { cell += char; escaped = false; }
    else if (char === "\\") escaped = true;
    else if (char === "|") { out.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  if (escaped) cell += "\\";
  out.push(cell.trim());
  return out;
}

function alignment(line, count) {
  const parts = cells(line);
  if (parts.length !== count || !parts.every((part) => /^:?-{3,}:?$/.test(part))) return null;
  return parts.map((part) => part.startsWith(":") && part.endsWith(":") ? "center" : part.startsWith(":") ? "left" : part.endsWith(":") ? "right" : null);
}

/**
 * @param {string} text - complete markdown text
 * @returns {Array<object>} marked-shaped block tokens
 */
export function lexBuiltin(text) {
  const tokens = [];
  const state = { inFence: false };
  let code = null;  // { lang, lines } while a fence is open
  let quote = null; // { lines } while quote lines accumulate
  let list = null;  // { ordered, start, items } while list lines accumulate
  const flush = () => {
    if (quote) {
      tokens.push({
        type: "blockquote",
        tokens: quote.lines.map((l) => ({ type: "paragraph", tokens: inlineTokens(l) })),
      });
      quote = null;
    }
    if (list) {
      tokens.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items });
      list = null;
    }
  };
  const lines = String(text ?? "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // GFM table: a header row immediately followed by an alignment row.
    // It is recognized before line classification so `|` remains data, not prose.
    const header = cells(line);
    const align = !state.inFence && index + 1 < lines.length && line.includes("|") ? alignment(lines[index + 1], header.length) : null;
    if (align) {
      flush();
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) {
        const row = cells(lines[index]);
        if (row.length !== header.length) break;
        rows.push(row.map((text) => ({ text, tokens: inlineTokens(text) })));
        index++;
      }
      tokens.push({ type: "table", header: header.map((text) => ({ text, tokens: inlineTokens(text) })), align, rows });
      index--; // outer loop consumes the first non-table line next
      continue;
    }
    const c = classifyLine(line, state);
    switch (c.kind) {
      case "fence":
        if (code) {
          tokens.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
          code = null;
        } else {
          flush();
          code = { lang: c.lang, lines: [] };
        }
        break;
      case "code":
        code.lines.push(c.raw);
        break;
      case "hr":
        flush();
        tokens.push({ type: "hr", width: c.width });
        break;
      case "heading":
        flush();
        tokens.push({ type: "heading", depth: c.depth, tokens: inlineTokens(c.text) });
        break;
      case "list":
        if (list && list.ordered !== c.ordered) flush();
        if (!list) {
          flush();
          list = { ordered: c.ordered, start: c.ordered ? parseInt(c.marker, 10) : "", items: [] };
        }
        list.items.push({
          type: "list_item", tokens: inlineTokens(c.text),
          indent: c.indent, marker: c.marker, ordered: c.ordered,
        });
        break;
      case "quote":
        if (!quote) {
          flush();
          quote = { lines: [] };
        }
        quote.lines.push(c.text);
        break;
      default:
        flush();
        if (c.text.trim() === "") tokens.push({ type: "space" });
        else tokens.push({ type: "paragraph", tokens: inlineTokens(c.text) });
    }
  }
  // an unclosed fence still yields its code token (marked does the same)
  if (code) tokens.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
  flush();
  return tokens;
}
