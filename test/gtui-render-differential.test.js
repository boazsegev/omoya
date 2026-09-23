import { expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { renderDiff } from "../lib/gtui/render.js";
import { sgr } from "../lib/gtui/cell.js";

const esc = String.fromCharCode(27);
const reset = `${esc}[0m`;
const close = `${esc}]8;;${esc}\\`;
const open = (url) => `${esc}]8;;${url}${esc}\\`;
const sameStyle = (a, b) => a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs;
function oldRender(buffer, prev) {
  let out = "";
  for (const run of buffer.diff(prev)) {
    out += `${esc}[${run.y + 1};${run.x + 1}H`;
    let active = null, styled = false, activeUrl = null;
    for (const cell of run.cells) {
      if (cell.text === null) continue;
      if (cell.url !== activeUrl) { if (activeUrl !== null) out += close; if (cell.url !== null) out += open(cell.url); activeUrl = cell.url; }
      const style = { fg: cell.fg, bg: cell.bg, attrs: cell.attrs };
      if (active === null || !sameStyle(active, style)) { const codes = sgr(style); out += reset + codes; active = style; styled = codes !== ""; }
      out += cell.text;
    }
    if (styled) out += reset;
    if (activeUrl !== null) out += close;
  }
  const cursor = buffer.cursor, previous = prev?.cursor ?? null;
  const sameCursor = (cursor === null) === (previous === null) && (cursor === null || (cursor.x === previous.x && cursor.y === previous.y));
  if (out !== "" || !sameCursor) out += cursor ? `${esc}[${cursor.y + 1};${cursor.x + 1}H${esc}[?25h` : `${esc}[?25l`;
  return out;
}

test("renderDiff randomized differential preserves prior ANSI bytes", () => {
  let seed = 0xdecafbad;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const glyphs = ["a", "b", "日", "🟠"], urls = [null, "https://a.test", "https://b.test"];
  for (let sample = 0; sample < 100; sample++) {
    const before = createBuffer(12, 5), after = createBuffer(12, 5);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 12; x++) {
      const style = { fg: random() % 3 ? null : random() % 256, bg: random() % 5 ? null : random() % 256, attrs: random() % 8, url: urls[random() % urls.length] };
      const glyph = glyphs[random() % glyphs.length];
      before.set(x, y, glyph, style);
      const changed = random() % 3 === 0;
      after.set(x, y, changed ? glyphs[random() % glyphs.length] : glyph, changed ? { ...style, attrs: random() % 8, url: urls[random() % urls.length] } : style);
    }
    if (random() % 2) { const x = random() % 12, y = random() % 5; before.setCursor(x, y); after.setCursor(x, y); }
    expect(renderDiff(after, before)).toBe(oldRender(after, before));
  }
});
