import { spawn } from "node:child_process";
import { NAMES } from "../namespace.js";

const processes = new WeakMap();

/**
 * Spawn a child process and register its lifecycle for sandbox cleanup.
 * Outside a tool-worker process on non-Windows platforms, the child is detached
 * so its descendants can be killed as an owned process group.
 * @param {string} file Executable to run.
 * @param {string[]} args Arguments passed to the executable.
 * @param {import("node:child_process").SpawnOptions} [options={}] Options forwarded to `child_process.spawn` (with the sandbox's `detached` policy taking precedence).
 * @returns {import("node:child_process").ChildProcess} The spawned child; spawn failures are reported through its `error` event (invalid arguments may also throw).
 */
export function processSpawn(file, args, options = {}) {
  const group = process.platform !== "win32" && process.env[NAMES.toolWorkerEnv] !== "1";
  const child = spawn(file, args, { ...options, detached: group });
  processRecord(child, group);
  return child;
}

/**
 * Get or create the lifecycle record associated with a child process.
 * Installs one-time listeners that mark the record closed and resolve its exit promise.
 * @param {import("node:child_process").ChildProcess} child Child process to record.
 * @param {boolean} group Whether the child belongs to a process group that can be signalled as a unit.
 * @returns {{ group: boolean, exited: Promise<void>, stopped: boolean, closed: boolean }} The shared lifecycle record.
 */
function processRecord(child, group) {
  let record = processes.get(child);
  if (record) return record;
  let finish;
  const exited = new Promise(/** Capture the resolver used by lifecycle completion. @param {(value: void | PromiseLike<void>) => void} resolve Resolve the exit promise. @returns {void} */ (resolve) => { finish = resolve; });
  record = { group, exited, stopped: false, closed: false };
  /** Mark the record closed and resolve its exit promise after child close/error. @returns {void} */
  const done = () => { record.closed = true; finish(); };
  child.once("close", done);
  child.once("error", done);
  processes.set(child, record);
  return record;
}

/**
 * Idempotently kill a child or its owned process group.
 * The returned promise resolves when the child's `close` or `error` event fires,
 * which indicates its stdio streams have closed. Kill failures are swallowed;
 * a failed group kill falls back to killing the child directly.
 * @param {import("node:child_process").ChildProcess} child Child process to stop.
 * @param {{group?: boolean}} [options={}] Stop policy; `group` defaults to `false` and selects negative-PID group signalling on non-Windows platforms.
 * @returns {Promise<void>} Promise resolved after lifecycle closure.
 */
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

/**
 * Own the child processes created or tracked during one tool dispatch.
 * Retained children survive a normal close, but cancellation stops all children.
 */
export class ProcessScope {
  #children = new Map();
  #closed = false;
  #closing;

  /**
   * Spawn and track a child in this scope.
   * @param {string} file Executable to run.
   * @param {string[]} args Arguments passed to the executable.
   * @param {import("node:child_process").SpawnOptions} [options={}] Options forwarded to process spawning; defaults to `{}`.
   * @param {{retain?: boolean, group?: boolean, onStop?: () => void}} [policy={}] Tracking policy passed to {@link ProcessScope.track}; omitted values use that method's defaults.
   * @returns {import("node:child_process").ChildProcess} The spawned child.
   * @throws {Error} If the scope is already closed; underlying spawn argument errors may also throw.
   */
  spawn(file, args, options, policy) {
    if (this.#closed) throw new Error("tool sandbox is closed");
    const child = processSpawn(file, args, options);
    this.track(child, policy);
    return child;
  }

  /**
   * Track a child so scope closure can stop it when required.
   * Duplicate registrations with the same `onStop` and `retain` policy reuse
   * the existing release function. If already closed, the callback runs, the
   * child is stopped asynchronously, and this method throws.
   * @param {import("node:child_process").ChildProcess} child Child process to track.
   * @param {{retain?: boolean, group?: boolean, onStop?: () => void}} [options={}] Policy: `retain` defaults to `false`, `group` to `true`, and `onStop` is an optional zero-argument callback invoked before stopping.
   * @returns {() => void} Function that removes this registration and its lifecycle listeners.
   * @throws {Error} If the scope is closed; an exception from `onStop` also propagates.
   */
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
    /** Release this registration and detach its close/error listeners. @returns {void} */
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

  /**
   * Close the scope and stop children that are not retained, or every child on cancellation.
   * All registrations are released immediately; the returned promise waits for
   * every selected child to close. Repeated calls share the same promise.
   * @param {{cancel?: boolean}} [options={}] Close policy; `cancel` defaults to `false`.
   * @returns {Promise<void>} Promise resolved when all selected children close.
   * @throws {Error} If a registered `onStop` callback throws.
   */
  close({ cancel = false } = {}) {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const pending = [];
    for (const [child, entries] of this.#children) {
      if (cancel || [...entries].some(/** Select registrations requiring a stop. @param {{retain: boolean}} entry Child tracking registration. @returns {boolean} True when it is not retained. */ (entry) => !entry.retain)) {
        for (const entry of entries) entry.onStop?.();
        pending.push(processStop(child, { group: [...entries].some(/** Determine whether any registration requests group signalling. @param {{group: boolean}} entry Child tracking registration. @returns {boolean} True when group signalling is requested. */ (entry) => entry.group) }));
      }
      for (const entry of entries) entry.release();
    }
    this.#closing = Promise.all(pending);
    return this.#closing;
  }
}
