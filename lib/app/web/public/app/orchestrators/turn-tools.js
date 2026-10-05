/** tools.js — Live tool-call assembly, output sanitization, and final result handling. */
import { settleCurrent, pushBlock, touch } from "./turn-state.js";
import { state } from "../state.js";
import { sanitizeText, BashSanitizer } from "../../text-safe.js";
import { displaySource } from "../logic/tool-display.js";
import { toolLabel, argsText } from "../logic/tool-label.js";

// Live tool cards. A card starts when the model begins composing the call
// (tool.call.start), fills with streamed arguments, runs (tool.execute),
// streams output (tool.data) and settles on tool.result — one card per call.
/**
 * Find the most recent unfinished tool block matching `predicate`.
 * @param {(block: object) => boolean} predicate
 * @returns {object|undefined} the matching live tool block.
 */
const liveTool = (predicate) => state.blocks.findLast((block) => block.kind === "tool" && !block.done && predicate(block));
/**
 * Begin a live tool card as the model starts composing the call (tool.call.start).
 * @param {object} m - `{ name?, text?, args?, index?, callId? }` packet.
 * @returns {void}
 */
function startToolCall(m) {
  settleCurrent();
  pushBlock( { kind: "tool", name: m.name ?? m.text ?? "tool", args: typeof m.args === "string" ? m.args : m.args !== undefined ? JSON.stringify(m.args) : "", index: m.index, callId: m.callId, state: "composing", output: "", done: false, started: Date.now() });
}
/**
 * Append streamed argument text to the composing tool card (tool.call.delta).
 * @param {object} m - `{ args?|text?, index? }` delta.
 * @returns {void}
 */
function appendToolCall(m) {
  const block = liveTool((item) => item.state === "composing" && (m.index === undefined || item.index === m.index)) ?? liveTool((item) => item.state === "composing");
  if (!block) return;
  block.args += typeof m.args === "string" ? m.args : m.text ?? "";
  touch( block);
}
/**
 * Finish call composition; the card moves to "queued" awaiting execution (tool.call.end).
 * @param {object} [m] - `{ args?, index? }`; structured args replace the streamed text.
 * @returns {void}
 */
function finishToolCall(m) {
  const block = liveTool((item) => item.state === "composing" && (m?.index === undefined || item.index === m.index)) ?? liveTool((item) => item.state === "composing");
  if (!block) return;
  if (m?.args !== undefined && typeof m.args !== "string") block.args = JSON.stringify(m.args);
  block.state = "queued";
  touch( block);
}
/**
 * Mark a queued tool card as running (tool.execute), creating it if the call was never seen.
 * @param {object} m - `{ call: { callId?, name?, arguments? } }` packet.
 * @returns {void}
 */
function startToolAnswer(m) {
  const call = m.call ?? {};
  let block = (call.callId && liveTool((item) => item.callId === call.callId))
    ?? liveTool((item) => item.state === "queued" && item.name === call.name)
    ?? liveTool((item) => item.state === "queued");
  if (!block) { block = { kind: "tool", name: call.name ?? "tool", args: "", output: "", done: false }; state.blocks.push(block); }
  Object.assign(block, { name: call.name ?? block.name, callId: call.callId ?? block.callId, state: "running", started: block.started ?? Date.now(), runStarted: Date.now() });
  if (call.arguments !== undefined) block.args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
  touch( block);
}
// One streaming sanitizer PER LIVE TOOL CALL (its look-back buffer catches
// escape sequences split across chunks — never shared between calls).
// Untrusted chunks are sanitized at this ingest boundary; the wire carries
// byte-exact output and the Agent's persisted result is never altered.
const toolSanitizers = new Map(); // call key → BashSanitizer
/**
 * Map a tool call to its sanitizer bucket key (call id, else name).
 * @param {object} [call] - `{ callId?, name? }`.
 * @returns {string}
 */
const toolKey = (call) => String(call?.callId ?? call?.name ?? "tool");
/**
 * Get (creating if needed) the streaming sanitizer for one live tool call.
 * @param {object} [call] - the tool call (keyed by `toolKey`).
 * @returns {BashSanitizer}
 */
function sanitizerFor(call) {
  const key = toolKey(call);
  let sanitizer = toolSanitizers.get(key);
  if (sanitizer === undefined) { sanitizer = new BashSanitizer({ markdown: true }); toolSanitizers.set(key, sanitizer); }
  return sanitizer;
}
/**
 * Sanitize and append a streamed output chunk to the running tool card (tool.data).
 * @param {object} m - `{ call?, chunk }` packet.
 * @returns {void}
 */
function appendToolData(m) {
  const block = (m.call?.callId && liveTool((item) => item.callId === m.call.callId)) ?? liveTool((item) => item.state === "running");
  if (!block) return;
  block.output = (block.output ?? "") + sanitizerFor(m.call ?? block).push(typeof m.chunk === "string" ? m.chunk : "");
  block.streamed = true;
  touch( block);
}
/**
 * Settle a tool card with its final result (tool.result): flush the sanitizer tail,
 * apply authoritative output/display, and mark the card ok/error + done.
 * @param {object} m - `{ result?, display? }` packet.
 * @returns {void}
 */
function finishTool(m) {
  const result = m.result ?? {};
  const block = (result.callId && liveTool((item) => item.callId === result.callId)) ?? liveTool((item) => item.state === "running");
  const key = toolKey(block ?? result);
  const sanitizer = toolSanitizers.get(key);
  let tail = "";
  if (sanitizer !== undefined) { tail = sanitizer.end(); toolSanitizers.delete(key); }
  const final = resultText(result);
  const shown = displaySource(m.display);
  const target = block ?? { kind: "tool", name: result.name ?? "tool", args: "", output: "" };
  if (!block) state.blocks.push(target);
  // The final result is authoritative; streamed output stays when the
  // result carries no text of its own (e.g. a status-only answer).
  target.output = final || ((target.output ?? "") + tail);
  target.display = shown;
  target.attachments = Array.isArray(m.attachments) ? m.attachments : [];
  target.state = result.error === true ? "error" : "ok";
  target.done = true;
  target.ended = Date.now();
  touch( target);
}
/**
 * Extract the sanitized display text of a tool result.
 * @param {object|string} result - `{ content: [{type, text}], error? }` or a plain string.
 * @returns {string} joined, markdown-safe text blocks; "" when there is none.
 */
function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? sanitizeText(result, { markdown: true }) : "";
  return content.filter((b) => b?.type === "text" && b.text).map((b) => sanitizeText(String(b.text), { markdown: true })).join("\n");
}

export { toolLabel, argsText, liveTool, startToolCall, appendToolCall, finishToolCall, startToolAnswer, toolSanitizers, toolKey, sanitizerFor, appendToolData, finishTool, resultText };
