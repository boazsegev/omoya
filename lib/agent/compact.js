/**
 * lib/agent/compact.js — /context-compact ownership (private to Agent):
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
 * The ALGORITHM is Agent's concern; consumers observe the compact turn
 * through the same Agent event subscriptions as any other turn.
 */

import Context from "../context.js";
const { MessageType, ContentType, userMessage, assistantMessage } = Context;

const COMPACT_INSTRUCTION =
  "Create a detailed summary of this conversation so far. It will REPLACE the full " +
  "history, so it must be self-contained for continuing the work. Structure it as: " +
  "1. primary request and intent; 2. key decisions made and their rationale; " +
  "3. current state and progress (done vs in flight); 4. important technical details " +
  "(file paths, artifacts, commands, constraints); 5. errors encountered and how they " +
  "were resolved; 6. pending tasks and next steps. Be concise but complete; omit " +
  "anything irrelevant to continuing. Reply with the summary only — no preamble.";

/** Plain text of a message's Text content blocks, joined. */
function textOf(message) {
  return (message?.content ?? []).filter((b) => b?.type === ContentType.Text).map((b) => b.text ?? "").join("\n");
}

/**
 * Run /context-compact over `agent`: ask the model to summarize, then
 * replace the context with the surviving SYSTEM messages plus one
 * ASSISTANT message holding the marked summary. A no-op (returns
 * `{ok: false}`, context untouched) when the model's compaction turn
 * produced no usable summary text.
 * @param {object} agent
 * @returns {Promise<{ok: boolean, before: number, summaryText?: string}>}
 */
export async function compactContext(agent) {
  const before = agent.context.length;
  // enqueue() starts an idle agent immediately under the ordinary context
  // guard. Compaction deliberately bypasses that guard, so append its private
  // instruction directly and own the ensuing guarded-off run here.
  agent._append(userMessage(COMPACT_INSTRUCTION));
  let terminal;
  do {
    terminal = await agent.run({ contextGuard: false });
  } while (terminal?.type === "done" && agent.pending.length > 0);
  // only the compact turn's own messages qualify as the summary
  const summary = agent.context.slice(before).reverse()
    .find((m) => m?.type === MessageType.Assistant && textOf(m).trim() !== "");
  if (!summary) return { ok: false, before };
  const summaryText = textOf(summary).trim();
  const systemMessages = agent.context.filter((m) => m?.type === MessageType.System);
  // metadata RECORDS (string type) survive: opaque tool/agent state
  // (the note tool's snapshots) — never provider-bound, so they cost
  // the model nothing and compaction must not lose them
  const records = agent.context.filter((m) => typeof m?.type === "string");
  agent.rollback(0);
  for (const m of systemMessages) agent.append(m);
  for (const m of records) agent.append(m);
  agent.append(assistantMessage([{
    type: ContentType.Text,
    text: `[context compacted — the summary of the earlier conversation follows]\n${summaryText}\n\n` +
      `[end of summary — continue the work based on it]`,
  }]));
  agent.session?.flush?.();
  return { ok: true, before, summaryText };
}
