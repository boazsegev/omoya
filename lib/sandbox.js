/**
 * Sandbox — process ownership primitives. Dispatch owns scope teardown and
 * cancellation policy; tools only spawn through their supplied scope. Worker
 * descendants inherit the worker group so one kill reaches the command tree.
 */
import { ProcessScope, processSpawn, processStop } from "./sandbox/processes.js";
import { osSandboxAvailable, osSandboxKind, osSandboxWrap } from "./sandbox/os.js";

/** Sandbox façade for scoped child processes; dispatch owns teardown. */
export class Sandbox {
  /** Create a process scope owned and closed by one tool dispatch. */
  static scope() {
    return new ProcessScope();
  }

  /** Spawn a process using the same ownership policy as scoped calls. */
  static spawn(file, args, options) {
    return processSpawn(file, args, options);
  }

  /** Stop a process/group and await closure; safe to call repeatedly. */
  static processStop(child, options) {
    return processStop(child, options);
  }

  /**
   * The OS write-sandbox mechanism in effect: "seatbelt", "bwrap",
   * "delegated" (an outer jail already confines this process; the wrap
   * is a passthrough), or null (no enforcement; Agent forces safe mode).
   * @returns {"seatbelt"|"bwrap"|"delegated"|null}
   */
  static osKind() {
    return osSandboxKind();
  }

  /**
   * Is OS write-sandbox enforcement in effect (own mechanism or a
   * detected outer jail)? Probed once per process; no opt-out.
   * @returns {boolean}
   */
  static osAvailable() {
    return osSandboxAvailable();
  }

  /**
   * Wrap a program invocation in the OS write sandbox: the [file, argv]
   * to spawn (unchanged when no mechanism applies).
   * @param {string} file - the program to run
   * @param {string[]} args - its arguments
   * @param {string} [cwd] - the working folder writes are limited to
   * @param {string} [workingDirectory] - the process working folder
   * @returns {[string, string[]]}
   */
  static osWrap(file, args, cwd, workingDirectory) {
    return osSandboxWrap(file, args, cwd, workingDirectory);
  }
}

export default Sandbox;
