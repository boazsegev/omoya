// test/gtui-term.test.js — proof for lib/gtui/term.js (ported from
// lib/tui-helpers/term.js + terminal-title.js's OSC 0 mechanism,
// AI-TUI MIGRATION.md Phase 01 step 2): cursor shape/visibility,
// synchronized-output framing, window title.
import { describe, expect, test } from "bun:test";
import {
  SYNC_START, SYNC_END, CURSOR_SHOW, CURSOR_HIDE,
  cursorStyle, cursorStyleReset, notificationBytes, overlayCursorHidden, titleBytes,
} from "../lib/gtui/term.js";

describe("synchronized-output framing", () => {
  test("begin/end bracket a frame", () => {
    expect(SYNC_START).toBe("\x1b[?2026h");
    expect(SYNC_END).toBe("\x1b[?2026l");
  });
});

describe("cursor visibility", () => {
  test("show/hide the hardware cursor", () => {
    expect(CURSOR_SHOW).toBe("\x1b[?25h");
    expect(CURSOR_HIDE).toBe("\x1b[?25l");
    expect(overlayCursorHidden()).toBe(CURSOR_HIDE);
  });
});

describe("terminal cursor style", () => {
  test("defaults to a blinking vertical line and resets on exit", () => {
    expect(cursorStyle()).toBe("\x1b[5 q");
    expect(cursorStyle(1, false)).toBe("\x1b[6 q");
    expect(cursorStyle(1, 1000)).toBe("\x1b[5 q");
    expect(cursorStyleReset()).toBe("\x1b[0 q");
  });

  test("accepts named cursor shapes while preserving the width compatibility preference", () => {
    expect(cursorStyle("line")).toBe("\x1b[5 q");
    expect(cursorStyle("underline", false)).toBe("\x1b[4 q");
    expect(cursorStyle("block")).toBe("\x1b[1 q");
    expect(cursorStyle(1)).toBe("\x1b[5 q");
    expect(cursorStyle(50)).toBe("\x1b[3 q");
    expect(cursorStyle(100)).toBe("\x1b[1 q");
  });
});

describe("window/tab title and notifications", () => {
  test("frames sanitized strings as OSC without visible screen writes", () => {
    expect(titleBytes("@repo/project")).toBe("\x1b]0;@repo/project\x07");
    expect(titleBytes("bad\x07\x1btitle")).toBe("\x1b]0;bad title\x07");
    expect(notificationBytes("build\nfinished")).toBe("\x1b]9;build finished\x07");
  });
});
