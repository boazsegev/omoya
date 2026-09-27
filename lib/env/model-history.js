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
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./persist.js";

export const LAST_MODEL_FILE = "last-model.json";
export const LAST_MODEL_LIMIT = 8;

/** @param {object} env @returns {string} the memory file's path */
export function lastModelFile(env) {
  return join(env._settingsDir ?? env._dir, LAST_MODEL_FILE);
}

/** @returns {{endpoint: string, model: string, ts: string}|null} a clean entry, or null */
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
 * @param {object} env
 * @returns {{endpoint: string, model: string, ts: string}[]} newest-first
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
 * @param {object} env
 * @param {{endpoint: string, model: string}} combo
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
