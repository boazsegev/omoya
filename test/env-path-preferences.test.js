import { expect, test } from "bun:test";
import { pathPreferences } from "../lib/env/path-preferences.js";

test("configured path map enables selected roots in key order", () => {
  expect(pathPreferences({ alpha: true, beta: false, gamma: true }, "roots")).toEqual(["alpha", "gamma"]);
});

test("configured path map validates booleans and unsafe keys", () => {
  expect(() => pathPreferences({ alpha: "yes" }, "roots")).toThrow(TypeError);
  expect(() => pathPreferences(JSON.parse('{"__proto__":true}'), "roots")).toThrow(TypeError);
});

test("path preferences reject legacy strings and arrays with migration guidance", () => {
  for (const legacy of ["./extra", ["./a", "./b"]]) expect(() => pathPreferences(legacy, "roots")).toThrow(/migrate legacy arrays/);
  for (const value of [null, [""], [42], "bad\0path", { "bad\0path": true }, { " ": false }]) {
    expect(() => pathPreferences(value, "roots")).toThrow(TypeError);
  }
  expect(pathPreferences(undefined, "roots")).toEqual([]);
});
