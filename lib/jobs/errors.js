import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";

function fail(code, message, details = {}) { throw new JobsError(code, message, details); }
/** Stable SHA-256 key for a filename/failure code; contains no source text. */
export function taskDiagnosticKey(diagnostic) {
  return createHash("sha256").update(`${diagnostic.code}\0${diagnostic.filename}`).digest("hex");
}
function record(diagnostic) {
  return `${JSON.stringify({ code: diagnostic.code, task: taskDiagnosticKey(diagnostic) })}\n`;
}

/**
 * Atomically record one frontmatter fallback without retaining source text,
 * metadata names, values, or filenames. Repeated reports overwrite one stable
 * hash-named record for the same task and failure class.
 */
export async function reportTaskDiagnostic(projectRoot, diagnostic, io = { mkdir, open, rename, unlink }) {
  if (!diagnostic?.reportable || typeof diagnostic.code !== "string" || typeof diagnostic.filename !== "string") {
    fail("JOBS_TASK_ERROR_DIAGNOSTIC", "task error diagnostic must be reportable with code and filename");
  }
  const path = `${jobsPaths(projectRoot).errors}/${taskDiagnosticKey(diagnostic)}.json`;
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await io.open(temporary, "wx", 0o600);
    await handle.writeFile(record(diagnostic), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await io.rename(temporary, path);
  } catch (cause) {
    try { await handle?.close(); } catch {}
    try { await io.unlink(temporary); } catch {}
    fail("JOBS_TASK_ERROR_WRITE", "task fallback error cannot be atomically written", { path, cause });
  }
  return path;
}

/** Parse entries purely, then durably report only all-or-nothing frontmatter fallbacks. */
export async function loadTasks(projectRoot, entries, io) {
  const { parseTasks } = await import("./tasks.js");
  const result = parseTasks(entries);
  await Promise.all(result.diagnostics.filter((diagnostic) => diagnostic.reportable)
    .map((diagnostic) => reportTaskDiagnostic(projectRoot, diagnostic, io)));
  return result;
}
