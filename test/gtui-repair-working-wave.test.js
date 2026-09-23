import { expect, test } from "bun:test";
import { createTheme } from "../lib/gtui/theme.js";

test("wave uses three configured crest colors over normal bold text", () => {
  const theme = createTheme({ working: { bold: true, animation: { type: "wave", period: 1400, colors: [220, 208, 220] } } });
  const styles = Array.from({ length: 7 }, (_, index) => theme.animated("working", { time: 700, index, count: 7 }));
  expect(styles.map((style) => style.fg)).toEqual([null, null, 220, 208, 220, null, null]);
  expect(styles.every((style) => (style.attrs & 1) !== 0)).toBe(true);
});

test("mirrored wave ping-pongs instead of jumping back after one-way travel", () => {
  const theme = createTheme({ working: { animation: { type: "wave", period: 1000, mirror: true, colors: [220] } } });
  const colorsAt = (time) => Array.from({ length: 5 }, (_, index) => theme.animated("working", { time, index, count: 5 }).fg);
  expect(colorsAt(0)).toEqual([null, null, null, null, null]);
  expect(colorsAt(500)).toEqual([null, null, 220, null, null]);
  expect(colorsAt(1000)).toEqual([null, null, null, null, null]);
  expect(colorsAt(1500)).toEqual([null, null, 220, null, null]);
  expect(colorsAt(2000)).toEqual([null, null, null, null, null]);
});

test("the complete three-color wave clears the word before reversing", () => {
  const theme = createTheme({ working: { animation: { type: "wave", period: 1000, colors: [220, 208, 220] } } });
  const colorsAt = (time) => Array.from({ length: 5 }, (_, index) => theme.animated("working", { time, index, count: 5 }).fg);

  expect(colorsAt(0)).toEqual([null, null, null, null, null]);
  expect(colorsAt(500)).toEqual([null, 220, 208, 220, null]);
  expect(colorsAt(1000)).toEqual([null, null, null, null, null]);
  expect(colorsAt(1500)).toEqual([null, 220, 208, 220, null]);
});
