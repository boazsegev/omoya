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
import Context from "../../context.js";
const { messageUser } = Context;
import CLI from "../../cli.js";
const { armCancelSignals } = CLI;
import { createStreamRenderer, bindTurn } from "./stream.js";
import { createCommands } from "./commands.js";

/**
 * Create a piped, cooked-mode REPL that processes one input line at a time,
 * renders Agent output through `writeOut`, and sends diagnostics to `log`.
 * @param {Object} options Configuration object.
 * @param {object} options.agent Agent providing context, endpoint/model state, `run`, `cancel`, and environment.
 * @param {NodeJS.ReadableStream} options.input Readable line source, typically stdin.
 * @param {(chunk: string) => void} options.writeOut Receives rendered output chunks.
 * @param {(line: string) => void} options.log Receives diagnostic lines.
 * @param {boolean} [options.ansi=true] Whether rendered output uses ANSI colors; defaults to true.
 * @param {boolean} [options.signals=true] Whether SIGINT/SIGTERM cancellation handlers are armed for each turn; defaults to true.
 * @param {() => void} [options.onExit] Optional hook invoked by the exit-command callback; it is not invoked if no exit command is handled.
 * @returns {{run: () => Promise<void>, runTurn: (line: string) => Promise<void>, close: () => void}} REPL controls: `run` consumes input until end or exit, `runTurn` processes one line, and `close` closes the CLI resources.
 * @throws Errors thrown while constructing the renderer or commands propagate synchronously. Errors during a turn or input iteration reject `runTurn`/`run`; `run` still closes resources in its `finally` block.
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

  /**
   * Process one line as a slash-command or Agent message.
   * @param {string} line Input line; an empty string is ignored.
   * @returns {Promise<void>} Resolves when the command or Agent turn completes, or immediately for an ignored/unavailable-model line.
   * @throws Errors from command handling, context operations, signal setup, `agent.run()`, signal disarming, or turn closing reject the promise.
   * @effects Commands may mutate/flush Agent state or request exit; a normal message is appended to Agent context, Agent output is rendered, and cancellation signals may call `agent.cancel()`.
   */
  async function runTurn(line) {
    if (line === "") return;
    if (await commands.handle(line)) {
      agent.context.flush();
      return;
    }
    if (!agent.model) {
      log("Please load a model");
      return;
    }
    // The Agent's fresh context already starts with the seeded system
    // prompt (Agent-owned, at construction) — just append the message.
    agent.context.append(messageUser(line));
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
  /**
   * Close the CLI resources associated with this REPL; repeated calls have no effect.
   * @returns {void}
   * @effects Calls `CLI.close` once with the Agent's environment and Agent.
   */
  const close = () => {
    if (closed) return;
    closed = true;
    CLI.close({ env: agent.env, agent });
  };

  /**
   * Read and process input lines sequentially until input ends or an exit command is handled.
   * @returns {Promise<void>} Resolves after input consumption or early exit.
   * @throws Errors from line processing or iteration reject the promise; resources are closed in all cases.
   * @effects Creates a non-terminal readline interface, trims each line before processing, and closes this REPL in a `finally` block.
   */
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
