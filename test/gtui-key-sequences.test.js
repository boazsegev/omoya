// test/gtui-key-sequences.test.js — proof for lib/gtui/key-sequences.js:
// the DECLARATIVE escape-sequence maps stay internally consistent (one
// semantic key ↔ every protocol's spelling), so byte-filter decode and
// term-host enable bytes can never drift apart into per-key brittleness.
import { describe, expect, test } from "bun:test";
import {
  CSI_FINAL_KEYS, CSI_TILDE_KEYS, CSI_U_KEYS, FUNCTIONAL_KEYS,
  keySequenceInternals, modifierBits, modifierValue,
} from "../lib/gtui/key-sequences.js";
import { ALT, CTRL, META, SHIFT } from "../lib/gtui/keymap.js";

describe("modifier value ↔ bits round-trip", () => {
  test("kitty modifier values map to GTUI modifier bits and back", () => {
    expect(modifierBits(undefined)).toBe(0);
    expect(modifierBits(1)).toBe(0);
    expect(modifierBits(2)).toBe(SHIFT);
    expect(modifierBits(3)).toBe(ALT);
    expect(modifierBits(4)).toBe(SHIFT | ALT);
    expect(modifierBits(5)).toBe(CTRL);
    expect(modifierBits(8)).toBe(SHIFT | ALT | CTRL);
    expect(modifierBits(9)).toBe(META); // kitty SUPER (Cmd)
    expect(modifierValue(SHIFT)).toBe(2);
    expect(modifierValue(ALT | CTRL)).toBe(7);
    expect(modifierValue(META | SHIFT)).toBe(10);
    for (let value = 1; value <= 16; value++) expect(modifierValue(modifierBits(value))).toBe(value);
  });
});

describe("the named-key tables stay one coherent map", () => {
  const { NAMED } = keySequenceInternals;

  test("every kitty code decodes to the same named key across tables", () => {
    for (const [name, spec] of Object.entries(NAMED)) {
      expect(CSI_U_KEYS.get(spec.kitty)).toEqual({ name, key: spec.key });
      if (spec.tilde !== undefined) expect(CSI_TILDE_KEYS.get(spec.tilde)).toEqual({ name, key: spec.key });
      if (spec.final !== undefined) expect(CSI_FINAL_KEYS.get(spec.final)).toEqual({ name, key: spec.key });
    }
  });

  test("kitty PUA functional keys derive their legacy spellings from the same map", () => {
    // Arrows keep the specified order (the retired ad-hoc table had them
    // scrambled) and each keeps a legacy final-letter spelling.
    expect(FUNCTIONAL_KEYS.get(57350)).toEqual(["final", "D"]); // left
    expect(FUNCTIONAL_KEYS.get(57351)).toEqual(["final", "C"]); // right
    expect(FUNCTIONAL_KEYS.get(57352)).toEqual(["final", "A"]); // up
    expect(FUNCTIONAL_KEYS.get(57353)).toEqual(["final", "B"]); // down
    expect(FUNCTIONAL_KEYS.get(57349)).toEqual(["tilde", "3"]); // delete
    expect(FUNCTIONAL_KEYS.get(57356)).toEqual(["final", "H"]); // home
  });

  test("no two named keys share a kitty, tilde, or final spelling", () => {
    const kitty = new Set(), tilde = new Set(), final = new Set();
    for (const spec of Object.values(NAMED)) {
      if (spec.kitty !== undefined) { expect(kitty.has(spec.kitty)).toBe(false); kitty.add(spec.kitty); }
      if (spec.tilde !== undefined) { expect(tilde.has(spec.tilde)).toBe(false); tilde.add(spec.tilde); }
      if (spec.final !== undefined) { expect(final.has(spec.final)).toBe(false); final.add(spec.final); }
    }
  });
});
