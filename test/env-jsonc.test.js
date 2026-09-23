// test/env-jsonc.test.js — proof for lib/env/jsonc.js: // and /* */
// comments stripped outside string literals, real JSON untouched.
import { describe, expect, test } from "bun:test";
import { parseJsonc, stripJsonComments } from "../lib/env/jsonc.js";

describe("stripJsonComments / parseJsonc", () => {
  test("line and block comments are removed", () => {
    const text = `{
      // a line comment
      "a": 1, /* a block comment */ "b": 2
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  test("a // inside a string is never treated as a comment", () => {
    expect(parseJsonc(`{ "url": "https://example.com" }`)).toEqual({ url: "https://example.com" });
  });

  test("an escaped quote inside a string does not end it early", () => {
    expect(parseJsonc(String.raw`{ "a": "say \"//not a comment\"" }`)).toEqual({ a: 'say "//not a comment"' });
  });

  test("a commented-out key leaves valid JSON behind", () => {
    const text = `{
      // "toolTimeout": 120000,
      "maxActive": 4
    }`;
    expect(parseJsonc(text)).toEqual({ maxActive: 4 });
  });

  test("plain JSON with no comments parses identically to JSON.parse", () => {
    const text = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: "e" } });
    expect(parseJsonc(text)).toEqual(JSON.parse(text));
  });

  test("a multi-line block comment keeps line numbers intact for parse errors", () => {
    const text = `{\n/* line 2\nline 3 */\n"a": ,\n}`; // deliberately malformed at line 4
    expect(() => parseJsonc(text)).toThrow();
    expect(stripJsonComments(text).split("\n").length).toBe(text.split("\n").length);
  });
});
