/**
 * lib/env/model-history.js — the last-model memory (private to Env).
 *
 * Settings key `last-model` (the user folder's last-model.json, a catch-all
 * mounted at that key) maps the last LAST_MODEL_LIMIT different
 * `<endpoint>/<model>` pairs to their ISO usage timestamps. Selection walks
 * them newest first and takes the first pair whose endpoint is AVAILABLE now;
 * an unregistered endpoint is skipped, not fatal.
 *
 * A PINNED project (`env.constructor.settings.projects[<cwd>]`, the user's projects.json)
 * keeps the same map in its `models` key; selection prefers it.
 */

import { isPlainObject } from "./settings.js";
import { modelsChanged } from "./models-changed.js";

export const LAST_MODEL_LIMIT = 8;

/** Valid `<endpoint>/<model>` → timestamp entries of a history map, newest first. */
function entries(map) {
  if (!isPlainObject(map)) return [];
  return Object.entries(map)
    .filter(([pair, ts]) => pair.indexOf("/") > 0 && typeof ts === "string" && !Number.isNaN(Date.parse(ts)))
    .sort((left, right) => right[1].localeCompare(left[1]));
}

/** `map` with `pair` as its newest entry, keeping LAST_MODEL_LIMIT pairs. */
function touched(map, pair) {
  const all = entries(map);
  const others = all.filter(([key]) => key !== pair);
  const previous = all.length ? Date.parse(all[0][1]) : 0; // always later than every entry
  const ts = new Date(Math.max(Date.now(), previous + 1)).toISOString();
  return Object.fromEntries([[pair, ts], ...others.slice(0, LAST_MODEL_LIMIT - 1)]);
}

/** The global history, newest first: `[{ endpoint, model, ts }]`. */
export function readHistory(env) {
  return entries(env._sourceGraph.store.read(["last-model"])).map(([pair, ts]) => {
    const slash = pair.indexOf("/");
    return { endpoint: pair.slice(0, slash), model: pair.slice(slash + 1), ts };
  });
}

/** Reread changed settings files (another process may have selected a model), then read the history. */
export async function loadHistory(env) {
  try { await env._sourceGraph.store.poll(); } catch { /* a failing file keeps its last good data */ }
  return readHistory(env);
}

/** Record a selection as the newest pair; saves with the settings. */
export async function touchHistory(env, { endpoint, model }) {
  const node = env._sourceGraph.lastModel;
  node.replace(touched(node.own(), `${endpoint}/${model}`));
  modelsChanged(env);
  await env._sourceGraph.flush();
}

/** The pinned project's history: `<endpoint>/<model>` → ISO timestamp (empty when unpinned). */
export function readProjectHistory(env) {
  return new Map(entries(env.constructor.settings.projects[env.folder]?.models));
}

/** Record a selection in the pinned project's history (no-op when unpinned); saves to projects.json. */
export function touchProjectHistory(env, { endpoint, model }) {
  const pin = env.constructor.settings.projects[env.folder];
  if (!isPlainObject(pin)) return;
  env.constructor.settings.projects[env.folder] = { ...pin, models: touched(pin.models, `${endpoint}/${model}`) };
}
