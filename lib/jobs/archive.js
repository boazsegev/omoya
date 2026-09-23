import { link, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";

const fs = { link, readdir, readFile, stat, unlink };
function fail(code, message, details = {}) { throw new JobsError(code, message, details); }
function date(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("JOBS_ARCHIVE_DATE", "local date must be YYYY-MM-DD"); return value; }
function filename(value) { const name = basename(value); if (!name || name === "." || name === ".." || name !== value) fail("JOBS_ARCHIVE_FILENAME", "filename must be a basename"); return name; }
/** Allocate an unused date-local archival name. The integer field has no 999 cap. */
export async function allocateArchive(projectRoot, localDate, sourceFilename, io = fs) {
  const directory = jobsPaths(projectRoot).completed; const prefix = `${date(localDate)} `; const name = filename(sourceFilename);
  try { const entries = await io.readdir(directory); let index = 0; const used = new Set(entries.filter((entry) => entry.startsWith(prefix)).map((entry) => Number(entry.slice(prefix.length).match(/^(\d+) /)?.[1])).filter(Number.isSafeInteger)); while (used.has(index)) index++; return join(directory, `${prefix}${String(index).padStart(3, "0")} ${name}`); }
  catch (cause) { fail("JOBS_ARCHIVE_ALLOCATE", "archive path cannot be allocated", { directory, cause }); }
}
/** Atomically claim destination without overwrite, then remove source hardlink. */
export async function moveToArchive(source, archive, io = fs) {
  try { await io.link(source, archive); } catch (cause) { if (cause?.code === "EEXIST") fail("JOBS_ARCHIVE_COLLISION", "archive destination already exists", { archive }); fail("JOBS_ARCHIVE_MOVE", "source cannot be linked to archive", { source, archive, cause }); }
  try { await io.unlink(source); } catch (cause) { fail("JOBS_ARCHIVE_MOVE", "archive was created but source cannot be removed", { source, archive, cause }); }
  return archive;
}
/** Snapshot source bytes before move. Execution must consume snapshot, not disk. */
export async function snapshotAndArchive(source, archive, io = fs) {
  let snapshot;
  try { snapshot = await io.readFile(source, "utf8"); } catch (cause) { fail("JOBS_ARCHIVE_SNAPSHOT", "source snapshot cannot be read", { source, cause }); }
  await moveToArchive(source, archive, io); return snapshot;
}
/** Check archive presence; absence returns false, other I/O failures throw JobsError. */
export async function archiveExists(path, io = fs) { try { await io.stat(path); return true; } catch (cause) { if (cause?.code === "ENOENT") return false; fail("JOBS_ARCHIVE_CHECK", "archive cannot be checked", { path, cause }); } }
