/**
 * The Jobs error log: ai-jobs/errors/YYYY-MM-DD.md (local date), one readable
 * Markdown entry per problem or warning — time, task file, code, message, and
 * the outcome and session of a job that ran. Everything inside the project is
 * written in full; nothing outside it is (see messageLocal).
 */
import { appendFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { jobsPaths } from "./paths.js";

const pad = (value, width = 2) => String(value).padStart(width, "0");

/** Local calendar date (YYYY-MM-DD) and time (HH:MM:SS) of an epoch-ms instant. */
export function localStamp(at) {
  const date = new Date(at);
  return {
    date: `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

/**
 * Error text that names nothing outside the project: paths under the project
 * root read relative to it, any other absolute path shrinks to `…/<name>`.
 * @param {string} root - canonical project root
 * @param {unknown} text
 * @returns {string}
 */
export function messageLocal(root, text) {
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
    .replace(/(['"`])(\/[^'"`\n]*)\1/g, (match, quote, path) => `${quote}${outside(path)}${quote}`)
    .replace(/(^|[\s(=,])(\/[^\s'"`),]*)/g, (match, lead, path) => `${lead}${outside(path)}`);
}

/** One entry after its time: "— <task file> — <code>", message, facts. */
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
 * @param {object[]} problems - {code, message, filename?, id?, outcome?, session?, level?: "warning"}
 * @param {number} at - scan time (epoch ms)
 * @returns {Promise<string|undefined>} the log file relative to the project, or undefined when nothing went wrong
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
