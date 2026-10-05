/** Shared read-query execution contract. Wrappers serialize results; write never dispatches a provider tool. */
import { toolRevision } from "../../lib/tool-runtime.js";
const revision = toolRevision();
import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
const { normalizeReadQuery } = await import(`./query.js?revision=${revision}`);
const { relativeCwdPath } = await import(`../guard/resolve.js?now=${revision}`);
const { createReadState, selectReadBoundary, guardedPath, openReadFile, readChunk, directoryEntries, charge, checkReadState, relativeReadPath, readError, ReadBudgetError } = await import(`./fs.js?revision=${revision}`);
const { matchesGlob } = await import(`./glob.js?revision=${revision}`);
const { ancestorIgnores, loadIgnore, isIgnored, isSystemFile } = await import(`./ignore.js?revision=${revision}`);
const { loadText, selectText, sourceLines, rangeBounds } = await import(`./text.js?revision=${revision}`);
const { matchSearch, closeSearch } = await import(`./search.js?revision=${revision}`);
const { mimeDetect } = await import(`./mime-detection.js?revision=${revision}`);

function accepts(path, query) {
  return (!query.glob.length || query.glob.some((glob) => matchesGlob(path, glob))) && !query.exclude.some((glob) => matchesGlob(path, glob));
}

function excludedDirectory(path, query) {
  return query.exclude.some((glob) => matchesGlob(path, glob) || matchesGlob(`${path}/`, glob));
}

async function* walk(abs, query, state, skips, stack) {
  checkReadState(state);
  const base = relative(state.scope.boundary, abs).split(sep).join("/");
  const own = query.ignore ? await loadIgnore(abs, base, state) : null;
  const ignores = own ? [...stack, own] : stack;
  for (const entry of await directoryEntries(abs, state)) {
    checkReadState(state);
    const target = join(abs, entry.name);
    const path = relative(state.root, target).split(sep).join("/");
    const projectPath = relative(state.scope.boundary, target).split(sep).join("/");
    if (entry.isSymbolicLink()) { skips.symlink++; continue; }
    const dir = entry.isDirectory();
    if (!dir && !entry.isFile()) { skips.special++; continue; }
    if (query.ignore && (isSystemFile(projectPath) || isIgnored(ignores, `${projectPath}${dir ? "/" : ""}`, state))) { skips.ignored++; continue; }
    if (dir && excludedDirectory(path, query)) continue;
    // Dirents decide relevance before metadata I/O; directories are guarded when opened.
    if (!dir && !accepts(path, query)) continue;
    let metadata;
    try { metadata = dir ? entry : await lstat(target); }
    catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) { skips.unreadable++; continue; }
      throw error;
    }
    if (metadata.isSymbolicLink()) { skips.symlink++; continue; }
    if (!metadata.isFile() && !metadata.isDirectory()) { skips.special++; continue; }

    if (dir) {
      if (!query.glob.length && !query.search) yield { abs: target, path: `${path}/`, metadata };
      if (query.recursive) {
        try { yield* walk(target, query, state, skips, ignores); }
        catch (error) {
          if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) skips.unreadable++;
          else throw error;
        }
      }
    } else yield { abs: target, path, metadata };
  }
}

function skipped() { return { symlink: 0, special: 0, ignored: 0, binary: 0, oversized: 0, unreadable: 0 }; }

function rootHint(state, path) {
  if (![".", "./"].includes(path) || state.scope.cwd === state.scope.project) return null;
  const folder = relative(state.scope.project, state.scope.cwd).split(sep).join("/");
  const up = relative(state.scope.cwd, state.scope.project).split(sep).join("/");
  return `Hint: you're in \`./${folder}\`, use \`${up}/\` to read files from the root project.`;
}

/** Normalize and execute within finite host budgets. Result payload and completeness/status are separate. */
export async function executeReadQuery(args, context, { artifact = false } = {}) {
  const state = createReadState(context, artifact);
  try {
    try { return await executeQuery(normalizeReadQuery(args, { artifact }), state); }
    finally { await closeSearch(state); }
  } catch (error) { throw readError(error, state); }
}

