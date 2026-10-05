/**
 * lib/env/model-history.js — the last-model memory (private to Env).
 *
 * `last-model.json` holds a sorted ARRAY of the last 8 DIFFERENT
 * endpoint/model combos, newest first — each entry
 * `{endpoint, model, ts}` (ISO usage timestamp). Setting a model
 * refreshes its entry's timestamp (and re-sorts) or appends a new one,
 * evicting the oldest when full. Selection walks the array and takes
 * the first combo whose endpoint has an AVAILABLE connection right
 * now — an unregistered endpoint (removed config, a lost dynamic or
 * ambient-key connection) is skipped, not fatal, so the memory belongs
 * to no fixed endpoint set.
 *
 * A legacy `{endpoint, model}` record migrates on read: its combos are
 * stamped with the file's mtime (one combo → one entry).
 *
 * A PINNED project (`settings.projects[<cwd>]`, the user's projects.json)
 * also remembers its own last LAST_MODEL_LIMIT pairs in its `models` map
 * (`<endpoint>/<model>` → ISO timestamp); selection prefers them.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./persist.js";
import { isPlainObject } from "./settings.js";
import { settingsView } from "./settings-view.js";

export const LAST_MODEL_FILE = "last-model.json";
export const LAST_MODEL_LIMIT = 8;

/**
 * Build the path to this environment's last-model history file.
 * @param {object} env Environment; uses `_settingsDir` when set, otherwise `_dir`.
 * @returns {string} Path to `last-model.json`.
 */
export function lastModelFile(env) {
  return join(env._settingsDir ?? env._dir, LAST_MODEL_FILE);
}

/**
 * Validate and normalize a history value into a clean entry.
 * @param {*} value Candidate value; must be a non-array object with non-empty string `endpoint` and `model`.
 * @returns {{endpoint: string, model: string, ts: string}|null} Sanitized entry, or `null` if invalid. Invalid/missing timestamps become the Unix epoch.
 */
function entrySanitize(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint : null;
  const model = typeof value.model === "string" ? value.model : null;
  // Both halves are required; the endpoint name may not smuggle a
  // selector slash (a bare model id may contain one).
  if (!endpoint || !model || endpoint === "" || model === ""
    || endpoint.includes("/")) return null;
  const ts = typeof value.ts === "string" && !Number.isNaN(Date.parse(value.ts))
    ? value.ts : new Date(0).toISOString();
  return { endpoint, model, ts };
}

/**
 * Read the raw history: an array migrates nothing, a legacy single-combo
 * record becomes one entry stamped with the file mtime, and malformed
 * content reads as EMPTY. Entries de-duplicate by combo (first — the
 * newest — wins), sort newest-first, and cap at LAST_MODEL_LIMIT.
 * @param {object} env Environment used to locate the history file via `lastModelFile`.
 * @returns {{endpoint: string, model: string, ts: string}[]} Newest-first, deduplicated entries, capped at `LAST_MODEL_LIMIT`; returns an empty array on read or parse failure. Legacy records are stamped from file mtime when available.
 */
export function readHistory(env) {
  const file = lastModelFile(env);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const entries = [];
  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      const entry = entrySanitize(value);
      if (entry) entries.push(entry);
    }
  } else {
    const entry = entrySanitize(parsed);
    if (entry) {
      try {
        entry.ts = statSync(file).mtime.toISOString();
      } catch { /* keep the epoch stamp */ }
      entries.push(entry);
    }
  }
  const seen = new Set();
  return entries
    .filter(({ endpoint, model }) => {
      const key = `${endpoint}/${model}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, LAST_MODEL_LIMIT);
}

/**
 * Persist a selection: refresh the combo's timestamp and re-sort, or
 * append it — evicting the oldest entry when the history is full.
 * @param {object} env Environment used to locate the history file.
 * @param {{endpoint: string, model: string}} combo Selected endpoint/model pair; both fields are expected to be non-empty strings.
 * @returns {void} No value. Reads prior history and atomically writes the updated array; persistence errors may propagate.
 */
export function touchHistory(env, { endpoint, model }) {
  const entries = readHistory(env);
  const key = `${endpoint}/${model}`;
  const next = entries.filter((entry) => `${entry.endpoint}/${entry.model}` !== key);
  // strictly increasing stamps: a pair touched in the same millisecond as
  // the previous newest still sorts after it
  const previous = entries.length > 0 ? Date.parse(entries[0].ts) : 0;
  next.unshift({ endpoint, model, ts: new Date(Math.max(Date.now(), previous + 1)).toISOString() });
  writeJsonAtomic(lastModelFile(env), next.slice(0, LAST_MODEL_LIMIT));
}

/**
 * The pinned project's model memory: `<endpoint>/<model>` → ISO timestamp.
 * @param {object} env Environment whose cwd names the project.
 * @returns {Map<string, string>} Valid entries; empty when the project is not pinned.
 */
export function readProjectHistory(env) {
  const models = env._settings.projects?.[env.cwd]?.models;
  if (!isPlainObject(models)) return new Map();
  return new Map(Object.entries(models).filter(([key, ts]) => key.indexOf("/") > 0 && typeof ts === "string" && !Number.isNaN(Date.parse(ts))));
}

/**
 * Record a selection in the pinned project's memory (no-op when unpinned):
 * the pair gets the newest timestamp; the map keeps LAST_MODEL_LIMIT pairs.
 * @param {object} env Environment whose cwd names the project.
 * @param {{endpoint: string, model: string}} combo Selected pair.
 * @returns {void} Persists through the settings view (projects.json).
 */
export function touchProjectHistory(env, { endpoint, model }) {
  if (!isPlainObject(env._settings.projects?.[env.cwd])) return;
  const key = `${endpoint}/${model}`;
  const others = [...readProjectHistory(env)].filter(([pair]) => pair !== key).sort((a, b) => b[1].localeCompare(a[1]));
  const previous = others.length > 0 ? Date.parse(others[0][1]) : 0;
  const ts = new Date(Math.max(Date.now(), previous + 1)).toISOString();
  settingsView(env).projects[env.cwd].models = Object.fromEntries([[key, ts], ...others.slice(0, LAST_MODEL_LIMIT - 1)]);
}
