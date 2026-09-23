/** Persistent named key contexts with allocation-free normalized-string lookup. */

export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;
const CACHE_LIMIT = 256;
const parsed = new Map();
const compiled = new WeakMap();
const BRAND = Symbol("GTUI.keybindings.context");

function format(base, mask) {
  let value = "";
  if (mask & ALT) value = "alt+";
  if (mask & CTRL) value += "ctrl+";
  if (mask & META) value += "meta+";
  if (mask & SHIFT) value += "shift+";
  return value + base;
}

/** Parse a public spelling once; unknown text remains compatible. */
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

export function keyInfo(message) {
  if (typeof message?.code === "string" && Number.isInteger(message.modifiers)) return message;
  return decodeKey(message?.key);
}

const canonical = Array.from({ length: 16 }, () => Object.create(null));
const canonicalCounts = new Uint16Array(16);
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

function tables() { return Array.from({ length: 16 }, () => Object.create(null)); }
function freezeContext(name, contextTables) {
  for (const table of contextTables) Object.freeze(table);
  return Object.freeze({ name, tables: Object.freeze(contextTables), [BRAND]: true });
}
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

/** Build one immutable, named context for application module lifetime. */
export function createKeybindings(name, bindingStrings = []) {
  if (typeof name !== "string" || !Array.isArray(bindingStrings)) throw new TypeError("GTUI.keybindings.create requires a name and binding strings");
  return build(name, bindingStrings, true);
}

/** Contexts pass unchanged; frozen legacy lists retain compatibility caching. */
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

export function matchesBinding(context, message) {
  const info = keyInfo(message);
  return Boolean(info && info.modifiers >= 0 && info.modifiers < 16 && context.tables[info.modifiers][info.code]);
}

const EMPTY = freezeContext("empty", tables());
export const keymapInternals = Object.freeze({ CACHE_LIMIT, parsed });
