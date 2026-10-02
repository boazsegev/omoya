/**
 * lib/gtui/key-sequences.js — DECLARATIVE terminal escape-sequence maps.
 *
 * Every byte spelling GTUI recognizes or emits lives here as data, never
 * as control flow: one semantic key ("left" + modifiers) ↔ its spellings
 * in each protocol the terminal may speak. byte-filter.js DECODES the raw
 * stream through these tables; term.js ENABLES the protocols. A new
 * terminal protocol is a new map entry — no procedural translation code,
 * no scattered per-key if-chains.
 *
 *   KEYMAP        semantic named keys  → per-protocol byte spellings (emit)
 *   CSI_U_KEYS    kitty / modifyOtherKeys code → named key        (decode)
 *   CSI_TILDE_KEYS legacy CSI n ~ code         → named key        (decode)
 *   CSI_FINAL_KEYS legacy CSI 1 ; mod F letter → named key        (decode)
 *   MODIFIER      kitty/xterm modifier value   → modifier bits    (decode)
 *
 * Legacy (non-kitty) terminals spell modified keys as CSI/tilde sequences
 * Node's readline already decodes; the kitty keyboard protocol and
 * xterm's modifyOtherKeys spell EVERY key as CSI number ; modifier u or
 * CSI 27 ; modifier ; number ~, which readline cannot parse — so those
 * are the spellings the byte filter must normalize BEFORE the decoder.
 */

import { ALT, CTRL, META, SHIFT } from "./keymap.js";

/** Convert a kitty/xterm modifier value (1 + bitmask) to GTUI modifier bits.
 *  Kitty adds bit 8 for SUPER (Cmd on macOS); xterm uses the same shifted
 *  1/2/4/8 bitmask. Legacy readline bytes cannot express SUPER.
 *  @param {number|string|null|undefined} mod Modifier value; omitted, null,
 *    or undefined means no modifiers. Other values are coerced with Number.
 *  @returns {number} GTUI modifier-bit mask. Values whose numeric coercion
 *    is non-finite yield no bits; the low four mask bits are used.
 */
export function modifierBits(mod) {
  if (mod === undefined || mod === null) return 0;
  const bits = (Number(mod) - 1) & 15;
  let modifiers = 0;
  if (bits & 1) modifiers |= SHIFT;
  if (bits & 2) modifiers |= ALT;
  if (bits & 4) modifiers |= CTRL;
  if (bits & 8) modifiers |= META;
  return modifiers;
}

/** Convert GTUI modifier bits to the kitty/xterm modifier value.
 *  This is the inverse mapping of {@link modifierBits} for the four
 *  supported modifier bits.
 *  @param {number} bits GTUI modifier-bit mask; unrelated bits are ignored.
 *  @returns {number} Kitty/xterm value, starting at 1 for no modifiers.
 */
export function modifierValue(bits) {
  let value = 1;
  if (bits & SHIFT) value += 1;
  if (bits & ALT) value += 2;
  if (bits & CTRL) value += 4;
  if (bits & META) value += 8;
  return value;
}

/** Internal descriptors for named keys supported by the protocols.
 *  Each entry maps a GTUI public name to a canonical readline `key` and a
 *  kitty code, with optional legacy `tilde` and `final` spellings.
 *  @returns {Object} This private mutable source object is consumed during
 *    module initialization; it is not exported directly.
 */
const NAMED = {
  enter: { key: "return", kitty: 13 },
  tab: { key: "tab", kitty: 9 },
  escape: { key: "escape", kitty: 27 },
  backspace: { key: "backspace", kitty: 127 },
  insert: { key: "insert", kitty: 57348, tilde: 2 },
  delete: { key: "delete", kitty: 57349, tilde: 3 },
  left: { key: "left", kitty: 57350, final: "D" },
  right: { key: "right", kitty: 57351, final: "C" },
  up: { key: "up", kitty: 57352, final: "A" },
  down: { key: "down", kitty: 57353, final: "B" },
  pageup: { key: "pageup", kitty: 57354, tilde: 5 },
  pagedown: { key: "pagedown", kitty: 57355, tilde: 6 },
  home: { key: "home", kitty: 57356, final: "H", tilde: 1 },
  end: { key: "end", kitty: 57357, final: "F", tilde: 4 },
};

/** Decode-table map from kitty/modifyOtherKeys code to named-key descriptors.
 *  @returns {Map<number, {name: string, key: string}>} Map from protocol code
 *    to GTUI public name and canonical readline key. The map is frozen as an
 *    object, though freezing does not disable Map mutation methods.
 */
export const CSI_U_KEYS = Object.freeze(new Map(
  Object.entries(NAMED).filter(([, v]) => v.kitty !== undefined).map(([name, v]) => [v.kitty, { name, key: v.key }]),
));

/** Decode-table map from legacy CSI `n~` code to named-key descriptors.
 *  @returns {Map<number, {name: string, key: string}>} Map from tilde code
 *    to GTUI public name and canonical readline key; object-frozen only.
 */
export const CSI_TILDE_KEYS = Object.freeze(new Map(
  Object.entries(NAMED).filter(([, v]) => v.tilde !== undefined).map(([name, v]) => [v.tilde, { name, key: v.key }]),
));

/** Decode-table map from legacy CSI `1;mod<final>` letter to named keys.
 *  @returns {Map<string, {name: string, key: string}>} Map from final letter
 *    to GTUI public name and canonical readline key; object-frozen only.
 */
export const CSI_FINAL_KEYS = Object.freeze(new Map(
  Object.entries(NAMED).filter(([, v]) => v.final !== undefined).map(([name, v]) => [v.final, { name, key: v.key }]),
));

/** Decode-table map from kitty PUA functional-key codes to legacy spellings.
 *  Descriptors are derived from {@link NAMED}; final-letter spellings take
 *  precedence over tilde spellings.
 *  @returns {Map<number, [string, string]>} Map to `final` or `tilde` plus
 *    its spelling. The map object is frozen, but its entries remain mutable.
 */
export const FUNCTIONAL_KEYS = Object.freeze(new Map(
  Object.values(NAMED).filter((v) => v.kitty >= 57348)
    .map((v) => [v.kitty, v.final ? ["final", v.final] : ["tilde", String(v.tilde)]]),
));

/** Internal inspection bundle containing the named-key descriptor source.
 *  @returns {{NAMED: Object}} Frozen wrapper exposing the underlying NAMED
 *    object; freezing the wrapper does not freeze that nested object.
 */
export const keySequenceInternals = Object.freeze({ NAMED });
