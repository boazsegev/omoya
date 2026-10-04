/** Mutating writer. Optional source query uses the shared read engine, never provider dispatch. */
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { dirname, basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { toolRevision } from "../lib/tool-runtime.js";
const revision = toolRevision();
const { rejectSymlinkPath, resolveCwdPath } = await import(`./guard/resolve.js?now=${revision}`);
const { enforceContentPolicy } = await import(`./guard/paths.js?now=${revision}`);
const { executeReadQuery } = await import(`./read/engine.js?revision=${revision}`);
const { serializeReadResult } = await import(`./read/serialize.js?revision=${revision}`);
const { readQuerySchema, normalizeReadQuery } = await import(`./read/query.js?revision=${revision}`);
const { readScope } = await import(`./read/fs.js?revision=${revision}`);

function absent(value) {
  return value === undefined || value === null || value === -1 || value === 0 || typeof value === "boolean" || (Array.isArray(value) && !value.length);
}

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

function sameFile(result, metadata) {
  return metadata && result.metadata.isFile() && metadata.dev === result.metadata.dev && metadata.ino === result.metadata.ino;
}

async function queryPayload(query, resolved, context) {
  const normalized = normalizeReadQuery(query);
  // Saving source data must not insert display decoration; searches retain useful locations.
  if (!normalized.search) normalized.annotate = false;
  const result = await executeReadQuery(normalized, context, { artifact: true });
  let metadata;
  try { metadata = await lstat(resolved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (result.source === resolved || sameFile(result, metadata)) throw new Error("write source and destination must differ");
  const payload = serializeReadResult(result);
  if (!result.selectionComplete) throw new Error(`write source query refused incomplete output: ${result.status.join("; ")}`);
  const skipped = Object.entries(result.skips).filter(([, count]) => count).map(([name, count]) => `${count} ${name} skipped`);
  return { payload, binary: result.binary && !result.query.base64, status: [...result.status, ...skipped] };
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
    await destination(relativeDestination(resolved, scope), scope);
    await rename(temporary, resolved);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function relativeDestination(resolved, scope) {
  // resolveCwdPath requires a relative spelling; never expose the host path.
  return relative(scope.cwd, resolved) || ".";
}

/** Exactly one effective content/source; destination changes only after guarded successful serialization. */
export async function write(args = {}, context) {
  if (context?.safe === true) throw new Error("write is unavailable in safe mode");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("write arguments must be an object");
  for (const key of Object.keys(args)) if (!["path", "content", "source", "ask"].includes(key)) throw new Error(`Unknown write field: ${key}`);
  const hasContent = !absent(args.content);
  const hasSource = !absent(args.source) && args.source !== "";
  if (hasContent === hasSource) throw new TypeError("write requires exactly one effective content or source");
  if (hasContent && typeof args.content !== "string") throw new TypeError("write.content must be a string");
  if (!absent(args.ask) && typeof args.ask !== "boolean") throw new TypeError("write.ask must be a boolean");
  checkWrite(context);
  const scope = readScope(context);
  const resolved = await destination(args.path, scope);
  const data = hasSource ? await queryPayload(args.source, resolved, context) : { payload: Buffer.from(args.content), binary: false, status: [] };
  if (!data.binary) await enforceContentPolicy({ path: args.path, content: data.payload.toString("utf8"),
    ask: args.ask === true || typeof context?.question?.ask === "function", context, askable: true, cwd: scope.boundary, lax: true });
  await atomicWrite(resolved, data.payload, context, scope);
  return `Successfully wrote ${data.payload.length} bytes to ${args.path}${data.status.length ? ` (${data.status.join("; ")})` : ""}`;
}

export function toolDescription() {
  return { write: { trusted: true,
    description: "Create or overwrite a project file. Supply content for text, or source to copy a file or save a listing or search result; never both. Use edit for targeted changes. Incomplete source results leave the destination unchanged.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", description: "Destination path relative to the working folder, inside the project." },
      content: { type: "string", description: "Writes text to file. Use an empty string to create an empty file or clear an existing file. Omit when using a source." },
      source: { ...readQuerySchema(), description: "Writes directly from file system source. Use to copy files, or save folder listings and search results to a file. Binary reads save raw bytes unless base64 is true. Omit when writing text to file." },
      ask: { type: "boolean", description: "Ask permission if saved text references an existing path outside the project; without permission, the write is refused." },
    } },
  } };
}
