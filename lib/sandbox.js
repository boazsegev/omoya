/**
 * Sandbox — process ownership primitives. Dispatch owns scope teardown and
 * cancellation policy; tools only spawn through their supplied scope. Worker
 * descendants inherit the worker group so one kill reaches the command tree.
 */
import { ProcessScope, processSpawn, processStop } from "./sandbox/processes.js";
import { osSandboxAvailable, osSandboxKind, osSandboxWrap } from "./sandbox/os.js";

/** Sandbox façade for scoped child processes; dispatch owns teardown. */
export class Sandbox {
  /**
   * Create a process scope owned and closed by one tool dispatch.
   * @returns {ProcessScope} A scope for spawning, tracking, and stopping child processes.
   */
  static scope() {
    return new ProcessScope();
  }

  /**
   * Spawn a child process using the sandbox's process-group ownership policy.
   * On non-Windows hosts outside a tool-worker process, the child is detached
   * so its process group can be stopped together. Spawn errors are reported on
   * the returned child process using Node.js child-process events.
   * @param {string} file - Executable to run.
   * @param {string[]} args - Arguments passed to the executable.
   * @param {import("node:child_process").SpawnOptions} [options={}] - Node.js spawn options.
   * @returns {import("node:child_process").ChildProcess} The spawned child process.
   */
  static spawn(file, args, options) {
    return processSpawn(file, args, options);
  }

  /**
   * Stop a child process or its owned process group and wait for it to close.
   * Repeated calls are safe and share the same completion promise. Sends
   * SIGKILL; if group termination fails, it falls back to killing the child.
   * @param {import("node:child_process").ChildProcess} child - Process to stop.
   * @param {{group?: boolean}} [options={}] - Set `group` to true to stop the process group; defaults to false.
   * @returns {Promise<void>} Resolves when the child closes or emits an error.
   */
  static processStop(child, options) {
    return processStop(child, options);
  }

  /**
   * The OS write-sandbox mechanism in effect: "seatbelt", "bwrap",
   * "delegated" (an outer jail already confines this process; the wrap
   * is a passthrough), or null (no enforcement; Agent forces safe mode).
   * @returns {"seatbelt"|"bwrap"|"delegated"|null} The active mechanism, or null if unavailable.
   */
  static osKind() {
    return osSandboxKind();
  }

  /**
   * Is OS write-sandbox enforcement in effect (own mechanism or a
   * detected outer jail)? Probed once per process; no opt-out.
   * @returns {boolean} Whether this process or an enclosing jail enforces write restrictions.
   */
  static osAvailable() {
    return osSandboxAvailable();
  }

  /**
   * Wrap a program invocation in the OS write sandbox: the [file, argv]
   * to spawn (unchanged when no mechanism applies).
   * @param {string} file - Program executable to run.
   * @param {string[]} [args=[]] - Arguments passed to the program.
   * @param {string} [cwd=process.cwd()] - Project folder whose writes are permitted.
   * @param {string} [workingDirectory=cwd] - Working directory for the wrapped process.
   * @returns {[string, string[]]} Executable and argument vector to pass to spawn.
   */
  static osWrap(file, args, cwd, workingDirectory) {
    return osSandboxWrap(file, args, cwd, workingDirectory);
  }
}

export default Sandbox;
