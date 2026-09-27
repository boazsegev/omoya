// test/io-thinking.test.js — the harness thinking vocabulary and its
// mapping onto a model's native modes (lib/io/thinking.js): IO maps a
// level to the nearest native mode at or below it before a provider
// reads `think`.
import { describe, expect, test } from "bun:test";
import { THINKING_LEVELS } from "../lib/io.js";
import { thinkingNative, thinkingSort, thinkingFromError } from "../lib/io/thinking.js";

const OPENAI = ["none", "minimal", "low", "medium", "high", "xhigh"];

describe("thinking vocabulary", () => {
  test("the normalized levels are none through max", () => {
    expect(THINKING_LEVELS).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("thinkingNative", () => {
  test("a model without modes takes no thinking setting at all", () => {
    expect(thinkingNative("high", [])).toBeUndefined();
    expect(thinkingNative("high", undefined)).toBeUndefined();
  });

  test("default is the declared default mapped onto the modes, else nothing", () => {
    expect(thinkingNative(undefined, OPENAI)).toBeUndefined();
    expect(thinkingNative("default", OPENAI, "high")).toBe("high");
    expect(thinkingNative(true, OPENAI, "low")).toBe("low");
    expect(thinkingNative(undefined, ["low", "high"], "medium")).toBe("low");
  });

  test("off is the leading off mode where present, else the weakest mode", () => {
    expect(thinkingNative(false, OPENAI)).toBe("none");
    expect(thinkingNative("none", OPENAI)).toBe("none");
    expect(thinkingNative("off", ["none", "low", "medium"])).toBe("none");
    expect(thinkingNative(false, ["minimal", "low", "medium", "high"])).toBe("minimal");
    expect(thinkingNative(false, ["low", "medium", "high", "xhigh", "max"])).toBe("low");
  });

  test("a level the model lacks maps to the nearest mode at or below it", () => {
    expect(thinkingNative("max", ["low", "medium", "high"])).toBe("high");
    expect(thinkingNative("max", ["none", "minimal", "low", "medium", "high", "ultra"])).toBe("high");
    expect(thinkingNative("medium", ["none", "low", "high"])).toBe("low");
    expect(thinkingNative("xhigh", ["low", "medium", "high", "max"])).toBe("high");
    expect(thinkingNative("low", ["none", "minimal", "medium", "high"])).toBe("minimal");
    expect(thinkingNative("high", ["high"])).toBe("high");
    expect(thinkingNative("xhigh", ["none", "low", "medium", "high", "xhigh"])).toBe("xhigh");
  });

  test("below every effort: the weakest effort, never the off mode", () => {
    expect(thinkingNative("low", ["none", "high", "max"])).toBe("high");
  });

  test("unknown native symbols rank just above their predecessor", () => {
    expect(thinkingNative("medium", ["none", "low", "deep"])).toBe("deep");
    expect(thinkingNative("low", ["none", "low", "deep"])).toBe("low");
  });
});

describe("native mode discovery", () => {
  test("an API rejection's supported-value list is parsed verbatim", () => {
    const message = "Unsupported value: 'minimal' is not supported with the 'gpt-5.5' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.";
    expect(thinkingFromError(message)).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(thinkingFromError("something else")).toBeUndefined();
  });

  test("thinkingSort orders by strength and drops duplicates", () => {
    expect(thinkingSort(["max", "low", "ultra", "low", "none"])).toEqual(["none", "low", "max", "ultra"]);
  });
});
