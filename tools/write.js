import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { toolRevision } from "../lib/tool-runtime.js"; // the tool-runtime leaf: one instance across cache-busted imports — no whole-library load for a timestamp

const timestamp = toolRevision();
const { rejectSymlinkPath, resolveCwdPath } = await import(`./guard/resolve.js?now=${timestamp}`);
const { enforceContentPolicy } = await import(`./guard/paths.js?now=${timestamp}`);

export async function write({ path, content, ask = false } = {}, context) {
  if (typeof content !== "string") throw new TypeError("write: content must be a string");
  // The agent folder is the working directory, while Env.cwd bounds the
  // project. Relative ../ paths may reach project siblings but never leave
  // that project; the OS sandbox has the same project-wide write scope.
  const writeCwd = context?.agent?.folder ?? context?.env?.cwd ?? context?.agent?.env?.cwd ?? process.cwd();
  const projectCwd = context?.env?.cwd ?? context?.agent?.env?.cwd ?? writeCwd;
  const contentCwd = projectCwd;
  const resolved = await rejectSymlinkPath(resolveCwdPath(path, { cwd: writeCwd, boundary: projectCwd }), { cwd: projectCwd });
  // A live question bridge makes the write interactive already; ask by
  // default there. Direct/non-agent callers still get a deterministic
  // refusal unless they explicitly request permission.
  const requestPermission = ask === true || typeof context?.question?.ask === "function";
  await enforceContentPolicy({ path, content, ask: requestPermission, context, askable: true, cwd: contentCwd, lax: true });
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  return `Successfully wrote to ${path}`;
}

export function toolDescription() {
  return { write: {
    trusted: true,
    description: "Create or overwrite a working-folder file; create parent folders as needed.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Path relative to the working folder." },
      content: { type: "string", description: "Content to write." },
      ask: { type: "boolean", description: "Ask for permission with surrounding context when the content names an existing path outside the working folder." },
    }, required: ["path", "content"] },
  } };
}
