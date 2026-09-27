/**
 * lib/env/models-changed.js — the native catalog event (private to Env;
 * published as Env.EVENT.MODELS_CHANGED): whatever changes what
 * env.models() answers (a model list arrives, credentials or the
 * loginRequired mark change, endpoints appear or go, a setting moves)
 * announces it here, coalesced to one event per tick.
 */

/** The native catalog event: re-read env.models(). */
export const MODELS_CHANGED = Symbol("models-changed");

/** Announce a catalog change once per tick (the cached catalog drops at once). */
export function modelsChanged(env) {
  env._modelsCache = null;
  if (env._modelsChangedQueued) return;
  env._modelsChangedQueued = true;
  queueMicrotask(() => {
    env._modelsChangedQueued = false;
    env._emitEvent?.(MODELS_CHANGED, {});
  });
}
