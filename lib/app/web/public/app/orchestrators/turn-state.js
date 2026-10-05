/** Browser packet reducer (temporary root dispatch until domain tables land). */
import { state } from "../state.js";
import { historyScrollFlags } from "../logic/transcript-scroll.js";
import { sameAgent } from "../logic/agents.js";
import { displaySource } from "../logic/tool-display.js";
import { invalidate } from "../render.js";
import { appendTranscriptBlock } from "../logic/transcript-scroll.js";
/* ----------------------------------------------------------- packet flow */
/** Repaint the server-imposed throttle countdown until it expires. */
function showThrottle(until) {
  state.throttledUntil = Number.isFinite(until) && until > Date.now() ? until : null;
  clearInterval(state.throttleClock);
  state.throttleClock = state.throttledUntil ? setInterval(() => {
    if (Date.now() >= state.throttledUntil) showThrottle(null);
    else invalidate("header");
  }, 250) : null;
  invalidate("header");
}

/**
 * Replace the transcript with a server-sent history snapshot.
 * @param {Array} list - history items (messages/blocks) to normalize.
 * @param {boolean} [preserveRows=false] - keep mounted DOM rows (same-agent refresh) instead of resetting the transcript.
 * @returns {void}
 * Effects: marks unfinished tool blocks "skipped" on an idle agent, clears the in-flight
 * block, and schedules a render.
 */
function setHistory(list, preserveRows = false) {
  const flags = historyScrollFlags(preserveRows);
  state.resetTranscript ||= flags.resetTranscript;
  state.stickBottom ||= flags.stickBottom; // a full history reload (session resume) lands at the bottom
  state.blocks = normalizeHistory(list);
  state.fullRender = true; // authoritative snapshots refresh controls and Markdown
  // An unanswered call on an idle agent never ran to completion.
  if (!(state.agent?.busy || state.agent?.state === "working")) for (const block of state.blocks) if (block.kind === "tool" && !block.done) Object.assign(block, { state: "skipped", done: true });
  state.current = null;
  invalidate("transcript");
}

/**
 * Fold replayed tool-call/tool-answer pairs into one tool card (the live
 * stream's shape), keyed by call id.
 * @param {Array} list - raw history items from the server.
 * @returns {Array} transcript blocks; calls without answers stay "running".
 */
function normalizeHistory(list) {
  const out = [];
  const byCall = new Map();
  for (const item of list) {
    if (item.kind === "tool-call") {
      // No answer yet: the call is still running (a turn in flight).
      const block = { kind: "tool", name: item.name ?? "tool", args: typeof item.text === "string" ? item.text : "", callId: item.callId, state: "running", output: "", done: false, messageIndex: item.messageIndex, blockIndex: item.blockIndex };
      if (item.callId) byCall.set(item.callId, block);
      out.push(block);
    } else if (item.kind === "tool-answer") {
      const call = item.tool ?? {};
      const block = (call.callId && byCall.get(call.callId)) ?? null;
      const state = item.error ? "error" : "ok";
      const display = displaySource(item.display);
      if (block) { block.output = item.output ?? ""; block.display = display; block.attachments = item.attachments; block.state = state; block.done = true; block.resultIndex = item.messageIndex; }
      else out.push({ kind: "tool", name: call.name ?? (typeof item.text === "object" ? item.text?.name : item.text) ?? "tool", args: "", state, output: item.output ?? "", display, attachments: item.attachments, done: true, resultIndex: item.messageIndex });
    } else out.push({ ...item });
  }
  return out;
}

/**
 * Append a streamed text/thinking delta to the in-flight block.
 * @param {object} m - `{ kind: "text"|"thinking", text }` delta packet.
 * @returns {void}
 * Effects: closes the previous in-flight block when the kind changes; schedules a render.
 */
function onDelta(m) {
  const kind = m.kind === "thinking" ? "thinking" : "text";
  if (!state.current || state.current.kind !== kind) {
    settleCurrent();
    state.current = { kind, text: "", done: false, started: Date.now() };
    state.blocks.push(state.current);
  }
  state.current.text += m.text ?? "";
  touch(state.current);
}

/**
 * Handle the end of a turn: settle streams, swap in authoritative history, and
 * surface terminal errors/cancellations.
 * @param {object} m - `{ history?, terminal?, busy?, status? }` packet.
 * @returns {void}
 * Effects: marks unfinished tool blocks skipped when not busy, updates usage/header/
 * composer/sidebar, schedules a render.
 */
function settleCurrent() {
  if (state.current) { state.current.done = true; state.current.ended = Date.now(); touch(state.current); }
  state.current = null;
}
function pushBlock(block) { appendTranscriptBlock(state, block, touch); }
function touch(block) { state.dirty.add(block); invalidate("transcript"); }
function onTurnEnd(m) {
  settleCurrent();
  // The assembled context can differ from the streamed preview, including
  // delimiters that change Markdown/math layout. Replace the preview with
  // authoritative blocks before the next paint (also refreshes view controls).
  if (Array.isArray(m.history)) setHistory(m.history, true);
  if (m.terminal?.type === "error" && !(state.blocks.at(-1)?.kind === "error" && state.blocks.at(-1).text === (m.terminal.error ?? "turn failed"))) pushBlock({ kind: "error", text: m.terminal.error ?? "turn failed", done: true, retry: true });
  else if (m.terminal?.type === "cancelled" || m.terminal?.type === "cancel") pushBlock({ kind: "command", text: "cancelled", done: true });
  if (m.busy !== true) for (const block of state.blocks) if (block.kind === "tool" && !block.done) { block.state = "skipped"; block.done = true; touch(block); }
  if (m.status) state.usage = m.status;
  // busy may stay true here (queued messages or a tool round still ahead);
  // the indicators must follow the server's report, not assume the run ended.
  if (state.agent && typeof m.busy === "boolean") {
    state.agent = { ...state.agent, busy: m.busy, state: m.busy ? "working" : "idle" };
    // The sidebar row reads the sessions tree; keep it in step too.
    const row = state.sessions.agents.flatMap(function walk(item) { return [item, ...(item.children ?? []).flatMap(walk)]; }).find((item) => sameAgent(item, state.agent));
    if (row) Object.assign(row, { busy: m.busy, state: state.agent.state });
    invalidate("sidebar");
  }
  invalidate("usage"); invalidate("header"); invalidate("composer"); invalidate("transcript");
}

export { showThrottle, setHistory, normalizeHistory, onDelta, onTurnEnd, settleCurrent, pushBlock, touch };
