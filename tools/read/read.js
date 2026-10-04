/** Read-only wrapper. Shared query execution is also consumed directly by write.source. */
import { toolRevision } from "../../lib/tool-runtime.js";
const revision = toolRevision();
const { executeReadQuery } = await import(`./engine.js?revision=${revision}`);
const { readResponse } = await import(`./serialize.js?revision=${revision}`);
const { readQuerySchema } = await import(`./query.js?revision=${revision}`);
const { READ_DEFAULTS } = await import(`./fs.js?revision=${revision}`);

export function readSettingsSchema() {
  return { read: { default: { ...READ_DEFAULTS }, description: "Finite read budgets: scanBytes, files, entries, fileBytes, grepFileSizeLimit, outputBytes, artifactBytes, regexMs, timeoutMs. Positive safe integer host settings; invalid/nonpositive values use defaults. Query args cannot disable budgets." } };
}

export function readDescription() {
  return { safe: true, description: "Read project files, list folders, or search their contents. Use ranges for excerpts, glob/exclude to filter files, and search for literal text or regex matches. Set recursive for subfolders. Check skip and incomplete-result notices before assuming coverage.", inputSchema: readQuerySchema() };
}

/** Execute a read-only project-bounded query; throws actionable input/filesystem errors. */
export async function read(args, context) {
  return readResponse(await executeReadQuery(args, context));
}
