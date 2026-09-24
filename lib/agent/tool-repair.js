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
const { ContentType, MessageType, textContent, hasContent, isMessage } = Context;

/** Preserve one detached ToolResult as a normal System record. */
function detachedRecord(message) {
  const { type: _type, ...record } = message;
  let json;
  try { json = JSON.stringify(record); } catch { json = String(record); }
  return {
    type: MessageType.System,
    content: [textContent(
      "detached tool result preserved after its matching call was removed or already answered:\n" + json,
    )],
  };
}

/**
 * Sweep EMPTY messages out of the live context: a message no provider
 * dialect can carry (hasContent — empty content, or only payload-less
 * blocks like a text_start that never produced a delta) must never
 * persist. appendMessage already REFUSES an incoming empty, but a
 * merge consuming a message's whole payload into its predecessor, or
 * an edit hollowing one out, can legitimately leave an empty inside
 * the live array — and an interrupted turn is exactly where that
 * happens. Every MESSAGE sweeps (numeric `type` — isMessage: user,
 * assistant, system alike — a contentless message is dead weight in
 * the live array and the session file, and IO already filters empties
 * from every provider-bound context, so no dialect distinction
 * matters); non-message entries (metadata records — string `type`,
 * harness/tool-owned state riding the context) are never the sweep's
 * business. The session shares this array, so sweeping here persists.
 * @param {object} agent
 * @returns {number} messages removed
 */
export function sweepEmptyMessages(agent) {
  const context = agent.context;
  let removed = 0;
  for (let i = context.length - 1; i >= 0; i--) {
    if (isMessage(context[i]) && !hasContent(context[i])) {
      context.splice(i, 1);
      removed++;
    }
  }
  if (removed > 0) {
    agent.session?._mutate?.();
    agent._emit(EVENT.LOG, `swept ${removed} empty message(s) from the context`);
  }
  return removed;
}

/**
 * Repair detached results and insert synthetic errors for unanswered
 *  calls. Rewrites the context ARRAY in place (Agent and SessionStore
 *  share it) but never mutates a stored MESSAGE: repairs replace
 *  messages through the Context edit path (identity-keyed caches and
 *  memos across the app bet on stored-message immutability). Marks the
 *  session dirty when anything changed.
 * @param {object} agent
 * @returns {number} total converted + inserted messages
 */
export function repairToolCalls(agent) {
  const context = agent.context;
  let converted = 0;
  let inserted = 0;

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
      agent.edit(i, { ...message, content });
    }
    for (const call of missing) {
      const callId = call.callId ?? ids.get(call);
      context.splice(j, 0, {
        type: MessageType.ToolResult,
        callId,
        ...(call.name !== undefined ? { name: call.name } : {}),
        error: true,
        content: [textContent(
          `tool error: the "${call.name ?? "unknown"}" call was interrupted — no result was recorded`,
        )],
      });
      j++; // the window grew by the inserted result
      inserted++;
    }
  }
  const repaired = converted + inserted;
  if (repaired > 0) {
    agent.session?._mutate?.();
    agent._emit(EVENT.LOG,
      `repaired tool linkage — converted ${converted} detached result(s), inserted ${inserted} interruption result(s)`,
    );
  }
  return repaired;
}

/** A callId no ToolCall block or ToolResult in the context uses.
 *  `extra` holds ids already handed out in this repair pass (they are
 *  not in the context yet). */
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
