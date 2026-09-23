import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { createTheme } from "../lib/gtui/theme.js";
import { layoutView, measureView } from "../lib/gtui/layout.js";

const bordered = { decoration: { left: { glyph: "▌", role: "border", gap: 1 } } };

test("generic theme decorates all wrapped and blank rows without source contamination", () => {
  const theme = createTheme({ quoted: bordered });
  const root = GTUI.view.text({ margin: 0, role: "quoted", selectionKey: "source", sourceText: "abc\n\ndef", source: { start: 0, end: 8 } }, "abc\n\ndef");
  const scene = layoutView(root, { width: 4, height: 6, theme });
  expect(scene.snapshot.lines).toEqual(["▌ ab", "▌ c", "▌", "▌ de", "▌ f"]);
  expect(measureView(root, { width: 4, height: 6, theme }).height).toBe(5);
  for (const row of scene.canvas.cells.slice(0, 5)) {
    expect(row[0].source).toBeUndefined();
    expect(row[0].selectionKey).toBeUndefined();
  }
  expect(layoutView(root, { width: 4, height: 6, theme: createTheme() }).snapshot.lines).toEqual(["abc", "", "def"]);
});

test("last explicit null decoration disables a prior combined role decoration", () => {
  const theme = createTheme({ quoted: bordered, plain: { decoration: null } });
  expect(theme.decoration("quoted plain")).toBeNull();
});

test("a narrow decorated box never paints into its adjacent sibling", () => {
  const root = GTUI.view.row({ columns: [1, 3] }, [GTUI.view.text({ margin: 0, role: "quoted" }, "abc"), GTUI.view.text({ margin: 0 }, "")]);
  const scene = layoutView(root, { width: 4, height: 1, theme: createTheme({ quoted: bordered }) });
  expect(scene.snapshot.lines[0]).toBe("▌");
});

for (const left of [{ glyph: "界", role: "border" }, { glyph: "xx", role: "border" }, { glyph: "|", role: "border", gap: -1 }]) {
  test(`invalid theme decoration fails at creation: ${JSON.stringify(left)}`, () => {
    expect(() => createTheme({ quoted: { decoration: { left } } })).toThrow();
  });
}
