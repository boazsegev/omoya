import { isAbsolute, relative, sep } from "node:path";
import { resolveAgentPath } from "../../lib/agent/path-info.js";

export function resolveCwdPath(path, { cwd = process.cwd(), boundary = cwd } = {}) {
  return resolveAgentPath(path, { folder: cwd, boundary }).resolved;
}

/** Localize a tool-owned absolute path label; preserve already-relative spellings. */
export function relativeCwdPath(path, { cwd = process.cwd(), boundary = cwd } = {}) {
  if (!isAbsolute(path)) return path;
  const target = resolveAgentPath(path, { folder: cwd, boundary });
  return relative(target.root, target.resolved).split(sep).join("/") || ".";
}

export { rejectSymlinkPath } from "./symlinks.js";