async function executeQuery(query, state) {
  selectReadBoundary(query.path, state.scope);
  query.path = relativeCwdPath(query.path, state.scope);
  let inspected;
  try { inspected = await guardedPath(query.path, state); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const safe = readError(error, state);
    safe.message = `ENOENT: no such file or directory, '${query.path}'${rootHint(state, ".") ? ` ${rootHint(state, ".")}` : ""}`;
    safe.stack = `Error: ${safe.message}`;
    throw safe;
  }
  const result = { query, source: inspected.abs, metadata: inspected.metadata, kind: inspected.metadata.isDirectory() ? "folder" : "file",
    records: [], payload: "", binary: false, complete: true, selectionComplete: true, status: [], skips: skipped(),
    selected: 0, returned: 0, scannedBytes: 0, totals: null, matchingFiles: [], hint: rootHint(state, query.path) };
  state.root = inspected.abs;
  if (result.kind === "folder") validateFolder(query);
  if (!query.info && result.kind === "folder" && query.limit === 0) return { ...result, outputLimit: state.outputLimit };
  try {
    if (result.kind === "folder") await folderQuery(result, state);
    else await fileQuery(result, state);
  } catch (error) {
    if (!(error instanceof ReadBudgetError)) throw error;
    result.complete = false;
    result.selectionComplete = false;
    result.status.push(error.message);
  }
  result.scannedBytes = state.scanned;
  result.outputLimit = state.outputLimit;
  return result;
}

async function fileQuery(result, state) {
  const { query } = result;
  if (!accepts(relativeReadPath(result.source, state), query)) throw new Error("The requested file does not match glob/exclude filters");
  charge(state, "files", 1);
  const opened = await openReadFile(result.source, state);
  try {
    result.metadata = opened.metadata;
    if (query.binary && !query.search) return await byteQuery(result, opened, state);
    const loaded = await loadText(opened, query, state);
    const selection = query.search && !query.info && !query.lines && !query.characters && !query.bytes
      ? { text: loaded.text, lineOffset: 1 } : selectText(loaded, query);
    result.totals = selection.totals;
    result.descriptions = selection.descriptions;
    result.mime = mimeDetect({ path: result.source });
    if (query.search) await searchFile(result, { path: query.path, ...selection }, state);
    else result.payload = selection.text;
  } finally { await opened.handle.close(); }
}

async function byteQuery(result, opened, state) {
  const [from, to] = rangeBounds(result.query.bytes, opened.metadata.size);
  result.descriptions = [`bytes ${from}–${to} (exclusive end) of ${opened.metadata.size}`];
  result.mime = mimeDetect({ path: result.source });
  result.byteCount = to - from;
  if (result.query.info) return;
  const prefix = result.mime === "application/octet-stream" && from === 0
    ? await readChunk(opened.handle, from, Math.min(16, to - from, state.outputLimit), state) : Buffer.alloc(0);
  result.mime = mimeDetect({ path: result.source, buffer: prefix });
  const count = binaryReadCount(result, opened.metadata.size, state, from, to);
  if (count === null) return;
  const rest = await readChunk(opened.handle, from + prefix.length, count - prefix.length, state);
  result.payload = prefix.length ? Buffer.concat([prefix, rest]) : rest;
  result.mime = mimeDetect({ path: result.source, buffer: result.payload });
  result.binary = true;
}

function binaryReadCount(result, size, state, from, to) {
  const image = result.mime.startsWith("image/") && !result.query.base64 && !state.artifact;
  const count = Math.min(to - from, image ? state.budgets.fileBytes : state.outputLimit);
  if (count < to - from) {
    result.selectionComplete = false;
    result.status.push(image ? "image fileBytes budget exhausted; resize the image" : "binary output budget exhausted; narrow bytes");
  }
  // Vision decoders need a whole file, never a text-budget preview or byte slice.
  if (image && (size === 0 || from !== 0 || to !== size || count !== size)) {
    result.selectionComplete = false;
    result.status.push("image not sent: empty or incomplete file; use a complete image within read.fileBytes, or base64:true to inspect bytes as text");
    return null;
  }
  return count;
}

function validateFolder(query) {
  if (query.lines || query.characters || query.bytes) throw new Error("File ranges do not apply to folders; use limit/offset");
  if (query.binary && !query.search) throw new Error("binary applies only to files or byte searches");
}

