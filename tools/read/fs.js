/** Guarded filesystem access and finite query budgets. No concurrent hostile-tree confinement claim. */
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { toolRevision } from "../../lib/tool-runtime.js";
const { rejectSymlinkPath, resolveCwdPath } = await import(`../guard/resolve.js?now=${toolRevision()}`);

export const READ_DEFAULTS = Object.freeze({
  scanBytes: 64 * 1024 * 1024, files: 10000, entries: 20000,
  outputBytes: 64 * 1024, artifactBytes: 16 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024, grepFileSizeLimit: 5 * 1024 * 1024,
  regexMs: 1000, timeoutMs: 30000,
});

export class ReadBudgetError extends Error {
  constructor(message) { super(message); this.name = "ReadBudgetError"; }
}

/** Host settings only; invalid/nonpositive budgets cannot disable limits. */
export function readBudgets(context) {
  const settings = context?.env?.settings?.read ?? context?.agent?.env?.settings?.read ?? {};
  return Object.fromEntries(Object.entries(READ_DEFAULTS).map(([key, value]) => [key,
    Number.isSafeInteger(settings[key]) && settings[key] > 0 ? settings[key] : value]));
}

export function readScope(context) {
  const cwd = context?.agent?.folder ?? context?.env?.cwd ?? context?.agent?.env?.cwd ?? process.cwd();
  return { cwd: resolve(cwd), boundary: resolve(context?.env?.cwd ?? context?.agent?.env?.cwd ?? cwd) };
}

export function createReadState(context, artifact = false) {
  const budgets = readBudgets(context);
  return { budgets, scope: readScope(context), signal: context?.signal,
    deadline: Math.min(context?.deadline ?? Infinity, Date.now() + budgets.timeoutMs),
    scanned: 0, files: 0, entries: 0, output: 0,
    outputLimit: artifact ? budgets.artifactBytes : budgets.outputBytes };
}

export function checkReadState(state) {
  state.signal?.throwIfAborted();
  if (Date.now() >= state.deadline) throw new ReadBudgetError("read time budget exhausted");
}

export function charge(state, key, amount) {
  checkReadState(state);
  const budgetKey = { scanned: "scanBytes", files: "files", entries: "entries" }[key];
  if (state[key] + amount > state.budgets[budgetKey]) throw new ReadBudgetError(`read ${budgetKey} budget exhausted`);
  state[key] += amount;
}

export function relativeReadPath(abs, state) {
  return relative(state.scope.cwd, abs).split(sep).join("/") || ".";
}

export async function guardedPath(path, state) {
  checkReadState(state);
  const abs = resolveCwdPath(path, state.scope);
  await rejectSymlinkPath(abs, { cwd: state.scope.boundary });
  const metadata = await lstat(abs);
  if (metadata.isSymbolicLink()) throw new Error("symbolic links are refused");
  if (!metadata.isFile() && !metadata.isDirectory()) throw new Error("Choose a regular file or folder; special files are refused");
  return { abs, metadata };
}

/** Inspect every component, then no-follow open and verify the opened regular-file identity. Caller closes. */
export async function openReadFile(abs, state) {
  checkReadState(state);
  const inspected = await guardedPath(relativeReadPath(abs, state), state);
  if (!inspected.metadata.isFile()) throw new Error("Choose a regular file, not a folder");
  const handle = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== inspected.metadata.dev || metadata.ino !== inspected.metadata.ino) throw new Error("File changed during guarded open");
    checkReadState(state);
    return { handle, metadata };
  } catch (error) { await handle.close(); throw error; }
}

export async function readChunk(handle, position, length, state) {
  checkReadState(state);
  const remaining = state.budgets.scanBytes - state.scanned;
  if (length > remaining) throw new ReadBudgetError("read scanBytes budget exhausted");
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    checkReadState(state);
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw new ReadBudgetError("File changed or ended during read; retry the query");
    charge(state, "scanned", bytesRead);
    offset += bytesRead;
  }
  return buffer;
}

/** Directory memory is bounded by the entries budget; order is locale-independent. */
export async function directoryEntries(abs, state) {
  await guardedPath(relativeReadPath(abs, state), state);
  const folder = await opendir(abs);
  const entries = [];
  try {
    for await (const entry of folder) { charge(state, "entries", 1); entries.push(entry); }
  } finally {
    await folder.close().catch((error) => { if (error.code !== "ERR_DIR_CLOSED") throw error; });
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
