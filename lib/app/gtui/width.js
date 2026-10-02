/**
 * lib/gtui/width.js — display-width math and wrap functions (generic
 * terminal primitive, ported from the retired lib/tui-helpers/width.js).
 *
 * Terminal ROW MATH must count DISPLAY COLUMNS, never string length,
 * and it must count GRAPHEME CLUSTERS, never code points: East-Asian
 * wide/fullwidth characters and emoji occupy 2 columns, tabs expand to
 * the next multiple of 8, combining marks / zero-width characters
 * occupy none — and an emoji built from several code points (a ZWJ
 * family, a skin-tone modifier, a flag pair, a VS16-forced emoji) is
 * ONE 2-column cell. Counting its parts (2+0+2+0+2) would make every
 * erase climb the wrong number of rows — the classic "the display
 * and the text diverge" glitch. Clusters come from Intl.Segmenter
 * (code points are the fallback where it is unavailable).
 */

const RESET = "\x1b[0m";
const SGR = /^\x1b\[[0-9;]*m/;
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/**
 * Split text into grapheme clusters (what the terminal draws as one
 * cell group). Returns an empty array for empty input, uses an ASCII
 * fast path for printable text, and falls back to code points when
 * Intl.Segmenter is unavailable.
 * @param {string} text - Input text; required, with no default.
 * @returns {string[]} Grapheme clusters in source order.
 * @effects None; does not modify the input.
 */
export function graphemes(text) {
  if (text === "") return [];
  if (ASCII_PRINTABLE.test(text)) return text.split("");
  if (!segmenter) return [...text];
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Default-emoji-presentation BMP/SMP symbols outside the pictograph block
 *  (Unicode East_Asian_Width=W: ✅ ❌ ⭐ ⚡ ⌛ ☕ ❗ ➕ 🀄 🈚 …). Terminals draw
 *  them 2 columns wide; counting 1 shifted the rest of the row right, so the
 *  last glyph landed in a cell the diff renderer believed blank and never
 *  cleared (a trail of repeated last letters while scrolling). */
const WIDE_SYMBOLS = [
  [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
  [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265],
];

/**
 * Test whether a Unicode code point belongs to the supported wide ranges.
 * @param {number} cp - Unicode code point value; required, with no default.
 * @returns {boolean} Whether the code point is treated as two columns.
 * @effects None; reads the module's immutable range table.
 */
function isWide(cp) {
  if (cp >= 0x231a && cp <= 0x2b55 || cp >= 0x1f004 && cp <= 0x1f265) {
    for (const [low, high] of WIDE_SYMBOLS) if (cp >= low && cp <= high) return true;
  }
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … Ideographic Desc.
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi Syllables
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B and beyond
  );
}

/**
 * Test whether a Unicode code point is treated as zero-width.
 * @param {number} cp - Unicode code point value; required, with no default.
 * @returns {boolean} Whether the code point is treated as zero columns.
 * @effects None.
 */
function isZeroWidth(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP, ZWNJ, ZWJ, marks
    (cp >= 0x202a && cp <= 0x202e) || // bidi controls
    (cp >= 0x2060 && cp <= 0x2064) || // word joiner & co.
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // emoji skin-tone modifiers
    (cp >= 0xe0020 && cp <= 0xe007f) || // tag characters (subdivision flags)
    cp === 0xfeff // BOM / zero-width no-break space
  );
}

/**
 * Display columns of ONE grapheme cluster: 0 for controls and
 * zero-width clusters, 2 for wide/emoji clusters (a VS16 emoji
 * presentation selector or a regional-indicator pair forces 2), 1
 * otherwise. Tabs are measured by displayWidth (they depend on the
 * column).
 * @param {string} cluster - One grapheme cluster; required, with no default.
 * @returns {number} Display columns (0, 1, or 2).
 * @effects None; does not modify the cluster.
 */
export function graphemeWidth(cluster) {
  let width = 0;
  let vs16 = false;
  let regional = 0;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f) { vs16 = true; continue; }
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) { regional++; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // controls
    if (isZeroWidth(cp)) continue;
    width = Math.max(width, isWide(cp) ? 2 : 1);
  }
  if (regional > 0) return regional >= 2 ? 2 : 1;
  if (vs16 && width > 0) return 2;
  return width;
}

