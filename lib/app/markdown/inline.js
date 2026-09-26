/**
 * lib/markdown/inline.js — the builtin INLINE tokenizer (private to
 * Markdown): markdown inline markup -> a flat span list, zero
 * presentation knowledge. This is the fallback engine's inline half
 * (used when `marked` is unavailable) and the primitive incremental
 * renderers style complete lines with.
 *
 * Deliberately NOT CommonMark: code spans, links, bold, and italic,
 * scanned left-to-right; the earliest match wins (ties break in
 * pattern order: codespan > link > strong > em), a consumed span is
 * atomic (its content is never re-scanned — no nesting), and anything
 * unrecognized is plain text. Good enough for chat-model output.
 *
 * A span: { type: "text" | "codespan" | "strong" | "em" | "link",
 *           text, href? } — `text` is the span's literal content
 * (markers stripped), `href` only on links.
 */

const SPAN_RES = [
  ["strong", /\*\*([^*]+)\*\*/],
  ["em", /(?<![*\w])_([^_]+)_(?![*\w])/],
  ["em", /(?<!\*)\*([^*]+)\*(?!\*)/],
];

/** Find a code span closed by a backtick run the same length as its opener. */
function findCodeSpan(text) {
  const runs = [...text.matchAll(/`+/g)];
  for (let opener = 0; opener < runs.length; opener += 1) {
    const start = runs[opener];
    for (let closer = opener + 1; closer < runs.length; closer += 1) {
      const end = runs[closer];
      if (end[0].length !== start[0].length) continue;
      const contentStart = start.index + start[0].length;
      if (end.index === contentStart) break;
      return {
        index: start.index,
        raw: text.slice(start.index, end.index + end[0].length),
        text: text.slice(contentStart, end.index),
      };
    }
  }
  return null;
}

/** Find a Markdown link, allowing balanced parentheses in its destination. */
function findLink(text) {
  const start = /\[([^\]]+)\]\(/g;
  for (let match; (match = start.exec(text));) {
    const hrefStart = start.lastIndex;
    let depth = 1;
    let i = hrefStart;
    for (; i < text.length; i += 1) {
      if (text[i] === "\\") { i += 1; continue; }
      if (text[i] === "(") depth += 1;
      if (text[i] === ")" && --depth === 0) {
        return { index: match.index, raw: text.slice(match.index, i + 1), text: match[1], href: text.slice(hrefStart, i) };
      }
    }
    start.lastIndex = match.index + 1;
  }
  return null;
}

/**
 * Tokenize inline markdown into flat spans.
 * @param {string} text - one line/fragment of inline markdown
 * @returns {Array<{type: string, text: string, href?: string}>}
 */
export function parseInline(text) {
  const spans = [];
  let rest = String(text ?? "");
  while (rest !== "") {
    let first = null;
    const code = findCodeSpan(rest);
    if (code) first = { type: "codespan", ...code };
    const link = findLink(rest);
    if (link && (!first || link.index < first.index)) first = { type: "link", ...link };
    for (const [type, re] of SPAN_RES) {
      const match = re.exec(rest);
      if (!match) continue;
      if (!first || match.index < first.index) {
        first = { type, index: match.index, raw: match[0], text: match[1], href: match[2] };
      }
    }
    if (!first) {
      spans.push({ type: "text", text: rest });
      break;
    }
    if (first.index > 0) spans.push({ type: "text", text: rest.slice(0, first.index) });
    spans.push(first.type === "link"
      ? { type: "link", text: first.text, href: first.href }
      : { type: first.type, text: first.text });
    rest = rest.slice(first.index + first.raw.length);
  }
  return spans;
}

/**
 * Spans -> marked-shaped inline tokens ({type, text?, href?, tokens?}),
 * so the SAME walker (lib/markdown/walk.js) serves the builtin engine
 * and `marked`'s lexer alike.
 * @param {Array<{type: string, text: string, href?: string}>} spans
 * @returns {Array<object>}
 */
export function spansToTokens(spans) {
  return (spans ?? []).map((s) => {
    switch (s.type) {
      case "strong": return { type: "strong", tokens: [{ type: "text", text: s.text }] };
      case "em": return { type: "em", tokens: [{ type: "text", text: s.text }] };
      case "codespan": return { type: "codespan", text: s.text };
      case "link": return { type: "link", href: s.href, tokens: [{ type: "text", text: s.text }] };
      default: return { type: "text", text: s.text };
    }
  });
}
