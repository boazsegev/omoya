/**
 * lib/agent/hooks.js — trusted extension observers of existing Agent events.
 *
 * Scan only `hooks/*.js` in the package root, installed extension roots, and
 * the user settings folder (in that order, no project layer or extra path
 * setting). Each module exports `hooks(env)` returning an object whose keys
 * are numeric Agent.EVENT values and whose values are `(payload, agent) => *`.
 * Example: `export const hooks = (env) => ({ [Agent.EVENT.MESSAGE_COMMITTED]:
 *   (message, agent) => { /* observe message; do not alter the turn *\/ } });`
 * Import Agent from `lib/agent.js` if needed, or use the documented numeric
 * constants. Hooks run in a microtask and are never awaited by a turn. Failures
 * (sync or async) reach the Agent.LOG diagnostic stream once per file/event;
 * they cannot propagate back into the turn. Refresh replaces existing listeners
 * and reimports files with the tool refresh revision. Missing folders do nothing.
 */
import { readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EVENT } from "./events.js";

/** Refresh all hook registrations, including already-registered agents. */
export async function refreshHooks(environment) {
  const validEvents = new Set(Object.values(EVENT));
  const seen = new Set();
  const roots = [environment._dir, ...(environment._extensionRoots ?? []), environment._settingsDir]
    .filter(Boolean).map((root) => join(root, "hooks")).filter((root) => {
      let id;
      try { id = realpathSync(root); } catch { id = resolve(root); }
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const entries = [];
  for (const root of roots) {
    let files;
    try { files = readdirSync(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".js")).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, file.name);
      const mod = await import(`${pathToFileURL(path).href}?v=${environment.toolRevision?.() ?? 0}`);
      if (typeof mod.hooks !== "function") throw new TypeError(`Env: ${path} must export hooks(env)`);
      const declared = mod.hooks(environment);
      if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
        throw new TypeError(`Env: ${path} hooks(env) must return an event-to-function object`);
      }
      for (const [key, fn] of Object.entries(declared)) {
        const event = Number(key);
        if (!validEvents.has(event) || String(event) !== key || typeof fn !== "function") {
          throw new TypeError(`Env: ${path} invalid Agent hook event/function ${key}`);
        }
        entries.push({ path, event, fn });
      }
    }
  }
  // Validation/import failures leave the previous hook set intact.
  for (const [agent, handles] of environment._hookHandles ?? []) {
    for (const handle of handles) agent.offEvent(handle);
  }
  environment._hookLogEvent = EVENT.LOG;
  environment._hookEntries = entries;
  environment._hookFailures = new Set();
  environment._hookHandles = new Map();
  for (const agent of environment.agents?.() ?? []) attachHooks(environment, agent);
}

/** Subscribe one newly registered agent to the currently loaded hooks. */
export function attachHooks(environment, agent) {
  if (!environment._hookEntries?.length || environment._hookHandles?.has(agent)) return;
  const handles = environment._hookEntries.map(({ path, event, fn }) => agent.onEvent(event, (payload) => {
    // Decouple observer execution from the synchronous Agent event delivery.
    queueMicrotask(() => {
      try {
        Promise.resolve(fn(payload, agent)).catch((error) => reportFailure(environment, agent, path, event, error));
      } catch (error) { reportFailure(environment, agent, path, event, error); }
    });
  }));
  environment._hookHandles.set(agent, handles);
}

/** Release registrations on close without retaining a closed Agent. */
export function detachHooks(environment, agent) {
  const handles = environment._hookHandles?.get(agent);
  if (!handles) return;
  for (const handle of handles) agent.offEvent(handle);
  environment._hookHandles.delete(agent);
}

/** Failure diagnostics use the existing Agent.LOG stream, not stdout/console. */
function reportFailure(environment, agent, path, event, error) {
  const key = `${path}:${event}`;
  if (environment._hookFailures.has(key)) return;
  environment._hookFailures.add(key);
  try { agent._emit(environment._hookLogEvent, `Env: hook ${path} event ${event} failed: ${error?.message ?? String(error)}`); }
  catch { /* a diagnostic listener must not affect the turn either */ }
}
