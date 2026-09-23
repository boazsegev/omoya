/**
 * lib/tui-app/line-repl.js — the PIPED (non-TTY) front end: a cooked-mode
 * readline loop, one user message per line (moved verbatim from the
 * retired lib/tui-helpers/line-repl.js; engine-agnostic, so it never
 * touched GTUI and just needed a new home once tui-helpers went away,
 * now importing tui-app's commands.js directly instead of the deleted
 * legacy shim).
 *
 * The same slash-commands as the interactive TUI, with no line editor,
 * footer, pager or menu: programs piping into ai get the rendered
 * stream on stdout and diagnostics on stderr. terminal:false ALWAYS —
 * the TTY line discipline (when there IS one) echoes input and handles
 * backspace in cooked mode; readline's own terminal mode swallows the
 * echo under Bun (invisible typing).
 */

import { createInterface } from "node:readline";
import Context from "../context.js";
const { userMessage } = Context;
import CLI from "../cli.js";
const { armCancelSignals } = CLI;
import { createStreamRenderer, bindTurn } from "./stream.js";
import { createCommands } from "./commands.js";

/**
 * Create the piped (cooked-mode) front end over an Agent: one user
 * message per input line, rendered responses on writeOut, diagnostics
 * through log; run() consumes the input to its end.
 * @param {Object} options
 * @param {object} options.agent
 * @param {NodeJS.ReadableStream} options.input - the line source (stdin)
 * @param {(chunk: string) => void} options.writeOut - rendered responses
 * @param {(line: string) => void} options.log - diagnostics (one line each)
 * @param {boolean} [options.ansi] - color output (default true)
 * @param {boolean} [options.signals] - arm SIGINT/SIGTERM per turn (default true)
 * @param {() => void} [options.onExit] - /bye /exit /quit hook (fires once)
 * @returns {{run: () => Promise<void>, runTurn: (line: string) => Promise<void>, close: () => void}}
 *   run() consumes the input to its end (resolving when it closes;
 *   onExit may end the process earlier)
 */
export function createLineRepl({ agent, input, writeOut, log, ansi = true, signals = true, onExit }) {
  const renderer = createStreamRenderer({ write: writeOut, ansi });
  let exiting = false;
  const commands = createCommands({
    agent,
    log,
    copy: () => false, // clipboard effect wiring: not yet built (same scoped gap as the interactive app.js)
    onExit: () => {
      exiting = true;
      onExit?.();
    },
  });

  /** One turn: a slash-command, or a user message run through the Agent. */
  async function runTurn(line) {
    if (line === "") return;
    if (await commands.handle(line)) {
      agent.session?.flush?.();
      return;
    }
    if (!agent.endpoint || !agent.model) {
      log("Please load a model");
      return;
    }
    // The Agent's fresh context already starts with the seeded system
    // prompt (Agent-owned, at construction) — just append the message.
    agent.append(userMessage(line));
    const turn = bindTurn(renderer, agent);
    const disarm = signals
      ? armCancelSignals({
          onCancel: (signal) => {
            log(`${signal} received; cancelling`);
            agent.cancel();
          },
        })
      : () => {};
    try {
      await agent.run();
    } finally {
      disarm();
      turn.close();
    }
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    CLI.close({ env: agent.env, agent });
  };

  async function run() {
    const rl = createInterface({ input, terminal: false });
    try {
      for await (const line of rl) {
        await runTurn(line.trim());
        if (exiting) return;
      }
    } finally {
      close();
    }
  }

  return { run, runTurn, close };
}
