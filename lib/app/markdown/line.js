/**
 * lib/markdown/line.js — single-line block classification (private to
 * Markdown): what KIND of markdown line is this, threading fence
 * state across calls. The builtin lexer (lib/markdown/lexer.js)
 * groups these classifications into block tokens; incremental
 * renderers (the terminal's line styler) paint one classified line at
 * a time while a stream is still growing. Zero presentation
 * knowledge — a classification carries structure only.
 */

const FENCE = /^(\s*)(`{3,}|~{3,})([^`~\s]*)\s*$/;
const HEADER = /^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/;
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const QUOTE = /^\s?>\s?(.*)$/;
const HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;

/**
 * Classify one complete Markdown source line into its block kind.
 * Fence markers are recognized against and update the supplied fence
 * state; while inside a fence, non-closing lines are classified as code.
 * Outside fences, block markers are checked in horizontal-rule, heading,
 * list, and quote order; unmatched lines are plain text.
 *
 * @param {string} line - One source line, without a trailing `\n`.
 * @param {{inFence: boolean, fence?: {char: string, length: number, lang: string}}} [state={inFence:false}] - Mutable fence state shared across successive calls. A recognized opening or closing fence toggles `inFence` and updates or clears `fence`; a closing marker must match the opening character and be at least its length.
 * @returns {{kind: "fence", lang: string, raw: string}
 *         | {kind: "code", raw: string}
 *         | {kind: "hr", width: number, raw: string}
 *         | {kind: "heading", depth: number, text: string, raw: string}
 *         | {kind: "list", indent: string, marker: string, ordered: boolean, text: string, raw: string}
 *         | {kind: "quote", text: string, raw: string}
 *         | {kind: "text", text: string, raw: string}} Classification object. `raw` is always the source line; where present, `text` is content with the block marker stripped. List `marker` preserves the source marker (for example, `-`, `*`, or `2.`); normalization is left to the renderer.
 * @throws {TypeError} If `line` is not a string or `state` is null/undefined when explicitly supplied; regular-expression matching and state access require valid inputs.
 * @sideEffects Mutates `state.inFence` and `state.fence` when a recognized fence marker opens or closes a fence.
 */
export function classifyLine(line, state = { inFence: false }) {
  const fence = FENCE.exec(line);
  if (fence && (!state.inFence || (fence[2][0] === state.fence?.char && fence[2].length >= state.fence.length && fence[3] === ""))) {
    state.inFence = !state.inFence;
    state.fence = state.inFence ? { char: fence[2][0], length: fence[2].length, lang: fence[3] ?? "" } : undefined;
    return { kind: "fence", lang: fence[3] ?? "", raw: line };
  }
  if (state.inFence) return { kind: "code", raw: line };

  const hr = HR.exec(line);
  if (hr) return { kind: "hr", width: Math.max(3, line.trim().length), raw: line };

  const header = HEADER.exec(line);
  if (header) return { kind: "heading", depth: header[1].length, text: header[2], raw: line };

  const list = LIST.exec(line);
  if (list) {
    const [, indent, marker, text] = list;
    return { kind: "list", indent, marker, ordered: /\d+\./.test(marker), text, raw: line };
  }

  const quote = QUOTE.exec(line);
  if (quote) return { kind: "quote", text: quote[1], raw: line };

  return { kind: "text", text: line, raw: line };
}
