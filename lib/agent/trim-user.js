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
 * Trim whitespace (spaces, tabs, EOLs, every Unicode whitespace) from text/thinking blocks of a user message. Empty blocks are removed; non-text blocks are preserved and may keep the message consumable. Non-user messages and messages without array content are returned intact.
 * @param {object} message Message to normalize; required, no default.
 * @returns {{message: object}|null} Original or normalized message wrapper, or null when nothing consumable remains.
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

/**
 * Extract focus from an Agent-owned `/compact` command in a single-text-block user message. The command must be followed by whitespace or end-of-string; returned focus is trimmed.
 * @param {object} message Message to inspect; required, no default.
 * @returns {string|null} Trimmed focus (possibly empty), or null if not a matching command.
 */
export function compactFocus(message) {
  if (message?.type !== MessageType.User || !Array.isArray(message.content) || message.content.length !== 1) return null;
  const block = message.content[0];
  if (block?.type !== ContentType.Text || typeof block.text !== "string") return null;
  const match = /^\/compact(?=\s|$)/.exec(block.text);
  return match ? block.text.slice(match[0].length).trim() : null;
}

/**
 * Expand a leading registered slash-prompt name in a delivered user message. Unknown names and ineligible messages remain unchanged; registered prompt body replaces the command and is followed by remaining text.
 * @param {object} message Message to inspect; required, no default.
 * @param {object} env Environment providing `prompts().get(name)?.body`; required, no default.
 * @returns {object} Original message or shallow-copied expanded message. Synchronous; no Promise.
 * @throws Propagates errors from environment prompt lookup.
 */
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
 * @param {object} agent Agent with `context.update` and `_expandedUserMessages`; required, no default.
 * @returns {boolean} Whether a trailing message was rewritten, as reported by `context.update`.
 * @throws Propagates errors from context updates, trimming, or expansion tracking.
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

/**
 * Resolve trailing user messages once after queued and direct context writes: remove recognized `/compact` messages and expand registered prompts, skipping already-expanded messages.
 * @param {object} agent Agent with `context.update`, `_expandedUserMessages`, and `env`; required, no default.
 * @returns {string|null} Focus from the nearest recognized compact command encountered in reverse order (empty string is valid), or null. Synchronous; no Promise.
 * @throws Propagates errors from context updates, prompt lookup, or expansion tracking.
 */
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
