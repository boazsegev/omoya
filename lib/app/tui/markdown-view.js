/**
 * lib/app/tui/markdown-view.js — one block's raw markdown text into
 * GTUI rich-text rows: role-tagged spans carrying SOURCE OFFSETS into
 * that same raw text (never x/y — a viewer resolves a click/selection
 * to an offset, GTUI's own concern; copying always reads the offsets
 * back out of the source, never the displayed glyphs). Built on
 * App.Markdown's two SYNCHRONOUS primitives (classifyLine, parseInline) —
 * GTUI's view() must never be async, so the marked-routed whole-text
 * renderer (renderMarkdown) doesn't apply here. Never ANSI.
 *
 * Presentation-only glyphs (fence frames, code gutters, task boxes, list
 * bullets) carry no source range, so copying never picks them up.
 *
 * parseInline doesn't report offsets (lib/markdown.js's tested public
 * shape stays untouched), so spans are re-measured here from each
 * type's fixed marker width — unambiguous: "_x_" and "*x*" differ in
 * delimiter but not length, so `em`'s consumed width never depends on
 * which one matched. Math is left in source form to preserve GTUI's
 * per-grapheme selection mapping.
 */

import Markdown from "../markdown/index.js";
import { HIGHLIGHT_ROLE, highlightLine } from "./code-highlight.js";
const { classifyLine, parseInline, mathBlockAt } = Markdown;

const MARKER_WIDTH = { text: 0, strong: 2, em: 1, codespan: 1, link: 1, math_inline: 0 };
const RAW_WIDTH = {
  /** @param {{text: string}} span @returns {number} Visible text length; no side effects or expected errors. */
  text: (span) => span.text.length,
  /** @param {{text: string}} span @returns {number} Raw width including strong delimiters; no side effects or expected errors. */
  strong: (span) => span.text.length + 4,
  /** @param {{text: string}} span @returns {number} Raw width including emphasis delimiters; no side effects or expected errors. */
  em: (span) => span.text.length + 2,
  /** @param {{text: string}} span @returns {number} Raw width including code delimiters; no side effects or expected errors. */
  codespan: (span) => span.text.length + 2,
  /** @param {{text: string, href?: string}} span @returns {number} Raw width including link syntax; no side effects or expected errors. */
  link: (span) => span.text.length + (span.href?.length ?? 0) + 4,
  /** @param {{source: string}} span @returns {number} Raw source length; no side effects or expected errors. */
  math_inline: (span) => span.source.length,
};
const INLINE_ROLE = { strong: "md.strong", em: "md.em", codespan: "md.code" };

/**
 * Convert marker-stripped inline text into display spans mapped to raw-source offsets.
 * @param {string} text Inline text to parse.
 * @param {number} base Zero-based source offset at which this text begins.
 * @returns {Array<{text: string, source: {start: number, end: number}, role?: string, link?: string}>} Source-mapped spans.
 * @throws Propagates errors from `parseInline` or malformed parser span data.
 */
function inlineSpans(text, base) {
  let cursor = base;
  return parseInline(text).map((span) => {
    const start = cursor + MARKER_WIDTH[span.type];
    const end = start + (span.type === "math_inline" ? span.source.length : span.text.length);
    cursor += RAW_WIDTH[span.type](span);
    const role = INLINE_ROLE[span.type];
    return {
      // GTUI maps display graphemes 1:1 to source offsets. Preserve TeX
      // verbatim here so partial selections also copy the correct source.
      text: span.type === "math_inline" ? span.source : span.text,
      source: { start, end },
      ...(role ? { role } : {}),
      ...(span.type === "link" ? { role: "md.link", link: span.href } : {}),
      ...(span.type === "math_inline" ? { role: "md.code" } : {}),
    };
  });
}

const LINE_ROLE = { heading: "md.heading", quote: "md.quote", list: "md.list", code: "md.code", fence: "md.code", hr: "md.hr", table: "md.table" };
/**
 * Split a pipe-delimited table row into trimmed cell strings.
 * @param {string} line Raw table row.
 * @returns {string[]} Trimmed cells, excluding optional outer pipes; escaped pipes remain within their cell.
 * @throws None for string input; non-string input fails when string methods are accessed.
 */
