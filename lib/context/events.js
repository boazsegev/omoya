/**
 * lib/events.js — normalized IO response event vocabulary and
 * callback/default routing.
 *
 * Events are plain objects: { type: <event name>, ...payload }.
 * Indexed events (block start/delta/end) carry `contentIndex`. A
 * `text_end` may additionally carry the provider's authoritative full
 * `text` snapshot; the assembler consolidates it over streamed deltas
 * for every text block, regardless of its position among other blocks.
 * Partial/final events (done, error) carry the assistant `message`
 * assembled so far; usage numbers ride in the terminal event.
 *
 * IO invokes camelCase callbacks (onStart, onTextDelta, ...).
 * Missing callbacks get binding-appropriate defaults: events flow
 * through onData, onError also reports through onLog, terminal
 * callbacks complete the binding. Explicit false/null selects no-op.
 */

/** The full normalized event vocabulary. */
export const EventType = Object.freeze({
  Start: "start",
  TextStart: "text_start",
  TextDelta: "text_delta",
  TextEnd: "text_end",
  ThinkingStart: "thinking_start",
  ThinkingDelta: "thinking_delta",
  ThinkingEnd: "thinking_end",
  ToolCallStart: "tool_call_start",
  ToolCallDelta: "tool_call_delta",
  ToolCallEnd: "tool_call_end",
  Done: "done",
  Error: "error",
});

const EVENT_NAMES = new Set(Object.values(EventType));

/** Events that must carry a numeric contentIndex. */
const INDEXED = new Set([
  "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "tool_call_start", "tool_call_delta", "tool_call_end",
]);

/** Terminal events complete the binding. */
const TERMINAL = new Set(["done", "error"]);

/**
 * No-op callback used when a binding explicitly disables an event callback.
 * @returns {void}
 */
const NOOP = () => {};

/**
 * Map an event name to its camelCase callback name.
 * "text_delta" -> "onTextDelta"; "tool_call_start" -> "onToolCallStart".
 * @param {string} eventName - normalized event name to convert.
 * @returns {string} The corresponding camelCase callback name.
 * @throws {TypeError} If `eventName` does not support `split` (for example, it is not a string).
 */
export function callbackName(eventName) {
  return (
    "on" +
    eventName
      .split("_")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("")
  );
}

/**
 * Is this a well-formed normalized response event (a known `type`;
 * indexed events carry a non-negative integer `contentIndex`)?
 * @param {*} event - value to check.
 * @returns {boolean} `true` for an object with a known event type and, for indexed events, a non-negative integer `contentIndex`; otherwise `false`.
 */
export function isResponseEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  if (!EVENT_NAMES.has(event.type)) return false;
  if (INDEXED.has(event.type) && (!Number.isInteger(event.contentIndex) || event.contentIndex < 0)) {
    return false;
  }
  return true;
}

/**
 * Validate a normalized response event (used by IO to check connector
 * output). Returns the same object; throws on violation.
 * @param {*} event - value to validate.
 * @returns {object} The same event object when it is valid.
 * @throws {TypeError} If the value is not a well-formed normalized response event.
 */
export function validateResponseEvent(event) {
  if (!isResponseEvent(event)) {
    throw new TypeError(
      `invalid response event: ${JSON.stringify(event)?.slice(0, 120)}`,
    );
  }
  return event;
}

/**
 * Build the full callback set for a binding.
 *
 * @param {Object} [callbacks={}] - consumer-supplied callbacks, keyed by camelCase callback name. A function is used as-is; explicit `false` or `null` selects a no-op; an omitted or `undefined` callback gets the binding default.
 * @param {Object} [binding={}] - binding-appropriate default handlers.
 * @param {(event:object)=>void} [binding.onData] - receives every event
 *   whose callback was omitted (stdout replacement)
 * @param {(line:string)=>void} [binding.onLog] - receives error reports
 *   (stderr replacement)
 * @param {(event:object)=>void|false|null} [binding.onTerminal] - completes the binding; called for `done` and `error` even when the consumer supplied its own terminal callback. `false` or `null` disables this additional call.
 * @returns {Object} Complete callback set keyed by camelCase names.
 * @throws {Error} If an invoked binding handler throws; its error propagates to the caller.
 */
export function normalizeCallbacks(callbacks = {}, binding = {}) {
  const { onData, onLog, onTerminal } = binding;
  const set = {};

  for (const name of EVENT_NAMES) {
    const cbName = callbackName(name);
    const given = callbacks[cbName];

    if (given === false || given === null) {
      set[cbName] = NOOP;
    } else if (typeof given === "function") {
      set[cbName] = given;
    } else if (name === "error") {
      // default: report through onData AND onLog
      set[cbName] = (event) => {
        onData?.(event);
        onLog?.(event.error ? String(event.error) : "unknown error");
      };
    } else {
      // default: response events flow through onData
      set[cbName] = (event) => onData?.(event);
    }

    if (TERMINAL.has(name) && onTerminal !== false && onTerminal != null) {
      const inner = set[cbName];
      set[cbName] = (event) => {
        inner(event);
        onTerminal(event);
      };
    }
  }
  return set;
}

/**
 * Dispatch one event through a normalized callback set. Validates the event
 * before invoking its matching callback; callback errors propagate to the caller.
 * @param {Object} set - callback set returned by `normalizeCallbacks`.
 * @param {object} event - normalized response event to dispatch.
 * @returns {void}
 * @throws {TypeError} If `event` is invalid or the callback cannot be invoked; errors thrown by the callback also propagate unchanged.
 */
export function dispatch(set, event) {
  validateResponseEvent(event);
  set[callbackName(event.type)](event);
}
