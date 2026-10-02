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
 * Get the memoized regular-expression matcher for an endpoint section's
 * `filter` setting.
 *
 * Non-plain sections and absent, null, or empty filter values have no
 * matcher. Other values are converted to strings (strings are used as-is)
 * and compiled as regular expressions. Invalid patterns are caught and
 * memoized as null, so they behave like no filter rather than throwing.
 * Compilation is cached by section object and filter value; the cache is
 * cleared when section churn grows it beyond 256 entries.
 *
 * @param {Object} section - Endpoint settings section; required, with no default.
 * @returns {RegExp|null|undefined} The matcher, null for an invalid pattern,
 *   or undefined when no filter applies.
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
 * Mark models whose ids do not match the endpoint's valid filter as secret.
 * If there is no usable matcher or `models` is not a plain object, return
 * `models` unchanged. Otherwise, create a new model map: matching entries
 * retain their original metadata references, while nonmatching entries get
 * a shallow metadata copy with `secret: true` (non-plain metadata becomes an
 * object containing only that flag). Existing matching metadata is not
 * modified. Invalid filter patterns are ignored by {@link modelFilter}.
 *
 * @param {Object} section - Endpoint settings section passed to
 *   {@link modelFilter}; required, with no default.
 * @param {Object|undefined} models - The merged model map; required, with no
 *   default. Non-plain values are returned unchanged.
 * @returns {Object|undefined} The filtered copy when a valid matcher and
 *   plain model map are provided, otherwise the original `models` value.
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
