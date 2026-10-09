import Agent from "../../agent.js";

let signalDisarm = null;

/**
 * Arm process termination signals to run Agent's synchronous finish hooks,
 * then re-raise the received signal so the process retains signal exit semantics.
 * Repeated arming returns the existing disarm function without changing options.
 * This is an opt-in CLI binding; it is not suitable for asynchronous cancellation.
 * @param {Object} [options] Signal-arming options.
 * @param {NodeJS.Process} [options.process=process] Process on which to install handlers and call `kill`.
 * @param {string[]} [options.signals=["SIGINT", "SIGTERM", "SIGHUP"]] Signals to handle.
 * @returns {() => void} Idempotent function that removes these signal handlers and permits rearming.
 * @effects Registers a process exit listener (once per process) and handlers for the selected signals. On a signal, runs Agent.finishRun(), removes the signal handlers, then calls process.kill(process.pid, signal). Finish callbacks may run again on exit and must be synchronous and idempotent.
 */
export function finishSignalsArm({
  process: proc = process,
  signals = ["SIGINT", "SIGTERM", "SIGHUP"],
} = {}) {
  if (signalDisarm) return signalDisarm;
  // Register the exit backstop even when no cleanup was added yet. The
  // no-op is removed immediately; Agent owns the listener and registry.
  Agent.finishAdd(() => {}, { process: proc })();
  const handlers = signals.map((sig) => {
    const handler = () => {
      Agent.finishRun();
      disarm();
      proc.kill(proc.pid, sig);
    };
    proc.on(sig, handler);
    return [sig, handler];
  });
  let armed = true;
  function disarm() {
    if (!armed) return;
    armed = false;
    for (const [sig, handler] of handlers) proc.off(sig, handler);
    signalDisarm = null;
  }
  signalDisarm = disarm;
  return disarm;
}
