/**
 * lib/agent/compact.js — compaction ownership (private to Agent):
 * model-driven context compaction, best practices:
 *   1. a STRUCTURED summarization prompt (intent, decisions, state,
 *      artifacts, errors, next steps — self-contained, no preamble);
 *   2. the summary is taken ONLY from the compact turn's OWN messages
 *      (index >= before) — never an arbitrary assistant text from
 *      earlier history;
 *   3. the rebuilt context is the surviving SYSTEM messages plus the
 *      metadata RECORDS (string `type` — opaque tool/agent state like
 *      the note tool's snapshots; IO filters records from every
 *      request, so they cost the model nothing) plus ONE ASSISTANT
 *      message holding the marked summary + a continuation
 *      instruction — roles never mix, and the summary lands as an
 *      ASSISTANT turn (the model's own words), never a user one.
 *
 * AUTO-COMPACTION (compactAuto, agent.policy.context.autocompact):
 * before every provider request the run loop compacts once usage reaches
 * the threshold — after a tool round, a user message, or a worker's
 * message alike. The not-yet-answered tail (trailing USER messages;
 * worker replies arrive as user messages too) is held out of the
 * summary and re-attached after it, in order; messages queued during
 * the compaction stay pending. A manual `/compact [focus]` waiting in
 * the tail or the pending queue joins the automatic round instead of
 * running a second one: the command is removed and its focus text guides
 * the summary (when it was all that waited, the turn ends there, as a
 * manual /compact would). A failed compaction restores the context (and
 * the queue) exactly as it was.
 *
 * The ALGORITHM is Agent's concern; consumers observe the compact turn
 * through the same Agent event subscriptions as any other turn.
 */

import Context from "../context.js";
import { EVENT } from "./events.js";
import { compactFocus } from "./trim-user.js";
const { MessageType, ContentType, messageUser, messageAssistant } = Context;

const COMPACT_INSTRUCTION =
  "Create a detailed summary of this conversation so far. It will REPLACE the full " +
  "history, so it must be self-contained for continuing the work. Structure it as: " +
  "1. primary request and intent; 2. key decisions made and their rationale; " +
  "3. current state and progress (done vs in flight); 4. important technical details " +
  "(file paths, artifacts, commands, constraints); 5. errors encountered and how they " +
  "were resolved; 6. pending tasks and next steps. Be concise but complete; omit " +
  "anything irrelevant to continuing. Reply with the summary only — no preamble.";

/**
 * Extracts the text of a message's Text content blocks, joined by newlines.
 * @param {object|null|undefined} message - message whose `content` may be absent
 * @returns {string} joined text, or an empty string when no text blocks exist
 */
function textOf(message) {
  return (message?.content ?? []).filter((b) => b?.type === ContentType.Text).map((b) => b.text ?? "").join("\n");
}

/**
 * Run compaction over `agent`: ask the model to summarize, then
 * replace the context with the surviving SYSTEM messages plus one
 * ASSISTANT message holding the marked summary. A no-op (returns
 * `{ok: false}`, context untouched) when the model's compaction turn
 * produced no usable summary text.
 * @param {object} agent
 * @param {string} [focus] - optional guidance appended to the instruction
 * @param {(options: object) => Promise<object>} [run] - runs the compact turn
 * @param {{pendingHold?: boolean}} [options] - pendingHold: messages queued
 *   meanwhile stay pending (for the next request) instead of joining the turn
 * @returns {Promise<{ok: boolean, before: number, summaryText?: string}>}
 */
export async function compactContext(agent, focus = "", run = (options) => agent.run(options), { pendingHold = false } = {}) {
  if (typeof focus !== "string") throw new TypeError("Agent.compact: focus must be a string");
  const before = agent.context.length;
  // send() starts an idle agent immediately under the ordinary context
  // guard. Compaction deliberately bypasses that guard, so append its private
  // instruction directly and own the ensuing guarded-off run here.
  agent._append(messageUser(focus.trim() ? `${COMPACT_INSTRUCTION}\n${focus.trim()}` : COMPACT_INSTRUCTION));
  let terminal;
  do {
    terminal = await run({ contextGuard: false, compacting: true, pendingHold });
  } while (!pendingHold && terminal?.type === "done" && agent.pending.length > 0);
  // only the compact turn's own messages qualify as the summary
  const summary = agent.context.messages().slice(before).reverse()
    .find((m) => m?.type === MessageType.Assistant && textOf(m).trim() !== "");
  if (!summary) return { ok: false, before };
  const summaryText = textOf(summary).trim();
  const systemMessages = agent.context.messages().filter((m) => m?.type === MessageType.System);
  // metadata RECORDS (string type) survive: opaque tool/agent state
  // (the note tool's snapshots) — never provider-bound, so they cost
  // the model nothing and compaction must not lose them
  const records = agent.context.messages().filter((m) => typeof m?.type === "string");
  agent.context.rollback(0);
  for (const m of systemMessages) agent.context.append(m);
  for (const m of records) agent.context.append(m);
  agent.context.append(messageAssistant([{
    type: ContentType.Text,
    text: `[context compacted — the summary of the earlier conversation follows]\n${summaryText}\n\n` +
      `[end of summary — continue the work based on it]`,
  }]));
  // the last provider report measured the replaced context: drop its
  // `used` so the readout (and the guards) estimate the rebuilt one
  if (agent._contextReport) agent._contextReport = { ...agent._contextReport, used: undefined };
  agent._lastUsage = null;
  agent.context.flush();
  return { ok: true, before, summaryText };
}

