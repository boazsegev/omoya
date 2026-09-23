/** Agent-owned path policy and inspected file metadata. */

import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import Context from "../context.js";

const { detectMime } = Context;

function refusal(detail) {
  return `path traversal refused: ${detail} — path traversal is a global security policy violation. Escaping the working folder is forbidden everywhere, and attempting it is a policy breach even if it would succeed. Ask the user to bring the file inside the working folder instead.`;
}

/** Resolve a relative path from `folder`, bounded by `boundary` (the project root by default). */
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

/** Reject existing symbolic links along a resolved, in-root path. */
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
 * @returns {Promise<{path:string,isFolder:boolean,mimetype?:string}>}
 */
export async function pathInfo(path, { folder = process.cwd(), requireExists = true } = {}) {
  const resolved = resolveAgentPath(path, { folder });
  await rejectAgentSymlinks(resolved.resolved, { folder: resolved.root });
  let stat;
  try { stat = await lstat(resolved.resolved); } catch (error) {
    if (error?.code === "ENOENT" && !requireExists) return { path: resolved.path, isFolder: false, mimetype: detectMime({ path: resolved.path }) };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are refused: "${resolved.path}"`);
  if (stat.isDirectory()) return { path: resolved.path, isFolder: true };
  if (!stat.isFile()) throw new Error(`path is not a regular file: "${resolved.path}"`);
  return { path: resolved.path, isFolder: false, mimetype: detectMime({ path: resolved.path }) };
}

export async function resolvedFile(path, options) {
  const info = await pathInfo(path, options);
  if (info.isFolder) throw new Error(`path is a folder: "${info.path}"`);
  return { ...info, resolved: resolveAgentPath(path, options).resolved };
}
