import { rejectAgentSymlinks } from "../../lib/agent/path-info.js";

/** Reject a path containing an existing symbolic link below cwd. */
export async function rejectSymlinkPath(resolvedPath, { cwd = process.cwd() } = {}) {
  return rejectAgentSymlinks(resolvedPath, { folder: cwd });
}
