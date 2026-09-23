import { expect, test } from "bun:test";
import { createInlineRenderer } from "../lib/gtui/inline-render.js";
import { TerminalScreen } from "./terminal-screen.js";

test("ordinary inline update leaves the unchanged transcript prefix untouched", () => {
  const render = createInlineRenderer({ rows: () => 12, sync: false });
  const output = new TerminalScreen(50, 12);
  output.write(render.paint({ region: ["settled first", "settled second", "stream: a", "> "], cursor: { row: 4, col: 3 } }));
  const update = render.paint({ region: ["settled first", "settled second", "stream: ab", "> "], cursor: { row: 4, col: 3 } });
  expect(update).not.toContain("settled first");
  expect(update).not.toContain("settled second");
  expect(update).not.toContain("\x1b[3J");
  output.write(update);
  expect(output.text()).toContain("settled first\nsettled second\nstream: ab\n>");
});

test("unchanged inline region emits no bytes", () => {
  const render = createInlineRenderer({ rows: () => 8, sync: false });
  const frame = { region: ["settled", "> "], cursor: { row: 2, col: 3 } };
  render.paint(frame);
  expect(render.paint(frame)).toBe("");
});

test("cursor-only inline updates use relative movement without repainting rows", () => {
  const render = createInlineRenderer({ rows: () => 8, sync: false });
  const frame = { region: ["settled", "> "], cursor: { row: 2, col: 3 } };
  render.paint(frame);
  const bytes = render.paint({ ...frame, cursor: { row: 1, col: 2 } });
  expect(bytes).toBe("\x1b[1A\r\x1b[1C");
  expect(bytes).not.toContain("settled");
  expect(bytes).not.toContain("\x1b[J");
});

test("tail shrink, growth, and emptying preserve the physical viewport", () => {
  let height = 4;
  const render = createInlineRenderer({ rows: () => height, sync: false });
  const output = new TerminalScreen(30, 4);
  output.write(render.paint({ region: ["one", "two", "three"], cursor: { row: 3, col: 6 } }));
  output.write(render.paint({ region: ["one", "two"], cursor: { row: 2, col: 4 } }));
  expect(output.text()).toContain("one\ntwo");
  expect(output.lines()[2]).toBe("");
  output.write(render.paint({ region: ["one", "two", "three", "four"], cursor: { row: 4, col: 5 } }));
  expect(output.text()).toContain("one\ntwo\nthree\nfour");
  output.write(render.paint({ region: [], cursor: null }));
  expect(output.lines()).toEqual(["", "", "", ""]);
  height = 2;
  output.write(render.paint({ region: ["one", "two", "three"], cursor: { row: 2, col: 4 } }));
  expect(render.region()).toEqual(["two", "three"]);
  expect(output.text()).toContain("two\nthree");
});

test("a native-history commit repaints the old tail once rather than duplicating it", () => {
  const render = createInlineRenderer({ rows: () => 5, sync: false });
  const output = new TerminalScreen(30, 5);
  output.write(render.paint({ region: ["old", "live"], cursor: { row: 2, col: 5 } }));
  const bytes = render.paint({ commit: ["old"], region: ["live"], cursor: { row: 1, col: 5 } });
  expect((bytes.match(/old/g) ?? []).length).toBe(1);
  output.write(bytes);
  expect(output.text()).toContain("old\nlive");
});
