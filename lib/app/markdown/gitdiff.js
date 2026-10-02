/** Unified Git-diff recognition; internal implementation for Markdown.parseGitDiff. */
const FENCE = String.fromCharCode(96).repeat(3);
const METADATA = ["diff --git ", "index ", "new file mode ", "deleted file mode ", "similarity index ", "rename from ", "rename to "];

/**
 * Test whether a line begins with one of the recognized Git diff metadata prefixes.
 * @param {string} line Line to inspect.
 * @returns {boolean} True when the line is diff metadata.
 */
function startsMetadata(line) { return METADATA.some((prefix) => line.startsWith(prefix)); }

/**
 * Remove a four-character diff header marker and any trailing carriage return.
 * @param {string} line Header line to normalize.
 * @returns {string} Filename text following the marker.
 */
function filename(line) { return line.slice(4).replace(/\r$/, ""); }

/**
 * Parse a unified Git diff, optionally enclosed in a fenced diff block.
 * @param {*} text Input converted to a string; nullish values become an empty string.
 * @returns {object|null} Parsed diff with filenames, edit lines, source-line offsets and add/remove counts, or null when input is not a supported diff. Does not mutate input.
 */
export function parseGitDiff(text) {
  const source = String(text ?? "");
  const firstEnd = source.indexOf("\n");
  const firstLine = firstEnd < 0 ? source : source.slice(0, firstEnd);
  const fenced = firstLine.trim().toLowerCase() === `${FENCE}diff`;
  if (!fenced && !firstLine.startsWith("--- ") && !firstLine.startsWith("diff --git ")) return null;

  const raw = source.split("\n");
  let first = 0;
  let last = raw.length;
  if (fenced) {
    const close = raw.findIndex((line, index) => index > 0 && line.trim() === FENCE);
    if (close < 0 || !raw.slice(close + 1).every((line) => line === "")) return null;
    first = 1;
    last = close;
  }

  let header = first;
  while (header < last && startsMetadata(raw[header])) header++;
  if (!raw[header]?.startsWith("--- ") || !raw[header + 1]?.startsWith("+++ ")) return null;

  const headers = new Set();
  if (fenced) { headers.add(0); headers.add(last); }
  for (let index = first; index < last; index++) {
    if (startsMetadata(raw[index])) headers.add(index);
    if (raw[index].startsWith("--- ") && raw[index + 1]?.startsWith("+++ ")) {
      headers.add(index);
      headers.add(index + 1);
      index++;
    }
  }
  const offsets = [];
  let offset = 0;
  for (const line of raw) { offsets.push(offset); offset += line.length + 1; }
  /**
   * Classify a source line using the known headers and its leading diff marker.
   * @param {string} line Source line text.
   * @param {number} index Zero-based index in the raw source lines.
   * @returns {"fence"|"header"|"hunk"|"add"|"remove"|"context"} The line category.
   */
  const kind = (line, index) => {
    if (headers.has(index)) return fenced && (index === 0 || index === last) ? "fence" : "header";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "remove";
    return "context";
  };
  const sourceLines = raw.map((line, index) => ({ text: line, start: offsets[index], end: offsets[index] + line.length, kind: kind(line, index) }));
  const edits = raw.slice(header + 2, last);
  const bodyKinds = sourceLines.slice(header + 2, last).map((line) => line.kind);
  return {
    type: "gitdiff", aFilename: filename(raw[header]), bFilename: filename(raw[header + 1]),
    totalAdd: bodyKinds.filter((value) => value === "add").length,
    totalRemove: bodyKinds.filter((value) => value === "remove").length,
    lines: edits, sourceLines,
  };
}
