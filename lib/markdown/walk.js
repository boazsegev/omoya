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

const identity = (x) => x;

/**
 * Fill a renderer's missing callbacks with plain-text defaults.
 * @param {object} [renderer]
 * @returns {object} a total renderer
 */
export function completeRenderer(renderer = {}) {
  const tableRow = renderer.tableRow ?? renderer.tablerow ?? identity;
  const tableCell = renderer.tableCell ?? renderer.tablecell ?? identity;
  return {
    text: identity,
    strong: identity,
    em: identity,
    codespan: (t) => `\`${t}\``,
    link: (t, href) => `${t} (${href})`,
    br: () => "\n",
    heading: identity,
    code: identity,
    blockquote: identity,
    list: identity,
    listItem: identity,
    table: (header, body) => [header, body].filter(Boolean).join("\n"),
    tableRow,
    tableCell,
    // marked Renderer spelling, retained alongside Omoya's camelCase API.
    tablerow: tableRow,
    tablecell: tableCell,
    paragraph: identity,
    hr: () => "",
    space: () => "",
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
 * Walk inline tokens through a COMPLETE renderer (use
 * completeRenderer first, or renderInline for raw text).
 * @param {Array<object>} tokens
 * @param {object} r - a complete renderer
 * @returns {string}
 */
export function walkInline(tokens, r) {
  return (tokens ?? []).map((t) => {
    switch (t.type) {
      case "strong": return r.strong(walkInline(t.tokens, r), t);
      case "em": return r.em(walkInline(t.tokens, r), t);
      case "codespan": return r.codespan(t.text ?? "", t);
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
 * Walk block tokens through a renderer (completed internally).
 * @param {Array<object>} tokens - marked-shaped block tokens
 * @param {object} [renderer] - callbacks; missing ones default to plain text
 * @returns {string}
 */
export function walkTokens(tokens, renderer = {}) {
  const r = completeRenderer(renderer);
  return (tokens ?? []).map((t) => {
    switch (t.type) {
      case "heading": return r.heading(walkInline(t.tokens, r), t.depth ?? 1, t);
      case "code": return r.code(t.text ?? "", t.lang ?? "", t);
      case "blockquote": return r.blockquote(walkTokens(t.tokens, r), t);
      case "list": {
        const ordered = Boolean(t.ordered);
        const base = Number.parseInt(t.start, 10) || 1;
        const body = (t.items ?? []).map((item, i) => r.listItem(walkInline(item.tokens, r), {
          ordered: item.ordered ?? ordered,
          marker: item.marker, // the builtin lexer carries the SOURCE marker
          indent: item.indent ?? "",
          number: base + i,
        }, item)).join("\n");
        return r.list(body, { ordered, start: t.start }, t);
      }
      case "table": {
        const row = (cells, header) => r.tableRow((cells ?? []).map((cell, index) => {
          const tokens = cell?.tokens ?? (typeof cell?.text === "string" ? [{ type: "text", text: cell.text }] : []);
          return r.tableCell(walkInline(tokens, r), { header, align: t.align?.[index] ?? null, index }, cell);
        }).join(""), { header }, cells);
        const header = row(t.header, true);
        const body = (t.rows ?? []).map((cells) => row(cells, false)).join("\n");
        return r.table(header, body, t);
      }
      case "hr": return r.hr(t.width, t); // width: builtin carries the source's
      case "space": return r.space(t);
      case "gitdiff": {
        const body = (t.lines ?? []).map((line) => line.startsWith("+")
          ? r.gitdiffAdd(line, t)
          : line.startsWith("-") ? r.gitdiffRemove(line, t) : r.gitdiffEdit(line, t)).join("\n");
        return r.gitdiff(t.aFilename, t.bFilename, t.totalAdd, t.totalRemove, body, t);
      }
      case "paragraph": return r.paragraph(walkInline(t.tokens, r), t);
      default: return t.tokens ? walkInline(t.tokens, r) : r.text(t.text ?? "", t);
    }
  }).join("\n");
}
