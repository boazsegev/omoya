/** One server-wide exit request and one timer, shared by every served Env. */
import Agent from "../../agent.js";
import Sandbox from "../../sandbox.js";

/** Create the app exit controller. The host owns disposal and the injected process/clock. */
export function createExitController(registry, { stop, clock = globalThis, proc = process, duration = 60_000 } = {}) {
  let requested = false;
  let finished = false;
  let timer;
  const handles = new Map();
  const clear = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; };
  const idle = () => registry.entries.every(({ env }) => env.agents().every((agent) => agent.busy === false));
  const finish = async (crash) => {
    if (finished) return;
    finished = true;
    clear();
    if (crash) {
      // Sandbox owns the tracked child groups (retained tools, dispatch workers
      // and MCP). Signal them before abort; no graceful provider wait or PID scan.
      Sandbox.processesKill();
      proc.abort();
      return;
    }
    try { await stop(); proc.exit(0); }
    catch (error) {
      proc.stderr?.write?.(`web exit cleanup: ${error?.message ?? error}\n`);
      proc.exit(1);
    }
  };
  const schedule = () => {
    if (!requested || finished) return;
    clear();
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (idle()) void finish(false).catch((error) => { proc.stderr?.write?.(`web exit: ${error?.message ?? error}\n`); proc.exit(1); });
      // A busy check does not re-arm. Only the next request terminal event may.
    }, duration);
  };
  const watch = (agent) => {
    if (handles.has(agent)) return;
    handles.set(agent, [Agent.EVENT.REQUEST_DONE, Agent.EVENT.REQUEST_ERROR]
      .map((event) => agent.onEvent(event, schedule)));
  };
  const unwatch = (agent) => {
    for (const handle of handles.get(agent) ?? []) agent.offEvent(handle);
    handles.delete(agent);
  };
  const envHandles = new Map();
  const watchEnv = (env) => {
    if (envHandles.has(env)) return;
    for (const agent of env.agents()) watch(agent);
    envHandles.set(env, [env.onEvent(env.constructor.EVENT.AGENT_ADDED, ({ agent }) => watch(agent)),
      env.onEvent(env.constructor.EVENT.AGENT_REMOVED, ({ agent }) => unwatch(agent))]);
  };
  const forgetEnv = (env) => {
    for (const handle of envHandles.get(env) ?? []) env.offEvent(handle);
    envHandles.delete(env);
    for (const agent of [...handles.keys()]) if (agent.env === env) unwatch(agent);
  };
  const dispose = () => { finished = true; clear(); for (const env of [...envHandles.keys()]) forgetEnv(env); };
  const request = () => {
    if (finished) return;
    if (requested) {
      void finish(true).catch((error) => { proc.stderr?.write?.(`web owned-process kill: ${error?.message ?? error}\n`); proc.abort(); });
      return;
    }
    requested = true;
    if (idle()) void finish(false).catch((error) => { proc.stderr?.write?.(`web exit: ${error?.message ?? error}\n`); proc.exit(1); });
    else schedule();
    return true;
  };
  return { request, get requested() { return requested; }, watchEnv, forgetEnv, dispose };
}
