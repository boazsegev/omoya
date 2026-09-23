import { describe, expect, test } from "bun:test";
import { cometFrame, createTheme, flashFrame, themeRoles, waveFrame } from "../lib/gtui/theme.js";

describe("GTUI themes", () => {
  test("normalizes colors, variants, attributes, and token fallback", () => {
    const theme = createTheme({
      text: { fg: { dark: "ansi:252", light: "ansi:235" } },
      accent: { style: { fg: "#AABBCC", bold: true }, animation: "wave" },
      input: { fg: "ansi:7" },
      cursor: { fg: "#FEDCBA", shape: "block", blinkMs: 700 },
    }, { dark: true });
    expect(theme.resolve("text").fg).toBe(252);
    expect(theme.resolve("accent")).toMatchObject({ fg: "#aabbcc", attrs: 1 });
    expect(theme.resolve("input.text").fg).toBe(7);
    expect(theme.resolve("unknown")).toEqual(theme.resolve("text"));
    expect(theme.animation("accent")).toEqual({ type: "wave" });
    expect(theme.cursor).toEqual({ color: "#fedcba", shape: "block", blinkMs: 700 });
    expect(themeRoles).toContain("overlay.border");
    expect(themeRoles).toContain("cursor");
    expect(themeRoles).toContain("scroll.track");
    expect(themeRoles).toContain("scroll.thumb");
    expect(theme.resolve("scroll.track")).toEqual(theme.resolve("text"));
  });

  test("a link hover role layers theme colors while retaining link underline", () => {
    const theme = createTheme({ "md.link": { underline: true }, "link.hover": { fg: 6, bg: 4 } }, { dark: true });
    expect(theme.resolve("md.link link.hover")).toMatchObject({ fg: 6, bg: 4, attrs: 4 });
  });

  test("detects COLORFGBG correctly and composes base plus inline roles", () => {
    const theme = createTheme({
      text: {},
      base: { fg: { dark: 250, light: 238, default: 7 }, bg: { dark: 8, light: 15, default: null } },
      strong: { bold: true },
    }, { colorfgbg: "15;0" });
    expect(theme.dark).toBe(true);
    expect(theme.resolve("base strong")).toMatchObject({ fg: 250, bg: 8, attrs: 1 });
    const unknown = createTheme({ text: {}, base: { bg: { dark: 8, light: 15, default: null } } }, { colorfgbg: "invalid" });
    expect(unknown.dark).toBeNull();
    expect(unknown.resolve("base").bg).toBeNull();
  });

  test("rejects invalid colors at the theme boundary", () => {
    expect(() => createTheme({ text: { fg: "orange" } })).toThrow("invalid GTUI color");
  });

  test("comet frames are a width-sized color ramp that travels and mirrors", () => {
    for (const width of [12, 40, 100]) {
      let sawLit = false;
      for (const phase of [0, 50, 350, 1550]) {
        const frame = cometFrame(width, phase);
        expect(frame).toHaveLength(width);
        const lit = frame.filter((stop) => stop !== null);
        sawLit ||= lit.length > 0;
        for (const stop of lit) expect(Number.isInteger(stop)).toBe(true);
        // a later phase moves the comet; the animation is not static
        expect(cometFrame(width, phase + 100).join()).not.toBe(frame.join());
        // mirroring flips the geometry around the row's center
        const mirrored = cometFrame(width, phase, { mirror: true });
        expect(mirrored).toHaveLength(width);
        expect(mirrored.filter((stop) => stop !== null).length).toBe(lit.length);
      }
      expect(sawLit).toBe(true); // the comet is on the row at some phase
    }
  });

  test("wave and flash derive solely from the host clock", () => {
    expect(waveFrame("abcd", 0).map(({ role }) => role)).toEqual(["text", "text", "text", "text"]);
    expect(waveFrame("abcd", 350).map(({ role }) => role)).toEqual(["accent", "text", "text", "text"]);
    expect(waveFrame("abcd", 700).map(({ role }) => role)).toEqual(["text", "text", "accent", "text"]);
    expect(waveFrame("abcd", 1400).map(({ role }) => role)).toEqual(["text", "text", "text", "text"]);
    expect(flashFrame(0)).toBe(true);
    expect(flashFrame(600)).toBe(false);
    const theme = createTheme({ text: {}, accent: { fg: 6 }, busy: { fg: 3, animation: "wave" } }, { dark: true });
    expect(theme.animated("busy", { time: 350, index: 0, count: 4 }).fg).toBe(6);
    expect(theme.animated("busy", { time: 0, index: 0, count: 4 }).fg).toBe(3);
    expect(theme.animated("busy", { time: 0, index: 1, count: 4 }).fg).toBe(3);
  });
});
