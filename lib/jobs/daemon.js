import { fileURLToPath } from "node:url";
import { jobsPaths } from "./paths.js";
import { validateJobsOperational } from "./operations.js";
import { daemonLoop, spawnDaemonRun } from "./daemon-loop.js";

const RUN_WRAPPER = fileURLToPath(new URL("../../bin/scripts/jobs", import.meta.url));

/**
 * Run a foreground, cwd-bound best-effort daemon. No daemon identity or control
 * record is persisted; multiple foreground daemons may run concurrently.
 */
export async function foregroundJobsDaemon(projectRoot, options = {}) {
  const initial = await validateJobsOperational(projectRoot);
  const root = initial.projectRoot;
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    await options.ready?.({ state: "running" });
    await daemonLoop({
      signal: controller.signal,
      childSignal: controller.signal,
      state: options.state ?? (() => {}),
      admit: async () => {
        try { await validateJobsOperational(root); return true; }
        catch { return false; }
      },
      launch: (signal) => (options.launch ?? spawnDaemonRun)({ runtime: process.execPath, wrapper: RUN_WRAPPER, root, signal, env: process.env }),
      ...(options.delay ? { delay: options.delay } : {}),
    });
    return { state: "exited" };
  } finally { options.signal?.removeEventListener("abort", stop); }
}

