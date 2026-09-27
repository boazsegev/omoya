// Regression: default-emoji-presentation symbols (✅ ❌ ⭐ ⚡ …) are drawn two
// columns wide by terminals. Measuring them as one column shifted the rest of
// the row right; the last glyph landed in a cell the alt diff renderer
// believed blank, so scrolling left a trail of repeated last letters.
import { expect, test } from "bun:test";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { graphemeWidth } from "../lib/app/gtui/width.js";
import { createTheme } from "../lib/app/gtui/theme.js";
import { layoutView } from "../lib/app/gtui/layout.js";
import { sceneBaseBuffer } from "../lib/app/gtui/scene-buffer.js";
import { createScreen, screenPresent } from "../lib/app/gtui/screen.js";
import { createControls } from "../lib/app/gtui/controls.js";
import { TerminalScreen } from "./terminal-screen.js";

// East_Asian_Width=W symbols outside the pictograph block (terminal oracle).
const SYMBOLS = ["✅", "❌", "⭐", "⚡", "⌛", "☕", "❗", "❓", "➕", "⬛", "🀄", "🈚"];

test("wide emoji-presentation symbols measure two columns", () => {
  for (const symbol of SYMBOLS) expect([symbol, graphemeWidth(symbol)]).toEqual([symbol, 2]);
  for (const narrow of ["✔", "⚠", "™", "→", "│"]) expect([narrow, graphemeWidth(narrow)]).toEqual([narrow, 1]);
});

function scrollSession(glyphs, wide, scrollBar = { track: "│", thumb: "█" }) {
  const [width, height] = [50, 10];
  const theme = createTheme();
  const controls = createControls(() => {}, { scrollBar });
  const lines = Array.from({ length: 30 }, (_, index) => GTUI.view.text({}, `${glyphs[index % glyphs.length]} item ${index} ${"x".repeat(index % 7)}Z`));
  const root = (offset) => GTUI.view.scroll({ id: "history", anchor: "end", offset }, [GTUI.view.column({}, lines)]);
  const screen = new TerminalScreen(width, height, { wide });
  const frames = createScreen();
  for (const offset of [...Array(15).keys(), ...Array.from({ length: 15 }, (_, index) => 14 - index)]) {
    const scene = layoutView(root(offset), { width, height, controls, theme });
    screen.write(screenPresent(frames, width, height, (back) => sceneBaseBuffer(scene, theme, back)));
    const buffer = frames.front;
    const expected = Array.from({ length: height }, (_, y) => buffer.row(y).map((cell) => cell.text ?? "").join("").trimEnd());
    // The oracle joins wide glyphs without their continuation, so a row
    // shifted by a width disagreement still reads equal — only stale glyphs differ.
    expect(screen.lines().map((line) => line.replace(/ +(?=[│█]$)/, " "))).toEqual(expected.map((line) => line.replace(/ +(?=[│█]$)/, " ")));
  }
}

test("alt scrolling over wide symbols leaves no stale trailing glyphs", () => {
  scrollSession(SYMBOLS, (char) => SYMBOLS.includes(char));
});

// Ambiguous-width glyphs (⚠) are one column to us but two in some terminals.
// Row repaint + erase-to-end-of-line keeps stale glyphs from surviving. (A
// glyph in the final column would still be pushed off the row, which is why
// widths must be right; this test isolates the stale-glyph safety net.)
test("alt scrolling leaves no stale glyphs when a terminal draws an ambiguous glyph wide", () => {
  scrollSession(["⚠", "a"], (char) => char === "⚠", null);
});

test("alt scrolling over wide symbols matches cell-for-cell", () => {
  const [width, height] = [50, 10];
  const theme = createTheme();
  const controls = createControls(() => {}, { scrollBar: { track: "│", thumb: "█" } });
  const lines = Array.from({ length: 30 }, (_, index) => GTUI.view.text({}, `${SYMBOLS[index % SYMBOLS.length]} item ${index} ${"x".repeat(index % 7)}Z`));
  const root = (offset) => GTUI.view.scroll({ id: "history", anchor: "end", offset }, [GTUI.view.column({}, lines)]);
  const screen = new TerminalScreen(width, height, { wide: (char) => SYMBOLS.includes(char) });
  const frames = createScreen();
  for (const offset of [...Array(15).keys(), ...Array.from({ length: 15 }, (_, index) => 14 - index)]) {
    const scene = layoutView(root(offset), { width, height, controls, theme });
    screen.write(screenPresent(frames, width, height, (back) => sceneBaseBuffer(scene, theme, back)));
    const buffer = frames.front;
    const expected = Array.from({ length: height }, (_, y) => buffer.row(y).map((cell) => cell.text ?? "").join("").trimEnd());
    expect(screen.lines()).toEqual(expected);
  }
});
