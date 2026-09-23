/**
 * lib/markdown.js — Markdown: markdown STRUCTURE for any render
 * target, presentation-free.
 *
 * This module depends on no higher-level library code. CLI, TUI, and
 * external hosts can use its public functions.
 *
 * The interface is `marked`-style CALLBACKS: a renderer is an object
 * of string-in/string-out functions — inline: text, strong, em,
 * codespan, link, br; block: heading, code, blockquote, list,
 * listItem, table, tableRow/tableCell (or marked's tablerow/tablecell),
 * paragraph, hr, space — every one optional (missing ones
 * default to plain text). Whole-text tokenization routes internally:
 * the optional `marked` package's lexer when it resolves (a guarded
 * dynamic import in lib/markdown/marked.js), or the builtin lexer
 * (lib/markdown/lexer.js). Both produce the marked-shaped tokens
 * accepted by the same walker (lib/markdown/walk.js), so renderers
 * receive the same token contract from either engine.
 *
 * Render targets hook in two ways:
 *   - whole text: renderMarkdown(text, renderer) — async (the marked
 *     import is), engine-routed;
 *   - incrementally (a still-growing stream, where marked's
 *     whole-text requirement can't apply): classifyLine() per
 *     complete line + renderInline() for the inline spans — the
 *     builtin engine's own primitives, synchronous.
 * The terminal's shared SGR implementation lives in
 * lib/tui-helpers/markdown-ansi.js; each TUI engine can use it or
 * supply its own codes.
 */

import { parseInline, spansToTokens } from "./markdown/inline.js";
import { classifyLine } from "./markdown/line.js";
import { lexBuiltin } from "./markdown/lexer.js";
import { loadMarked } from "./markdown/marked.js";
import { completeRenderer, walkInline, walkTokens } from "./markdown/walk.js";
import { parseGitDiff as parseGitDiffInternal } from "./markdown/gitdiff.js";

export { parseInline, classifyLine, walkTokens };

/** Parse one complete unified Git diff synchronously, with exact source-line spans. */
export function parseGitDiff(text) { return parseGitDiffInternal(text); }

/**
 * Which engine whole-text rendering routes through: "marked" when the
 * optional package resolved, "builtin" otherwise.
 * @returns {Promise<"marked"|"builtin">}
 */
export async function markdownEngine() {
  return (await loadMarked()) ? "marked" : "builtin";
}

/**
 * Tokenize complete markdown text: `marked`'s lexer (gfm, breaks) when
 * available, the builtin lexer otherwise — same token shapes either
 * way, ready for walkTokens.
 * @param {string} text
 * @returns {Promise<Array<object>>} marked-shaped block tokens
 */
export async function lexMarkdown(text) {
  const source = String(text ?? "");
  const gitdiff = parseGitDiff(source);
  if (gitdiff) return [gitdiff];
  const marked = await loadMarked();
  if (marked) return marked.lexer(source, { gfm: true, breaks: true });
  return lexBuiltin(source);
}

/**
 * Render complete markdown text through a renderer's callbacks,
 * engine-routed (see lexMarkdown). Rendered tokens join with one
 * "\n"; source blank lines are space tokens, so one blank line remains
 * one blank line in the output.
 * @param {string} text
 * @param {object} [renderer] - marked-style callbacks; missing ones
 *   default to plain text
 * @returns {Promise<string>}
 */
export async function renderMarkdown(text, renderer = {}) {
  return walkTokens(await lexMarkdown(text), renderer);
}

/**
 * Render one fragment of inline markdown through a renderer's inline
 * callbacks, synchronously, via the builtin tokenizer (engine routing
 * needs whole text — inline fragments don't have it). This is the
 * primitive incremental renderers style complete lines with.
 * @param {string} text - inline markdown (no block structure)
 * @param {object} [renderer] - inline callbacks; missing ones default
 *   to plain text
 * @returns {string}
 */
export function renderInline(text, renderer = {}) {
  return walkInline(spansToTokens(parseInline(text)), completeRenderer(renderer));
}

/** Canonical markdown module namespace. Static-only by design. */
export class Markdown {}
Object.assign(Markdown, {
  parseInline, classifyLine, walkTokens, parseGitDiff,
  markdownEngine, lexMarkdown, renderMarkdown, renderInline,
});
export default Markdown;
