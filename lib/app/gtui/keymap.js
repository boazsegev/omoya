/** Persistent named key contexts with allocation-free normalized-string lookup. */

export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;
const CACHE_LIMIT = 256;
const parsed = new Map();
const compiled = new WeakMap();
const BRAND = Symbol("GTUI.keybindings.context");

/**
 * Format a base key and modifier bitmask as the public normalized spelling.
 * @param {string} base - Key code to append after the modifier names.
 * @param {number} mask - Bitmask using the exported ALT, CTRL, META, and SHIFT flags.
 * @returns {string} The normalized key spelling; this helper does not mutate state.
 */
function format(base, mask) {
  let value = "";
  if (mask & ALT) value = "alt+";
  if (mask & CTRL) value += "ctrl+";
  if (mask & META) value += "meta+";
  if (mask & SHIFT) value += "shift+";
  return value + base;
}

/**
 * Parse a public key spelling into its code and modifier bitmask.
 * @param {string} key - Public key spelling; there is no default.
 * @returns {{code: string, modifiers: number}|null} A frozen parsed result, or null for non-string, empty, or invalid spellings. This function is synchronous and does not return a Promise.
 * @throws {never} Invalid spellings are reported with null rather than an exception.
 * @effects Reuses and may populate the bounded parsed-key cache.
 */
export function decodeKey(key) {
  if (typeof key !== "string" || key === "") return null;
  const hit = parsed.get(key);
  if (hit) return hit;
  const plus = key === "+";
  const suffixPlus = key.endsWith("++");
  const bits = plus ? [] : (suffixPlus ? key.slice(0, -2) : key).split("+");
  const base = plus || suffixPlus ? "+" : bits.pop();
  let modifiers = 0;
  let valid = base !== "";
  for (const bit of bits) {
    if (bit === "alt") modifiers |= ALT;
    else if (bit === "ctrl") modifiers |= CTRL;
    else if (bit === "meta" || bit === "cmd") modifiers |= META;
    else if (bit === "shift") modifiers |= SHIFT;
    else valid = false;
  }
  if (!valid) return null;
  const result = Object.freeze({ code: base, modifiers });
  if (parsed.size < CACHE_LIMIT && (key.length > 1 || modifiers || base.length > 1)) parsed.set(key, result);
  return result;
}

/**
 * Obtain normalized key information from a keyboard message.
 * @param {object|null|undefined} message - Message with either a string `code` and integer `modifiers`, or a public `key` spelling; there is no default.
 * @returns {{code: string, modifiers: number}|null} The supplied message itself when it already has normalized fields, otherwise the decoded key information or null. Synchronous; does not return a Promise.
 * @effects May populate the bounded parsed-key cache when decoding a public spelling.
 */
export function keyInfo(message) {
  if (typeof message?.code === "string" && Number.isInteger(message.modifiers)) return message;
  return decodeKey(message?.key);
}

const canonical = Array.from({ length: 16 }, () => Object.create(null));
const canonicalCounts = new Uint16Array(16);
/**
 * Return the canonical public spelling for a key code and modifier bitmask.
 * @param {string} base - Key code; there is no default.
 * @param {number} [modifiers=0] - Modifier bitmask, limited to the four supported flag bits.
 * @returns {string} The canonical spelling. Synchronous; does not return a Promise.
 * @effects Reuses and may populate the bounded canonical-spelling cache.
 */
export function canonicalKey(base, modifiers = 0) {
  const mask = modifiers & 15;
  if (base.length === 1 && mask === 0) return base;
  const bucket = canonical[mask];
  const hit = bucket[base];
  if (hit) return hit;
  const value = format(base, mask);
  if (canonicalCounts[mask] < CACHE_LIMIT) { bucket[base] = value; canonicalCounts[mask]++; }
  return value;
}

/**
 * Allocate empty lookup tables for each possible four-bit modifier mask.
 * @returns {object[]} Sixteen fresh null-prototype lookup tables. Synchronous; does not return a Promise.
 */