/**
 * Display column width of a line (grapheme clusters; tabs expand to
 * the next tab stop; controls count zero). SGR sequences are NOT
 * stripped here — measure styled text through wrapWords/wrapByWidth
 * or strip it first.
 * @param {string} line - Input line; required, with no default.
 * @returns {number} Display columns, with tabs expanded to 8-column stops.
 * @effects None; does not modify the line. SGR escapes are counted as text.
 */
export function displayWidth(line) {
  if (ASCII_PRINTABLE.test(line)) return line.length; // the common case
  let col = 0;
  for (const g of graphemes(line)) {
    if (g === "\t") { col += 8 - (col % 8); continue; } // tab stops
    col += graphemeWidth(g);
  }
  return col;
}

/**
 * Tokenize a styled line into SGR sequences and grapheme clusters. Tabs
 * are represented as grapheme tokens with width 1 for wrapping to handle.
 * @param {string} line - Styled input line; required, with no default.
 * @returns {Array<{sgr: string}|{g: string, w: number}>} Tokens in source order.
 * @effects None; does not modify the line. Recognizes only the module's SGR pattern.
 */
export function tokenize(line) {
  const out = [];
  let i = 0;
  let run = "";
  /**
   * Emit pending text as grapheme tokens and clear the local run buffer.
   * @returns {void}
   * @effects Appends tokens to the enclosing output array and clears run.
   */
  const flush = () => {
    if (run === "") return;
    for (const g of graphemes(run)) out.push({ g, w: g === "\t" ? 1 : graphemeWidth(g) });
    run = "";
  };
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      const sgr = SGR.exec(line.slice(i));
      if (sgr) {
        flush();
        out.push({ sgr: sgr[0] });
        i += sgr[0].length;
        continue;
      }
    }
    run += line[i];
    i++;
  }
  flush();
  return out;
}

/**
 * Split a line into terminal-width visual rows by DISPLAY columns
 * (grapheme clusters never split; no word awareness — see wrapWords).
 * @param {string} line - Input line; required, with no default.
 * @param {number} width - Maximum display columns per row; required, with no default.
 * @returns {string[]} Visual rows in source order; an over-wide cluster is kept intact.
 * @effects None; does not modify the input. Does not interpret SGR specially.
 */
export function wrapByWidth(line, width) {
  if (displayWidth(line) <= width) return [line];
  const rows = [];
  let current = "";
  let col = 0;
  for (const g of graphemes(line)) {
    const w = graphemeWidth(g);
    if (col + w > width && current !== "") {
      rows.push(current);
      current = "";
      col = 0;
    }
    current += g;
    col += w;
  }
  if (current !== "") rows.push(current);
  return rows.length > 0 ? rows : [line];
}

/**
 * Word-aware wrap — THE line-breaking function: rows break at word
 * boundaries (spaces), never mid-word. A word longer than the width
 * still hard-breaks (nothing else fits); a break consumes the
 * boundary space and trailing spaces of a broken row are dropped.
 * ANSI-aware: SGR sequences are zero-width, a cut row closes with
 * RESET, and the active style re-opens on the next row (styles
 * neither bleed nor vanish across a wrap). Drawing AND row math both
 * derive from this function, so what is measured is exactly what
 * is on screen. Widths below 1 are clamped to 1. An empty input returns
 * one empty row; no external state is changed.
 * @param {string} line - Styled or plain input line; required, with no default.
 * @param {number} width - Requested maximum display columns; required, with no default.
 * @returns {string[]} Display rows in order, preserving SGR and balancing wrapped styles.
 * @effects None; does not modify the input. SGR tokenization follows tokenize().
 */
