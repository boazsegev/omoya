/**
 * lib/markdown/walk.js — the token walker (private to Markdown):
 * walk marked-shaped tokens (from `marked`'s lexer OR the builtin
 * lexer — same shapes) through a renderer's callbacks, marked-style:
 * inline callbacks receive and return strings, block callbacks
 * receive their already-rendered inner text and return strings,
 * blocks join with ONE "\n", inline spans join with "".
 *
 * Every callback is optional — completeRenderer fills the missing
 * ones with plain-text defaults, so a renderer implements only what
 * it styles.
 */

import { mathText } from "./math.js";

/**
 * Return a value unchanged.
 * @param {*} x - value to return
 * @returns {*} the same value
 */
const identity = (x) => x;

/**
 * Create a renderer with plain-text defaults for every supported callback.
 * Supplied renderer properties override defaults, except tableRow/tableCell
 * are normalized from either camelCase or marked's lowercase spellings.
 * @param {object} [renderer={}] - renderer callbacks; omitted callbacks use defaults
 * @returns {object} a total renderer suitable for walkInline and walkTokens
 * @throws {TypeError} if renderer is null, because its callback aliases are read
 */
export function completeRenderer(renderer = {}) {
  const tableRow = renderer.tableRow ?? renderer.tablerow ?? identity;
  const tableCell = renderer.tableCell ?? renderer.tablecell ?? identity;
  return {
    text: identity,
    strong: identity,
    em: identity,
    /** Format code-span text with literal backticks. @param {string} t - code-span text @returns {string} formatted code span */
    codespan: (t) => `\`${t}\``,
    /** Render inline math from its parsed tree, ignoring the source text. @param {string} _text - original math source @param {*} tree - parsed math tree @returns {string} rendered math */
    mathInline: (_text, tree) => mathText(tree),
    /** Render block math from its parsed tree, ignoring the source text. @param {string} _text - original math source @param {*} tree - parsed math tree @returns {string} rendered math */
    mathBlock: (_text, tree) => mathText(tree),
    /** Format link text with its destination. @param {string} t - rendered link text @param {string} href - link destination @returns {string} formatted link */
    link: (t, href) => `${t} (${href})`,
    /** Render a line break as one newline. @returns {string} newline */
    br: () => "\n",
    heading: identity,
    code: identity,
    blockquote: identity,
    list: identity,
    listItem: identity,
    /** Join nonempty table sections with one newline. @param {string} header - rendered header @param {string} body - rendered body @returns {string} table output */
    table: (header, body) => [header, body].filter(Boolean).join("\n"),
    tableRow,
    tableCell,
    // marked Renderer spelling, retained alongside Omoya's camelCase API.
    tablerow: tableRow,
    tablecell: tableCell,
    paragraph: identity,
    /** Omit a horizontal rule in plain-text output. @returns {string} empty string */
    hr: () => "",
    /** Omit a spacing token in plain-text output. @returns {string} empty string */
    space: () => "",
    /** Return rendered diff lines unchanged. @param {*} _a - source filename, unused @param {*} _b - destination filename, unused @param {*} _added - addition count, unused @param {*} _removed - removal count, unused @param {string} body - rendered diff body @returns {string} body */
    gitdiff: (_a, _b, _added, _removed, body) => body,
    gitdiffAdd: identity,
    gitdiffRemove: identity,
    gitdiffEdit: identity,
    ...renderer,
    tableRow,
    tableCell,
  };
}

/**
 * Render inline tokens through a complete renderer, recursively rendering
 * nested token arrays and concatenating their results without separators.
 * @param {Array<object>|null|undefined} tokens - marked-shaped inline tokens; nullish input is treated as empty
 * @param {object} r - complete renderer whose callbacks receive token data and rendered child text
 * @returns {string} concatenated inline output
 * @throws {TypeError} if tokens is not an array, a token is nullish, r lacks a required callback, or a callback throws
 */
