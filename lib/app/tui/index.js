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
 *             something is actually clickable
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
import Env from "../../env.js";
import { runApplication } from "./cli-run.js";

// Importing the optional TUI surface enables bundled/user theme discovery.
Env._loadThemes = true;

/** Create the piped, cooked-mode front end; one input message per line. */
export { createLineRepl } from "./line-repl.js";

/** The rendering modes accepted by createRepl. */
export const TUI_ENGINES = TUI_MODES;

/**
 * The interactive REPL. `options.engine` picks the rendering mode:
 * "inline" (native scrollback) or "alt" (default alternate screen).
 * Both share one option contract.
 * @param {Object} options
 * @param {object} options.agent
 * @param {object} [options.env]
 * @param {"inline"|"alt"} [options.engine]
 * @param {NodeJS.ReadableStream} options.input - stdin-like stream
 * @param {(chunk: string) => void} [options.write] - THE terminal sink
 * @param {NodeJS.WritableStream} [options.output] - terminal output/resize source
 * @param {NodeJS.EventEmitter} [options.resizeEmitter] - explicit resize source
 * @param {(line: string) => void} [options.log] - diagnostics mirror
 * @param {() => void} [options.onExit] - fires after terminal restoration
 * @param {string} [options.cwd] - working folder used for the title
 * @param {NodeJS.EventEmitter} [options.signals] - signal source
 * @param {(() => number)|number} [options.columns] - viewport width override
 * @param {(() => number)|number} [options.rows] - viewport height override
 * @returns {{start: () => Promise<void>, close: () => void}} controller
 */
export function createRepl({ agent, env, engine, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows }) {
  const requested = engine ?? "alt";
  if (!TUI_MODES.includes(requested)) {
    throw new Error(`unknown TUI engine "${requested}" (available: ${TUI_MODES.join(", ")})`);
  }
  return createInteractiveRepl({ agent, env, mode: requested, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows });
}

/** Close TUI-owned agents, sessions, and background resources.
 * @param {{env?: object, agent?: object}} [runtime] - runtime resources
 * @returns {{agent?: object, session?: {id: string, file?: string}|null}}
 * Controllers returned by createRepl/createLineRepl also expose an
 * idempotent close(). */
export function close(runtime) {
  return CLI.close(runtime);
}

/** Run the complete TUI application from normalized declarative state.
 * Executables own argument parsing and process-exit policy; the runner
 * creates the environment and Agent, selects the mode, and performs cleanup.
 * @param {object} [state] - normalized application state
 * @returns {Promise<{code: number, agent: object, session: object|null}>}
 */
export function run(state) {
  return runApplication(state);
}

/** TUI module namespace (published as App.TUI by lib/app.js). */
export class TUI {}
Object.assign(TUI, { TUI_ENGINES, createApp, createRepl, createLineRepl, close, run });
export default TUI;
