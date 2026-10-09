/** Browser settings access for app modules and future plugins. */
import { state } from "./state.js";

const listeners = new Set();

/**
 * Read all effective public Env settings (defaults and unknown keys included).
 * @returns {object} Detached snapshot; safe to mutate locally, never persisted.
 * Before the first settings packet returns {}; missing keys remain absent.
 * Credentials in `auth` subtrees are intentionally not sent to the browser.
 */
export function settingsRead() {
  return structuredClone(state.envSettings);
}

/**
 * Observe complete settings snapshots after browser state is synchronized.
 * @param {(settings: object) => void} listener Receives its own detached snapshot.
 * Called immediately with current settings, then only when effective settings
 * change (including deletions and changed project/agent snapshots).
 * @returns {() => void} Idempotent unsubscribe; the caller owns its lifetime.
 * @throws {TypeError} If listener is not a function. Listener exceptions are
 * reported without interrupting app updates or other subscribers.
 */
export function settingsSubscribe(listener) {
  if (typeof listener !== "function") throw new TypeError("settingsSubscribe: expected a function");
  listeners.add(listener);
  notify(listener);
  return () => { listeners.delete(listener); };
}

function notify(listener) {
  try { listener(settingsRead()); }
  catch (error) { console.error("Settings subscriber failed", error); }
}

/** Notify consumers after the orchestrator applies an authoritative packet. */
export function settingsChanged() {
  for (const listener of [...listeners]) if (listeners.has(listener)) notify(listener);
}
