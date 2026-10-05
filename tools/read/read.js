/** Read wrapper. Optional target saves the payload through write's guarded saver instead of returning it. */
import { toolRevision } from "../../lib/tool-runtime.js";
const revision = toolRevision();
const { executeReadQuery } = await import(`./engine.js?revision=${revision}`);
const { readResponse, serializeReadResult } = await import(`./serialize.js?revision=${revision}`);
const { readQuerySchema, normalizeReadQuery } = await import(`./query.js?revision=${revision}`);
const { READ_DEFAULTS } = await import(`./fs.js?revision=${revision}`);
const { saveTarget, sameTargetFile, savePayload } = await import(`../write/save.js?revision=${revision}`);

/** Model fillers (null, "", false) mean no target. */
const hasTarget = (args) => ![undefined, null, "", false].includes(args?.target);

export function readSettingsSchema() {
  return { read: { default: { ...READ_DEFAULTS }, description: "Finite read budgets: scanBytes, files, entries, fileBytes, grepFileSizeLimit, outputBytes, artifactBytes, regexMs, timeoutMs. Positive safe integer host settings; invalid/nonpositive values use defaults. Query args cannot disable budgets." } };
}

export function readDescription() {
  return { safe: true, readOnly: (args) => !hasTarget(args),
    description: "Read files, list folders, or search contents. Heed skip and incomplete notices before assuming full coverage.",
    inputSchema: readQuerySchema() };
}

/** Save a complete payload; non-search saves drop annotations so copies stay exact. */
async function saveRead(query, path, context) {
  const target = await saveTarget(path, context);
  const normalized = normalizeReadQuery(query, { artifact: true });
  if (!normalized.search) normalized.annotate = false;
  const result = await executeReadQuery(normalized, context, { artifact: true });
  if (await sameTargetFile(target, result.source, result.metadata)) throw new Error("read source and target must differ");
  const payload = serializeReadResult(result);
  const skipped = Object.entries(result.skips).filter(([, count]) => count).map(([name, count]) => `${count} ${name} skipped`);
  const incompleteScan = ["oversized", "unreadable"].some((name) => result.skips[name] > 0);
  if (!result.selectionComplete || incompleteScan) throw new Error(`read target refused incomplete output: ${[...result.status, ...skipped].join("; ")}`);
  return savePayload(target, { payload, binary: result.binary && !result.query.base64, status: [...result.status, ...skipped] }, context);
}

/** Execute a project-bounded query; with target, save instead of returning. Throws actionable input/filesystem errors. */
export async function read(args, context) {
  if (!args || typeof args !== "object" || !("target" in args)) return readResponse(await executeReadQuery(args, context));
  const { target, ...query } = args;
  if (!hasTarget(args)) return readResponse(await executeReadQuery(query, context));
  if (typeof target !== "string") throw new TypeError("read.target must be a path string");
  return saveRead(query, target, context);
}
