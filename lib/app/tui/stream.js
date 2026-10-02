/**
 * lib/tui-app/stream.js — the PIPED front end's plain streaming renderer
 * (moved verbatim from the retired lib/tui-helpers/stream.js; the
 * piped connector is engine-agnostic and never touched GTUI, so it
 * just needed a new home once tui-helpers went away). No cursor movement, no screen: text and thinking deltas are
 * written as they arrive (thinking dimmed), tool calls and results as
 * one-line status lines, errors as a notice. Programs piping into ai
 * read this stream.
 */

import Agent from "../../agent.js";
import Context from "../../context.js";
const { EVENT_CALLBACKS } = Agent;
const { MessageType, mimeOf } = Context;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const TOOL = "\x1b[2;32m";
const TOOL_ERR = "\x1b[2;31m";
const ERR = "\x1b[31m";
const ARGS_BUDGET = 120;

/**
 * Format tool arguments as a single line within the renderer's character budget.
 * @param {*} args - Arguments value; non-strings are JSON-serialized, with nullish values treated as `{}`.
 * @returns {string} Empty for empty arguments; otherwise the serialized/clipped text.
 * @throws {TypeError} If JSON serialization of a non-string value fails (for example, a circular structure).
 */
function shortArgs(args) {
  let text = typeof args === "string" ? args : JSON.stringify(args ?? {});
  if (text === "{}" || text === "") return "";
  if (text.length > ARGS_BUDGET) text = text.slice(0, ARGS_BUDGET - 1) + "…";
  return text;
}

/**
 * Render a message's text blocks and describe binary/image blocks without exposing their bytes.
 * @param {object|null|undefined} message - Message whose optional `content` is an array of blocks.
 * @returns {string} Text blocks and binary/image placeholders joined with newlines; other block types are omitted.
 * @throws {TypeError} If content is not mappable or MIME inspection fails for a supported block.
 */
function fullText(message) {
  // Each supported content block is rendered as text or a binary/image placeholder.
  return (message?.content ?? [])
    .map((b) => {
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "binary" || b?.type === "image") {
        const bytes = typeof b.content === "string" ? Math.floor((b.content.length * 3) / 4) : 0;
        return `[${b.type}: ${mimeOf(b) ?? "unknown"}, ${bytes} bytes]`;
      }
      return null;
    })
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * @param {object} options - Renderer configuration.
 * @param {(chunk: string) => void} options.write - Destination called for each non-empty output chunk; its exceptions propagate.
 * @param {boolean} [options.ansi=true] - Whether to wrap styled output in ANSI escape sequences.
 * @returns {{callbacks: Object, toolResult: (message: object) => void, system: (message: object) => void}} Event callbacks and methods for rendering tool/system context messages. Output is written incrementally; adjacent output is separated to preserve line boundaries.
 * @throws {TypeError} If options.write is not callable or output formatting encounters invalid input.
 */
