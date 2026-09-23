/**
 * lib/tui-app/run.js — the interactive TUI's PRODUCTION entry: wires
 * createApp (this app) onto GTUI's real terminal host, over an actual
 * input/output stream pair. Same responsibility lib/tui/repl.js and
 * lib/tui-old/repl.js each used to carry alone; now one function, one
 * engine, two modes ("inline" keeps the terminal's native scrollback,
 * "alt" owns the alternate screen) — see lib/gtui/README.md for what
 * each mode means at the host level.
 *
 * Returns the same {start, finish} shape the legacy engines did, so
 * bin/scripts/app (the SIGINT/SIGTERM -> finish() process bridge) can keep the
 * process-specific wiring outside the reusable TUI library.
 */

import { basename, dirname } from "node:path";
import { GTUI } from "../gtui/gtui.js";
import { createApp } from "./app.js";
import CLI from "../cli.js";

/** The modes createRepl actually offers; lib/tui.js rejects any other name. */
export const TUI_MODES = Object.freeze(["inline", "alt"]);

/** Short, stable terminal tab title: @parent/project. */
export function terminalTitle(cwd) {
  const folder = basename(cwd) || cwd;
  const parent = basename(dirname(cwd));
  return parent ? `@${parent}/${folder}` : `@${folder}`;
}

/**
 * @param {Object} options
 * @param {object} options.agent
 * @param {object} [options.env]
 * @param {"inline"|"alt"} options.mode
 * @param {NodeJS.ReadableStream} options.input - stdin-like stream (raw mode)
 * @param {(chunk: string) => void} [options.write] - terminal sink (defaults to output.write)
 * @param {NodeJS.WritableStream} [options.output] - terminal output and resize source
 * @param {NodeJS.EventEmitter} [options.resizeEmitter] - explicit resize source
 * @param {(line: string) => void} [options.log] - diagnostics mirror
 *   (piped `--input` runs: stdout IS the byte stream, not readable)
 * @param {() => void} [options.onExit] - fires once, after the host
 *   has fully restored the terminal
 * @param {string} [options.cwd] - the process working folder
 * @param {NodeJS.EventEmitter} [options.signals] - SIGINT/SIGTERM/SIGHUP
 *   source (default: none — the executable arms its own; tests pass nothing)
 * @param {(() => number)|number} [options.columns]
 * @param {(() => number)|number} [options.rows]
 * @returns {{start: () => void, close: () => void}}
 */
export function createInteractiveRepl({
  agent, env, mode, input, write, output: suppliedOutput, resizeEmitter, log, onExit = () => {}, cwd,
  signals, columns, rows,
}) {
  const root = cwd ?? env?.cwd ?? process.cwd();
  const app = createApp(agent, { env, cwd: root, log });
  // Keep the real terminal EventEmitter intact. The old write-only wrapper
  // discarded stdout's resize events, so production never learned a viewport
  // had changed. A separate emitter is useful for embedders and tests.
  const stream = suppliedOutput ?? process.stdout;
  const emitter = resizeEmitter ?? stream;
  const sink = write ?? stream?.write?.bind(stream);
  if (typeof sink !== "function") throw new TypeError("interactive TUI requires a terminal write function");
  const output = {
    write: (chunk) => sink(chunk),
    on: emitter?.on?.bind(emitter),
    off: emitter?.off?.bind(emitter),
  };
  Object.defineProperties(output, {
    columns: { get: () => stream?.columns },
    rows: { get: () => stream?.rows },
  });
  const scroll = env?.settings?.tui?.scroll;
  const scrollBar = {
    show: scroll?.show !== false,
    track: GTUI.scrollGlyph(scroll?.track, "│"),
    thumb: GTUI.scrollGlyph(scroll?.thumb, "█"),
  };
  const mouseSetting = env?.settings?.tui?.mouse;
  const host = GTUI.host.terminal({
    input, output, mode, columns, rows, signals, title: terminalTitle(root), scrollBar,
    osc52: env?.settings?.tui?.osc52 !== false,
    mouse: mouseSetting === true ? "always" : mouseSetting === false ? "off" : undefined,
    cursorShape: env?.settings?.tui?.cursor?.shape,
    cursorBlink: env?.settings?.tui?.cursor?.blink,
  });
  const ui = new GTUI({ host, theme: app.theme });
  let finished = false;
  let started = false;
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    const activeAgent = app.currentAgent();
    CLI.close({ env, agent: activeAgent });
    onExit({ agent: activeAgent, session: activeAgent.session ?? null });
  };
  const close = () => {
    if (finished) return;
    // Mark synchronously so repeated signal/exit paths cannot race, and
    // dispose app-owned pending question/copy work even if the host stops
    // before GTUI reaches its normal disposal pass.
    finished = true;
    try { app.dispose?.(); } catch { /* teardown is best-effort */ }
    ui.stop();
    if (!started) exitOnce();
  };
  return {
    async start() {
      if (started) return;
      started = true;
      try {
        await ui.run(app);
      } catch (error) {
        // start() is normally called from the process front end without an
        // await. Observe a failed UI run here so it cannot become unhandled.
        try { log?.(`TUI failed: ${error?.message ?? error}`); } catch { /* diagnostics are best-effort */ }
      } finally {
        finished = true;
        exitOnce();
      }
    },
    close,
  };
}
