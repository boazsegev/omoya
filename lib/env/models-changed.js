/**
 * lib/env/models-changed.js — the native catalog event (private to Env;
 * published as Env.EVENT.MODELS_CHANGED): whatever changes what
 * env.models() answers (a model list arrives, credentials or the
 * loginRequired mark change, endpoints appear or go, a setting moves)
 * announces it here, coalesced to one event per tick.
 */

/** The native catalog event: re-read env.models(). */
export const MODELS_CHANGED = Symbol("models-changed");

/**
 * Invalidate the model cache and announce a catalog change, coalescing
 * announcements until the queued microtask runs.
 *
 * @param {object} env - Environment whose model cache and event queue are updated.
 * @returns {void} No value is returned; the event is emitted asynchronously.
 * @throws {TypeError} If `env` cannot be written to while invalidating or queuing.
 * @effects Sets `env._modelsCache` to `null`. On the first call before the
 *   microtask runs, sets `env._modelsChangedQueued` and queues a microtask that
 *   clears the flag and optionally emits `MODELS_CHANGED` with an empty payload.
 */
export function modelsChanged(env) {
  env._modelsCache = null;
  if (env._modelsChangedQueued) return;
  env._modelsChangedQueued = true;
  queueMicrotask(() => {
    env._modelsChangedQueued = false;
    env._emitEvent?.(MODELS_CHANGED, {});
  });
}