export function createStreamRenderer({ write, ansi = true }) {
  /** Create a painter that applies an ANSI prefix when enabled.
   * @param {string} code - ANSI style prefix.
   * @returns {(s: string) => string} Painter that accepts text and returns it styled or unchanged.
   */
  const paint = (code) => (s) => (ansi ? `${code}${s}${RESET}` : s);
  const dim = paint(DIM);
  let dirty = false; // output since the last newline
  const names = new Map(); // contentIndex -> tool name (start carries it, end may not)
  const streamed = new Map(); // contentIndex -> text already written for that block
  /** Write non-empty output and update whether the current line is incomplete.
   * @param {string} s - Output chunk.
   * @returns {void}
   * @throws {*} Propagates exceptions from the configured write function.
   */
  const emit = (s) => { if (s === "") return; write(s); dirty = !s.endsWith("\n"); };
  /** Ensure the next rendered item starts on a fresh line.
   * @returns {void}
   */
  const fresh = () => { if (dirty) emit("\n"); };
  /** Agent event handlers that render streaming output.
   * @type {Object}
   */
  const callbacks = {
    /** Reset accumulated text-delta state at the start of an agent run. @returns {void} */
    onStart: () => streamed.clear(),
    /** Start a text block on a fresh line. @returns {void} */
    onTextStart: () => fresh(),
    /** Emit a text delta and retain it for comparison with the terminal snapshot.
     * @param {object} e - Event with optional contentIndex and text fields.
     * @returns {void}
     */
    onTextDelta: (e) => {
      const index = e.contentIndex ?? 0;
      streamed.set(index, (streamed.get(index) ?? "") + (e.text ?? ""));
      emit(e.text ?? "");
    },
    // `text_end.text` is the provider's FULL snapshot (lib/context/events.js):
    // an append-only stream can only add the part the deltas never wrote
    /** Append any text present in the terminal snapshot but not already streamed.
     * @param {object} e - End event with optional contentIndex and full text snapshot.
     * @returns {void}
     */
    onTextEnd: (e) => {
      const index = e.contentIndex ?? 0;
      const written = streamed.get(index) ?? "";
      streamed.delete(index);
      if (typeof e.text === "string" && e.text.startsWith(written)) emit(e.text.slice(written.length));
      fresh();
    },
    /** Start a thinking block on a fresh line. @returns {void} */
    onThinkingStart: () => fresh(),
    /** Emit a dimmed thinking delta.
     * @param {object} e - Event with optional text.
     * @returns {void}
     */
    onThinkingDelta: (e) => emit(dim(e.text ?? "")),
    /** Emit any final thinking text and finish its line.
     * @param {object} e - End event with optional text.
     * @returns {void}
     */
    onThinkingEnd: (e) => { emit(dim(e.text ?? "")); fresh(); },
    /** Record a tool name for the eventual call-end event.
     * @param {object} e - Start event with optional contentIndex and name.
     * @returns {void}
     */
    onToolCallStart: (e) => { fresh(); names.set(e.contentIndex ?? 0, e.name); },
    /** Ignore tool-call argument deltas; arguments are rendered at call end.
     * @param {object} _e - Tool-call delta event (unused).
     * @returns {void}
     */
    onToolCallDelta: () => {},
    /** Render a completed tool call as a one-line status.
     * @param {object} e - End event with arguments and optional name/contentIndex.
     * @returns {void}
     * @throws {TypeError} If argument serialization fails.
     */
    onToolCallEnd: (e) => {
      const sa = shortArgs(e.arguments);
      const name = e.name ?? names.get(e.contentIndex ?? 0) ?? "?";
      emit(`${paint(TOOL)(`[tool call] ${name}`)}${sa === "" ? "" : dim(` ${sa}`)}\n`);
    },
    /** Finish the current output line after a successful run. @returns {void} */
    onDone: () => fresh(),
    /** Render an error notice and finish the current line.
     * @param {object} e - Error event with optional error text.
     * @returns {void}
     */
    onError: (e) => { fresh(); emit(`${paint(ERR)(`[error] ${e.error ?? "unknown error"}`)}\n`); },
  };
  return {
    callbacks,
    /** Render a tool result as a status line followed by its first content line.
     * @param {object} message - Tool-result message; its error/name/content fields control the display.
     * @returns {void}
     * @throws {TypeError} If message content cannot be inspected or formatted.
     */
    toolResult(message) {
      fresh();
      const first = fullText(message).split("\n")[0];
      const style = message?.error ? paint(TOOL_ERR) : paint(TOOL);
      emit(`${style(`[tool ${message?.error ? "error" : "ok"}] ${message?.name ?? "?"}`)}${first ? dim(`: ${first}`) : ""}\n`);
    },
    /** Render a system message in dim text, preserving its line breaks.
     * @param {object} message - System message whose content blocks are rendered.
     * @returns {void}
     * @throws {TypeError} If message content cannot be inspected or formatted.
     */
    system(message) {
      fresh();
      emit(`${dim("[system]")}\n${fullText(message).split("\n").map(dim).join("\n")}\n`);
    },
  };
}

/**
 * Bind the renderer to one Agent turn: callbacks for agent.run() that
 * first print any tool result / system message appended to the context
 * since the last event (results land inline, in order), plus drain()
 * for the ones trailing the terminal event.
 * @param {ReturnType<typeof createStreamRenderer>} renderer - Renderer used for stream and context output.
 * @param {object} agent - Agent observed for this turn; must expose context messages and event subscription methods.
 * @returns {{close: () => void}} Handle whose close method drains trailing messages and unsubscribes all listeners.
 * @throws {TypeError} If the agent/context does not provide the required methods or renderer methods.
 */
export function bindTurn(renderer, agent) {
  const context = agent.context;
  /** Identify context messages rendered inline by this binding.
   * @param {object|null|undefined} m - Candidate context message.
   * @returns {boolean} Whether it is a tool result or system message.
   */
  const tracked = (m) => m?.type === MessageType.ToolResult || m?.type === MessageType.System;
  let seen = context.messages().filter(tracked).length;
  /** Render all newly appended tracked messages, in context order.
   * @returns {number} Number of tracked messages observed so far.
   */
  const drain = () => {
    const list = context.messages().filter(tracked);
    if (list.length < seen) seen = list.length;
    for (; seen < list.length; seen++) {
      const m = list[seen];
      if (m.type === MessageType.ToolResult) renderer.toolResult(m);
      else renderer.system(m);
    }
    return seen;
  };
  // Each listener drains context changes before dispatching its event payload.
  const handles = EVENT_CALLBACKS.map(([callback, event]) =>
    agent.onEvent(event, (value) => { drain(); renderer.callbacks[callback](value); }));
  /** The returned close method drains trailing messages and removes every event listener.
   * @returns {void}
   */
  return { close() { drain(); for (const handle of handles) agent.offEvent(handle); } };
}
