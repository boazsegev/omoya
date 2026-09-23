import { spawn } from "node:child_process";

/** The only wake delay: five minutes AFTER exit and both output streams drain. */
export const JOBS_DAEMON_DELAY = 5 * 60 * 1000;
const OUTPUT_LIMIT = 16 * 1024;

/** One cancellable timer, never polling. */
export function daemonDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
function drain(stream) {
  return new Promise((resolve) => {
    let bytes = 0;
    if (!stream) return resolve(0);
    // Retain no task output or secrets. Counts saturate; pipes are always drained.
    stream.on("data", (chunk) => { bytes = Math.min(OUTPUT_LIMIT, bytes + chunk.length); });
    stream.once("close", () => resolve(bytes));
    stream.once("error", () => resolve(bytes));
  });
}
function send(child, message) {
  if (child.connected) child.send(message, () => {});
}

/** Spawn an owned child handle, not a PID; cancellation is cooperative IPC only. */
export function spawnDaemonRun({ runtime, wrapper, root, signal, env }) {
  const child = spawn(runtime, [wrapper, "run"], { cwd: root, env, shell: false, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const output = Promise.all([drain(child.stdout), drain(child.stderr)]);
  const cancel = () => send(child, { type: "jobs-cancel" });
  child.on("message", (message) => {
    if (message?.type !== "jobs-run-ready") return;
    send(child, { type: "jobs-run", cancelled: signal.aborted });
  });
  signal.addEventListener("abort", cancel, { once: true });
  const closed = new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, error: "JOBS_DAEMON_SPAWN" }));
    child.once("close", (code) => resolve({ code }));
  });
  return (async () => {
    try { const result = await closed; return { ...result, outputBytes: await output }; }
    finally { signal.removeEventListener("abort", cancel); }
  })();
}

/** Serial fixed-delay loop. Dependencies permit deterministic clocks and spawns. */
export async function daemonLoop({ signal, childSignal, admit, launch, state, delay = daemonDelay }) {
  while (!signal.aborted) {
    if (!await admit() || signal.aborted) break;
    state("running");
    try { await launch(childSignal); }
    catch { /* A failed wake gets the same post-completion delay, never an immediate retry. */ }
    if (signal.aborted) break;
    state("waiting");
    await delay(JOBS_DAEMON_DELAY, signal);
  }
}
