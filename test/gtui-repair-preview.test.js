import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { layoutView, measureView } from "../lib/gtui/layout.js";

test("generic tail preview retains last eight wrapped rows with logical source offsets", () => {
  const source = Array.from({ length: 12 }, (_, index) => `row ${index}`).join("\n");
  const root = GTUI.view.column({ maxRows: 8, overflow: "tail" }, [GTUI.view.text({ margin: 0, sourceText: source, selectionKey: "s", source: { start: 0, end: source.length } }, source)]);
  const scene = layoutView(root, { width: 30, height: 20 });
  expect(scene.snapshot.lines).toEqual(Array.from({ length: 8 }, (_, index) => `row ${index + 4}`));
  expect(measureView(root, { width: 30, height: 20 }).height).toBe(8);
  expect(scene.canvas.cells[0][0].source.start).toBe(source.indexOf("row 4"));
});

test("tail caps visual soft-wrap rows across markdown children, preserving their source identity", () => {
  const first = "one two three four";
  const second = "five six seven eight";
  const root = GTUI.view.column({ maxRows: 3, overflow: "tail" }, [
    GTUI.view.text({ margin: 0, sourceText: first, source: { start: 0, end: first.length } }, first),
    GTUI.view.text({ margin: 0, sourceText: second, source: { start: 100, end: 100 + second.length } }, second),
  ]);
  const scene = layoutView(root, { width: 6, height: 20 });
  expect(scene.snapshot.lines).toEqual(["six", "seven", "eight"]);
  expect(measureView(root, { width: 6, height: 20 }).height).toBe(3);
  expect(scene.canvas.cells[0][0].source.start).toBe(105);
});

test("tail preview can retain a head and mark omitted visual rows", () => {
  const source = Array.from({ length: 8 }, (_, index) => `row ${index}`).join("\n");
  const root = GTUI.view.column({ maxRows: 3, overflow: "tail", head: 1, ellipsis: true }, [
    GTUI.view.text({ margin: 0, sourceText: source, selectionKey: "s", source: { start: 0, end: source.length } }, source),
  ]);
  const scene = layoutView(root, { width: 30, height: 20 });
  expect(scene.snapshot.lines).toEqual(["row 0", "...", "row 5", "row 6", "row 7"]);
  expect(measureView(root, { width: 30, height: 20 }).height).toBe(5);
  expect(scene.canvas.cells[0][0].source.start).toBe(0);
  expect(scene.canvas.cells[2][0].source.start).toBe(source.indexOf("row 5"));
});

test("head/ellipsis preview does not add an ellipsis when no rows are omitted", () => {
  const children = ["a", "b", "c"].map((content) => GTUI.view.text({ margin: 0 }, content));
  const root = GTUI.view.column({ maxRows: 2, overflow: "tail", head: 1, ellipsis: true }, children);
  expect(layoutView(root, { width: 10, height: 10 }).snapshot.lines).toEqual(["a", "b", "c"]);
  expect(measureView(root, { width: 10, height: 10 }).height).toBe(3);
});

test("tail preview is safe at zero capacity and remains a stable suffix as it grows", () => {
  const children = ["a", "b", "c", "d"].map((text) => GTUI.view.text({ margin: 0 }, text));
  const zero = GTUI.view.column({ maxRows: 0, overflow: "tail" }, children);
  expect(measureView(zero, { width: 1, height: 5 }).height).toBe(0);
  expect(layoutView(zero, { width: 1, height: 5 }).snapshot.lines).toEqual([]);
  const preview = GTUI.view.column({ maxRows: 2, overflow: "tail" }, children);
  expect(layoutView(preview, { width: 1, height: 5 }).snapshot.lines).toEqual(["c", "d"]);
  const grown = GTUI.view.column({ maxRows: 2, overflow: "tail" }, [...children, GTUI.view.text({ margin: 0 }, "e")]);
  expect(layoutView(grown, { width: 1, height: 5 }).snapshot.lines).toEqual(["d", "e"]);
});
