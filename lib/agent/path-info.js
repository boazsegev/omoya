/** Agent-owned path policy and inspected file metadata. */

import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import Context from "../context.js";

const { mimeDetect } = Context;

/** Format the policy error raised when a path is unsafe.
 * @param {string} detail - Description of the refused path or traversal.
 * @returns {string} The path-traversal refusal message.
 */
function refusal(detail) {
  return `path traversal refused: ${detail} — path traversal is a global security policy violation. Escaping the working folder is forbidden everywhere, and attempting it is a policy breach even if it would succeed. Ask the user to bring the file inside the working folder instead.`;
}

/** Resolve a relative path from `folder`, bounded by `boundary` (the project root by default).
 * @param {string} path - Non-empty relative path to resolve.
 * @param {object} [options] - Resolution options.
 * @param {string} [options.folder=process.cwd()] - Base folder for the path.
 * @param {string} [options.boundary=options.folder] - Project boundary the result must remain within.
 * @returns {{root:string,boundary:string,resolved:string,path:string}} Absolute roots and resolved path, plus normalized project-relative path.
 * @throws {TypeError} If `path` is empty or not a string.
 * @throws {Error} If `path` is absolute or escapes the project boundary.
 */
export function resolveAgentPath(path, { folder = process.cwd(), boundary = folder } = {}) {
  if (typeof path !== "string" || path.trim() === "") throw new TypeError("path must be a non-empty string");
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    throw new Error(refusal(`absolute path "${path}"`));
  }
  const root = resolve(folder);
  const limit = resolve(boundary);
  const resolved = resolve(root, path);
  const rel = relative(limit, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(refusal(`"${path}" escapes the working folder's project boundary`));
  return { root, boundary: limit, resolved, path: rel === "" ? "." : `./${rel.split(sep).join("/")}` };
}

/** Reject existing symbolic links along a resolved, in-root path.
 * @param {string} resolved - Resolved path to inspect.
 * @param {object} [options] - Inspection options.
 * @param {string} [options.folder=process.cwd()] - Root folder from which to inspect path components.
 * @returns {Promise<string>} The unchanged resolved path when no existing component is a symlink.
 * @throws {Error} If an existing component is a symbolic link or filesystem inspection fails.
 */
export async function rejectAgentSymlinks(resolved, { folder = process.cwd() } = {}) {
  const root = resolve(folder);
  const rel = relative(root, resolved);
  let current = root;
  for (const part of rel === "" ? [] : rel.split(sep)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`symbolic links are refused: "${rel}" contains symlink "${part}"`);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return resolved;
}

/**
 * Validate and inspect a path rooted at an Agent folder.
 * @param {string} path - Non-empty relative path to inspect.
 * @param {object} [options] - Inspection options.
 * @param {string} [options.folder=process.cwd()] - Agent folder containing the path.
 * @param {boolean} [options.requireExists=true] - Whether a missing path is an error.
 * @returns {Promise<{path:string,isFolder:boolean,mimetype?:string}>} Normalized path, folder status, and file MIME type when applicable.
 * @throws {TypeError} If the path is invalid.
 * @throws {Error} If the path is unsafe, a symlink, a non-regular file, or cannot be inspected.
 */
export async function pathInfo(path, { folder = process.cwd(), requireExists = true } = {}) {
  const resolved = resolveAgentPath(path, { folder });
  await rejectAgentSymlinks(resolved.resolved, { folder: resolved.root });
  let stat;
  try { stat = await lstat(resolved.resolved); } catch (error) {
    if (error?.code === "ENOENT" && !requireExists) return { path: resolved.path, isFolder: false, mimetype: mimeDetect({ path: resolved.path }) };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are refused: "${resolved.path}"`);
  if (stat.isDirectory()) return { path: resolved.path, isFolder: true };
  if (!stat.isFile()) throw new Error(`path is not a regular file: "${resolved.path}"`);
  return { path: resolved.path, isFolder: false, mimetype: mimeDetect({ path: resolved.path }) };
}

/** Inspect a path and return its absolute file location, rejecting folders.
 * @param {string} path - Non-empty relative path to inspect.
 * @param {object} [options] - Options forwarded to {@link pathInfo}; `folder` and `requireExists` default there.
 * @returns {Promise<{path:string,isFolder:false,mimetype?:string,resolved:string}>} File metadata and its absolute resolved path.
 * @throws {Error} If inspection fails or the path is a folder.
 */
export async function resolvedFile(path, options) {
  const info = await pathInfo(path, options);
  if (info.isFolder) throw new Error(`path is a folder: "${info.path}"`);
  return { ...info, resolved: resolveAgentPath(path, options).resolved };
}
