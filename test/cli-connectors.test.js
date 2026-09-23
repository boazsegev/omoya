// test/cli-connectors.test.js — the ai executable owns its three tiny IO
// entry modes directly; reusable REPL behavior remains in lib/tui.js.
import { describe, expect, test } from "bun:test";
import { IO_MODES, resolveIoMode } from "../lib/tui-app/cli-run.js";
import { createRepl, TUI_ENGINES } from "../lib/tui.js";
import { HELP_TEMPLATE } from "../bin/scripts/help.js";

describe("ai IO modes: inline/alt/line", () => {
  test("inline, alt, and line are the available modes", () => {
    expect(IO_MODES).toEqual(expect.arrayContaining(["inline", "alt", "line"]));
    expect(resolveIoMode(undefined, { interactive: false })).toBe("line");
    for (const mode of IO_MODES) expect(resolveIoMode(mode)).toBe(mode);
  });

  test("an unknown mode rejects and lists the available names", () => {
    expect(() => resolveIoMode("bogus")).toThrow(/unknown io mode "bogus"/);
    expect(() => resolveIoMode("bogus")).toThrow(/inline, alt, line/);
  });
});

describe("lib/tui.js: engine names inline/alt", () => {
  test("the interactive REPL offers inline and alt", () => {
    expect(TUI_ENGINES).toEqual(expect.arrayContaining(["inline", "alt"]));
  });

  test("an unrecognized engine name lists the current names", () => {
    expect(() => createRepl({ agent: {}, engine: "bogus", input: {} })).toThrow(/unknown TUI engine "bogus"/);
  });
});

describe("cli help: documents the screen modes", () => {
  test("--screen names inline/alt/line", () => {
    expect(HELP_TEMPLATE).toContain("--screen");
    expect(HELP_TEMPLATE).toContain("inline");
    expect(HELP_TEMPLATE).toContain("alt");
    expect(HELP_TEMPLATE).toContain("line");
  });
});
