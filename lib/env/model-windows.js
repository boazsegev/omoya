/**
 * lib/env/model-windows.js — the context-window FALLBACK for endpoints
 * whose model listings publish none (OpenAI's /models and /models/{id}
 * carry id/created/owned_by only — probed 2026-09-28; see
 * ai-tmp/probe-openai-models.js). The models.dev registry (~5MB) is
 * downloaded AT MOST ONCE per process — an interactive host starts it
 * at launch, asynchronously — and every read afterwards is a
 * synchronous Map lookup. Nothing ever awaits it on a request path:
 * until the registry has landed (or when offline) a read answers null
 * and consumers hide the window or use the curated tier table
 * (Context.fallbackContextWindow, lib/context.js); the host repaints
 * its readouts when the load settles. No model LIST comes from here —
 * only the one missing field.
 */


const REGISTRY_URL = "https://models.dev/api.json";

/** Download cap: a hung registry settles as "offline" instead of pinning a socket. */
const REGISTRY_TIMEOUT = 5000;

/** Process-global state: the single load (a promise, shared by every
 *  caller) and its result (Map of model id -> window, or null offline). */
let loading;
let windows = null;

/** Test hook: forget the process-global load so each test starts cold. */
export function registryCacheReset() {
  loading = undefined;
  windows = null;
}

/** Fetch and index the registry's openai section; null when offline. */
async function registryFetch() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("registry lookup timed out")), REGISTRY_TIMEOUT);
  timer.unref?.();
  try {
    const response = await fetch(REGISTRY_URL, { headers: { connection: "close" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const map = new Map();
    for (const [id, entry] of Object.entries(body?.openai?.models ?? {})) {
      if (Number.isFinite(entry?.limit?.context) && entry.limit.context > 0) map.set(id, entry.limit.context);
    }
    return map;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the registry download once per process (later calls share the
 * same promise, loaded or not). Never rejects.
 * @returns {Promise<boolean>} true when registry windows are available
 */
export function contextWindowsLoad() {
  loading ??= registryFetch().then((map) => {
    windows = map;
    return map !== null;
  });
  return loading;
}

/**
 * One model's registry window — synchronous, never fetches.
 * @param {string} model - bare model id
 * @returns {number|null} null until the registry landed, or when unknown
 */
export function registryContextWindow(model) {
  return windows?.get(model) ?? null;
}
