/** Single guarded way to read task Markdown: regular file, never a symlink. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { JobsError } from "./errors-base.js";

const DEFAULT_OPEN = { open };

/** Read a task file without following symlinks; other I/O failures propagate. */
export async function readTaskFile(path, io = DEFAULT_OPEN) {
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new JobsError("JOBS_TASK_FILE", "task must be a regular file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
