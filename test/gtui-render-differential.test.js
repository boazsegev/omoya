import { expect, test } from "bun:test";
import { createBuffer } from "../lib/app/gtui/buffer.js";
import { renderDiff } from "../lib/app/gtui/render.js";
import { graphemeWidth } from "../lib/app/gtui/width.js";
import { TerminalScreen } from "./terminal-screen.js";

const textRows = (buffer) => Array.from({ length: buffer.h }, (_, y) => buffer.row(y).map((cell) => cell.text ?? "").join("").trimEnd());

// Screen-state oracle: after painting `before` and then diffing to `after`,
// the physical screen holds exactly `after` — whatever junk the terminal
// had in cells the buffers consider blank.
test("renderDiff randomized differential reproduces the target screen", () => {
  let seed = 0xdecafbad;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const glyphs = ["a", "b", " ", " ", "日", "🟠"], urls = [null, "https://a.test", "https://b.test"];
  for (let sample = 0; sample < 200; sample++) {
    const before = createBuffer(12, 5), after = createBuffer(12, 5);
    // Advance by glyph width like layout does: a wide glyph's continuation
    // cell is never overwritten by its right neighbour.
    for (let y = 0; y < 5; y++) for (let x = 0; x < 12; x++) {
      if (before.cells[y * 12 + x].text === null || after.cells[y * 12 + x].text === null) continue;
      const style = { fg: random() % 3 ? null : random() % 256, bg: random() % 5 ? null : random() % 256, attrs: random() % 8, url: urls[random() % urls.length] };
      const glyph = glyphs[random() % glyphs.length];
      before.set(x, y, glyph, style);
      const changed = random() % 3 === 0;
      after.set(x, y, changed ? glyphs[random() % glyphs.length] : glyph, changed ? { ...style, attrs: random() % 8, url: urls[random() % urls.length] } : style);
    }
    if (random() % 2) { const x = random() % 12, y = random() % 5; before.setCursor(x, y); after.setCursor(x, y); }
    const screen = new TerminalScreen(12, 5, { wide: (char) => graphemeWidth(char) === 2 });
    // Stale glyphs a width-disagreeing terminal might have left behind.
    screen.write("\x1b[1;1H" + "z".repeat(12 * 5));
    screen.write(renderDiff(before, null));
    expect(screen.lines()).toEqual(textRows(before));
    screen.write(renderDiff(after, before));
    expect(screen.lines()).toEqual(textRows(after));
  }
});
