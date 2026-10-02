/** Single guarded way to read task Markdown: regular file, never a symlink. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { JobsError } from "./errors-base.js";

const DEFAULT_OPEN = { open };

/**
 * Read a task file as UTF-8, requiring it to be a regular file.
 *
 * @param {string} path - Path of the task file to open.
 * @param {{ open: Function }} [io=DEFAULT_OPEN] - I/O provider whose `open` method
 *   accepts the path and flags and returns a file handle.
 * @returns {Promise<string>} The file contents decoded as UTF-8.
 * @throws {JobsError} With code `JOBS_TASK_FILE` if the opened path is not a regular file.
 * @throws {Error} Propagates open, stat, read, and close failures from the I/O provider.
 * @effects Opens the file read-only with `O_NOFOLLOW` and closes its handle after use.
 */
export async function readTaskFile(path, io = DEFAULT_OPEN) {
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new JobsError("JOBS_TASK_FILE", "task must be a regular file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
