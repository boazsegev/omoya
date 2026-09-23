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
  ToolcallStart: "toolcall_start",
  ToolcallDelta: "toolcall_delta",
  ToolcallEnd: "toolcall_end",
  Done: "done",
  Error: "error",
});

const EVENT_NAMES = new Set(Object.values(EventType));

/** Events that must carry a numeric contentIndex. */
const INDEXED = new Set([
  "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end",
]);

/** Terminal events complete the binding. */
const TERMINAL = new Set(["done", "error"]);

/** start + all block start events begin output. */
const NOOP = () => {};

/**
 * Map an event name to its camelCase callback name.
 * "text_delta" -> "onTextDelta"; "toolcall_start" -> "onToolcallStart".
 * @param {string} eventName
 * @returns {string}
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
 * @param {*} event
 * @returns {boolean} true for a well-formed normalized response event
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
 * @param {*} event
 * @returns {object}
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
 * @param {Object} [callbacks] - consumer-supplied callbacks. A function
 *   is used as-is; explicit false/null selects a no-op; undefined gets
 *   the binding default.
 * @param {Object} binding - binding-appropriate defaults
 * @param {(event:object)=>void} [binding.onData] - receives every event
 *   whose callback was omitted (stdout replacement)
 * @param {(line:string)=>void} [binding.onLog] - receives error reports
 *   (stderr replacement)
 * @param {(event:object)=>void} [binding.onTerminal] - completes the
 *   binding; fires on done/error even when the consumer supplied its own
 *   terminal callback (unless itself false/null)
 * @returns {Object} complete callback set keyed by camelCase names
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
 * Dispatch one event through a (normalized) callback set.
 * @param {Object} set - callback set from normalizeCallbacks
 * @param {object} event - a normalized response event
 */
export function dispatch(set, event) {
  validateResponseEvent(event);
  set[callbackName(event.type)](event);
}
