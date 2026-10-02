import { link, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";

const fs = { link, readdir, readFile, stat, unlink };
/**
 * Throw a JobsError with the supplied code, message, and optional details.
 * @param {string} code - Error code.
 * @param {string} message - Error message.
 * @param {object} [details={}] - Additional error details.
 * @returns {never} Never returns; throws a JobsError.
 * @throws {JobsError} Always, with the supplied values.
 */
function fail(code, message, details = {}) { throw new JobsError(code, message, details); }
/**
 * Validate and return a date string in YYYY-MM-DD form (format only; not calendar-validity checked).
 * @param {string} value - Date string to validate.
 * @returns {string} The unchanged validated date.
 * @throws {JobsError} Throws with code JOBS_ARCHIVE_DATE if the value does not match YYYY-MM-DD.
 */
function date(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("JOBS_ARCHIVE_DATE", "local date must be YYYY-MM-DD"); return value; }
/**
 * Validate and return a filename that is exactly one basename.
 * @param {string} value - Candidate filename.
 * @returns {string} The validated basename.
 * @throws {JobsError} Throws with code JOBS_ARCHIVE_FILENAME if the value is empty, dot/dot-dot, or contains a path.
 */
function filename(value) { const name = basename(value); if (!name || name === "." || name === ".." || name !== value) fail("JOBS_ARCHIVE_FILENAME", "filename must be a basename"); return name; }
/**
 * Allocate an unused date-local archival path. The integer field has no 999 cap.
 * @param {string} projectRoot - Project root used to resolve the completed-jobs directory.
 * @param {string} localDate - Local date in YYYY-MM-DD form.
 * @param {string} sourceFilename - Basename to include in the archival path.
 * @param {object} [io=fs] - Filesystem adapter providing `readdir(directory)`.
 * @returns {Promise<string>} The allocated path; allocation does not create or reserve it.
 * @throws {JobsError} Throws JOBS_ARCHIVE_DATE or JOBS_ARCHIVE_FILENAME for invalid inputs, or JOBS_ARCHIVE_ALLOCATE if reading the archive directory fails.
 * @effects Reads directory entries to select the lowest unused nonnegative date-local index.
 */
export async function allocateArchive(projectRoot, localDate, sourceFilename, io = fs) {
  const directory = jobsPaths(projectRoot).completed; const prefix = `${date(localDate)} `; const name = filename(sourceFilename);
  try { const entries = await io.readdir(directory); let index = 0; const used = new Set(entries.filter((entry) => entry.startsWith(prefix)).map((entry) => Number(entry.slice(prefix.length).match(/^(\d+) /)?.[1])).filter(Number.isSafeInteger)); while (used.has(index)) index++; return join(directory, `${prefix}${String(index).padStart(3, "0")} ${name}`); }
  catch (cause) { fail("JOBS_ARCHIVE_ALLOCATE", "archive path cannot be allocated", { directory, cause }); }
}
/**
 * Create a hard link at the archive path without overwriting an existing destination, then remove the source link.
 * @param {string} source - Existing source file path.
 * @param {string} archive - Destination archive path to claim.
 * @param {object} [io=fs] - Filesystem adapter providing `link(source, archive)` and `unlink(source)`.
 * @returns {Promise<string>} The archive path after the source link is removed.
 * @throws {JobsError} Throws JOBS_ARCHIVE_COLLISION if the destination exists; throws JOBS_ARCHIVE_MOVE if linking fails or if source removal fails after the archive link was created.
 * @effects Creates a hard link at `archive`; on successful linking, attempts to unlink `source`. If source removal fails, both links may remain.
 */
export async function moveToArchive(source, archive, io = fs) {
  try { await io.link(source, archive); } catch (cause) { if (cause?.code === "EEXIST") fail("JOBS_ARCHIVE_COLLISION", "archive destination already exists", { archive }); fail("JOBS_ARCHIVE_MOVE", "source cannot be linked to archive", { source, archive, cause }); }
  try { await io.unlink(source); } catch (cause) { fail("JOBS_ARCHIVE_MOVE", "archive was created but source cannot be removed", { source, archive, cause }); }
  return archive;
}
/**
 * Read a UTF-8 snapshot of the source before moving it to the archive.
 * @param {string} source - Existing source file path.
 * @param {string} archive - Destination archive path.
 * @param {object} [io=fs] - Filesystem adapter providing `readFile(source, "utf8")`, `link(source, archive)`, and `unlink(source)`.
 * @returns {Promise<string>} The source contents read before the move; callers should consume this snapshot rather than rereading disk.
 * @throws {JobsError} Throws JOBS_ARCHIVE_SNAPSHOT if reading fails, or propagates JOBS_ARCHIVE_COLLISION/JOBS_ARCHIVE_MOVE if archiving fails.
 * @effects Reads source contents, then creates a hard link at `archive` and removes `source` through {@link moveToArchive}.
 */
export async function snapshotAndArchive(source, archive, io = fs) {
  let snapshot;
  try { snapshot = await io.readFile(source, "utf8"); } catch (cause) { fail("JOBS_ARCHIVE_SNAPSHOT", "source snapshot cannot be read", { source, cause }); }
  await moveToArchive(source, archive, io); return snapshot;
}
/**
 * Check whether a path currently exists as a stat-able filesystem entry.
 * @param {string} path - Archive path to check.
 * @param {object} [io=fs] - Filesystem adapter providing `stat(path)`.
 * @returns {Promise<boolean>} `true` if stat succeeds, `false` if the path is absent (ENOENT).
 * @throws {JobsError} Throws JOBS_ARCHIVE_CHECK for filesystem errors other than ENOENT.
 * @effects Performs a filesystem stat; this is a point-in-time check and does not reserve the path.
 */
export async function archiveExists(path, io = fs) { try { await io.stat(path); return true; } catch (cause) { if (cause?.code === "ENOENT") return false; fail("JOBS_ARCHIVE_CHECK", "archive cannot be checked", { path, cause }); } }