const tableCells = (line) => {
  const trimmed = line.trim(); const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  return (body.endsWith("|") ? body.slice(0, -1) : body).split(/(?<!\\)\|/).map((cell) => cell.trim());
};
/**
 * Split a table row into trimmed cell text and each cell's source-relative start.
 * @param {string} line Raw table row.
 * @returns {Array<{text: string, start: number}>} Cells with zero-based starts in `line`.
 * @throws None for string input; non-string input fails when string methods are accessed.
 */
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
/**
 * Test whether a row is a Markdown table alignment rule with the expected cell count.
 * @param {string} line Candidate alignment row.
 * @param {number} count Expected number of columns.
 * @returns {boolean} Whether all cells are valid alignment markers and the count matches.
 * @throws Propagates errors from `tableCells` for invalid input.
 */
const tableAlignment = (line, count) => {
  const cells = tableCells(line);
  return cells.length === count && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};
/**
 * Convert one code line into highlighted spans with offsets into its source.
 * @param {string} line Raw code line.
 * @param {string} lang Fence language used by the syntax highlighter (empty string when unknown).
 * @param {number} offset Zero-based source offset of the line.
 * @returns {Array<{text: string, source: {start: number, end: number}, role?: string}>} Highlighted source-mapped spans.
 * @throws Propagates errors from `highlightLine` or malformed highlight ranges.
 */
function codeSpans(line, lang, offset) {
  const spans = [];
  let cursor = 0;
  /** @param {number} end Exclusive line-relative segment end. @returns {void} Appends a nonempty plain span to the local array. @throws May propagate `slice` errors for malformed captured input. */
  const plain = (end) => { if (end > cursor) spans.push({ text: line.slice(cursor, end), source: { start: offset + cursor, end: offset + end } }); };
  for (const { start, end, kind } of highlightLine(line, lang)) {
    plain(start);
    spans.push({ text: line.slice(start, end), source: { start: offset + start, end: offset + end }, role: HIGHLIGHT_ROLE[kind] });
    cursor = end;
  }
  plain(line.length);
  return spans.length > 0 ? spans : [{ text: line, source: { start: offset, end: offset + line.length } }];
}

/**
 * Classify a diff source line for presentation.
 * @param {string} line Raw diff line.
 * @returns {string} The corresponding `md.diff.*` role.
 * @throws None for string input; non-string input fails when `startsWith` is called.
 */
const DIFF_ROLE = (line) => line.startsWith("--- ") || line.startsWith("+++ ") ? "md.diff.header"
  : line.startsWith("@@") ? "md.diff.hunk"
    : line.startsWith("+") ? "md.diff.add"
      : line.startsWith("-") ? "md.diff.remove"
        : "md.diff.context";

const MARKER_TEXT = "...";
/** Fenced code sits in a light frame: `╭─ js`, `│ ` gutters, `╰─`. */
const FRAME_ROLE = "muted";
const TASK_BOX = { " ": "☐", x: "☑", X: "☑" };

/**
 * Normalize settled-preview windowing bounds: materialize only the first
 * `head` and last `tail` source lines, with one omission-marker row between.
 * The preview column's own split (head/ellipsis/tail) overdraws the marker,
 * so the visual result is identical to rendering every line and clipping.
 * @param {number} count Total number of source lines.
 * @param {{head?: number, tail?: number}|null|undefined} window Requested line counts; missing values default to zero, and null disables windowing.
 * @returns {{head: number, tail: number}|null} Nonnegative floored bounds when truncation is needed, otherwise null.
 * @throws May propagate errors from property access or numeric coercion (including invalid numeric values).
 */
function windowBounds(count, window) {
  if (window == null) return null;
  const head = Math.max(0, Math.floor(window.head ?? 0));
  const tail = Math.max(0, Math.floor(window.tail ?? 0));
  return count > head + tail ? { head, tail } : null;
}

