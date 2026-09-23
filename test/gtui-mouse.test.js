// test/gtui-mouse.test.js — proof for lib/gtui/mouse.js (ported from
// lib/tui-helpers/mouse.js, AI-TUI MIGRATION.md Phase 01 step 2): SGR
// mouse report decode (buttons, release, wheel, modifiers, drag).
import { describe, expect, test } from "bun:test";
import { decodeMouse, isMouseEvent } from "../lib/gtui/mouse.js";

describe("decodeMouse", () => {
  test("buttons, release, wheel and modifiers", () => {
    expect(decodeMouse(0, 5, 7, "M")).toMatchObject({ type: "mouse", button: 0, x: 5, y: 7, press: true, release: false, wheel: null });
    expect(decodeMouse(2, 1, 1, "m")).toMatchObject({ button: 2, press: false, release: true });
    expect(decodeMouse(64, 1, 1, "M")).toMatchObject({ wheel: "up", button: null, press: false });
    expect(decodeMouse(65, 1, 1, "M")).toMatchObject({ wheel: "down" });
    expect(decodeMouse(0 + 4 + 8 + 16, 1, 1, "M")).toMatchObject({ shift: true, meta: true, ctrl: true });
    expect(decodeMouse(32, 1, 1, "M").drag).toBe(true);
    expect(decodeMouse(35, 1, 1, "M")).toMatchObject({ button: 3, press: false, drag: true, move: true });
  });
});

describe("isMouseEvent", () => {
  test("recognizes a decoded mouse event, rejects everything else", () => {
    expect(isMouseEvent(decodeMouse(0, 1, 1, "M"))).toBe(true);
    expect(isMouseEvent("down")).toBe(false);
    expect(isMouseEvent(null)).toBe(false);
    expect(isMouseEvent({ type: "key" })).toBe(false);
  });
});
