/**
 * lib/agent/trim-user.js — user-message whitespace normalization
 * (private to Agent).
 *
 * A user submission often arrives with surrounding whitespace: the TUI
 * input's trailing newline, a pasted line ending in tabs, a CLI echo.
 * None of it is meaningul content — the model should never see it, and
 * a submission that is whitespace ONLY must behave exactly like
 * /continue: no user turn enters the context, and the run loop simply
 * proceeds over the existing context.
 *
 * The rule: trim every text/thinking block of a USER message; a block
 * emptied by the trim is payload-less and drops out; when nothing
 * consumable remains (hasContent), the whole message is a no-op. Tool
 * results and assistant messages are history — never rewritten here.
 */

import Context from "../context.js";
const { ContentType, MessageType, hasContent } = Context;

/**
 * Trim whitespace (spaces, tabs, EOLs, every Unicode white space) out
 * of one user message's text/thinking blocks. Non-text blocks
 * (attachments, binaries) keep the message alive regardless.
 * @param {object} message
 * @returns {{message: object}|null} the normalized message, or null
 *   when trimming left nothing consumable
 */
export function trimUserMessage(message) {
  if (message?.type !== MessageType.User || !Array.isArray(message.content)) return { message };
  let changed = false;
  const content = message.content
    .map((block) => {
      if (block !== null && typeof block === "object" &&
          (block.type === ContentType.Text || block.type === ContentType.Thinking) &&
          typeof block.text === "string") {
        const text = block.text.trim();
        if (text === "") { changed = true; return null; } // payload-less after the trim
        if (text !== block.text) { changed = true; return { ...block, text }; }
      }
      return block;
    })
    .filter((block) => block !== null);
  if (!changed) return hasContent(message) ? { message } : null;
  const normalized = { ...message, content };
  return hasContent(normalized) ? { message: normalized } : null;
}

/**
 * Trim the LATEST user message in the live context (when it is the
 * last message — a mid-context message is settled history and stays
 * byte-for-byte). A message hollowed out by the trim is left in place
 * for the empty sweep that runs right after (one owner removes
 * messages from the context).
 * @param {object} agent
 * @returns {boolean} whether the latest message was rewritten
 */
export function trimLatestUserMessage(agent) {
  const context = agent.context;
  const last = context[context.length - 1];
  if (last?.type !== MessageType.User) return false;
  const trimmed = trimUserMessage(last);
  if (trimmed === null || trimmed.message === last) return false;
  context[context.length - 1] = trimmed.message;
  agent.session?._mutate?.();
  return true;
}
