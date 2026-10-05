/** Guarded atomic file saving shared by write and read.target. Not a tool: the tool scan does not recurse. */
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { dirname, basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { toolRevision } from "../../lib/tool-runtime.js";
const revision = toolRevision();
const { rejectSymlinkPath, resolveCwdPath, relativeCwdPath } = await import(`../guard/resolve.js?now=${revision}`);
const { enforceContentPolicy } = await import(`../guard/paths.js?now=${revision}`);
const { readScope } = await import(`../read/fs.js?revision=${revision}`);

function checkWrite(context) {
  context?.signal?.throwIfAborted();
  if (context?.deadline !== undefined && Date.now() >= context.deadline) throw new Error("write deadline exhausted");
}

async function destination(path, scope) {
  const resolved = await rejectSymlinkPath(resolveCwdPath(path, scope), { cwd: scope.boundary });
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isFile()) throw new Error("write destination must be a regular file");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return resolved;
}

/**
 * Resolve and guard a save destination before producing its payload.
 * @param {string} path Destination relative to the Agent folder or an absolute contained path.
 * @param {object} context Tool context; safe mode refuses saving.
 * @returns {Promise<{resolved: string, path: string, scope: object}>} Guarded destination.
 */
export async function saveTarget(path, context) {
  if (context?.safe === true) throw new Error("saving files is unavailable in safe mode");
  if (typeof path !== "string" || !path) throw new TypeError("save path must be a non-empty string");
  checkWrite(context);
  const scope = readScope(context);
  return { resolved: await destination(path, scope), path: relativeCwdPath(path, scope), scope };
}

/** True when an existing destination is the same regular file as `metadata`. */
export async function sameTargetFile(target, source, metadata) {
  if (source === target.resolved) return true;
  let current;
  try { current = await lstat(target.resolved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return Boolean(current && metadata?.isFile() && current.dev === metadata.dev && current.ino === metadata.ino);
}

/**
 * Apply the text content policy, then atomically replace the destination.
 * @param {{resolved: string, path: string, scope: object}} target From saveTarget.
 * @param {{payload: Buffer, binary?: boolean, status?: string[]}} data Payload; raw binary skips the text policy.
 * @param {object} context Tool context.
 * @param {{ask?: boolean}} [options] Request permission for policy matches.
 * @returns {Promise<string>} Confirmation with optional status.
 */
export async function savePayload(target, { payload, binary = false, status = [] }, context, { ask = false } = {}) {
  const { resolved, path, scope } = target;
  if (!binary) await enforceContentPolicy({ path, content: payload.toString("utf8"),
    ask: ask || typeof context?.question?.ask === "function", context, askable: true, cwd: scope.boundary, lax: true });
  await atomicWrite(resolved, payload, context, scope);
  return `Successfully wrote ${payload.length} bytes to ${path}${status.length ? ` (${status.join("; ")})` : ""}`;
}

async function atomicWrite(resolved, payload, context, scope) {
  checkWrite(context);
  await mkdir(dirname(resolved), { recursive: true });
  await rejectSymlinkPath(resolved, { cwd: scope.boundary });
  const temporary = join(dirname(resolved), `.${basename(resolved)}.${randomUUID()}.tmp`);
  let handle;
  let previous;
  try { previous = await lstat(resolved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(payload);
    if (previous?.isFile()) await handle.chmod(previous.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = null;
    checkWrite(context);
    // Revalidation uses the same working-folder-relative spelling as tool output.
    await destination(relative(scope.cwd, resolved) || ".", scope);
    await rename(temporary, resolved);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
