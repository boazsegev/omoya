/**
 * lib/tui-app/agent-slot.js — the ACTIVE-SESSION SLOT: one stable Proxy
 * the app holds as `slot.agent`, forwarding every read/write/call to
 * the CURRENT underlying Agent. Switching the viewed session
 * (/session-switch, the ^X Peers sub-menu, Alt+Ctrl+←/→) is a
 * one-line slot.switchTo — every handler captured the slot at
 * construction and sees the new agent on its very next read, so
 * lib/tui-app/agent-adapter.js needs no changes at all: it already
 * only ever reads `agent.*` through whatever reference it was given.
 *
 * Ported verbatim from lib/tui-helpers/agent-slot.js — pure session
 * plumbing with zero terminal/rendering knowledge, so it needed no
 * redesign, only a new home.
 *
 * Identity-sensitive code (the session switch path
 * itself) reads slot.current() — the REAL Agent — never the proxy.
 */

import { NAMES } from "../namespace.js";

const REAL_AGENT = Symbol.for(NAMES.realAgentSymbol);

/**
 * @param {object} initial - the Agent the app was created with ("main")
 * @returns {{agent: object, current: () => object, switchTo: (agent: object) => boolean,
 *   onSwitch: (cb: (next: object, prev: object) => void) => Function}}
 */
export function createAgentSlot(initial) {
  let current = initial;
  const listeners = new Set();
  const proxy = new Proxy({}, {
    get(_, prop) {
      if (prop === REAL_AGENT) return current;
      const value = Reflect.get(current, prop, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
    set(_, prop, value) {
      Reflect.set(current, prop, value);
      return true;
    },
    has(_, prop) {
      return prop === Symbol.unscopables ? false : prop in current;
    },
    ownKeys() {
      return Reflect.ownKeys(current);
    },
    getOwnPropertyDescriptor(_, prop) {
      return Reflect.getOwnPropertyDescriptor(current, prop)
        ?? { configurable: true, enumerable: true, writable: true };
    },
  });
  return {
    agent: proxy,
    /** @returns {object} the REAL agent currently viewed (identity work reads this) */
    current: () => current,
    /**
     * Point the view at another agent. Returns false when it already
     * is the view; listeners fire (next, prev) on a real switch only.
     */
    switchTo(agent) {
      if (agent === current) return false;
      const prev = current;
      current = agent;
      for (const cb of listeners) cb(agent, prev);
      return true;
    },
    /** Subscribe to switches. @returns {Function} unsubscribe */
    onSwitch(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
