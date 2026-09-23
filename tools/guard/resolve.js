import { resolveAgentPath } from "../../lib/agent/path-info.js";

export function resolveCwdPath(path, { cwd = process.cwd(), boundary = cwd } = {}) {
  return resolveAgentPath(path, { folder: cwd, boundary }).resolved;
}

export { rejectSymlinkPath } from "./symlinks.js";
