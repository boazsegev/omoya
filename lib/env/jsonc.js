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
 * Remove `//` line comments and block comments outside JSON
 * string literals, replacing comment bytes with nothing while preserving
 * newline characters. String contents, including escaped quotes and slashes,
 * are retained. Unterminated comments are consumed through end of input.
 *
 * @param {string} text JSONC source text; required, with no default.
 * @returns {string} Comment-stripped text. This function does not mutate the
 *   input and does not parse or validate the resulting JSON.
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
 * Parse JSONC containing `//` line comments and block comments
 * outside string literals by stripping comments and passing the result to
 * `JSON.parse`.
 *
 * @param {string} text JSONC source text; required, with no default.
 * @returns {*} The parsed JSON value (object, array, string, number, boolean,
 *   or `null`); no Promise is returned.
 * @throws {SyntaxError} If the comment-stripped text is not valid JSON;
 *   parse error positions retain their original line numbers because
 *   newlines in comments are preserved.
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}
