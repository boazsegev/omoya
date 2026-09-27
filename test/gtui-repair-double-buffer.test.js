// The alt host reuses two screen buffers (lib/app/gtui/screen.js). Proof:
// 1. a steady session only ever swaps the same two buffers; a resize
//    reallocates them once and repaints every row;
// 2. animate -> resize -> scroll on a real host: the emulated terminal
//    matches a fresh layout of the same view after every step.
import { expect, test } from "bun:test";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { createTheme } from "../lib/app/gtui/theme.js";
import { layoutView } from "../lib/app/gtui/layout.js";
import { sceneBuffer } from "../lib/app/gtui/scene-buffer.js";
import { createControls } from "../lib/app/gtui/controls.js";
import { createScreen, screenInvalidate, screenPresent } from "../lib/app/gtui/screen.js";
import { TerminalInput, TerminalScreen } from "./terminal-screen.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("screen buffers are swapped, not reallocated, until the size changes", () => {
  const screen = createScreen();
  const paintText = (text) => (back) => { back.reset(); back.text(0, 0, text); };
  screenPresent(screen, 10, 3, paintText("one"));
  const pair = new Set([screen.front, screen.back]);
  for (const text of ["two", "three", "four"]) {
    const bytes = screenPresent(screen, 10, 3, paintText(text));
    expect(bytes).toContain(text);
    expect(new Set([screen.front, screen.back])).toEqual(pair);
  }
  // Unchanged frame: nothing to write.
  expect(screenPresent(screen, 10, 3, paintText("four"))).toBe("");
  // Invalidated (terminal state unknown): every row repaints, same buffers.
  screenInvalidate(screen);
  expect(screenPresent(screen, 10, 3, paintText("four")).match(/\x1b\[\d+;1H/g)).toHaveLength(3);
  expect(new Set([screen.front, screen.back])).toEqual(pair);
  // Resize: a new pair, full repaint at the new size.
  const bytes = screenPresent(screen, 12, 4, paintText("four"));
  expect(bytes.match(/\x1b\[\d+;1H/g)).toHaveLength(4);
  expect(pair.has(screen.front) || pair.has(screen.back)).toBe(false);
});

test("alt host: animate, resize, then scroll keeps the terminal equal to the model", async () => {
  const tokens = { text: {}, busy: { fg: 1, animation: { type: "flash", role: "accent", period: 20 } }, accent: { fg: 2 } };
  const theme = createTheme(tokens);
  const scrollBar = { track: "|", thumb: "#" };
  const view = (offset) => GTUI.view.column({}, [
    GTUI.view.scroll({ id: "doc", anchor: "end", offset, priority: 0 }, [
      GTUI.view.column({}, Array.from({ length: 30 }, (_, index) => GTUI.view.text({}, `line ${index} ${"~".repeat(index % 9)}`))),
    ]),
    GTUI.view.text({ margin: 0, role: "busy", priority: 20 }, "working…"),
  ]);
  const input = new TerminalInput();
  const output = new TerminalScreen(40, 10);
  let time = 0;
  const timers = [];
  const host = GTUI.host.terminal({
    input, output, mode: "alt", scrollBar, now: () => time,
    setTimeout(callback, delay, state) { const timer = { callback, delay, state, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; },
  });
  const ui = new GTUI({ host, theme: tokens });
  let offset = 0;
  const running = ui.run({
    init: () => ({ model: { offset: 0 }, effects: [] }),
    update: (model, message) => message.type === "key" ? { model: { offset: (offset = model.offset + 1) }, effects: [] } : { model, effects: [] },
    view: (model) => view(model.offset),
  });
  const expected = () => {
    const controls = createControls(() => {}, { scrollBar });
    const buffer = sceneBuffer(layoutView(view(offset), { width: output.columns, height: output.rows, controls, theme }), theme);
    return Array.from({ length: buffer.h }, (_, y) => buffer.row(y).map((cell) => cell.text ?? "").join("").trimEnd());
  };
  const animate = () => {
    time += 20;
    const timer = timers.findLast((entry) => !entry.cancelled);
    timer.cancelled = true;
    timer.callback(timer.state);
  };
  try {
    await tick();
    expect(output.lines()).toEqual(expected());
    const beforeAnimation = output.chunks.length;
    animate();
    // A wake repaints only the animated row, in the next phase's colour.
    const wake = output.chunks.slice(beforeAnimation).join("");
    expect(wake.match(/\x1b\[\d+;1H/g)).toEqual(["\x1b[10;1H"]);
    expect(wake).toContain("working…");
    const colour = (bytes) => bytes.match(/\x1b\[38;5;(\d)mworking/)?.[1];
    expect(colour(wake)).toBeDefined();
    expect(colour(wake)).not.toBe(colour(output.chunks.slice(0, beforeAnimation).join("").split("\x1b[?2026h").at(-1)));
    expect(output.lines()).toEqual(expected());
    output.resize(30, 7);
    await tick();
    expect(output.lines()).toEqual(expected());
    for (let step = 0; step < 6; step++) {
      input.emit("data", Buffer.from("x"));
      await tick();
      expect(output.lines()).toEqual(expected());
      animate();
      expect(output.lines()).toEqual(expected());
    }
    output.resize(44, 12);
    await tick();
    expect(output.lines()).toEqual(expected());
  } finally { ui.stop(); await running; }
});