export function walkInline(tokens, r) {
  return (tokens ?? []).map(/** Render an inline token, recursively rendering nested tokens. @param {object} t @returns {string} rendered token */(t) => {
    switch (t.type) {
      case "strong": return r.strong(walkInline(t.tokens, r), t);
      case "em": return r.em(walkInline(t.tokens, r), t);
      case "codespan": return r.codespan(t.text ?? "", t);
      case "math_inline": return r.mathInline(t.text ?? "", t.tree, t);
      case "link": return r.link(walkInline(t.tokens, r), t.href ?? "", t);
      case "br": return r.br(t);
      case "escape": return r.text(t.text ?? "", t);
      default:
        // text tokens may carry nested inline tokens (marked's tight
        // list items); anything unrecognized passes its raw through
        return t.tokens ? walkInline(t.tokens, r) : r.text(t.text ?? "", t);
    }
  }).join("");
}

/**
 * Render marked-shaped block tokens, completing missing renderer callbacks
 * with plain-text defaults. Nested block and inline content is rendered
 * recursively; top-level block results are joined with one newline.
 * List and table callbacks receive normalized item/cell metadata, and gitdiff
 * callbacks receive per-line classifications before the enclosing callback.
 * @param {Array<object>|null|undefined} tokens - block tokens; nullish input is treated as empty
 * @param {object} [renderer={}] - renderer callbacks; missing callbacks use plain-text defaults
 * @returns {string} rendered block output
 * @throws {TypeError} if tokens is not an array, a token is nullish, or a renderer callback throws
 */
export function walkTokens(tokens, renderer = {}) {
  const r = completeRenderer(renderer);
  return (tokens ?? []).map(/** Render a block token and its nested content. @param {object} t @returns {string} rendered block */(t) => {
    switch (t.type) {
      case "heading": return r.heading(walkInline(t.tokens, r), t.depth ?? 1, t);
      case "code": return r.code(t.text ?? "", t.lang ?? "", t);
      case "math_block": return r.mathBlock(t.text ?? "", t.tree, t);
      case "blockquote": return r.blockquote(walkTokens(t.tokens, r), t);
      case "list": {
        const ordered = Boolean(t.ordered);
        const base = Number.parseInt(t.start, 10) || 1;
        const body = (t.items ?? []).map(/** Render one list item with normalized metadata. @param {object} item @param {number} i @returns {string} rendered item */(item, i) => r.listItem(walkInline(item.tokens, r), {
          ordered: item.ordered ?? ordered,
          marker: item.marker, // the builtin lexer carries the SOURCE marker
          indent: item.indent ?? "",
          number: base + i,
        }, item)).join("\n");
        return r.list(body, { ordered, start: t.start }, t);
      }
      case "table": {
        const row = /** Render a table row and its cells. @param {Array<object>} cells @param {boolean} header @returns {string} rendered row */(cells, header) => r.tableRow((cells ?? []).map(/** Render a cell with alignment metadata. @param {object} cell @param {number} index @returns {string} rendered cell */(cell, index) => {
          const tokens = cell?.tokens ?? (typeof cell?.text === "string" ? [{ type: "text", text: cell.text }] : []);
          return r.tableCell(walkInline(tokens, r), { header, align: t.align?.[index] ?? null, index }, cell);
        }).join(""), { header }, cells);
        const header = row(t.header, true);
        const body = (t.rows ?? []).map(/** Render one table body row. @param {Array<object>} cells @returns {string} rendered row */(cells) => row(cells, false)).join("\n");
        return r.table(header, body, t);
      }
      case "hr": return r.hr(t.width, t); // width: builtin carries the source's
      case "space": return r.space(t);
      case "gitdiff": {
        const body = (t.lines ?? []).map(/** Dispatch a diff line to the add, remove, or edit callback. @param {string} line @returns {string} rendered line */(line) => line.startsWith("+")
          ? r.gitdiffAdd(line, t)
          : line.startsWith("-") ? r.gitdiffRemove(line, t) : r.gitdiffEdit(line, t)).join("\n");
        return r.gitdiff(t.aFilename, t.bFilename, t.totalAdd, t.totalRemove, body, t);
      }
      case "paragraph": return r.paragraph(walkInline(t.tokens, r), t);
      default: return t.tokens ? walkInline(t.tokens, r) : r.text(t.text ?? "", t);
    }
  }).join("\n");
}
