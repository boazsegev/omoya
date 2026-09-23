/**
 * lib/tui-app/markdown-view.js — one block's raw markdown text into
 * GTUI rich-text rows: role-tagged spans carrying SOURCE OFFSETS into
 * that same raw text (never x/y — a viewer resolves a click/selection
 * to an offset, GTUI's own concern; copying always reads the offsets
 * back out of the source, never the displayed glyphs). Built on
 * lib/markdown.js's two SYNCHRONOUS primitives (classifyLine,
 * parseInline) — GTUI's view() must never be async, so the marked-routed
 * whole-text renderer (lib/markdown.js's renderMarkdown) doesn't apply
 * here; that's the pager's job. Never ANSI: SGR is
 * lib/tui-helpers/markdown-ansi.js's terminal-only concern over the
 * SAME abstraction.
 *
 * parseInline doesn't report offsets (lib/markdown.js's tested public
 * shape stays untouched), so spans are re-measured here from each
 * type's fixed marker width — unambiguous: "_x_" and "*x*" differ in
 * delimiter but not length, so `em`'s consumed width never depends on
 * which one matched.
 */

import Markdown from "../markdown.js";
const { classifyLine, parseInline } = Markdown;

const MARKER_WIDTH = { text: 0, strong: 2, em: 1, codespan: 1, link: 1 };
const RAW_WIDTH = {
  text: (span) => span.text.length,
  strong: (span) => span.text.length + 4,
  em: (span) => span.text.length + 2,
  codespan: (span) => span.text.length + 2,
  link: (span) => span.text.length + (span.href?.length ?? 0) + 4,
};
const INLINE_ROLE = { strong: "md.strong", em: "md.em", codespan: "md.code" };

/** Inline spans for one line's already-marker-stripped text, offset from `base`. */
function inlineSpans(text, base) {
  let cursor = base;
  return parseInline(text).map((span) => {
    const start = cursor + MARKER_WIDTH[span.type];
    const end = start + span.text.length;
    cursor += RAW_WIDTH[span.type](span);
    const role = INLINE_ROLE[span.type];
    return {
      text: span.text,
      source: { start, end },
      ...(role ? { role } : {}),
      ...(span.type === "link" ? { role: "md.link", link: span.href } : {}),
    };
  });
}

const LINE_ROLE = { heading: "md.heading", quote: "md.quote", list: "md.list", code: "md.code", fence: "md.code", hr: "md.hr", table: "md.table" };
const tableCells = (line) => {
  const trimmed = line.trim(); const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  return (body.endsWith("|") ? body.slice(0, -1) : body).split(/(?<!\\)\|/).map((cell) => cell.trim());
};
const tableCellRanges = (line) => {
  const leading = line.match(/^\s*\|/)?.[0].length ?? 0;
  const trailing = /\|\s*$/.test(line);
  const body = line.slice(leading, trailing ? line.lastIndexOf("|") : line.length);
  const ranges = [];
  let start = 0;
  for (let index = 0; index <= body.length; index++) {
    if (index !== body.length && (body[index] !== "|" || body[index - 1] === "\\")) continue;
    const value = body.slice(start, index);
    const left = value.search(/\S|$/);
    const right = value.length - value.match(/\s*$/)[0].length;
    ranges.push({ text: value.slice(left, right), start: leading + start + left });
    start = index + 1;
  }
  return ranges;
};
const tableAlignment = (line, count) => {
  const cells = tableCells(line);
  return cells.length === count && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};
const DIFF_ROLE = (line) => line.startsWith("--- ") || line.startsWith("+++ ") ? "md.diff.header"
  : line.startsWith("@@") ? "md.diff.hunk"
    : line.startsWith("+") ? "md.diff.add"
      : line.startsWith("-") ? "md.diff.remove"
        : "md.diff.context";

const MARKER_TEXT = "...";

/** Windowing bounds for a settled preview: materialize only the first
 *  `head` and last `tail` source lines, one omission-marker row between.
 *  The preview column's own split (head/ellipsis/tail) overdraws the
 *  marker, so the visual result is identical to rendering every line
 *  and clipping — at a fraction of the cost for huge payloads. */
function windowBounds(count, window) {
  if (window == null) return null;
  const head = Math.max(0, Math.floor(window.head ?? 0));
  const tail = Math.max(0, Math.floor(window.tail ?? 0));
  return count > head + tail ? { head, tail } : null;
}

/**
 * @param {string} text - one block's raw markdown
 * @param {{head: number, tail: number}} [window] - settled-preview
 *   line window (see windowBounds); omitted renders every line
 * @returns {Array<{role: string, content: Array<object>}>} one row per kept source line
 */
export function markdownRows(text, window = null) {
  const source = String(text ?? "");
  const lines = source.split("\n");
  const bounds = windowBounds(lines.length, window);
  const state = { inFence: false };
  const rows = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const isTable = !state.inFence && line.includes("|") && index + 1 < lines.length && tableAlignment(lines[index + 1], tableCells(line).length);
    if (isTable) {
      const count = tableCells(line).length;
      const tableRows = [{ role: "table.head", cells: tableCellRanges(line).map((cell) => inlineSpans(cell.text, offset + cell.start)) }];
      let next = index + 2;
      let nextOffset = offset + line.length + 1 + lines[index + 1].length + 1;
      while (next < lines.length && lines[next].includes("|") && !tableAlignment(lines[next], count)) {
        tableRows.push({ cells: tableCellRanges(lines[next]).map((cell) => inlineSpans(cell.text, nextOffset + cell.start)) });
        nextOffset += lines[next].length + 1;
        next++;
      }
      rows.push({ role: "md.table", table: { rows: tableRows } });
      offset = nextOffset;
      index = next - 1;
      continue;
    }
    const c = classifyLine(line, state);
    const diffCode = c.kind === "code" && state.fence?.lang.toLowerCase() === "diff";
    if (bounds && index === bounds.head) rows.push({ role: "md.text", content: [{ text: MARKER_TEXT }] });
    if (bounds && index >= bounds.head && index < lines.length - bounds.tail) { offset += line.length + 1; continue; }
    const textStart = offset + (c.text == null ? 0 : Math.max(0, c.raw.indexOf(c.text)));
    const role = diffCode ? DIFF_ROLE(c.raw) : (LINE_ROLE[c.kind] ?? "md.text");
    if (c.kind === "hr") rows.push({ role, content: [{ text: "─".repeat(c.width), source: { start: offset, end: offset + c.raw.length } }] });
    else if (c.kind === "fence") rows.push({ role, content: [] });
    else if (c.kind === "code") rows.push({ role, content: [{ text: c.raw, source: { start: offset, end: offset + c.raw.length } }] });
    else if (c.kind === "list") {
      const marker = { text: c.ordered ? c.marker : "•", source: { start: offset + c.indent.length, end: offset + c.indent.length + c.marker.length } };
      rows.push({ role, content: [marker, { text: " " }, ...inlineSpans(c.text, textStart)] });
    } else rows.push({ role, content: inlineSpans(c.text, textStart) });
    offset += line.length + 1;
  }
  return rows;
}
