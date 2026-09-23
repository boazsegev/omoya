// test/cli-tool-run.test.js — proof for lib/cli/tool-run.js: the
// shared "manual door" arg-resolution and result-unwrapping used by
// bin/ai-tool and the TUI's /<tool> command.
import { describe, expect, test } from "bun:test";
import { resolveToolArgs, unwrapToolResult, formatToolResult } from "../lib/cli.js";

describe("resolveToolArgs", () => {
  const entry = { name: "skill", schema: { inputSchema: { properties: { names: {}, args: {} } } } };

  test("undefined/empty raw means no arguments", () => {
    expect(resolveToolArgs(undefined, entry)).toEqual({});
    expect(resolveToolArgs("", entry)).toEqual({});
  });

  test("a JSON object passes through as-is", () => {
    expect(resolveToolArgs('{"names": ["core"]}', entry)).toEqual({ names: ["core"] });
  });

  test("a bare JSON value shorthands into the tool's FIRST schema property", () => {
    expect(resolveToolArgs('["core"]', entry)).toEqual({ names: ["core"] });
    expect(resolveToolArgs('"core"', entry)).toEqual({ names: "core" });
  });

  test("invalid JSON is a clear error", () => {
    expect(() => resolveToolArgs("{ not json", entry)).toThrow(/invalid JSON args/);
  });

  test("a bare value against a tool with no schema properties refuses to guess", () => {
    expect(() => resolveToolArgs("42", { name: "bare-tool" })).toThrow(/no schema property to shorthand/);
  });
});

describe("unwrapToolResult / formatToolResult", () => {
  test("a plain value is the whole result, no side channels", () => {
    expect(unwrapToolResult("hello")).toEqual({ result: "hello", system: [], display: [] });
    expect(unwrapToolResult({ ok: true })).toEqual({ result: { ok: true }, system: [], display: [] });
  });

  test("an envelope splits result from system/display, normalized to arrays", () => {
    expect(unwrapToolResult({ result: "r", system: "s" })).toEqual({ result: "r", system: ["s"], display: [] });
    expect(unwrapToolResult({ result: "r", display: ["a", "b"] })).toEqual({ result: "r", system: [], display: ["a", "b"] });
  });

  test("formatToolResult prints strings as-is, everything else as pretty JSON", () => {
    expect(formatToolResult("plain text")).toBe("plain text");
    expect(formatToolResult({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(formatToolResult([1, 2])).toBe(JSON.stringify([1, 2], null, 2));
  });

  test("formatToolResult always returns a STRING, even for undefined (JSON.stringify(undefined) is not text)", () => {
    expect(formatToolResult(undefined)).toBe("undefined");
    expect(typeof formatToolResult(undefined)).toBe("string");
  });
});
