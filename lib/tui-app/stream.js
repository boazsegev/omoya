/**
 * lib/tui-app/stream.js — the PIPED front end's plain streaming renderer
 * (moved verbatim from the retired lib/tui-helpers/stream.js; the
 * piped connector is engine-agnostic and never touched GTUI, so it
 * just needed a new home once tui-helpers went away). No cursor movement, no screen: text and thinking deltas are
 * written as they arrive (thinking dimmed), tool calls and results as
 * one-line status lines, errors as a notice. Programs piping into ai
 * read this stream.
 */

import Agent from "../agent.js";
import Context from "../context.js";
const { RESPONSE_CALLBACK_EVENTS } = Agent;
const { MessageType, mimetypeOf } = Context;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const TOOL = "\x1b[2;32m";
const TOOL_ERR = "\x1b[2;31m";
const ERR = "\x1b[31m";
const ARGS_BUDGET = 120;

/** A tool call's arguments, one line, budget-clipped — the same
 *  summary the transcript's tool-call rows use (context-blocks.js),
 *  kept as its own small copy: this is the ONLY caller left once
 *  lib/tui-helpers/messages.js (450 lines of legacy row-rendering) was
 *  deleted, so porting the whole module here would be dead weight. */
function shortArgs(args) {
  let text = typeof args === "string" ? args : JSON.stringify(args ?? {});
  if (text === "{}" || text === "") return "";
  if (text.length > ARGS_BUDGET) text = text.slice(0, ARGS_BUDGET - 1) + "…";
  return text;
}

/** Full text content of a message: text blocks joined, one-line
 *  placeholders for binary/image blocks (their bytes never render). */
function fullText(message) {
  return (message?.content ?? [])
    .map((b) => {
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "binary" || b?.type === "image") {
        const bytes = typeof b.content === "string" ? Math.floor((b.content.length * 3) / 4) : 0;
        return `[${b.type}: ${mimetypeOf(b) ?? "unknown"}, ${bytes} bytes]`;
      }
      return null;
    })
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * @param {Object} options
 * @param {(chunk: string) => void} options.write
 * @param {boolean} [options.ansi]
 * @returns {{callbacks: Object, toolResult: (message: object) => void, system: (message: object) => void}}
 */
export function createStreamRenderer({ write, ansi = true }) {
  const paint = (code) => (s) => (ansi ? `${code}${s}${RESET}` : s);
  const dim = paint(DIM);
  let dirty = false; // output since the last newline
  const names = new Map(); // contentIndex -> tool name (start carries it, end may not)
  const streamed = new Map(); // contentIndex -> text already written for that block
  const emit = (s) => { if (s === "") return; write(s); dirty = !s.endsWith("\n"); };
  const fresh = () => { if (dirty) emit("\n"); };
  const callbacks = {
    onStart: () => streamed.clear(),
    onTextStart: () => fresh(),
    onTextDelta: (e) => {
      const index = e.contentIndex ?? 0;
      streamed.set(index, (streamed.get(index) ?? "") + (e.text ?? ""));
      emit(e.text ?? "");
    },
    // `text_end.text` is the provider's FULL snapshot (lib/context/events.js):
    // an append-only stream can only add the part the deltas never wrote
    onTextEnd: (e) => {
      const index = e.contentIndex ?? 0;
      const written = streamed.get(index) ?? "";
      streamed.delete(index);
      if (typeof e.text === "string" && e.text.startsWith(written)) emit(e.text.slice(written.length));
      fresh();
    },
    onThinkingStart: () => fresh(),
    onThinkingDelta: (e) => emit(dim(e.text ?? "")),
    onThinkingEnd: (e) => { emit(dim(e.text ?? "")); fresh(); },
    onToolcallStart: (e) => { fresh(); names.set(e.contentIndex ?? 0, e.name); },
    onToolcallDelta: () => {},
    onToolcallEnd: (e) => {
      const sa = shortArgs(e.arguments);
      const name = e.name ?? names.get(e.contentIndex ?? 0) ?? "?";
      emit(`${paint(TOOL)(`[tool call] ${name}`)}${sa === "" ? "" : dim(` ${sa}`)}\n`);
    },
    onDone: () => fresh(),
    onError: (e) => { fresh(); emit(`${paint(ERR)(`[error] ${e.error ?? "unknown error"}`)}\n`); },
  };
  return {
    callbacks,
    /** A tool result landed in the context: one status line + its first line. */
    toolResult(message) {
      fresh();
      const first = fullText(message).split("\n")[0];
      const style = message?.error ? paint(TOOL_ERR) : paint(TOOL);
      emit(`${style(`[tool ${message?.error ? "error" : "ok"}] ${message?.name ?? "?"}`)}${first ? dim(`: ${first}`) : ""}\n`);
    },
    /** A system message a tool attached: dimmed, one line per line. */
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
 * @param {ReturnType<typeof createStreamRenderer>} renderer
 * @param {object} agent - Agent observed for this turn
 * @returns {{close: () => void}}
 */
export function bindTurn(renderer, agent) {
  const context = agent.context;
  const tracked = (m) => m?.type === MessageType.ToolResult || m?.type === MessageType.System;
  let seen = context.filter(tracked).length;
  const drain = () => {
    const list = context.filter(tracked);
    if (list.length < seen) seen = list.length;
    for (; seen < list.length; seen++) {
      const m = list[seen];
      if (m.type === MessageType.ToolResult) renderer.toolResult(m);
      else renderer.system(m);
    }
    return seen;
  };
  const handles = RESPONSE_CALLBACK_EVENTS.map(([callback, event]) =>
    agent.onEvent(event, (value) => { drain(); renderer.callbacks[callback](value); }));
  return { close() { drain(); for (const handle of handles) agent.offEvent(handle); } };
}
