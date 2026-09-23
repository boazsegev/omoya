/**
 * tools/read/grep.js — INTERNAL helper of the `read` tool (never a
 * tool itself: the scan is not recursive). The grep-like search used
 * by file reads: over a (possibly pre-narrowed) text, or over every
 * file of a folder listing.
 */

import { readFile } from "node:fs/promises";
import { intArg } from "./util.js";

export const DEFAULT_MAX_MATCHES = 100;

/**
 * grep-like search over a text: matching lines with line numbers.
 * @param {string} text
 * @param {Object} options
 * @param {string} options.pattern - regular expression
 * @param {boolean} [options.ignoreCase]
 * @param {number} [options.maxMatches]
 * @param {string} options.path - shown in the header/no-match line
 * @param {string[]} [options.lines] - pre-narrowed lines (line range)
 * @param {number} [options.lineOffset] - first line number of `lines`
 * @param {string} [options.header] - prepended to a match report
 * @param {Object} [options.stats] - receives {matches} (info:true)
 * @returns {string} the match report or a no-match line
 */
export function grep(text, { pattern, ignoreCase, maxMatches, path, lines, lineOffset = 1, header = "", stats } = {}) {
  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    throw new Error("Invalid pattern. Use a valid regular expression.");
  }
  const cap = intArg(maxMatches ?? DEFAULT_MAX_MATCHES, "maxMatches", 1);
  const flags = ignoreCase ? "i" : "";
  const found = [];
  for (const [i, line] of (lines ?? text.split("\n")).entries()) {
    if (found.length >= cap) break;
    if (re.test(line)) found.push(`${lineOffset + i}: ${line}`);
  }
  if (found.length === 0) {
    if (stats) stats.matches = 0;
    return `grep: no matches for /${pattern}/${flags} in ${path}`;
  }
  const total = (lines ?? text.split("\n")).filter((l) => re.test(l)).length;
  if (stats) stats.matches = total;
  const note = total > cap ? `, showing first ${cap}` : "";
  return `grep ${path} /${pattern}/${flags} (${total}${note}):\n${header}${found.join("\n")}`;
}

/**
 * grep-like search over every file of a folder listing. Unreadable
 * files never sink a folder search (counted as skipped).
 * @param {Array<{rel: string, abs: string}>} files
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
  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    throw new Error("Invalid pattern. Use a valid regular expression.");
  }
  const cap = intArg(maxMatches ?? DEFAULT_MAX_MATCHES, "maxMatches", 1);
  const flags = ignoreCase ? "i" : "";
  const found = [];
  let total = 0;
  let skipped = 0;
  const matchFiles = new Set();
  for (const file of files) {
    let text;
    try {
      text = await readFile(file.abs, "utf8");
    } catch {
      skipped++;
      continue;
    }
    for (const [i, line] of text.split("\n").entries()) {
      if (!re.test(line)) continue;
      total++;
      matchFiles.add(file.rel);
      if (found.length < cap) found.push(`${file.rel}:${i + 1}: ${line}`);
    }
  }
  const skipNote = skipped > 0 ? `, ${skipped} unreadable skipped` : "";
  if (info) {
    return infoBlock(shown, stat, "folder",
      `grep would return ${total} matches in ${matchFiles.size} file(s)${skipNote}`);
  }
  if (total === 0) return `grep: no matches for /${pattern}/${flags} in ${shown}${skipNote ? ` (${skipNote.slice(2)})` : ""}`;
  const note = total > cap ? `, showing first ${cap}` : "";
  return `grep ${shown} /${pattern}/${flags} (${total}${note}${skipNote}):\n${found.join("\n")}`;
}
