/**
 * lib/env/model-filter.js — the endpoint `filter` setting: a regex
 * SOURCE STRING (e.g. "(luna|sol|astra)") limiting which models an
 * endpoint publishes. Every model whose id does NOT match is marked
 * `secret: true` in the merged model map endpointSettings returns,
 * so selectors, menus, completions, and the last-model memory hide
 * them through the existing secret path (an explicit `secret: false`
 * metadata entry on a matching key survives). An absent or empty
 * filter leaves the map untouched; an invalid pattern is a NO-OP —
 * a typo must never break the endpoint.
 *
 * Compilation is lazy and memoized on the owning endpoint section +
 * filter value: the models-map merge below builds a fresh object per
 * call, so an uncompiled filter would otherwise recompile on every
 * endpointSettings() call (every request, every menu redraw).
 */

import { isPlainObject } from "./settings.js";

/** section+filter -> RegExp|null|undefined (null = invalid pattern) */
const compiled = new Map();

/**
 * The compiled matcher for one endpoint section's `filter`, or
 * undefined (no filter) / null (invalid — treat as no filter).
 * @param {Object} section - a merged endpoint section (endpointSettings)
 * @returns {RegExp|null|undefined}
 */
export function modelFilter(section) {
  if (!isPlainObject(section)) return undefined;
  const source = section.filter;
  if (source === undefined || source === null || source === "") return undefined;
  let byFilter = compiled.get(section);
  if (byFilter === undefined) {
    if (compiled.size > 256) compiled.clear(); // pathological section churn: bound the cache
    byFilter = new Map();
    compiled.set(section, byFilter);
  } else if (byFilter.has(source)) {
    return byFilter.get(source);
  }
  let matcher = null;
  try {
    matcher = new RegExp(typeof source === "string" ? source : String(source));
  } catch {
    // null: invalid pattern — the filter silently matches everything.
  }
  byFilter.set(source, matcher);
  return matcher;
}

/**
 * Mark every model whose id the filter does NOT match as
 * `secret: true`. Returns the input untouched when there is no
 * (valid) filter or no model map.
 * @param {Object} section - the merged endpoint section
 * @param {Object|undefined} models - the merged model map
 * @returns {Object|undefined} the filtered (or original) model map
 */
export function applyModelFilter(section, models) {
  if (!isPlainObject(models)) return models;
  const matcher = modelFilter(section);
  if (!(matcher instanceof RegExp)) return models;
  const out = {};
  for (const [id, meta] of Object.entries(models)) {
    out[id] = matcher.test(id)
      ? meta
      : { ...(isPlainObject(meta) ? meta : {}), secret: true };
  }
  return out;
}
