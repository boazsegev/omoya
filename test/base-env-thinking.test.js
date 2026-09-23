// test/base-env-thinking.test.js — the harness thinking vocabulary and
// its translation to per-model native effort symbols (lib/env/thinking.js).
import { describe, expect, test } from "bun:test";
import {
  THINKING_LEVELS, DEFAULT_THINKING, resolveEffort, sortEfforts, registryEffortLevels, supportedValues,
} from "../lib/env.js";

describe("thinking vocabulary", () => {
  test("the visible levels are default/off/low/medium/high/xhigh; a silent model thinks at medium", () => {
    expect(THINKING_LEVELS).toEqual(["default", "off", "low", "medium", "high", "xhigh"]);
    expect(DEFAULT_THINKING).toBe("high");
  });
});

describe("resolveEffort", () => {
  test("default uses the model's advertised default, else high", () => {
    expect(resolveEffort(undefined)).toBe("high");
    expect(resolveEffort("default")).toBe("high");
    expect(resolveEffort(true, { defaultLevel: "low" })).toBe("low");
  });

  test("off is none where accepted, else the weakest accepted symbol", () => {
    expect(resolveEffort(false)).toBe("none");
    expect(resolveEffort("off", { levels: ["none", "low", "medium"] })).toBe("none");
    expect(resolveEffort(false, { levels: ["minimal", "low", "medium", "high"] })).toBe("minimal");
    expect(resolveEffort(false, { levels: ["low", "medium", "high", "xhigh", "max"] })).toBe("low");
  });

  test("a level the model lacks maps to its nearest symbol; ties go stronger", () => {
    expect(resolveEffort("xhigh", { levels: ["low", "medium", "high"] })).toBe("high");
    expect(resolveEffort("medium", { levels: ["low", "high", "max"] })).toBe("high");
    expect(resolveEffort("high", { levels: ["high"] })).toBe("high");
    expect(resolveEffort("xhigh", { levels: ["none", "low", "medium", "high", "xhigh"] })).toBe("xhigh");
  });

  test("an advertised default outside the accepted set is translated too", () => {
    expect(resolveEffort(undefined, { levels: ["low", "high"], defaultLevel: "medium" })).toBe("high");
  });
});

describe("native level discovery", () => {
  test("models.dev effort options become an ordered level list", () => {
    expect(registryEffortLevels({ reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["xhigh", "low", "none", "high"] }] }))
      .toEqual(["none", "low", "high", "xhigh"]);
    expect(registryEffortLevels({ reasoning_options: [{ type: "budget_tokens", min: 1024 }] })).toBeUndefined();
    expect(registryEffortLevels({})).toBeUndefined();
  });

  test("an API rejection's supported-value list is parsed verbatim", () => {
    const message = "Unsupported value: 'minimal' is not supported with the 'gpt-5.5' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.";
    expect(supportedValues(message)).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(supportedValues("something else")).toBeUndefined();
  });

  test("sortEfforts orders by strength and drops duplicates", () => {
    expect(sortEfforts(["max", "low", "ultra", "low", "none"])).toEqual(["none", "low", "max", "ultra"]);
  });
});
