/**
 * lib/agent/model-select.js — selector validation (private to Agent):
 * a `<endpoint>/<model>` selector checked against the Env catalog
 * (env.connection — no IO opened). An Agent ADOPTING a selection
 * remembers it as last used unless it is a worker (remember: !parent).
 */

/**
 * Validate and resolve an endpoint/model selector through the Env catalog without opening IO.
 * @param {object} env
 * @param {string} selector - `<endpoint>/<model>` selector to validate
 * @param {string} owner - caller name substituted into Env.connection-prefixed errors
 * @param {{remember?: boolean}} [options] - options object; `remember` defaults to `false`
 * @returns {string} Validated qualified model selector
 * @throws {TypeError} If Env.connection rejects the selector; wraps its message with `owner`
 * @sideEffects When `remember` is true, Env.connection may record the selection as last used
 */
export function modelSelectorValidate(env, selector, owner, { remember = false } = {}) {
  try {
    env.connection(selector, { remember });
    return selector;
  } catch (error) {
    throw new TypeError(String(error?.message ?? error).replace(/^Env\.connection/, owner));
  }
}
