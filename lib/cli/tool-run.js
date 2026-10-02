// lib/cli/tool-run.js — shared "manual door" tool-invocation helpers:
// arg resolution and result unwrapping for a HUMAN calling a
// registered tool directly, outside any Agent turn (bin/scripts/tool, the
// TUI's /<tool> command and Tools menu — see Env.toolCall).

/**
 * Parse raw JSON arguments, passing a JSON object through or wrapping a bare
 * JSON value in the tool's first schema property.
 * @param {string|undefined} raw - JSON text; omitted or empty text defaults to no arguments (`{}`).
 * @param {{name: string, schema?: {inputSchema?: {properties?: object}}}} entry - Tool metadata used to identify the first schema property for shorthand values.
 * @returns {object} The parsed argument object or shorthand wrapper.
 * @throws {Error} If non-empty `raw` is invalid JSON or a bare value cannot be wrapped because the tool has no schema property.
 */
export function resolveToolArgs(raw, entry) {
  if (raw === undefined || raw === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON args: ${err.message}`);
  }
  return shorthandToolArgs(parsed, entry);
}

/**
 * Pass an object through or wrap a non-object JSON value in the tool's first schema property.
 * @param {*} parsed - Parsed JSON value to pass through or wrap.
 * @param {{name: string, schema?: {inputSchema?: {properties?: object}}}} entry - Tool metadata, including the name used in any error and optional input schema.
 * @returns {object} The original object or an object keyed by the first schema property.
 * @throws {Error} If wrapping is needed but the tool has no schema property.
 */
function shorthandToolArgs(parsed, entry) {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  const [firstProp] = Object.keys(entry.schema?.inputSchema?.properties ?? {});
  if (!firstProp) {
    throw new Error(`"${entry.name}" has no schema property to shorthand a bare value into — pass a JSON object`);
  }
  return { [firstProp]: parsed };
}

/**
 * Resolve CLI arguments from JSON or shell-friendly shorthand. A single
 * argument is first tried as JSON; otherwise a colon in the first argument
 * selects key/value object form, and arguments without that colon become a
 * string-array shorthand for the tool's first schema property.
 * @param {string[]} argv - CLI argument strings; an empty array defaults to no arguments (`{}`).
 * @param {{name: string, schema?: {inputSchema?: {properties?: object}}}} entry - Tool metadata used for shorthand property selection and error messages.
 * @returns {object} The resolved argument object.
 * @throws {Error} If shorthand needs a missing schema property or object-form arguments contain text before a `key:value` pair.
 */
export function resolveCliToolArgs(argv, entry) {
  if (argv.length === 0) return {};
  if (argv.length === 1) {
    try { return resolveToolArgs(argv[0], entry); } catch { /* shell form below */ }
  }
  const isObject = argv[0].includes(":");
  if (!isObject) return shorthandToolArgs(argv, entry);
  const out = {};
  let key;
  let values = [];
  const commit = () => {
    if (!key) return;
    out[key] = values.join(" ");
  };
  for (const part of argv) {
    const colon = part.indexOf(":");
    if (colon > 0) {
      commit();
      key = part.slice(0, colon);
      values = part.slice(colon + 1) === "" ? [] : [part.slice(colon + 1)];
    } else if (key) {
      values.push(part);
    } else {
      throw new Error(`invalid shell args: expected key:value, got ${JSON.stringify(part)}`);
    }
  }
  commit();
  return out;
}

/**
 * Unwrap a tool return envelope into its result and side-channel arrays. An
 * object with a `system` or `display` property is treated as an envelope;
 * any other value is returned as `result` with empty side channels.
 * @param {*} value - Tool return value; there is no default.
 * @returns {{result: *, system: string[], display: string[]}} The result plus normalized `system` and `display` arrays (missing/falsy channels become empty arrays, and scalar channels become one-element arrays).
 */
export function unwrapToolResult(value) {
  const isEnvelope = value !== null && typeof value === "object" && !Array.isArray(value) &&
    ("system" in value || "display" in value);
  return {
    result: isEnvelope ? value.result : value,
    system: isEnvelope ? [].concat(value.system ?? []) : [],
    display: isEnvelope ? [].concat(value.display ?? []) : [],
  };
}

/**
 * Convert a result to printable text, preserving strings and pretty-printing
 * other values as JSON; values without a JSON representation are string-coerced.
 * @param {*} result - Value to format; there is no default.
 * @returns {string} The original string, indented JSON text, or string coercion when JSON serialization yields `undefined`.
 * @throws {TypeError} If JSON serialization fails, such as for a circular structure or a `BigInt` value.
 */
export function formatToolResult(result) {
  if (typeof result === "string") return result;
  const json = JSON.stringify(result, null, 2);
  return json === undefined ? String(result) : json;
}
