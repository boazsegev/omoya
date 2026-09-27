import { spawn } from "node:child_process";
import { NAMES } from "../namespace.js";

const processes = new WeakMap();

/** Spawn policy keeps worker descendants in their worker's owned group. */
export function processSpawn(file, args, options = {}) {
  const group = process.platform !== "win32" && process.env[NAMES.toolWorkerEnv] !== "1";
  const child = spawn(file, args, { ...options, detached: group });
  processRecord(child, group);
  return child;
}

function processRecord(child, group) {
  let record = processes.get(child);
  if (record) return record;
  let finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  record = { group, exited, stopped: false, closed: false };
  const done = () => { record.closed = true; finish(); };
  child.once("close", done);
  child.once("error", done);
  processes.set(child, record);
  return record;
}

/** Idempotent process/group kill; resolves after the process closes its pipes. */
export function processStop(child, { group = false } = {}) {
  const record = processRecord(child, group);
  if (!record.stopped) {
    record.stopped = true;
    if (!record.closed) {
      try {
        if (process.platform !== "win32" && record.group) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { try { child.kill("SIGKILL"); } catch {} }
    }
  }
  return record.exited;
}

/** One dispatch's resources. Retained processes are reusable after success only. */
export class ProcessScope {
  #children = new Map();
  #closed = false;
  #closing;

  spawn(file, args, options, policy) {
    if (this.#closed) throw new Error("tool sandbox is closed");
    const child = processSpawn(file, args, options);
    this.track(child, policy);
    return child;
  }

  track(child, { retain = false, group = true, onStop } = {}) {
    if (this.#closed) {
      onStop?.();
      void processStop(child, { group });
      throw new Error("tool sandbox is closed");
    }
    processRecord(child, group);
    const entries = this.#children.get(child) ?? new Set();
    for (const entry of entries) {
      if (entry.onStop === onStop && entry.retain === retain) return entry.release;
    }
    const entry = { retain, group, onStop };
    entries.add(entry);
    this.#children.set(child, entries);
    const release = () => {
      child.removeListener("close", release);
      child.removeListener("error", release);
      entries.delete(entry);
      if (entries.size === 0) this.#children.delete(child);
    };
    entry.release = release;
    child.once("close", release);
    child.once("error", release);
    return release;
  }

  close({ cancel = false } = {}) {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const pending = [];
    for (const [child, entries] of this.#children) {
      if (cancel || [...entries].some((entry) => !entry.retain)) {
        for (const entry of entries) entry.onStop?.();
        pending.push(processStop(child, { group: [...entries].some((entry) => entry.group) }));
      }
      for (const entry of entries) entry.release();
    }
    this.#closing = Promise.all(pending);
    return this.#closing;
  }
}
