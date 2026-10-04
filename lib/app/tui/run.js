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
import CLI from "../../cli.js";

/** The modes createRepl actually offers; lib/tui.js rejects any other name. */
export const TUI_MODES = Object.freeze(["inline", "alt"]);

/**
 * Build the stable terminal tab title from a working-directory path.
 * @param {string} cwd - path whose final two components identify the project
 * @returns {string} title in `@parent/project` form, or `@folder` without a parent
 */
export function terminalTitle(cwd) {
  const folder = basename(cwd) || cwd;
  const parent = basename(dirname(cwd));
  return parent ? `@${parent}/${folder}` : `@${folder}`;
}

/**
 * Create the terminal host and app-backed interactive TUI lifecycle.
 * The returned start operation runs the UI once; close is idempotent and
 * restores host/app resources, invoking onExit after teardown is complete.
 * @param {Object} options
 * @param {object} options.agent - active agent passed to the app
 * @param {object} [options.env] - app settings/environment; defaults to undefined
 * @param {"inline"|"alt"} options.mode - terminal display mode
 * @param {NodeJS.ReadableStream} options.input - stdin-like input stream (raw mode)
 * @param {(chunk: string) => void} [options.write] - terminal sink; defaults to the selected output stream's bound `write`
 * @param {NodeJS.WritableStream} [options.output] - terminal output and resize source; defaults to `process.stdout`
 * @param {NodeJS.EventEmitter} [options.resizeEmitter] - explicit resize source; defaults to the selected output stream
 * @param {(line: string) => void} [options.log] - optional diagnostics mirror (for piped `--input`, stdout is the byte stream)
 * @param {(details: {agent: object, session: *}) => void} [options.onExit] - optional callback; defaults to a no-op and fires once after host restoration
 * @param {string} [options.cwd] - working folder; defaults to `env.cwd`, then `process.cwd()`
 * @param {NodeJS.EventEmitter} [options.signals] - optional SIGINT/SIGTERM/SIGHUP source; defaults to none
 * @param {(() => number)|number} [options.columns] - optional fixed column count or getter
 * @param {(() => number)|number} [options.rows] - optional fixed row count or getter
 * @returns {{start: () => Promise<void>, close: () => void}} lifecycle methods; start observes UI-run failures, but setup and teardown callback errors may propagate
 * @throws {TypeError} if neither `write` nor the selected output stream supplies a write function; GTUI host construction errors also propagate
 */
export function createInteractiveRepl({
  agent, env, mode, input, write, output: suppliedOutput, resizeEmitter, log, onExit = () => {}, cwd,
  signals, columns, rows,
}) {
  const root = cwd ?? env?.cwd ?? process.cwd();
  // Keep the real terminal EventEmitter intact. The old write-only wrapper
  // discarded stdout's resize events, so production never learned a viewport
  // had changed. A separate emitter is useful for embedders and tests.
  const stream = suppliedOutput ?? process.stdout;
  const app = createApp(agent, { env, cwd: root, log,
    columns: () => typeof columns === "function" ? columns() : (columns ?? stream?.columns ?? 80),
    rows: () => typeof rows === "function" ? rows() : (rows ?? stream?.rows ?? 24),
  });
  const emitter = resizeEmitter ?? stream;
  const sink = write ?? stream?.write?.bind(stream);
  if (typeof sink !== "function") throw new TypeError("interactive TUI requires a terminal write function");
  const output = {
    /** Forward a terminal chunk to the selected sink.
     * @param {string} chunk - terminal data to write
     * @returns {*} the sink's result
     */
    write: (chunk) => sink(chunk),
    /** Subscribe to the selected resize emitter.
     * @param {...*} args - event name and listener arguments
     * @returns {*} the emitter's subscription result
     */
    on: emitter?.on?.bind(emitter),
    /** Unsubscribe from the selected resize emitter.
     * @param {...*} args - event name and listener arguments
     * @returns {*} the emitter's unsubscription result
     */
    off: emitter?.off?.bind(emitter),
  };
  Object.defineProperties(output, {
    columns: { /** Read the selected stream's current column count. @returns {number|undefined} current columns */ get: () => stream?.columns },
    rows: { /** Read the selected stream's current row count. @returns {number|undefined} current rows */ get: () => stream?.rows },
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
  /** Close CLI resources and notify the caller once after terminal restoration.
   * @returns {void}
   * @effects Closes CLI resources for the current agent and invokes onExit once.
   */
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    const activeAgent = app.currentAgent();
    CLI.close({ env, agent: activeAgent });
    onExit({ agent: activeAgent, session: activeAgent.context });
  };
  /** Idempotently stop the UI and dispose app work; if not started, finalize immediately.
   * @returns {void}
   * @effects Marks the lifecycle finished, disposes app resources, stops GTUI, and may invoke exitOnce.
   * @throws Errors from GTUI stop or exit cleanup/callbacks may propagate.
   */
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
    /** Run the UI at most once and absorb/report run failures.
     * @returns {Promise<void>} resolves after the UI exits; UI-run errors are logged when possible, while exit-cleanup errors can reject
     * @effects Starts GTUI, then marks the lifecycle finished and performs one-time exit cleanup.
     */
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
