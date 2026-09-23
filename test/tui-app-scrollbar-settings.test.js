/**
 * Settings-flow test: createInteractiveRepl must map env.settings.tui.scroll
 * into the GTUI.host.terminal scrollBar option (alt-screen scrollbar).
 *
 * run.js never passes a `host` option itself, so the `options.host` pass-through
 * seam is unreachable from outside. Instead we swap `GTUI.host` on the class
 * object (the class is not frozen; only the host record is) for a wrapper record
 * whose terminal() records the options run.js builds — a pure observation seam,
 * no lib/ change.
 */

import { expect, test } from "bun:test";
import { createInteractiveRepl } from "../lib/tui-app/run.js";
import { GTUI } from "../lib/gtui/gtui.js";
import { Agent } from "../lib/agent.js";
import { Env } from "../lib/env.js";
import { scriptedIO } from "./fakes.js";

/**
 * Run createInteractiveRepl with env.settings.tui set, capturing the terminal
 * options. env.settings is a read-only getter, so the tui config goes through
 * the Env constructor's explicit `settings` (merged LAST). testEnv() cannot
 * carry it — its signature takes no settings argument — so we build the same
 * throwaway Env shape inline.
 */
async function captureOptions(tuiSettings) {
  const { mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync("./ai-tmp/env-");
  const env = new Env({ dir, cwd: dir, settings: { providers: { p: { provider: "test", url: "test://script" } }, ...(tuiSettings === undefined ? {} : { tui: tuiSettings }) }, settingsDir: dir });
  const realHost = GTUI.host;
  let captured;
  GTUI.host = {
    ...realHost,
    terminal: (options) => {
      captured = options;
      return { _start() {}, _render() {}, _restore() {}, _setTheme() {} };
    },
  };
  try {
    const agent = new Agent({
      env, model: "p/m", context: [],
      createIO: () => scriptedIO([[{ type: "done" }]]),
    });
    const repl = createInteractiveRepl({
      agent, input: { on() {}, off() {}, resume() {}, setRawMode() {}, isTTY: true },
      output: { write() {}, columns: 40, rows: 10 }, mode: "alt", cwd: "project", env,
    });
    repl.close();
  } finally {
    GTUI.host = realHost;
  }
  return captured;
}

const DEFAULT_SCROLLBAR = { show: true, track: "│", thumb: "█" };

test("env scroll.show=false reaches the host scrollBar option", async () => {
  const options = await captureOptions({ scroll: { show: false } });
  expect(options.scrollBar.show).toBe(false);
});

test("env scroll glyphs reach the host scrollBar option", async () => {
  const options = await captureOptions({ scroll: { track: "~", thumb: "@" } });
  expect(options.scrollBar).toEqual({ show: true, track: "~", thumb: "@" });
});

test("invalid glyphs fall back to the defaults", async () => {
  const options = await captureOptions({ scroll: { track: "ab", thumb: 42 } });
  expect(options.scrollBar).toEqual(DEFAULT_SCROLLBAR);
});

test("absent scroll settings produce the defaults", async () => {
  const options = await captureOptions(undefined);
  expect(options.scrollBar).toEqual(DEFAULT_SCROLLBAR);
});
