/**
 * lib/agent/tool-repair.js — unanswered tool-call repair (private to
 * Agent).
 *
 * Strict chat dialects (Moonshot, OpenAI) REFUSE a request whose
 * assistant message carries tool_calls that no tool message answers —
 * one orphan call fails the whole request (HTTP 400). An orphan is
 * never intentional; it is the residue of an interruption:
 *   - a cancelled/killed turn whose partial assistant message already
 *     held a completed toolCall block (run.js appends the partial,
 *     then returns on the error terminal — dispatch never happens);
 *   - a runaway guard firing AFTER the assistant message was appended
 *     (the message's remaining calls never execute);
 *   - a crash between the assistant append and the result append —
 *     the session file keeps the orphan, and a resume reproduces it.
 *
 * The repair runs before every provider request in two passes:
 *   1. A ToolResult with no matching, still-unanswered call in its
 *      ANSWER WINDOW (including duplicate results) is DETACHED. Never
 *      drop it: convert the complete original message to an explicit
 *      System JSON record, preserving data while removing invalid tool
 *      linkage after an edit/rollback.
 *   2. Every toolCall still lacking a ToolResult in its window gets a
 *      synthetic interruption error inserted at the window's end, in
 *      call order.
 * The context becomes wire-valid for every dialect permanently (the
 * session flush persists both repair forms).
 */

import Context from "../context.js";
import { EVENT } from "./events.js";
const { ContentType, MessageType, contentText, messageHasContent, messageHasError, messageValid, messageRebuild } = Context;

/**
 * Convert a detached ToolResult into a System record while preserving its
 * original fields as JSON text. If JSON serialization fails, uses String()
 * as a fallback; does not mutate the input message.
 * @param {object} message - Detached ToolResult message to preserve.
 * @returns {object} System message containing the serialized original record.
 */
function detachedRecord(message) {
  const { type: _type, ...record } = message;
  let json;
  try { json = JSON.stringify(record); } catch { json = String(record); }
  return {
    type: MessageType.System,
    content: [contentText(
      "detached tool result preserved after its matching call was removed or already answered:\n" + json,
    )],
  };
}

/**
 * Remove empty message entries from the agent's live context. A message is
 * removed when it is valid and has neither content nor an error; non-message
 * metadata and error-bearing messages are retained. All removals run in one
 * Context.update() batch, and a log event is emitted only if messages were
 * removed. Errors from the context update or event emitter propagate.
 * @param {object} agent - Agent whose context is swept; must provide
 *   `context.update()` and `_emit()`.
 * @returns {number} Number of empty messages removed.
 */
export function sweepEmptyMessages(agent) {
  let removed = 0;
  agent.context.update((context) => {
    for (let i = context.length - 1; i >= 0; i--) {
      if (messageValid(context[i]) && !messageHasContent(context[i]) && !messageHasError(context[i])) {
        context.splice(i, 1);
        removed++;
      }
    }
    return removed > 0;
  });
  if (removed > 0) {
    agent._emit(EVENT.LOG, `swept ${removed} empty message(s) from the context`);
  }
  return removed;
}

/**
 * Repair tool linkage in the agent's live context in one Context.update()
 * batch. Detached or duplicate ToolResults become preserving System records;
 * unanswered ToolCalls receive synthetic interruption-error results, and
 * missing call IDs are assigned before insertion. Existing stored messages
 * are replaced rather than mutated. Emits a log event if any records were
 * converted or inserted. Errors from context updates, message rebuilding, or
 * event emission propagate.
 * @param {object} agent - Agent whose context is repaired; must provide
 *   `context.update()` and `_emit()`.
 * @returns {number} Total number of converted ToolResults and inserted
 *   interruption results.
 */
export function repairToolCalls(agent) {
  let converted = 0;
  let inserted = 0;
  agent.context.update((context) => {
    // Pass 1 — validate ToolResults against the immediately preceding
    // assistant answer window. A call id can be answered once; later
    // duplicates are detached too.
    let available = new Set();
    for (let i = 0; i < context.length; i++) {
      const message = context[i];
      if (message?.type === MessageType.User) {
        available = new Set();
        continue;
      }
      if (message?.type === MessageType.Assistant) {
        available = new Set((message.content ?? [])
          .filter((block) => block?.type === ContentType.ToolCall && block.callId !== undefined)
          .map((block) => block.callId));
        continue;
      }
      if (message?.type !== MessageType.ToolResult) continue; // System stays inside the window
      if (message.callId !== undefined && available.has(message.callId)) {
        available.delete(message.callId); // exactly one result answers one call
        continue;
      }
      context[i] = detachedRecord(message);
      converted++;
    }

    // Pass 2 — fill calls that remain unanswered after detached results
    // were normalized.
    for (let i = 0; i < context.length; i++) {
      const message = context[i];
      if (message?.type !== MessageType.Assistant) continue;
      const calls = (message.content ?? []).filter((b) => b?.type === ContentType.ToolCall);
      if (calls.length === 0) continue;
      // the answer window: everything up to the next User/Assistant
      // message (System messages are tool payloads — they belong to it)
      const answered = new Set();
      let j = i + 1;
      for (; j < context.length; j++) {
        const type = context[j]?.type;
        if (type === MessageType.User || type === MessageType.Assistant) break;
        if (type === MessageType.ToolResult) answered.add(context[j].callId);
      }
      const missing = calls.filter((call) => !answered.has(call.callId));
      if (missing.length === 0) continue;
      // A stored message is REPLACED, never mutated in place (see the
      // header): one rebuilt assistant message carries all fresh ids
      // (calls that already HAVE an id keep it — only id-less calls
      // need the message rebuilt at all).
      const ids = new Map();
      for (const call of missing) {
        if (call.callId === undefined) ids.set(call, freshCallId(context, new Set(ids.values())));
      }
      if (ids.size > 0) {
        const content = message.content.map((block) => ids.has(block) ? { ...block, callId: ids.get(block) } : block);
        context[i] = messageRebuild({ ...message, content }); // replaced, never mutated
      }
      for (const call of missing) {
        const callId = call.callId ?? ids.get(call);
        context.splice(j, 0, {
          type: MessageType.ToolResult,
          callId,
          ...(call.name !== undefined ? { name: call.name } : {}),
          error: true,
          content: [contentText(
            `tool error: the "${call.name ?? "unknown"}" call was interrupted — no result was recorded`,
          )],
        });
        j++; // the window grew by the inserted result
        inserted++;
      }
    }
    return converted + inserted > 0;
  });
  const repaired = converted + inserted;
  if (repaired > 0) {
    agent._emit(EVENT.LOG,
      `repaired tool linkage — converted ${converted} detached result(s), inserted ${inserted} interruption result(s)`,
    );
  }
  return repaired;
}

/**
 * Generate the first `repair-N` ID not used by a ToolCall or ToolResult in
 * the context or by an ID in `extra`.
 * @param {Array<object>} context - Context entries scanned for existing IDs.
 * @param {Set<*>} [extra=new Set()] - Additional IDs already assigned in the
 *   current repair pass.
 * @returns {string} An unused `repair-N` call ID.
 */
function freshCallId(context, extra = new Set()) {
  const used = new Set(extra);
  for (const message of context) {
    if (message?.type === MessageType.ToolResult && message.callId !== undefined) {
      used.add(message.callId);
    }
    for (const block of message?.content ?? []) {
      if (block?.type === ContentType.ToolCall && block.callId !== undefined) {
        used.add(block.callId);
      }
    }
  }
  let n = 0;
  while (used.has(`repair-${++n}`)) { /* keep looking */ }
  return `repair-${n}`;
}