/**
 * Convert one block's raw Markdown into presentation rows with source-offset mappings.
 * @param {string} text One block's raw Markdown; nullish input becomes an empty string and other values are string-coerced.
 * @param {{head?: number, tail?: number}|null} [window=null] Settled-preview line window; missing bounds default to zero and the window applies only when lines are omitted. Defaults to null (render every line).
 * @returns {Array<object>} View rows; tables use `table.rows`/`table.align`, while ordinary rows carry `content` spans.
 * @throws Propagates errors from value string conversion, Markdown classifiers/parsers, syntax highlighting, or malformed source data.
 * @effects None beyond invoking the imported Markdown and highlighting helpers; does not mutate the input text.
 */
export function markdownRows(text, window = null) {
  const source = String(text ?? "");
  const lines = source.split("\n");
  const bounds = windowBounds(lines.length, window);
  const state = { inFence: false };
  let fenceStart = null;
  let mathEnd = -1;
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
      rows.push({ role: "md.table", table: { rows: tableRows, align: "start", headerRule: "md.hr" } });
      offset = nextOffset;
      index = next - 1;
      continue;
    }
    if (!state.inFence && mathEnd < index) mathEnd = mathBlockAt(lines, index)?.end ?? -1;
    if (index <= mathEnd) {
      if (bounds && index === bounds.head) rows.push({ role: "md.text", content: [{ text: MARKER_TEXT }] });
      if (!bounds || index < bounds.head || index >= lines.length - bounds.tail) {
        rows.push({ role: "md.code", content: [{ text: line, source: { start: offset, end: offset + line.length } }] });
      }
      offset += line.length + 1;
      continue;
    }
    const wasInFence = state.inFence;
    const c = classifyLine(line, state);
    if (c.kind === "fence" && !wasInFence) fenceStart = offset + line.length + 1;
    const diffCode = c.kind === "code" && state.fence?.lang.toLowerCase() === "diff";
    if (bounds && index === bounds.head) rows.push({ role: "md.text", content: [{ text: MARKER_TEXT }] });
    if (bounds && index >= bounds.head && index < lines.length - bounds.tail) { offset += line.length + 1; continue; }
    const textStart = offset + (c.text == null ? 0 : Math.max(0, c.raw.indexOf(c.text)));
    const role = diffCode ? DIFF_ROLE(c.raw) : (LINE_ROLE[c.kind] ?? "md.text");
    if (c.kind === "hr") rows.push({ role, content: [{ text: "─".repeat(c.width), source: { start: offset, end: offset + c.raw.length } }] });
    else if (c.kind === "fence") {
      if (state.inFence) rows.push({ role, content: [{ text: `╭─${c.lang ? ` ${c.lang}` : ""}`, role: FRAME_ROLE }] });
      else {
        rows.push({ role, content: [{ text: "╰─ ", role: FRAME_ROLE }, { text: "copy", role: "md.link", copyRange: { start: fenceStart, end: Math.max(fenceStart, offset - 1) } }] });
        fenceStart = null;
      }
    }
    else if (c.kind === "code") rows.push({ role, content: [{ text: "│ ", role: FRAME_ROLE }, ...(diffCode ? [{ text: c.raw, source: { start: offset, end: offset + c.raw.length } }] : codeSpans(c.raw, state.fence?.lang ?? "", offset))] });
    else if (c.kind === "list") {
      const task = c.ordered ? null : /^\[([ xX])\] /.exec(c.text);
      // The displayed marker copies back as its source: "-" for •, "- [x]" for ☑.
      const marker = { text: task ? TASK_BOX[task[1]] : c.ordered ? c.marker : "•", source: { start: offset + c.indent.length, end: task ? textStart + 3 : offset + c.indent.length + c.marker.length } };
      rows.push({ role, content: [marker, { text: " " }, ...(task ? inlineSpans(c.text.slice(4), textStart + 4) : inlineSpans(c.text, textStart))] });
    } else rows.push({ role, content: inlineSpans(c.text, textStart) });
    offset += line.length + 1;
  }
  if (state.inFence && fenceStart !== null && (!bounds || bounds.tail > 0)) {
    rows.push({ role: "md.code", content: [{ text: "╰─ ", role: FRAME_ROLE }, { text: "copy", role: "md.link", copyRange: { start: fenceStart, end: Math.max(fenceStart, source.length) } }] });
  }
  return rows;
}
