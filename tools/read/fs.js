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
  const project = context?.env?.cwd ?? context?.agent?.env?.cwd ?? cwd;
  return { cwd: resolve(cwd), project: resolve(project), boundary: resolve(cwd) };
}

/** Reads may use either the Agent tree or the Env project tree, never a third tree. */
export function selectReadBoundary(path, scope) {
  const target = resolve(scope.cwd, path);
  const inside = (root) => target === root || target.startsWith(`${root}${sep}`);
  scope.boundary = inside(scope.cwd) ? scope.cwd : scope.project;
  if (!inside(scope.boundary)) throw new Error("path traversal refused: read path escapes the agent and project boundary");
}

export function createReadState(context, artifact = false) {
  const budgets = readBudgets(context);
  return { budgets, artifact, scope: readScope(context), signal: context?.signal,
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

const safeErrors = new WeakSet();

function errorPath(error, state) {
  if (typeof error?.path !== "string") return undefined;
  const abs = resolve(state.scope.cwd, error.path);
  const projectPath = relative(state.scope.boundary, abs);
  return projectPath === ".." || projectPath.startsWith(`..${sep}`) ? "[outside allowed folders]" : relativeReadPath(abs, state);
}

/** Rebuild filesystem failures without native messages, causes or absolute stack locations. */
export function readError(error, state) {
  if (error && typeof error === "object" && safeErrors.has(error)) return error;
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : undefined;
  const path = errorPath(error, state);
  const syscall = typeof error?.syscall === "string" && /^[a-zA-Z]+$/.test(error.syscall) ? error.syscall : undefined;
  const message = code ? `${code}: ${syscall ?? "filesystem operation"} failed${path ? `, ${JSON.stringify(path)}` : ""}` : String(error?.message ?? "read failed");
  const ErrorType = error instanceof TypeError ? TypeError : Error;
  const safe = new ErrorType(message.replaceAll(state.scope.cwd, ".").replaceAll(state.scope.boundary, "."));
  safe.name = error instanceof TypeError ? "TypeError" : error instanceof ReadBudgetError ? "ReadBudgetError" : "Error";
  if (code) safe.code = code;
  if (path) safe.path = path;
  if (syscall) safe.syscall = syscall;
  safe.stack = `${safe.name}: ${safe.message}`;
  safeErrors.add(safe);
  return safe;
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
  const folder = await opendir(abs, { bufferSize: Math.min(256, state.budgets.entries) });
  const entries = [];
  try {
    for await (const entry of folder) { charge(state, "entries", 1); entries.push(entry); }
  } finally {
    await folder.close().catch((error) => { if (error.code !== "ERR_DIR_CLOSED") throw error; });
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
