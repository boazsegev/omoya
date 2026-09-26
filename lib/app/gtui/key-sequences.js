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

/** Kitty/xterm modifier value (1 + bitmask) → GTUI modifier bits.
 *  kitty adds bit 8 for SUPER (Cmd on macOS); xterm's encoding tops out
 *  at the same 1/2/4/8 bitmask shifted by one. Value 1 (or absent) is
 *  "no modifiers". Legacy readline bytes cannot express SUPER at all. */
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

/** GTUI modifier bits → kitty/xterm modifier value (inverse of modifierBits). */
export function modifierValue(bits) {
  let value = 1;
  if (bits & SHIFT) value += 1;
  if (bits & ALT) value += 2;
  if (bits & CTRL) value += 4;
  if (bits & META) value += 8;
  return value;
}

/** Named keys addressable through every protocol. `key` is the canonical
 *  readline name ("left", "return", …) so all spellings decode to the
 *  same event; the GTUI public spelling ("enter", "delete") maps on top. */
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

/** kitty / modifyOtherKeys code → canonical named key (decode table). */
export const CSI_U_KEYS = Object.freeze(new Map(
  Object.entries(NAMED).filter(([, v]) => v.kitty !== undefined).map(([name, v]) => [v.kitty, { name, key: v.key }]),
));

/** Legacy CSI n ~ code → canonical named key (decode table). */
export const CSI_TILDE_KEYS = Object.freeze(new Map(
  Object.entries(NAMED).filter(([, v]) => v.tilde !== undefined).map(([name, v]) => [v.tilde, { name, key: v.key }]),
));

/** Legacy CSI 1 ; mod <final-letter> → canonical named key (decode table). */
export const CSI_FINAL_KEYS = Object.freeze(new Map(
  Object.entries(NAMED).filter(([, v]) => v.final !== undefined).map(([name, v]) => [v.final, { name, key: v.key }]),
));

/** kitty PUA functional-key code → its legacy legacy-spelling descriptor,
 *  derived from the SAME map (the arrows keep their specified order and
 *  every modifier survives, unlike the retired ad-hoc table). */
export const FUNCTIONAL_KEYS = Object.freeze(new Map(
  Object.values(NAMED).filter((v) => v.kitty >= 57348)
    .map((v) => [v.kitty, v.final ? ["final", v.final] : ["tilde", String(v.tilde)]]),
));

export const keySequenceInternals = Object.freeze({ NAMED });
