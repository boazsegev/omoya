import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { compileBindings, matchesBinding } from "../lib/gtui/keymap.js";
import { appBindings, resolveKeymap } from "../lib/tui-app/bindings.js";

const model = (overlay = null, completions = [], question = null) => ({ overlay, input: { completions }, question });

test("named contexts contain sixteen immutable null-prototype routing tables", () => {
  const context = GTUI.keybindings.create("Main", ["ctrl+x", "alt+shift+left"]);
  expect(context.name).toBe("Main");
  expect(context.tables).toHaveLength(16);
  for (const table of context.tables) {
    expect(Object.getPrototypeOf(table)).toBe(null);
    expect(Object.isFrozen(table)).toBe(true);
  }
  expect(context.tables[2].x).toBe(true);
  expect(context.tables[9].left).toBe(true);
  expect(context.tables[2].missing).toBeUndefined();
  expect(compileBindings(context)).toBe(context);
  expect(Object.isFrozen(context)).toBe(true);
});

test("application selects stable named contexts for finite overlay states", () => {
  const main = appBindings(model());
  const menu = appBindings(model({ type: "menu" }));
  const viewer = appBindings(model({ type: "viewer" }));
  const completion = appBindings(model(null, ["item"]));
  const combined = appBindings(model({ type: "viewer" }, ["item"]));
  const question = appBindings(model(null, [], {}));
  expect(new Set([main, menu, viewer, completion, combined, question]).size).toBe(6);
  for (const context of [main, menu, viewer, completion, combined, question]) {
    expect(context.tables).toHaveLength(16);
    expect(typeof context.name).toBe("string");
    expect(compileBindings(context)).toBe(context);
  }
  expect(appBindings(model())).toBe(main);
  expect(appBindings(model({ type: "menu" }))).toBe(menu);
  expect(appBindings(model({ type: "viewer" }))).toBe(viewer);
});

test("unknown and inherited names do not route and Unicode text cannot collide", () => {
  const context = GTUI.keybindings.create("safe", ["ctrl+x"]);
  expect(matchesBinding(context, { code: "constructor", modifiers: 2 })).toBe(false);
  expect(matchesBinding(context, { code: "toString", modifiers: 2 })).toBe(false);
  expect(matchesBinding(context, { code: "é", modifiers: 2 })).toBe(false);
  expect(matchesBinding(context, { code: "x", modifiers: 2 })).toBe(true);
});

test("word-navigation keys stay out of app routing even when settings try to claim them", () => {
  const keymap = resolveKeymap({ tui: { keys: { fork: "alt+right", nextSession: "alt+right" } } });
  expect(keymap.fork).toBe("alt+shift+f");
  expect(keymap.nextSession).toEqual(["alt+ctrl+right"]);
  const context = appBindings(model(), Object.values(keymap).flat());
  expect(matchesBinding(compileBindings(context), { code: "right", modifiers: 1 })).toBe(false);
});

test("all sixteen modifier masks remain separate with normalized string codes", () => {
  for (let modifiers = 0; modifiers < 16; modifiers++) {
    const context = GTUI.keybindings.create(`mask-${modifiers}`, [
      `${modifiers & 1 ? "alt+" : ""}${modifiers & 2 ? "ctrl+" : ""}${modifiers & 4 ? "meta+" : ""}${modifiers & 8 ? "shift+" : ""}x`,
    ]);
    expect(matchesBinding(context, { code: "x", modifiers })).toBe(true);
    expect(matchesBinding(context, { code: "x", modifiers: modifiers ^ 1 })).toBe(false);
  }
});
