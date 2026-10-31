import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resultContent } from "../lib/agent/tool-exec.js";

let warnings;
let emitWarning;
beforeEach(() => {
  warnings = [];
  emitWarning = process.emitWarning;
  process.emitWarning = (warning, options) => warnings.push({ warning, ...options });
});
afterEach(() => { process.emitWarning = emitWarning; });

const NO_OUTPUT = [{ type: "text", text: "(no output)" }];

describe("resultContent empty answers", () => {
  for (const [label, value] of [
    ["empty string", ""],
    ["empty array", []],
    ["empty content", { content: [] }],
    ["only empty text blocks", [{ type: "text", text: "" }]],
  ]) {
    test(`${label} becomes (no output) and warns with the tool name`, () => {
      expect(resultContent(value, "probe")).toEqual(NO_OUTPUT);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe("OMOYA_EMPTY_TOOL_RESULT");
      expect(warnings[0].warning).toContain('"probe"');
    });
  }

  test("meaningful answers pass through without a warning", () => {
    expect(resultContent("ok", "probe")).toEqual([{ type: "text", text: "ok" }]);
    expect(resultContent(null, "probe")).toEqual([{ type: "text", text: "null" }]);
    expect(warnings).toEqual([]);
  });
});
