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

/**
 * Reset the process-global registry cache, primarily for tests that need to
 * start from a cold state.
 *
 * @returns {void} Nothing.
 * @effects Clears the shared load promise and cached windows; the next load
 *   starts a new registry fetch.
 */
export function registryCacheReset() {
  loading = undefined;
  windows = null;
}

/**
 * Fetch the models.dev registry and index positive, finite context-window
 * values from its `openai.models` section.
 *
 * @returns {Promise<Map<string, number>|null>} A map from bare model IDs to
 *   context-window sizes, or null if the request, response, or JSON parsing
 *   fails, or the request times out.
 * @effects Makes one HTTP request to the registry URL, aborts it after the
 *   configured timeout, and clears the timeout on completion. Failures are
 *   caught and represented as null; this function does not reject.
 */
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
 * Start the registry download once per process; subsequent calls share the
 * same promise, whether the registry is available or offline. Never rejects.
 *
 * @returns {Promise<boolean>} Resolves true when registry windows are
 *   available, or false when the registry fetch fails.
 * @effects Starts the asynchronous registry fetch only on the first call and
 *   stores its resulting map (or null) in process-global state.
 */
export function contextWindowsLoad() {
  loading ??= registryFetch().then((map) => {
    windows = map;
    return map !== null;
  });
  return loading;
}

/**
 * Return one model's cached registry context window synchronously; this
 * lookup never initiates a fetch.
 *
 * @param {string} model - Bare model ID to look up; no default.
 * @returns {number|null} The positive context-window size, or null if the
 *   registry has not loaded or the model ID is unknown.
 * @effects Reads the process-global cached map without modifying it.
 */
export function registryContextWindow(model) {
  return windows?.get(model) ?? null;
}
