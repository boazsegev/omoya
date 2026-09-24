/** Endpoint/model selection and last-used persistence. */

import { join } from "node:path";
import Env from "../env.js";
const { writeJsonAtomic } = Env;

const LAST_COMBO_FILE = "last-model.json";

/** @returns {{endpoint?: string, model: string}|null} the last-used combo, or null when none is stored */
export function readLastCombo(env) {
  return env.lastModel();
}

/** Persist a selected endpoint/model combo (in the user settings folder). */
export function writeLastCombo(env, { endpoint, model } = {}) {
  // Scripted/test conversations must never replace the user's last live
  // endpoint selection.
  if (endpoint === "test" || env.endpoint(endpoint)?.provider === "test") return;
  if (typeof endpoint !== "string" || endpoint === "" || typeof model !== "string" || model === "") return;
  const combo = { model };
  if (typeof endpoint === "string" && endpoint !== "") combo.endpoint = endpoint;
  const current = readLastCombo(env);
  if (current && current.model === combo.model && (current.endpoint ?? null) === (combo.endpoint ?? null)) return;
  writeJsonAtomic(join(env.settingsDir ?? env.dir, LAST_COMBO_FILE), combo);
}

/** Resolve `<endpoint>/<model>`, a model id, an endpoint, or a bare model. */
export async function resolveModelCombo(value, env, { url } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("model combo must not be empty (use <endpoint>/<model>, <model>, or <endpoint>)");
  }
  if (value.startsWith("/")) {
    throw new Error(`empty endpoint in model combo "${value}" (use <endpoint>/<model>)`);
  }

  const slash = value.indexOf("/");
  if (slash > 0) {
    const endpoint = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (env.endpoint(endpoint)) {
      if (model === "") return endpointOnly(endpoint, env, { url });
      return { endpoint, model };
    }
  }

  for (const name of env.endpointNames()) {
    const cached = env.endpointSettings(name).models;
    if (isModelMap(cached) && Object.hasOwn(cached, value) && cached[value]?.secret !== true) {
      return { endpoint: name, model: value };
    }
  }

  if (env.endpoint(value)) return endpointOnly(value, env, { url });
  return { model: value };
}

/** @param {*} v @returns {boolean} a model MAP (unique names as keys) */
function isModelMap(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Published endpoint/model completion candidates (cache-only). */
export function listModelCandidates(env, { access = env.settings?.modelAccess ?? "all" } = {}) {
  const out = new Set();
  for (const name of env.endpointNames({ access })) {
    out.add(name);
    const models = env.endpointSettings(name).models;
    if (!isModelMap(models)) continue;
    for (const [id, meta] of Object.entries(models)) {
      if (meta?.secret === true || id === "") continue;
      out.add(id);
      out.add(`${name}/${id}`);
    }
  }
  return [...out];
}

/** Published endpoints with published cached model ids for the menu;
 *  loginRequired flags endpoints whose credentials failed (see Agent). */
export function listEndpointModels(env, { access = env.settings?.modelAccess ?? "all" } = {}) {
  return env.endpointNames({ access }).map((name) => {
    const settings = env.endpointSettings(name);
    const models = settings.models;
    return {
      name,
      models: isModelMap(models)
        ? Object.keys(models).filter((id) => id !== "" && models[id]?.secret !== true)
        : [],
      ...(settings.loginRequired === true ? { loginRequired: true } : {}),
    };
  });
}

/** Query each published endpoint and return its currently available public
 * model ids. A provider failure falls back to that endpoint's cached/static
 * catalogue, as Env.endpointModels promises. */
export async function listModels(env, { access = env.settings?.modelAccess ?? "all" } = {}) {
  return Promise.all(env.endpointNames({ access }).map(async (name) => {
    const models = await env.endpointModels(name, { refresh: true });
    return {
      name,
      models: Object.keys(models).filter((id) => id !== "" && models[id]?.secret !== true),
    };
  }));
}

async function endpointOnly(endpoint, env, { url } = {}) {
  const models = await knownModels(endpoint, env, { url, refresh: true });
  const first = Object.keys(models).find((id) => models[id]?.secret !== true);
  return { endpoint, model: first };
}

/** One endpoint's model map; refreshes live when asked (see Env.endpointModels). */
async function knownModels(endpoint, env, { url, refresh = false } = {}) {
  return env.endpointModels(endpoint, { refresh, url });
}
