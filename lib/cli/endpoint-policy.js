/**
 * lib/cli/endpoint-policy.js — the user-editable endpoint policies the
 * TUI and Web settings menus share: `providers.<endpoint>.disabled`
 * (endpoint only) and `maxActive` (endpoint, or one model through
 * `providers.<endpoint>.models.<model>.maxActive`). Reads come from the
 * Env catalog plus the settings view; writes go through the settings
 * view, which persists only the changed path.
 */

/**
 * Validate a maxActive value: a non-negative integer, `false` (exclude
 * the scope), or `undefined` (inherit).
 * @param {*} value - candidate value
 * @returns {number|false|undefined} the value
 * @throws {TypeError} for any other value
 */
function maxActiveValue(value) {
  if (value === undefined || value === false || (Number.isInteger(value) && value >= 0)) return value;
  throw new TypeError(`maxActive must be a non-negative integer, false, or undefined (inherit); got ${JSON.stringify(value)}`);
}

/**
 * List every endpoint the catalog knows (disabled ones included) with its
 * configured policies and each visible model's configured maxActive.
 * `effective` is the capacity the Agent plugin computed (absent without it).
 * @param {object} env - Env providing models(true) and settings
 * @returns {Array<{name: string, disabled: boolean, maxActive: number|false|undefined, effective: number|undefined, models: Array<{id: string, maxActive: number|false|undefined, effective: number|undefined}>}>}
 */
export function endpointPolicies(env) {
  const out = new Map();
  for (const info of env.models?.(true).values() ?? []) {
    if (info.secret) continue;
    let entry = out.get(info.endpoint);
    if (!entry) {
      const prefs = env.settings?.providers?.[info.endpoint];
      entry = { name: info.endpoint, disabled: info.disabled === true, maxActive: prefs?.maxActive, effective: undefined, models: [] };
      out.set(info.endpoint, entry);
    }
    if (!info.listed) continue;
    const effective = typeof info.maxActive === "number" ? info.maxActive : undefined;
    entry.effective = Math.max(entry.effective ?? 0, effective ?? 0);
    entry.models.push({ id: info.model, maxActive: env.settings?.providers?.[info.endpoint]?.models?.[info.model]?.maxActive, effective });
  }
  return [...out.values()];
}

/**
 * Write (or with `undefined` delete) one settings path through the live
 * settings view, creating missing parent objects; a deletion prunes the
 * parents it empties down to `keep` levels.
 * @param {object} env - Env whose settings view persists the change
 * @param {string[]} path - settings path
 * @param {*} value - new value; undefined deletes
 * @param {number} keep - number of leading path levels never pruned
 * @returns {void}
 */
function settingsWrite(env, path, value, keep) {
  const nodes = [env.settings];
  for (let i = 0; i < path.length - 1; i++) {
    const next = nodes[i][path[i]];
    if (next === null || typeof next !== "object") {
      if (value !== undefined) nodes[i][path[i]] = path.slice(i + 1).reduceRight((inner, key) => ({ [key]: inner }), value);
      return;
    }
    nodes.push(next);
  }
  if (value !== undefined) {
    nodes.at(-1)[path.at(-1)] = value;
    return;
  }
  delete nodes.at(-1)[path.at(-1)];
  for (let i = path.length - 2; i >= keep; i--) {
    if (Object.keys(nodes[i + 1]).length > 0) break;
    delete nodes[i][path[i]];
  }
}

/**
 * Set one endpoint policy. `selector` is `<endpoint>` or, for maxActive
 * only, `<endpoint>/<model>`. `disabled: false` removes the key;
 * `maxActive: undefined` removes the override (inherit).
 * @param {object} env - Env whose settings persist the change
 * @param {string} selector - `<endpoint>` or `<endpoint>/<model>`
 * @param {{disabled?: boolean, maxActive?: number|false|undefined}} change - exactly one policy key
 * @returns {void}
 * @throws {TypeError} for an unknown endpoint, a model-level `disabled`, or invalid values
 */
export function endpointPolicySet(env, selector, change) {
  if (typeof selector !== "string" || selector === "") throw new TypeError("endpointPolicySet: selector must be <endpoint> or <endpoint>/<model>");
  const slash = selector.indexOf("/");
  const endpoint = slash === -1 ? selector : selector.slice(0, slash);
  const model = slash === -1 ? undefined : selector.slice(slash + 1);
  const keys = Object.keys(change ?? {});
  if (keys.length !== 1 || !["disabled", "maxActive"].includes(keys[0])) throw new TypeError("endpointPolicySet: change must hold exactly one of disabled, maxActive");
  if (!endpointPolicies(env).some((entry) => entry.name === endpoint)) throw new TypeError(`endpointPolicySet: unknown endpoint ${JSON.stringify(endpoint)}`);
  if (keys[0] === "disabled") {
    if (model !== undefined) throw new TypeError("endpointPolicySet: disabled applies to an endpoint, not a model");
    if (typeof change.disabled !== "boolean") throw new TypeError("endpointPolicySet: disabled must be a boolean");
    settingsWrite(env, ["providers", endpoint, "disabled"], change.disabled ? true : undefined, 2);
    return;
  }
  const value = maxActiveValue(change.maxActive);
  if (model === undefined || model === "") settingsWrite(env, ["providers", endpoint, "maxActive"], value, 2);
  else settingsWrite(env, ["providers", endpoint, "models", model, "maxActive"], value, 2);
}
