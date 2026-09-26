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
 * cell group). Falls back to code points without Intl.Segmenter.
 * @param {string} text
 * @returns {string[]}
 */
export function graphemes(text) {
  if (text === "") return [];
  if (ASCII_PRINTABLE.test(text)) return text.split("");
  if (!segmenter) return [...text];
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Wide (2-column) code point ranges: CJK, Hangul, fullwidth, emoji. */
function isWide(cp) {
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

/** Zero-width code points: combining marks, format controls, joiners. */
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
 * @param {string} cluster
 * @returns {number}
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
 * @param {string} line
 * @returns {number}
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
 * Tokenize a styled line into SGR sequences and grapheme clusters.
 * @param {string} line
 * @returns {Array<{sgr: string}|{g: string, w: number}>}
 */
export function tokenize(line) {
  const out = [];
  let i = 0;
  let run = "";
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
 * @param {string} line
 * @param {number} width
 * @returns {string[]}
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
 * is on screen.
 * @param {string} line
 * @param {number} width
 * @returns {string[]}
 */
export function wrapWords(line, width) {
  const w = Math.max(1, width);
  if (displayWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= w) return [line];
  const rows = [];
  let row = "", col = 0; // the open visual row (may hold carried SGR at col 0)
  let word = [], wordCol = 0; // the pending word's tokens (breaks only before/after it)
  let active = ""; // the SGR sequence(s) currently in effect (ANSI carry)
  const text = (tokens) => tokens.map((t) => t.sgr ?? t.g).join("");
  const pushRow = () => {
    rows.push(row.replace(/ +$/, "") + (active !== "" ? RESET : ""));
    row = active;
    col = 0;
  };
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
 * @param {string} line - plain text
 * @param {number} width
 * @returns {{text: string, start: number, end: number}[]}
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
 * @param {string} line
 * @param {number} width
 * @returns {{graphemes: string[], width: number}[]}
 */
export function wrapRowsGraphemes(line, width) {
  return wrapWordsOffsets(line, width).map(({ text }) => ({
    graphemes: graphemes(text),
    width: displayWidth(text),
  }));
}
