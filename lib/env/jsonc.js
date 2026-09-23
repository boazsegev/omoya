/**
 * lib/env/jsonc.js — JSON-with-comments for settings/auth files
 * (private to Env). `//` line comments and `/* … *\/` block comments
 * are stripped OUTSIDE string literals only — a `"url": "https://…"`
 * value keeps its `//` untouched — then the result is handed to the
 * real JSON.parse (so a parse failure's line/column still refers to
 * real JSON, since only comment BYTES are removed, never shifted).
 * Zero dependencies: JSONC support elsewhere is normally a library
 * (jsonc-parser, strip-json-comments); this is the whole algorithm.
 */

/**
 * @param {string} text
 * @returns {string} `text` with every comment blanked out (newlines
 *   preserved, so line numbers in a subsequent parse error still line up)
 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") { inLineComment = false; out += c; }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") { inBlockComment = false; i++; }
      else if (c === "\n") out += c; // keep line numbers intact
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLineComment = true; i++; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; i++; continue; }
    out += c;
  }
  return out;
}

/**
 * Parse JSON that may contain `//`/`/* *\/` comments outside strings.
 * @param {string} text
 * @returns {*}
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}