export function wrapWords(line, width) {
  const w = Math.max(1, width);
  if (displayWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= w) return [line];
  const rows = [];
  let row = "", col = 0; // the open visual row (may hold carried SGR at col 0)
  let word = [], wordCol = 0; // the pending word's tokens (breaks only before/after it)
  let active = ""; // the SGR sequence(s) currently in effect (ANSI carry)
  /**
   * Reconstruct source text from a token list, retaining SGR sequences.
   * @param {Array<{sgr: string}|{g: string, w: number}>} tokens - Tokens to concatenate; required, with no default.
   * @returns {string} Concatenated SGR sequences and grapheme text.
   * @effects None; does not modify tokens.
   */
  const text = (tokens) => tokens.map((t) => t.sgr ?? t.g).join("");
  /**
   * Finish the current row, trim its trailing spaces, and carry active SGR.
   * @returns {void}
   * @effects Appends the finished row and updates the enclosing row and column state.
   */
  const pushRow = () => {
    rows.push(row.replace(/ +$/, "") + (active !== "" ? RESET : ""));
    row = active;
    col = 0;
  };
  /**
   * Place the pending word, wrapping it when required, then clear its buffer.
   * @returns {void}
   * @effects Updates enclosing row, column, pending-word, and output-row state.
   */
  const placeWord = () => {
    if (word.length === 0) return;
    if (col + wordCol <= w) {
      row += text(word);
      col += wordCol;
    } else {
      if (col > 0) pushRow(); // the word moves whole onto a fresh row
      if (wordCol <= w) {
        row += text(word);
        col = wordCol;
      } else {
        // the word alone exceeds the width: a mid-word break is
        // unavoidable — chunk it, SGR tokens riding along zero-width
        let chunk = "", ccol = 0;
        for (const t of word) {
          if (t.sgr) { chunk += t.sgr; continue; }
          if (ccol + t.w > w && chunk !== "") {
            rows.push(chunk + (active !== "" ? RESET : ""));
            chunk = active;
            ccol = 0;
          }
          chunk += t.g;
          ccol += t.w;
        }
        row = chunk;
        col = ccol;
      }
    }
    word = [];
    wordCol = 0;
  };
  for (const t of tokenize(line)) {
    if (t.sgr) {
      // flush the pending word first: a trailing SGR semantically
      // follows the word (a span's closing RESET belongs AFTER it),
      // so the break decision sees the style state at the cut point
      placeWord();
      active = t.sgr === RESET || t.sgr === "\x1b[m" ? "" : active + t.sgr;
      row += t.sgr;
      continue;
    }
    if (t.g === " ") {
      placeWord();
      if (col + 1 > w) pushRow(); // the boundary space is consumed by the break
      else { row += " "; col += 1; }
      continue;
    }
    word.push(t);
    wordCol += t.w;
  }
  placeWord();
  // unlike an intermediate pushRow() (a wrap-boundary trim — those
  // spaces are consumed by the break, never drawn), the FINAL row is
  // the true end of the line: trailing spaces here are content the
  // user actually typed and must stay, exactly like the short-line
  // fast path above keeps them — otherwise wrapWordsOffsets loses the
  // tail entirely (no row covers those indexes) and a cursor stalls
  // short of a space it just inserted.
  rows.push(row);
  return rows;
}

/**
 * wrapWords() for PLAIN text (no SGR), also reporting each row's
 * [start, end) character offset within the original line — cursor
 * math needs exact offsets, which wrapWords alone (styled-text
 * display, no reverse mapping) doesn't report. A row's `text`
 * excludes the boundary space that caused the break (still counted,
 * via the offset, as consumed by it).
 * @param {string} line - Plain input text (no SGR); required, with no default.
 * @param {number} width - Requested row width, clamped by wrapWords to at least 1; required, with no default.
 * @returns {{text: string, start: number, end: number}[]} Rows and their [start, end) UTF-16 offsets; a consumed boundary space is outside the row's range.
 * @effects None; does not modify the input.
 */
export function wrapWordsOffsets(line, width) {
  const parts = wrapWords(line, width);
  const rows = [];
  let pos = 0;
  for (const text of parts) {
    const start = line.indexOf(text, pos);
    const end = start + text.length;
    rows.push({ text, start, end });
    pos = line[end] === " " ? end + 1 : end;
  }
  return rows;
}

/**
 * Plain-text word wrapping as display-ready grapheme rows. The grapheme
 * arrays let structured renderers retain their own source-token metadata
 * while sharing the terminal's one word-boundary policy.
 * @param {string} line - Plain input text; required, with no default.
 * @param {number} width - Requested row width, clamped by wrapWords to at least 1; required, with no default.
 * @returns {{graphemes: string[], width: number}[]} Rows as grapheme arrays with their display-column widths.
 * @effects None; does not modify the input.
 */
export function wrapRowsGraphemes(line, width) {
  return wrapWordsOffsets(line, width).map(({ text }) => ({
    graphemes: graphemes(text),
    width: displayWidth(text),
  }));
}
