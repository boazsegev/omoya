import { expect, test } from "bun:test";
import { canonicalKey, compileBindings, decodeKey, matchesBinding } from "../lib/gtui/keymap.js";

for (let modifiers = 0; modifiers < 16; modifiers++) {
  test(`modifier bucket ${modifiers} matches only its own normalized key`, () => {
    const key = canonicalKey("left", modifiers);
    const table = compileBindings(Object.freeze([key]));
    expect(decodeKey(key)).toEqual({ code: "left", modifiers });
    expect(matchesBinding(table, { code: "left", modifiers })).toBe(true);
    expect(matchesBinding(table, { code: "left", modifiers: modifiers ^ 1 })).toBe(false);
    expect(Object.isFrozen(table.tables[modifiers])).toBe(true);
  });
}

test("cmd and meta bindings share the command bucket", () => {
  expect(matchesBinding(compileBindings(["cmd+c"]), { code: "c", modifiers: 4 })).toBe(true);
  expect(matchesBinding(compileBindings(["meta+c"]), { key: "cmd+c" })).toBe(true);
});

test("mutable binding lists are recompiled and frozen lists retain their tables", () => {
  const mutable = ["left"];
  const before = compileBindings(mutable);
  mutable[0] = "right";
  const after = compileBindings(mutable);
  expect(matchesBinding(before, { key: "left" })).toBe(true);
  expect(matchesBinding(after, { key: "left" })).toBe(false);
  expect(matchesBinding(after, { key: "right" })).toBe(true);
  const frozen = Object.freeze(["right"]);
  expect(compileBindings(frozen)).toBe(compileBindings(frozen));
});
