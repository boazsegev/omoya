/**
 * lib/agent/model-select.js — selector validation (private to Agent):
 * a `<endpoint>/<model>` selector checked against the Env catalog
 * (env.connection — no IO opened). An Agent ADOPTING a selection
 * remembers it as last used unless it is a worker (remember: !parent).
 */

/**
 * @param {object} env
 * @param {string} selector - `<endpoint>/<model>`
 * @param {string} owner - the caller named in error messages
 * @param {{remember?: boolean}} [options]
 * @returns {{endpoint: string, model: string}}
 */
export function modelSelectorParse(env, selector, owner, { remember = false } = {}) {
  try {
    const { endpoint, model } = env.connection(selector, { remember });
    return { endpoint, model };
  } catch (error) {
    throw new TypeError(String(error?.message ?? error).replace(/^Env\.connection/, owner));
  }
}