function tables() { return Array.from({ length: 16 }, () => Object.create(null)); }
/**
 * Freeze lookup tables and package them as a branded keybinding context.
 * @param {string} name - Context name; there is no default.
 * @param {object[]} contextTables - The sixteen modifier-indexed lookup tables to freeze.
 * @returns {object} The immutable branded context. Synchronous; does not return a Promise.
 * @effects Freezes each supplied table, the table array, and the returned context in place.
 */
function freezeContext(name, contextTables) {
  for (const table of contextTables) Object.freeze(table);
  return Object.freeze({ name, tables: Object.freeze(contextTables), [BRAND]: true });
}
/**
 * Build lookup tables and an immutable context from public binding spellings.
 * @param {string} name - Name stored on the resulting context; there is no default.
 * @param {Iterable<string>} bindings - Binding spellings to parse; there is no default.
 * @param {boolean} [strict=false] - If true, reject an invalid binding; otherwise skip invalid entries.
 * @returns {object} The immutable branded keybinding context. Synchronous; does not return a Promise.
 * @throws {TypeError} In strict mode, when a binding cannot be decoded.
 * @effects May populate the shared parsed-key cache while decoding bindings.
 */
function build(name, bindings, strict = false) {
  const contextTables = tables();
  for (const binding of bindings) {
    const info = decodeKey(binding);
    if (!info) {
      if (strict) throw new TypeError(`GTUI key binding is invalid: ${String(binding)}`);
      continue;
    }
    contextTables[info.modifiers][info.code] = true;
  }
  return freezeContext(name, contextTables);
}

/**
 * Build one immutable, named context for application module lifetime.
 * @param {string} name - Name to attach to the context; there is no default.
 * @param {string[]} [bindingStrings=[]] - Public key spellings to include.
 * @returns {object} The immutable branded keybinding context. Synchronous; does not return a Promise.
 * @throws {TypeError} If `name` is not a string, `bindingStrings` is not an array, or any binding is invalid.
 * @effects May populate the shared parsed-key cache while decoding bindings.
 */
export function createKeybindings(name, bindingStrings = []) {
  if (typeof name !== "string" || !Array.isArray(bindingStrings)) throw new TypeError("GTUI.keybindings.create requires a name and binding strings");
  return build(name, bindingStrings, true);
}

/**
 * Convert legacy bindings to a context while preserving branded contexts unchanged.
 * @param {object|Array<string>|null|undefined} bindings - Branded context or legacy binding array; there is no default.
 * @returns {object} The original branded context, a compiled context, or the shared empty context for non-arrays. Synchronous; does not return a Promise.
 * @effects Caches compiled results for frozen arrays and may populate the shared parsed-key cache.
 */
export function compileBindings(bindings) {
  if (bindings?.[BRAND] === true) return bindings;
  if (!Array.isArray(bindings)) return EMPTY;
  const cacheable = Object.isFrozen(bindings);
  const previous = cacheable && compiled.get(bindings);
  if (previous) return previous;
  const result = build("legacy", bindings);
  if (cacheable) compiled.set(bindings, result);
  return result;
}

/**
 * Test whether a keyboard message is present in a compiled keybinding context.
 * @param {object} context - Compiled context with modifier-indexed lookup tables; there is no default.
 * @param {object|null|undefined} message - Keyboard message accepted by `keyInfo`; there is no default.
 * @returns {boolean} True if the message's decoded key is bound, otherwise false. Synchronous; does not return a Promise.
 * @effects May populate the shared parsed-key cache while normalizing the message.
 */
export function matchesBinding(context, message) {
  const info = keyInfo(message);
  return Boolean(info && info.modifiers >= 0 && info.modifiers < 16 && context.tables[info.modifiers][info.code]);
}

const EMPTY = freezeContext("empty", tables());
export const keymapInternals = Object.freeze({ CACHE_LIMIT, parsed });