/**
 * Auto-compaction (see the module doc): compact when the policy
 * threshold is set, the window is known, and usage has reached it.
 * Decides SYNCHRONOUSLY: a run that needs no compaction never yields
 * here, so its first request keeps the ordering of a run without it.
 * @param {object} agent
 * @param {(options: object) => Promise<object>} run - runs the compact turn
 * @returns {Promise<void>|null} the compaction, or null when none is due
 */
export function compactAuto(agent, run) {
  const threshold = agent.policy.context.autocompact;
  if (threshold === false || agent._cancelRequested || agent._closeMarked) return null;
  const { used, total } = agent.contextUsage;
  if (!Number.isFinite(total) || total <= 0 || used / total < threshold) return null;
  let start = agent.context.length;
  while (start > 0 && agent.context.at(start - 1)?.type === MessageType.User) start--;
  // nothing but system messages/records ahead of the tail: nothing to summarize
  const history = agent.context.messages().slice(0, start);
  if (!history.some((m) => typeof m?.type === "number" && m.type !== MessageType.System)) return null;
  return compactHoldingTail(agent, run, start, used / total, total, threshold);
}

/**
 * Removes recognized waiting `/compact` commands from a message list and collects their focus text.
 * @param {Array<object>} messages - queued or held messages to inspect
 * @returns {{kept: Array<object>, focuses: string[]}} messages retained and extracted focus strings
 */
function compactCommands(messages) {
  const focuses = [];
  const kept = messages.filter((message) => {
    const focus = compactFocus(message);
    if (focus === null) return true;
    focuses.push(focus);
    return false;
  });
  return { kept, focuses };
}

/**
 * Compacts the history before `start`, temporarily holding and then restoring the tail.
 * Waiting `/compact` commands contribute focus text; on failure the original tail and queue are restored.
 * @param {object} agent - agent whose context and pending queue are managed
 * @param {(options: object) => Promise<object>} run - runs the compact turn
 * @param {number} start - index where the held-out context tail begins
 * @param {number} usedFrac - measured context usage as a fraction of the window
 * @param {number} total - context-window size in tokens, for the log message
 * @param {number} threshold - configured auto-compaction threshold
 * @returns {Promise<{done: boolean}>} whether a folded manual command should end the turn
 */
async function compactHoldingTail(agent, run, start, usedFrac, total, threshold) {
  const tail = start < agent.context.length ? agent.context.rollback(start) : [];
  const queued = [...agent._pending];
  // a waiting manual /compact joins this round: its focus guides the summary
  const held = compactCommands(tail);
  const pending = compactCommands(queued);
  agent._pending.splice(0, agent._pending.length, ...pending.kept);
  const focus = [...held.focuses, ...pending.focuses].filter((text) => text !== "").join("\n");
  agent._emit(EVENT.LOG, `auto-compacting: context usage is ${Math.round(usedFrac * 100)}% of the ` +
    `${total}-token window (threshold ${Math.round(threshold * 100)}%)`);
  let ok = false;
  try {
    const result = await compactContext(agent, focus, run, { pendingHold: true });
    ok = result.ok;
    if (!ok) {
      // the compact turn's own messages go; the history stays as it was
      if (agent.context.length > result.before) agent.context.rollback(result.before);
      agent._emit(EVENT.LOG, "auto-compaction produced no summary — continuing uncompacted");
    }
  } finally {
    // no summary: any waiting /compact returns to where it waited
    if (!ok) agent._pending.splice(0, pending.kept.length, ...queued);
    for (const message of ok ? held.kept : tail) agent.context.append(message, { merge: false });
  }
  // a folded /compact with nothing else waiting ends the turn, as a
  // manual /compact would
  return { done: ok && held.focuses.length > 0 && held.kept.length === 0 && agent._pending.length === 0 };
}
