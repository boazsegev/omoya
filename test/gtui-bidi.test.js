// Pragmatic Hebrew/Arabic visual ordering at the rendering boundary.
import { describe, expect, test } from "bun:test";
import { detectBidi, renderBidi } from "../lib/gtui/bidi.js";
import { createBuffer } from "../lib/gtui/buffer.js";

describe("detectBidi: plain LTR text", () => {
  test("no RTL code points: hasRTL false, no runs", () => {
    expect(detectBidi("hello world 123")).toEqual({ hasRTL: false, runs: [] });
  });
  test("empty string: no runs", () => {
    expect(detectBidi("")).toEqual({ hasRTL: false, runs: [] });
  });
});

describe("detectBidi: Hebrew and Arabic", () => {
  test("a bare Hebrew word is one run spanning it exactly", () => {
    const r = detectBidi("שלום");
    expect(r.hasRTL).toBe(true);
    expect(r.runs).toEqual([{ start: 0, end: 4, dir: "rtl" }]);
  });
  test("a bare Arabic word is one run spanning it exactly", () => {
    const r = detectBidi("مرحبا");
    expect(r.hasRTL).toBe(true);
    expect(r.runs[0].dir).toBe("rtl");
    expect(r.runs[0].end - r.runs[0].start).toBe(5);
  });
});

describe("detectBidi: mixed text", () => {
  test("an RTL word inside an LTR sentence: one run, LTR neighbors excluded", () => {
    const text = "hello שלום world";
    const r = detectBidi(text);
    expect(r.runs).toHaveLength(1);
    const { start, end } = r.runs[0];
    expect(text.slice(start, end)).toBe("שלום");
  });

  test("neutrals (spaces) BETWEEN two RTL spans merge them into ONE run", () => {
    // "שלום עולם" — two Hebrew words separated by a space; the space
    // sits between RTL content on both sides, so it's absorbed
    const text = "שלום עולם";
    const r = detectBidi(text);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toEqual({ start: 0, end: text.length, dir: "rtl" });
  });

  test("a trailing neutral is trimmed off the run, never left dangling on RTL content alone", () => {
    const text = "שלום, world"; // comma+space after the RTL word, then LTR
    const r = detectBidi(text);
    expect(r.runs).toHaveLength(1);
    // the run ends exactly at the RTL word — the ", " tail belongs to neither side
    expect(text.slice(r.runs[0].start, r.runs[0].end)).toBe("שלום");
  });

  test("two RTL spans separated by LTR text: two SEPARATE runs", () => {
    const text = "שלום hello עולם";
    const r = detectBidi(text);
    expect(r.runs).toHaveLength(2);
    expect(text.slice(r.runs[0].start, r.runs[0].end)).toBe("שלום");
    expect(text.slice(r.runs[1].start, r.runs[1].end)).toBe("עולם");
  });
});


describe("renderBidi: visual output only", () => {
  test("reverses RTL runs while retaining surrounding LTR order", () => {
    expect(renderBidi("hello שלום world")).toBe("hello םולש world");
    expect(renderBidi("שלום עולם")).toBe("םלוע םולש");
  });

  test("keeps Arabic combining marks attached to their base grapheme", () => {
    expect(renderBidi("مَر")).toBe("رمَ");
  });

  test("Buffer.text applies visual ordering without mutating source", () => {
    const source = "שלום";
    const buffer = createBuffer(8, 1);
    buffer.text(0, 0, source);
    expect(buffer.row(0).slice(0, 4).map((entry) => entry.text).join("")).toBe("םולש");
    expect(source).toBe("שלום");
  });
});
