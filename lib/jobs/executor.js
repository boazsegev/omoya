/** Isolated bounded Agent workers; local teardown does not guarantee remote cancellation. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./worker.js", import.meta.url));
/** User-visible limit on process-group teardown and accepted remote side effects. */
export const JOBS_TERMINATION_CAVEAT = "Remote work already accepted may outlive local termination; exactly-once external effects are not guaranteed. Deliberately daemonized children can escape the local process group.";
const OUTCOMES = new Set(["completed", "failed", "blocked", "cancelled", "timed-out"]);

/** Fresh isolated worker per call; resolves only after worker exit and group teardown.
 * startupTimeout bounds Env/model discovery; effective IO timeout bounds total
 * execution from spawn (not per retry). AbortSignal cancels via Agent first,
 * then a fixed grace deadline forcibly kills the whole inherited process group.
 * POSIX only: fail closed where process-group teardown is unavailable.
 */
export function createJobExecutor(projectRoot, options = {}) {
  return async (task) => {
    const session = `job-${crypto.randomUUID()}`;
    const terminal = (outcome, code, warning) => ({ outcome, session, ...(code ? { code } : {}), ...(warning ? { warning } : {}), caveat: JOBS_TERMINATION_CAVEAT });
    if (process.platform === "win32") return terminal("blocked", "JOBS_PLATFORM_BLOCKED");
    if (options.signal?.aborted) return terminal("cancelled", "JOBS_CANCELLED");
    const started = Date.now();
    return new Promise((resolve) => {
      let child, timer, hardTimer, settled = false, stopping = null, result = null;
      const kill = () => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(hardTimer);
        options.signal?.removeEventListener("abort", abort);
        // Even successful workers may have left ordinary command children behind.
        kill();
        resolve(stopping ?? result ?? terminal("failed", "JOBS_WORKER_FAILED"));
      };
      const workerFailed = () => {
        // An IPC failure means the worker cannot produce a trustworthy terminal
        // message.  Tear down its group, but still wait for its exit when it ran.
        if (settled || stopping || result) return;
        result = terminal("failed", "JOBS_WORKER_FAILED");
        clearTimeout(timer);
        if (!child?.pid) return finish();
        kill();
      };
      const send = (message, onFailure = workerFailed) => {
        try {
          if (typeof child?.send !== "function") throw new TypeError("worker IPC is unavailable");
          child.send(message, (error) => { if (error) onFailure(); });
        } catch { onFailure(); }
      };
      const stop = (outcome, code) => {
        if (settled || stopping) return;
        stopping = terminal(outcome, code);
        clearTimeout(timer);
        // Cancellation is best effort: an unavailable IPC channel must not keep
        // the executor from reaching its grace-deadline group teardown.
        send({ type: "cancel" }, () => {});
        hardTimer = setTimeout(kill, options.cancelGrace ?? 250);
      };
      const abort = () => stop("cancelled", "JOBS_CANCELLED");
      const arm = (duration) => {
        clearTimeout(timer);
        if (!Number.isFinite(duration) || duration <= 0) return stop("failed", "JOBS_TIMEOUT_INVALID");
        timer = setTimeout(() => stop("timed-out", "JOBS_TIMED_OUT"), Math.min(2_147_483_647, Math.max(1, duration - (Date.now() - started))));
      };
      try {
        child = (options.spawnImpl ?? spawn)(process.execPath, [options.worker ?? WORKER], {
          cwd: projectRoot, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: options.env ?? process.env,
        });
      } catch { resolve(terminal("failed", "JOBS_WORKER_SPAWN")); return; }
      child.on("message", (message) => {
        if (settled || stopping) return;
        if (message?.type === "ready") arm(message.timeout);
        if (message?.type === "terminal" && OUTCOMES.has(message.outcome)) {
          result = terminal(message.outcome, message.code, message.warning);
          // A result does not prove worker exit: cleanup is still deadline-bound.
          clearTimeout(timer);
          hardTimer = setTimeout(kill, options.cancelGrace ?? 250);
        }
        options.onMessage?.(message);
      });
      child.on("error", workerFailed);
      child.on("exit", finish);
      options.signal?.addEventListener("abort", abort, { once: true });
      arm(task.timeout ?? options.startupTimeout ?? 60_000);
      send({ type: "start", task, projectRoot, session: session, environment: options.environment, model: options.model });
      if (options.signal?.aborted) abort();
    });
  };
}
