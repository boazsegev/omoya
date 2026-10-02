/**
 * The Jobs error log: ai-jobs/errors/YYYY-MM-DD.md (local date), one readable
 * Markdown entry per problem or warning — time, task file, code, message, and
 * the outcome and session of a job that ran. Everything inside the project is
 * written in full; nothing outside it is (see messageLocal).
 */
import { appendFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { jobsPaths } from "./paths.js";

/**
 * Convert a value to a zero-padded string.
 * @param {*} value - value to stringify
 * @param {number} [width=2] - minimum output width
 * @returns {string} the padded string
 */
const pad = (value, width = 2) => String(value).padStart(width, "0");

/**
 * Format an epoch-millisecond instant using the local calendar and clock.
 * @param {number} at - instant in epoch milliseconds
 * @returns {{date: string, time: string}} local date (YYYY-MM-DD) and time (HH:MM:SS)
 */
export function localStamp(at) {
  const date = new Date(at);
  return {
    date: `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

/**
 * Localize absolute paths in error text so paths outside the project are not exposed.
 * Paths under root become project-relative; other absolute paths become `…/<name>`.
 * @param {string} root - canonical project root
 * @param {unknown} text - message content to convert to a string and localize
 * @returns {string} localized message text
 */
export function messageLocal(root, text) {
  /**
   * Replace an absolute path with an ellipsis and its final path component.
   * @param {string} path - absolute path to abbreviate
   * @returns {string} abbreviated path, or the original path if it has no component
   */
  const outside = (path) => { const name = path.split("/").filter(Boolean).pop(); return name ? `…/${name}` : path; };
  // The project root first, literally (it may contain spaces): "<root>/x" -> "x", "<root>" -> ".".
  let local = "", rest = String(text ?? "");
  for (let at = rest.indexOf(root); at >= 0; at = rest.indexOf(root)) {
    const next = rest[at + root.length];
    const inside = next === "/" ? 1 : next === undefined || /[\s'"`),:]/.test(next) ? 0 : -1;
    local += rest.slice(0, at) + (inside === 1 ? "" : inside === 0 ? "." : root);
    rest = rest.slice(at + root.length + Math.max(inside, 0));
  }
  // Then any other absolute path: whole when quoted, up to whitespace when bare.
  return (local + rest)
    .replace(/(['"`])(\/[^'"`\n]*)\1/g, /**
     * Abbreviate a quoted absolute path while preserving its quote character.
     * @param {string} match - complete regular-expression match
     * @param {string} quote - matched quote character
     * @param {string} path - absolute path captured from the message
     * @returns {string} quoted abbreviated path
     */ (match, quote, path) => `${quote}${outside(path)}${quote}`)
    .replace(/(^|[\s(=,])(\/[^\s'"`),]*)/g, /**
     * Abbreviate a bare absolute path while preserving its preceding delimiter.
     * @param {string} match - complete regular-expression match
     * @param {string} lead - captured preceding delimiter
     * @param {string} path - absolute path captured from the message
     * @returns {string} delimiter followed by the abbreviated path
     */ (match, lead, path) => `${lead}${outside(path)}`);
}

/**
 * Format one log entry after its timestamp, including message and available facts.
 * @param {string} root - canonical project root used to localize message paths
 * @param {object} problem - problem with code, message, and optional task/job metadata
 * @returns {string} Markdown entry body beginning with the task and code
 */
function entry(root, problem) {
  const subject = problem.filename ?? problem.id ?? "scan";
  const facts = [
    problem.id && problem.id !== subject ? `- Task id: ${problem.id}` : null,
    problem.outcome ? `- Outcome: ${problem.outcome}` : null,
    problem.session ? `- Session: ${problem.session}` : null,
  ].filter(Boolean);
  return `— ${subject} — ${problem.code}${problem.level === "warning" ? " (warning)" : ""}\n\n${messageLocal(root, problem.message || "(no message)")}\n\n${facts.length ? `${facts.join("\n")}\n\n` : ""}`;
}

/**
 * Append one scan's problems to that day's log. A task-file problem (no job
 * ran) is re-detected by every scan, so it is logged once per day; job
 * failures are logged every time.
 * @param {string} root - canonical project root
 * @param {object[]} problems - entries with code/message and optional filename, id, outcome, session, or warning level
 * @param {number} at - scan time (epoch milliseconds), used for local date and entry time
 * @param {{appendFile: Function, readFile: Function}} [io={appendFile, readFile}] - filesystem methods receiving the target path and UTF-8 encoding; injectable for callers/tests
 * @returns {Promise<string|undefined>} relative log path, or undefined when problems is empty
 * @throws {Error} rethrows read errors other than ENOENT and any append error
 * @effects Reads the day's log and appends new entries; task-file issues are deduplicated per day
 */
export async function errorsLog(root, problems, at, io = { appendFile, readFile }) {
  if (!problems.length) return undefined;
  const { date, time } = localStamp(at), path = join(jobsPaths(root).errors, `${date}.md`);
  let existing = "";
  try { existing = await io.readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const blocks = [];
  for (const problem of problems) {
    const block = entry(root, problem);
    if (!problem.outcome && existing.includes(block)) continue;
    blocks.push(`## ${time} ${block}`);
  }
  if (blocks.length) await io.appendFile(path, `${existing ? "" : `# Jobs errors ${date}\n\n`}${blocks.join("")}`, "utf8");
  return relative(root, path);
}
