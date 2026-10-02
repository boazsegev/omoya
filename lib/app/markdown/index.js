/**
 * lib/app/markdown/index.js — App.Markdown: markdown STRUCTURE for any render
 * target, presentation-free.
 *
 * This module depends on no other library code. App.TUI, App.Web, and
 * external hosts can use its public functions.
 *
 * The interface is `marked`-style CALLBACKS: a renderer is an object
 * of string-in/string-out functions — inline: text, strong, em,
 * codespan, link, br, mathInline; block: heading, code, mathBlock, blockquote, list,
 * listItem, table, tableRow/tableCell (or marked's tablerow/tablecell),
 * paragraph, hr, space — every one optional (missing ones
 * default to plain text). Whole-text tokenization routes internally:
 * the optional `marked` package's lexer when it resolves (a guarded
 * dynamic import in lib/app/markdown/marked.js), or the builtin lexer
 * (lib/app/markdown/lexer.js). Both produce the marked-shaped tokens
 * accepted by the same walker (lib/app/markdown/walk.js), so renderers
 * receive the same token contract from either engine. Dollar-bearing text
 * uses the builtin lexer for consistent math boundaries.
 *
 * Render targets hook in two ways:
 *   - whole text: renderMarkdown(text, renderer) — async (the marked
 *     import is), engine-routed;
 *   - incrementally (a still-growing stream, where marked's
 *     whole-text requirement can't apply): classifyLine() per
 *     complete line + renderInline() for the inline spans — the
 *     builtin engine's own primitives, synchronous.
 */

import { parseInline, spansToTokens } from "./inline.js";
import { classifyLine } from "./line.js";
import { lexBuiltin } from "./lexer.js";
import { loadMarked } from "./marked.js";
import { completeRenderer, walkInline, walkTokens } from "./walk.js";
import { parseGitDiff as parseGitDiffInternal } from "./gitdiff.js";
import { sanitizeText, BashSanitizer } from "./text-safe.js";
import { parseMath, mathText, mathBlockAt } from "./math.js";

export { parseInline, classifyLine, walkTokens, sanitizeText, BashSanitizer, parseMath, mathText, mathBlockAt };

/**
 * Parse one complete unified Git diff synchronously, with exact source-line spans.
 * @param {string} text - Source text; coerced to a string by the parser.
 * @returns {object|null} The Git-diff token, or `null` when the text is not a complete recognized diff.
 * @throws {TypeError} If converting `text` to a string fails.
 */
export function parseGitDiff(text) { return parseGitDiffInternal(text); }

/**
 * Determine which engine whole-text rendering routes through, lazily loading and caching optional-engine availability.
 * @returns {Promise<"marked"|"builtin">} Resolves to `"marked"` when the optional package is available, or `"builtin"` otherwise; import failure selects `"builtin"`.
 */
export async function markdownEngine() {
  return (await loadMarked()) ? "marked" : "builtin";
}

/**
 * Tokenize complete markdown text. A unified Git diff is detected first
 * and returned as its own single token (see parseGitDiff); otherwise
 * `marked`'s lexer (gfm, breaks) runs when available without math
 * delimiters; otherwise the builtin lexer handles math. Same token shapes for walkTokens.
 * @param {string} text - Complete markdown source; nullish values are coerced to an empty string at runtime.
 * @returns {Promise<Array<object>>} Resolves to marked-shaped block tokens; recognized unified Git diffs are returned as a single token.
 * @throws {Error} Rejects if engine loading or tokenization fails.
 */
export async function lexMarkdown(text) {
  const source = String(text ?? "");
  const gitdiff = parseGitDiff(source);
  if (gitdiff) return [gitdiff];
  const marked = await loadMarked();
  // marked does not know math; route math-delimiter candidates through
  // the builtin lexer so TeX commands, code and boundaries agree.
  if (marked && !source.includes("$") && !source.includes("\\[")) return marked.lexer(source, { gfm: true, breaks: true });
  return lexBuiltin(source);
}

/**
 * Render complete markdown text through a renderer's callbacks,
 * engine-routed (see lexMarkdown). Rendered tokens join with one
 * "\n"; source blank lines are space tokens, so one blank line remains
 * one blank line in the output.
 * @param {string} text - Complete markdown source passed to {@link lexMarkdown}.
 * @param {object} [renderer={}] - Marked-style callbacks; missing callbacks default to plain text.
 * @returns {Promise<string>} Resolves to rendered output with tokens joined by newlines.
 * @throws {Error} Rejects if tokenization or rendering fails.
 */
export async function renderMarkdown(text, renderer = {}) {
  return walkTokens(await lexMarkdown(text), renderer);
}

/**
 * Render one fragment of inline markdown through a renderer's inline
 * callbacks, synchronously, via the builtin tokenizer (engine routing
 * needs whole text — inline fragments don't have it). This is the
 * primitive incremental renderers style complete lines with.
 * @param {string} text - Inline markdown (no block structure).
 * @param {object} [renderer={}] - Inline callbacks; missing callbacks default to plain text.
 * @returns {string} The synchronously rendered inline fragment.
 * @throws {Error} Propagates errors thrown during parsing or by renderer callbacks.
 */
export function renderInline(text, renderer = {}) {
  return walkInline(spansToTokens(parseInline(text)), completeRenderer(renderer));
}

/** Canonical markdown module namespace. Static-only by design. */
export class Markdown {}
Object.assign(Markdown, {
  parseInline, classifyLine, walkTokens, parseGitDiff,
  markdownEngine, lexMarkdown, renderMarkdown, renderInline,
  sanitizeText, BashSanitizer, parseMath, mathText, mathBlockAt,
});
export default Markdown;
