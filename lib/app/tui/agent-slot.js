/**
 * lib/tui-app/agent-slot.js — the ACTIVE-SESSION SLOT: one stable Proxy
 * the app holds as `slot.agent`, forwarding every read/write/call to
 * the CURRENT underlying Agent. Switching the viewed session
 * (the ^X Peers sub-menu, Alt+Ctrl+←/→) is a
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

import { NAMES } from "../../namespace.js";

const REAL_AGENT = Symbol.for(NAMES.realAgentSymbol);

/**
 * Create a stable proxy that forwards operations to the currently selected agent.
 *
 * @param {object} initial - Agent to expose initially; there is no default.
 * @returns {{agent: object, current: () => object, switchTo: (agent: object) => boolean,
 *   onSwitch: (cb: (next: object, prev: object) => void) => Function}} The proxy and
 *   methods for reading, changing, and observing the selected agent. Property access
 *   through the proxy operates on `initial` until a switch occurs; invalid agents may
 *   cause errors when proxy operations are forwarded to them.
 */
export function createAgentSlot(initial) {
  let current = initial;
  const listeners = new Set();
  const proxy = new Proxy({}, {
    /**
     * Read a property from the current agent, exposing its real-agent symbol
     * directly and binding function values to that agent.
     *
     * @param {object} _ - Unused proxy target.
     * @param {PropertyKey} prop - Property to read.
     * @returns {*} The property value, or a function bound to the current agent.
     * @throws {*} Propagates errors thrown by property access or function binding.
     */
    get(_, prop) {
      if (prop === REAL_AGENT) return current;
      const value = Reflect.get(current, prop, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
    /**
     * Write a property on the current agent. The proxy reports success regardless
     * of the boolean returned by `Reflect.set`.
     *
     * @param {object} _ - Unused proxy target.
     * @param {PropertyKey} prop - Property to write.
     * @param {*} value - Value to assign; there is no default.
     * @returns {boolean} Always `true`.
     * @throws {*} Propagates errors thrown while setting the current agent's property.
     */
    set(_, prop, value) {
      Reflect.set(current, prop, value);
      return true;
    },
    /**
     * Test whether a property is present on the current agent; `Symbol.unscopables`
     * is always reported absent.
     *
     * @param {object} _ - Unused proxy target.
     * @param {PropertyKey} prop - Property to test.
     * @returns {boolean} Whether the property is present, subject to the unscopables exception.
     * @throws {*} Propagates errors from the `in` operation on the current agent.
     */
    has(_, prop) {
      return prop === Symbol.unscopables ? false : prop in current;
    },
    /**
     * Enumerate the own keys of the current agent.
     *
     * @returns {Array<string|symbol>} The keys returned by `Reflect.ownKeys`.
     * @throws {*} Propagates errors from enumerating the current agent's keys.
     */
    ownKeys() {
      return Reflect.ownKeys(current);
    },
    /**
     * Get a property descriptor from the current agent, or a configurable,
     * enumerable, writable placeholder when it has no descriptor for the key.
     *
     * @param {object} _ - Unused proxy target.
     * @param {PropertyKey} prop - Property whose descriptor is requested.
     * @returns {PropertyDescriptor} The current agent's descriptor or the placeholder.
     * @throws {*} Propagates errors from retrieving the current agent's descriptor.
     */
    getOwnPropertyDescriptor(_, prop) {
      return Reflect.getOwnPropertyDescriptor(current, prop)
        ?? { configurable: true, enumerable: true, writable: true };
    },
  });
  return {
    agent: proxy,
    /**
     * Return the actual agent currently viewed, rather than its forwarding proxy;
     * useful when object identity matters.
     *
     * @returns {object} The currently selected agent.
     */
    current: () => current,
    /**
     * Point the view at another agent. If it differs from the current agent,
     * update the view before notifying listeners in insertion order.
     *
     * @param {object} agent - Agent to select; there is no default.
     * @returns {boolean} `false` if already selected, otherwise `true` after
     *   listeners have been notified.
     * @throws {*} If a listener throws, the agent remains switched and the error
     *   propagates; later listeners in the iteration are not called.
     */
    switchTo(agent) {
      if (agent === current) return false;
      const prev = current;
      current = agent;
      for (const cb of listeners) cb(agent, prev);
      return true;
    },
    /**
     * Subscribe to actual agent switches. The callback receives the new agent
     * followed by the previously selected agent; it is not called for no-op switches.
     *
     * @param {(next: object, prev: object) => void} cb - Listener; there is no default.
     * @returns {() => boolean} An unsubscribe function that removes this listener
     *   from the subscription set and returns whether it was present.
     */
    onSwitch(cb) {
      listeners.add(cb);
      /**
       * Remove the registered callback from the listener set.
       *
       * @returns {boolean} Whether the callback was present and removed.
       */
      return () => listeners.delete(cb);
    },
  };
}
