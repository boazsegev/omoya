/**
 * tools/read/grep.js — INTERNAL helper of the `read` tool (never a
 * tool itself: the scan is not recursive). The grep-like search used
 * by file reads: over a (possibly pre-narrowed) text, or over every
 * file of a folder listing.
 *
 * The matching core is ONE global, multiline regular expression run
 * against the WHOLE text — a cheap full-file test answers "no match"
 * without ever splitting lines, and each match maps to its LINE RANGE
 * (first–last line the match spans) rather than a single line: the
 * report prints every line a match touches, and the range structure
 * is where future context (N lines before/after) attaches. Overlaps
 * merge, so one line is never printed twice.
 */

import { readFile } from "node:fs/promises";
import { intArg } from "./util.js";

export const DEFAULT_MAX_MATCHES = 100;

/** Compile the user pattern; a bad pattern is an ordinary error. */
function compile(pattern, ignoreCase) {
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    throw new Error("Invalid pattern. Use a valid regular expression.");
  }
}

/** The global/multiline twin of the user pattern for whole-text runs. */
function globalize(pattern, ignoreCase) {
  return new RegExp(pattern, `gm${ignoreCase ? "i" : ""}`);
}

/**
 * The 0-based line index containing a character offset, advancing a
 * running cursor — callers scan offsets in ascending order, so
 * counting stays O(text) overall instead of O(matches × text).
 */
function lineAt(text, offset, cursor) {
  let { line, offset: scanned } = cursor;
  for (; scanned < offset; scanned++) if (text[scanned] === "\n") line++;
  return { line, offset };
}

/**
 * Match line ranges over a whole text. A zero-length match counts the
 * line it sits on; a match spanning newlines reports every line it
 * touches. The empty text never matches (a split would invent a
 * phantom empty line).
 * @returns {{ranges: Array<{first: number, last: number}>, total: number}}
 *   0-based inclusive line ranges (unmerged, ascending) and their count
 */
export function matchLineRanges(text, pattern, ignoreCase) {
  const re = globalize(pattern, ignoreCase);
  const ranges = [];
  const last = text.length - 1;
  let cursor = { line: 0, offset: 0 }; // 0-based line of cursor.offset
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = lineAt(text, match.index, cursor);
    const endOffset = Math.min(match.index + match[0].length - 1, last);
    const end = lineAt(text, endOffset, start);
    ranges.push({ first: start.line, last: end.line });
    cursor = end;
    if (match[0] === "") re.lastIndex++; // zero-length matches must not loop
    if (re.lastIndex > text.length) break;
  }
  return { ranges, total: ranges.length };
}

/**
 * grep-like search over a text: matching lines with line numbers.
 * @param {string} text
 * @param {Object} options
 * @param {string} options.pattern - regular expression
 * @param {boolean} [options.ignoreCase]
 * @param {number} [options.maxMatches] - caps PRINTED lines (a match
 *   spanning lines prints them all); the total counts matches
 * @param {string} options.path - shown in the header/no-match line
 * @param {string[]} [options.lines] - pre-narrowed lines (line range)
 * @param {number} [options.lineOffset] - first line number of `lines`
 * @param {string} [options.header] - prepended to a match report
 * @param {Object} [options.stats] - receives {matches} (info:true)
 * @returns {string} the match report or a no-match line
 */
export function grep(text, { pattern, ignoreCase, maxMatches, path, lines, lineOffset = 1, header = "", stats } = {}) {
  compile(pattern, ignoreCase); // validate before any scanning
  const cap = intArg(maxMatches ?? DEFAULT_MAX_MATCHES, "maxMatches", 1);
  const flags = ignoreCase ? "i" : "";
  const all = lines ?? text.split("\n");
  // the full-text test first: a file without a match never splits/scans
  const { ranges, total } = matchLineRanges(all.join("\n"), pattern, ignoreCase);
  if (total === 0) {
    if (stats) stats.matches = 0;
    return `grep: no matches for /${pattern}/${flags} in ${path}`;
  }
  if (stats) stats.matches = total;
  const found = [];
  let lastPrinted = -1; // 0-based; overlapping ranges print a line once
  for (const range of ranges) {
    if (found.length >= cap) break;
    for (let i = Math.max(range.first, lastPrinted + 1); i <= range.last && found.length < cap; i++) {
      found.push(`${lineOffset + i}: ${all[i]}`);
      lastPrinted = i;
    }
  }
  const note = total > cap ? `, showing first ${cap}` : "";
  return `grep ${path} /${pattern}/${flags} (${total}${note}):\n${header}${found.join("\n")}`;
}

/**
 * grep-like search over every file of a folder listing. Binary files
 * (content-sniffed by the walk, never by name) are skipped — grep is
 * a text operation — and unreadable files never sink a folder search
 * (both counted and reported).
 * @param {Array<{rel: string, abs: string, binary?: boolean}>} files
 * @param {Object} options
 * @param {string} options.shown - the folder path as shown
 * @param {string} options.pattern
 * @param {boolean} [options.ignoreCase]
 * @param {number} [options.maxMatches]
 * @param {boolean} [options.info] - return the would-return summary
 * @param {Object} [options.stat] - folder stat (info:true)
 * @param {(path: string, stat: Object, kind: string, query: string) => string} options.infoBlock
 * @returns {string}
 */
export async function grepFolder(files, { shown, pattern, ignoreCase, maxMatches, info, stat, infoBlock }) {
  compile(pattern, ignoreCase);
  const cap = intArg(maxMatches ?? DEFAULT_MAX_MATCHES, "maxMatches", 1);
  const flags = ignoreCase ? "i" : "";
  const found = [];
  let total = 0;
  let unreadable = 0;
  let binary = 0;
  const matchFiles = new Set();
  for (const file of files) {
    if (file.binary) { binary++; continue; }
    let text;
    try {
      text = await readFile(file.abs, "utf8");
    } catch {
      unreadable++;
      continue;
    }
    const { ranges } = matchLineRanges(text, pattern, ignoreCase);
    if (ranges.length === 0) continue;
    total += ranges.length;
    matchFiles.add(file.rel);
    const lines = text.split("\n"); // only a matching file pays for the split
    let lastPrinted = -1;
    for (const range of ranges) {
      if (found.length >= cap) break;
      for (let i = Math.max(range.first, lastPrinted + 1); i <= range.last && found.length < cap; i++) {
        found.push(`${file.rel}:${i + 1}: ${lines[i]}`);
        lastPrinted = i;
      }
    }
  }
  const parts = [];
  if (binary > 0) parts.push(`${binary} binary skipped`);
  if (unreadable > 0) parts.push(`${unreadable} unreadable skipped`);
  const skipNote = parts.length > 0 ? `, ${parts.join(", ")}` : "";
  if (info) {
    return infoBlock(shown, stat, "folder",
      `grep would return ${total} matches in ${matchFiles.size} file(s)${skipNote}`);
  }
  if (total === 0) return `grep: no matches for /${pattern}/${flags} in ${shown}${skipNote ? ` (${skipNote.slice(2)})` : ""}`;
  const note = total > cap ? `, showing first ${cap}` : "";
  return `grep ${shown} /${pattern}/${flags} (${total}${note}${skipNote}):\n${found.join("\n")}`;
}
