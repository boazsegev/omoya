/**
 * lib/app/tui/index.js — App.TUI: the terminal front end.
 *
 * The TUI owns semantic policy and Agent-turn lifecycle,
 * and uses App.GTUI (lib/app/gtui/) for geometry, rendering, selection, and editing. It does
 * not own conversation state. The Agent owns context and the current turn;
 * the TUI renders response events and live context, collects input, and
 * sends messages and commands to the Agent.
 *
 * This folder supplies an {init, update, view, bindings} application to
 * GTUI through its `run` contract. The application supports two modes
 * over the same rendering and control machinery:
 *   - inline  the terminal keeps its native scrollback —
 *             finalized transcript rows print once and scroll; only
 *             the transient tail repaints in place; the footer rides
 *             the scroll; the mouse stays native except where
 *             something is actually clickable (overlays, completions,
 *             the ↓-focused status toolbar) — status chips ignore
 *             clicks while the input has focus (see GTUI README)
 *   - alt     owns the alternate screen (like vim): pins header/
 *             footer, scrolls the transcript in-app, owns the mouse
 * Mode selection: the `engine` option ("inline" | "alt"); createRepl
 * defaults to "alt" when no engine is supplied. Inline preserves native
 * terminal scrollback; alt owns the alternate screen.
 *
 * The module exposes two front ends over the same app and command set:
 *   - createRepl      the interactive terminal (raw-mode, ^O block
 *                     viewer, ^X menu);
 *   - createLineRepl  the piped, cooked-mode loop (one message per line).
 */

import { createInteractiveRepl, TUI_MODES } from "./run.js";
import { createApp } from "./app.js";
import { createLineRepl } from "./line-repl.js";
import CLI from "../../cli.js";
import { runApplication } from "./cli-run.js";


/**
 * Create the piped, cooked-mode front end, which reads one input message per
 * line. Re-exported from `./line-repl.js`; this module does not wrap it.
 * @function createLineRepl
 * @returns {object} The line-oriented REPL controller.
 */
export { createLineRepl } from "./line-repl.js";

/** The rendering modes accepted by {@link createRepl} (currently `inline` and `alt`). */
export const TUI_ENGINES = TUI_MODES;

/**
 * The interactive REPL. `options.engine` picks the rendering mode:
 * "inline" (native scrollback) or "alt" (default alternate screen).
 * Both modes use the same option contract. The function validates the mode
 * and delegates controller creation to the interactive REPL implementation.
 * @param {Object} options - REPL configuration; required, with no default.
 * @param {object} options.agent - Agent that owns conversation state and turns.
 * @param {object} [options.env] - Environment supplied to the REPL; omitted by default.
 * @param {"inline"|"alt"} [options.engine="alt"] - Rendering mode; nullish or omitted selects `alt`.
 * @param {NodeJS.ReadableStream} options.input - Required stdin-like input stream.
 * @param {(chunk: string) => void} [options.write] - Terminal output sink; omitted by default.
 * @param {NodeJS.WritableStream} [options.output] - Terminal output/resize source; omitted by default.
 * @param {NodeJS.EventEmitter} [options.resizeEmitter] - Explicit resize source; omitted by default.
 * @param {(line: string) => void} [options.log] - Diagnostics mirror; omitted by default.
 * @param {() => void} [options.onExit] - Callback after terminal restoration; omitted by default.
 * @param {string} [options.cwd] - Working folder used for the title; omitted by default.
 * @param {NodeJS.EventEmitter} [options.signals] - Signal source; omitted by default.
 * @param {(() => number)|number} [options.columns] - Viewport width override; omitted by default.
 * @param {(() => number)|number} [options.rows] - Viewport height override; omitted by default.
 * @returns {{start: () => Promise<void>, close: () => void}} Controller with asynchronous `start` and synchronous `close` methods.
 * @throws {Error} If `engine` is neither `inline` nor `alt`; the error lists available engines.
 * @effects Creates/delegates creation of an interactive terminal controller using the supplied streams and callbacks.
 */
export function createRepl({ agent, env, engine, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows }) {
  const requested = engine ?? "alt";
  if (!TUI_MODES.includes(requested)) {
    throw new Error(`unknown TUI engine "${requested}" (available: ${TUI_MODES.join(", ")})`);
  }
  return createInteractiveRepl({ agent, env, mode: requested, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows });
}

/**
 * Close TUI-owned agents, sessions, and background resources by delegating to
 * the CLI cleanup routine. Controllers returned by `createRepl` and
 * `createLineRepl` also expose an idempotent `close()` method.
 * @param {{env?: object, agent?: object}} [runtime] - Runtime resources; optional, with no default value applied here.
 * @returns {{agent?: object, session?: {id: string, file?: string}|null}} Cleanup result returned by the CLI routine.
 * @effects Delegates cleanup of the supplied runtime's TUI-owned resources.
 */
export function close(runtime) {
  return CLI.close(runtime);
}

/**
 * Run the complete TUI application from normalized declarative state.
 * Executables own argument parsing and process-exit policy; the runner
 * creates the environment and Agent, selects the mode, and performs cleanup.
 * @param {object} [state] - Normalized application state; optional and forwarded unchanged, with no default applied here.
 * @returns {Promise<{code: number, agent: object, session: object|null}>} Promise resolving to the application exit code, Agent, and session result.
 * @effects Runs the application and its cleanup lifecycle through `runApplication`.
 */
export function run(state) {
  return runApplication(state);
}

/**
 * Empty namespace class for the TUI module, published as `App.TUI` by
 * `lib/app.js`; static API members are assigned below.
 * @class
 */
export class TUI {}
Object.assign(TUI, { TUI_ENGINES, createApp, createRepl, createLineRepl, close, run });
export default TUI;