async function folderQuery(result, state) {
  const { query } = result;
  const ignores = query.ignore ? await ancestorIgnores(state.scope.boundary, result.source, state) : [];
  for await (const entry of walk(result.source, query, state, result.skips, ignores)) {
    if (query.search) {
      await folderSearchFile(result, entry, state);
      if (!query.info && (!result.selectionComplete || result.selected > query.offset + query.limit)) { result.complete = false; break; }
    } else {
      const index = result.selected++;
      if (index >= query.offset && result.returned < query.limit) {
        if (!addRecord(result, { path: entry.path, size: entry.metadata.isFile() ? entry.metadata.size : undefined }, state)) break;
      }
      if (!query.info && result.selected > query.offset + query.limit) { result.complete = false; break; }
    }
  }
  if (!result.complete && result.selectionComplete) result.status.push("selection limit reached; total count is not exact");
}

async function folderSearchFile(result, entry, state) {
  if (entry.metadata.size > state.budgets.grepFileSizeLimit) { result.skips.oversized++; return; }
  charge(state, "files", 1);
  let opened;
  try {
    opened = await openReadFile(entry.abs, state);
    if (opened.metadata.size > state.budgets.grepFileSizeLimit) { result.skips.oversized++; return; }
    const loaded = await loadText(opened, result.query, state);
    await searchFile(result, { path: entry.path, text: loaded.text, lineOffset: 1 }, state);
  } catch (error) {
    if (error instanceof ReadBudgetError || state.signal?.aborted) throw error;
    if (error.message.includes("Search applies only")) result.skips.binary++;
    else if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT") result.skips.unreadable++;
    else throw error;
  } finally { await opened?.handle.close(); }
}

function excerpt(text, position = 0) {
  const max = 2048;
  if (text.length <= max) return { text, omitted: false };
  const from = Math.max(0, Math.min(position - max / 2, text.length - max));
  return { text: `${from ? "..." : ""}${text.slice(from, from + max)}${from + max < text.length ? "..." : ""}`, omitted: true };
}

function addRecord(result, record, state) {
  const size = Buffer.byteLength(record.text ?? record.path) + Buffer.byteLength(record.path ?? "") + 64;
  if (state.output + size > state.outputLimit) {
    result.selectionComplete = false;
    result.complete = false;
    if (!result.status.includes("output budget exhausted; narrow the query")) result.status.push("output budget exhausted; narrow the query");
    return false;
  }
  state.output += size;
  result.records.push(record);
  if (!record.context) result.returned++;
  return true;
}

async function searchFile(result, selection, state) {
  const { query } = result;
  const matched = await matchSearch(selection.text, query.search, state);
  if (!matched.indexes.length) return;
  const lines = query.info ? null : sourceLines(selection.text);
  const lineCount = matched.lineCount;
  // A trailing newline does not manufacture an extra source line.
  const indexes = matched.indexes.filter((index) => index < lineCount);
  const base = result.selected;
  result.selected += indexes.length;
  if (indexes.length && query.info) {
    const record = { path: selection.path, count: indexes.length };
    const fileIndex = result.matchingFileCount ?? 0;
    result.matchingFileCount = fileIndex + 1;
    if (fileIndex >= query.offset && result.matchingFiles.length < query.limit && addRecord(result, record, state)) result.matchingFiles.push(record);
  }
  if (query.info) return;
  const chosen = indexes.filter((_, index) => base + index >= query.offset && base + index < query.offset + query.limit);
  const print = new Map();
  for (const index of chosen) {
    for (let i = Math.max(0, index - query.search.before); i <= Math.min(lineCount - 1, index + query.search.after); i++) {
      if (!print.has(i)) print.set(i, true);
    }
    print.set(index, false);
  }
  const positions = new Map(matched.positions);
  for (const [index, context] of [...print].sort((a, b) => a[0] - b[0])) {
    const shown = query.annotate && !state.artifact ? excerpt(lines[index], positions.get(index)) : { text: lines[index], omitted: false };
    if (shown.omitted) {
      result.selectionComplete = false;
      if (!result.status.includes("long lines excerpted; narrow the query or use annotate:false")) result.status.push("long lines excerpted; narrow the query or use annotate:false");
    }
    if (!addRecord(result, { path: selection.path, line: selection.lineOffset + index, text: shown.text, context }, state)) break;
  }
  if (result.kind === "file" && base + indexes.length > query.offset + query.limit) result.status.push("selection limit reached");
}
