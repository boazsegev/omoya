/**
 * lib/agent/trim-user.js — user-message whitespace normalization
 * (private to Agent).
 *
 * A user submission often arrives with surrounding whitespace: the TUI
 * input's trailing newline, a pasted line ending in tabs, a CLI echo.
 * None of it is meaningul content — the model should never see it, and
 * a submission that is whitespace ONLY must behave exactly like
 * /continue: no user turn enters the context, and the run loop simply
 * proceeds over the existing context. Registered slash prompts and
 * /compact are interpreted at the Agent→IO boundary for all entry paths.
 *
 * The rule: trim every text/thinking block of a USER message; a block
 * emptied by the trim is payload-less and drops out; when nothing
 * consumable remains (messageHasContent), the whole message is a no-op. Tool
 * results and assistant messages are history — never rewritten here.
 */

import Context from "../context.js";
const { ContentType, MessageType, messageHasContent } = Context;

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
  if (!changed) return messageHasContent(message) ? { message } : null;
  const normalized = { ...message, content };
  return messageHasContent(normalized) ? { message: normalized } : null;
}

/** Extract focus from the Agent-owned /compact command in a text-only user message. */
export function compactFocus(message) {
  if (message?.type !== MessageType.User || !Array.isArray(message.content) || message.content.length !== 1) return null;
  const block = message.content[0];
  if (block?.type !== ContentType.Text || typeof block.text !== "string") return null;
  const match = /^\/compact(?=\s|$)/.exec(block.text);
  return match ? block.text.slice(match[0].length).trim() : null;
}

/** Expand a leading registered slash prompt in a delivered user message. */
export function expandUserPrompt(message, env) {
  if (message?.type !== MessageType.User || !Array.isArray(message.content)) return message;
  const first = message.content[0];
  if (first?.type !== ContentType.Text || typeof first.text !== "string") return message;
  // Only a leading, standalone slash name is a prompt invocation. Unknown
  // commands remain literal text; application commands are UI operations.
  const match = /^\/{1,2}([^\s/]+)(?=\s|$)/.exec(first.text);
  if (!match) return message;
  const body = env.prompts().get(match[1])?.body;
  if (body === undefined) return message;
  const rest = first.text.slice(match[0].length).replace(/^\s/, "");
  return {
    ...message,
    content: [{ ...first, text: rest ? `${body}\n${rest}` : body }, ...message.content.slice(1)],
  };
}

/**
 * Trim the trailing user messages in the live context (settled history
 * stays byte-for-byte). A message hollowed out by the trim is left in place
 * for the empty sweep that runs right after (one owner removes
 * messages from the context).
 * @param {object} agent
 * @returns {boolean} whether the latest message was rewritten
 */
export function trimLatestUserMessage(agent) {
  return agent.context.update((context) => {
    let changed = false;
    for (let i = context.length - 1; i >= 0 && context[i]?.type === MessageType.User; i--) {
      const trimmed = trimUserMessage(context[i]);
      if (trimmed?.message && trimmed.message !== context[i]) {
        if (agent._expandedUserMessages.has(context[i])) agent._expandedUserMessages.add(trimmed.message);
        context[i] = trimmed.message;
        changed = true;
      }
    }
    return changed;
  });
}

/** Resolve trailing user messages once, after queued and direct context writes. */
export function prepareUserMessages(agent) {
  let focus = null;
  agent.context.update((messages) => {
    let changed = false;
    for (let i = messages.length - 1; i >= 0 && messages[i]?.type === MessageType.User; i--) {
      const message = messages[i];
      if (agent._expandedUserMessages.has(message)) continue;
      const command = compactFocus(message);
      if (command !== null) {
        messages.splice(i, 1);
        if (focus === null) focus = command;
        changed = true;
        continue;
      }
      const expanded = expandUserPrompt(message, agent.env);
      if (expanded !== message) {
        messages[i] = expanded;
        agent._expandedUserMessages.add(expanded);
        changed = true;
      }
    }
    return changed;
  });
  return focus;
}
