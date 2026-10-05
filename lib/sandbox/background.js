import { processSpawn } from "./processes.js";
import { osSandboxWrap } from "./os.js";
import { childEnv } from "../util.js";

const MAX_RUNNING = 8;
const MAX_RECORDS = 64;
const MAX_BYTES = 256 * 1024;
const GRACE_MS = 1000;
const owners = new WeakMap();

function registry(agent) {
  if (!agent) throw new Error("An Agent is required for background processes");
  let state = owners.get(agent);
  if (!state) {
    state = { next: 0, entries: new Map() };
    owners.set(agent, state);
    agent.onEvent(agent.constructor.EVENT.CLOSE_MARKED, () => stopAll(agent));
  }
  return state;
}

function append(entry, chunk) {
  entry.bytes += chunk.length;
  entry.buffer = Buffer.concat([entry.buffer, chunk]);
  if (entry.buffer.length > MAX_BYTES) entry.buffer = entry.buffer.subarray(entry.buffer.length - MAX_BYTES);
}

function summary(entry) {
  return { id: entry.id, command: entry.command, state: entry.running ? "running" : `exited(${entry.code ?? entry.signal ?? "?"})`, uptime: Date.now() - entry.started, bytes: entry.bytes };
}

function owned(agent, id) {
  if (typeof id !== "string") throw new TypeError("Provide a process id");
  const entry = owners.get(agent)?.entries.get(id);
  if (!entry) throw new Error(`Unknown process id: ${id}`);
  return entry;
}

function signalGroup(entry, signal) {
  try {
    if (process.platform !== "win32" && entry.child.pid) process.kill(-entry.child.pid, signal);
    else entry.child.kill(signal);
  } catch { try { entry.child.kill(signal); } catch {} }
}

function terminate(entry) {
  if (entry.stopping) return entry.done;
  entry.stopping = true;
  // Signal the group even when the shell has exited: descendants can retain pipes.
  signalGroup(entry, "SIGTERM");
  const timer = setTimeout(() => signalGroup(entry, "SIGKILL"), GRACE_MS);
  timer.unref?.();
  // A shell can exit while an ignoring descendant survives; keep escalation armed.
  return entry.done;
}

/** Start a command with the same child env and OS write jail as foreground bash. */
export async function backgroundStart(agent, { command, cwd, env }) {
  if (agent._closeMarked || agent._closed) throw new Error("A live Agent is required for background processes");
  const state = registry(agent);
  if ([...state.entries.values()].filter((entry) => entry.running).length >= MAX_RUNNING) throw new Error(`Background process limit (${MAX_RUNNING}) reached`);
  for (const [id, entry] of state.entries) {
    if (state.entries.size < MAX_RECORDS) break;
    if (!entry.running) state.entries.delete(id);
  }
  if (state.entries.size >= MAX_RECORDS) throw new Error(`Background process record limit (${MAX_RECORDS}) reached`);
  const [file, args] = osSandboxWrap("bash", ["-c", command], cwd, cwd);
  const child = processSpawn(file, args, { cwd, env: childEnv(agent.env.settings, env), stdio: ["ignore", "pipe", "pipe"] });
  const id = String(++state.next);
  const entry = { id, command, child, started: Date.now(), bytes: 0, buffer: Buffer.alloc(0), running: true, stopping: false, code: null, signal: null };
  state.entries.set(id, entry);
  entry.done = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => append(entry, chunk));
    child.stderr.on("data", (chunk) => append(entry, chunk));
    child.once("error", (error) => { entry.code = error.code ?? "error"; entry.running = false; resolve(); });
    child.once("close", (code, signal) => { entry.code = code; entry.signal = signal; entry.running = false; resolve(); });
  });
  let timer;
  await Promise.race([entry.done, new Promise((resolve) => { timer = setTimeout(resolve, GRACE_MS); })]);
  clearTimeout(timer);
  const preview = entry.buffer.subarray(0, 4000);
  return { ...summary(entry), output: preview.toString("utf8"), next: entry.bytes, previewTruncated: entry.bytes > preview.length };
}

/** List only this Agent's processes; completed records remain until Agent close. */
export function backgroundList(agent) {
  return [...(owners.get(agent)?.entries.values() ?? [])].map(summary);
}

/** Read a byte-offset window of one Agent-owned output stream. */
export function backgroundOutput(agent, id, from = 0) {
  if (!Number.isSafeInteger(from) || from < 0) throw new TypeError("from must be a nonnegative byte offset");
  const entry = owned(agent, id);
  const first = entry.bytes - entry.buffer.length;
  if (from > entry.bytes) throw new RangeError("from is beyond the output end");
  return { id, output: entry.buffer.subarray(Math.max(from, first) - first).toString("utf8"), dropped: Math.max(0, first - from), next: entry.bytes, state: summary(entry).state };
}

/** Stop one owned process group, then escalate to SIGKILL if still present. */
export async function backgroundStop(agent, id) {
  const entry = owned(agent, id);
  await terminate(entry);
  return summary(entry);
}

/** Best-effort synchronous teardown on Agent or Env close. */
export function stopAll(agent) {
  const state = owners.get(agent);
  if (!state) return;
  for (const entry of state.entries.values()) if (entry.running) void terminate(entry);
}

/** Stop processes belonging to agents registered with this Env. */
export function stopEnv(env) {
  for (const agent of env.agents?.() ?? []) stopAll(agent);
}
