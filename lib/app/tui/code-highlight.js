/**
 * lib/app/tui/code-highlight.js — a deliberately minimal, line-local code
 * highlighter for fenced blocks. One tokenizer for every language: line
 * comments, single-line block comments, quoted strings, numbers, and one
 * shared keyword set. No per-language grammars and no state across lines
 * (a multi-line string or comment simply isn't colored past its first line).
 *
 * It introduces no theme keys: each token kind maps onto a role every theme
 * already styles, so all themes pick it up as they are.
 */

/** Token kind -> existing theme role (layered over the code line's own role). */
export const HIGHLIGHT_ROLE = Object.freeze({ keyword: "accent", comment: "muted", string: "md.em", number: "md.strong" });

/** Fences that are output, prose, or already colored (diff) stay plain. */
const PLAIN = new Set(["", "text", "txt", "plain", "plaintext", "log", "output", "console", "diff", "patch", "markdown", "md"]);
/** Languages whose line comment is `#` rather than `//`. */
const HASH_COMMENT = new Set(["sh", "bash", "zsh", "shell", "fish", "py", "python", "rb", "ruby", "yaml", "yml", "toml", "make", "makefile", "dockerfile", "perl", "r", "conf", "ini", "nix"]);
/** Languages whose line comment is `--`. */
const DASH_COMMENT = new Set(["sql", "lua", "haskell", "hs", "elm"]);

const KEYWORDS = new Set(`
  if else elif elsif unless for while do loop until break continue return yield
  function fn func def lambda class struct enum union interface trait impl type typedef
  const let var mut static pub public private protected extern inline volatile
  import export from package use mod module require include define
  new delete this self super null nil None true false True False undefined void
  try catch finally throw raise except rescue ensure defer go async await
  switch case default match when in of is as and or not then end fi esac done
  local echo select where with begin
  join insert into update create table values group order by limit
`.trim().split(/\s+/));

const TOKEN = /(\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)|([A-Za-z_][\w]*)/g;

/**
 * Find syntax-highlight ranges in one line using the shared, language-light tokenizer.
 * Plain/output/prose/diff fences return no ranges. Recognized tokens are comments,
 * strings, numbers, and shared keywords; a line comment colors the remainder of
 * the line. Highlighting is line-local and does not parse or validate source code.
 *
 * @param {string} line - Source line to scan; expected to be a string.
 * @param {string} [lang=""] - Fence info string; only its first whitespace-delimited
 *   word is used (case-insensitively). Defaults to the empty string, treated as plain.
 * @returns {Array<{start: number, end: number, kind: string}>} Sorted, non-overlapping
 *   ranges with zero-based, end-exclusive offsets into `line`; `kind` is `keyword`,
 *   `comment`, `string`, or `number`.
 * @throws {TypeError} If `line` is not a string and cannot be processed by string
 *   methods. `lang` is coerced with `String`, so coercion may itself throw.
 * @effects Resets and consumes the module-level global TOKEN regular expression's
 *   `lastIndex`; it is reset to zero before scanning. Does not mutate `line` or `lang`.
 */
export function highlightLine(line, lang = "") {
  const language = String(lang).trim().split(/\s+/)[0].toLowerCase();
  if (PLAIN.has(language)) return [];
  const caseless = language === "sql";
  const marker = HASH_COMMENT.has(language) ? "#" : DASH_COMMENT.has(language) ? "--" : "//";
  const ranges = [];
  let comment = line.length;
  TOKEN.lastIndex = 0;
  for (let match; (match = TOKEN.exec(line)) !== null;) {
    // A line comment starts at the first marker outside a string/block comment.
    const before = line.indexOf(marker, ranges.at(-1)?.end ?? 0);
    if (before !== -1 && before < match.index) { comment = before; break; }
    const [text, block, string, number, word] = match;
    const kind = block ? "comment" : string ? "string" : number ? "number" : word && KEYWORDS.has(caseless ? word.toLowerCase() : word) ? "keyword" : null;
    if (kind) ranges.push({ start: match.index, end: match.index + text.length, kind });
  }
  if (comment === line.length) {
    const tail = line.indexOf(marker, ranges.at(-1)?.end ?? 0);
    if (tail !== -1) comment = tail;
  }
  if (comment < line.length) ranges.push({ start: comment, end: line.length, kind: "comment" });
  return ranges;
}
