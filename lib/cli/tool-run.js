// lib/cli/tool-run.js — shared "manual door" tool-invocation helpers:
// arg resolution and result unwrapping for a HUMAN calling a
// registered tool directly, outside any Agent turn (bin/scripts/tool, the
// TUI's /<tool> command and Tools menu — see Env.callTool).

/**
 * Resolve a raw JSON-args string into a tool's actual args object.
 * A JSON OBJECT passes through as-is; a bare JSON value (array,
 * string, number, ...) is a SHORTHAND for the tool's FIRST schema
 * property — so `"["core"]"` against a tool whose first property is
 * `names` becomes `{names: ["core"]}`.
 * @param {string|undefined} raw - undefined/"" means no arguments ({})
 * @param {{name: string, schema?: {inputSchema?: {properties?: object}}}} entry
 * @returns {object}
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

/** Turn a non-object JSON value into the tool's first schema property. */
function shorthandToolArgs(parsed, entry) {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  const [firstProp] = Object.keys(entry.schema?.inputSchema?.properties ?? {});
  if (!firstProp) {
    throw new Error(`"${entry.name}" has no schema property to shorthand a bare value into — pass a JSON object`);
  }
  return { [firstProp]: parsed };
}

/**
 * Resolve the tool CLI's shell-friendly non-JSON arguments. A colon in the
 * first argument selects object form (`path: file.md` or `path:file.md`);
 * otherwise every argument is a string array shorthand. JSON remains the
 * exact, explicit form and is tried first for backwards compatibility.
 * @param {string[]} argv
 * @param {{name: string, schema?: {inputSchema?: {properties?: object}}}} entry
 * @returns {object}
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
 * Split a tool's return value into its {result, system?, display?}
 * envelope (see the Tool contract's RETURNS section) — a plain return
 * value is `result` with no side channels.
 * @param {*} value
 * @returns {{result: *, system: string[], display: string[]}}
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
 * A result value as printable text: a string as-is, else pretty JSON
 * — ALWAYS a string (JSON.stringify(undefined) is the JS value
 * undefined, not text, so that case is coerced explicitly).
 */
export function formatToolResult(result) {
  if (typeof result === "string") return result;
  const json = JSON.stringify(result, null, 2);
  return json === undefined ? String(result) : json;
}
