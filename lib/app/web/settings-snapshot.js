/** Settings publication owns the browser boundary, not Env's storage schema. */

/**
 * Copy the complete effective settings view for browser consumers, including
 * defaults and unknown plugin keys. Provider authentication stays server-side:
 * all `auth` subtrees are omitted, matching Env's auth:false read policy.
 * @param {object} settings Live Env settings view; neither mutated nor retained.
 * @returns {object} Detached JSON snapshot. Arrays replace, absent keys disappear.
 * @throws {TypeError} If settings contain values that cannot be JSON serialized.
 */
export function settingsSnapshot(settings) {
  return JSON.parse(JSON.stringify(settings, (key, value) => key === "auth" ? undefined : value));
}
