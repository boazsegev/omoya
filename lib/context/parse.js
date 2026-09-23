/**
 * lib/context/parse.js — the shared CLI input grammar (pure).
 *
 * Grammar (frozen Decisions):
 *   1. The whole input is first parsed as ONE JSON context array.
 *   2. Otherwise line by line — JSON messages/arrays contribute
 *      structured context; non-JSON lines become user messages.
 * Reading stdin to EOF is a process concern and lives in lib/cli.js
 * (readStdin / readContextFromStdin); this module is the pure parser.
 */

import { MessageType, ContentType } from "./types.js";
import { isMessage } from "./validate.js";

/**
 * Parse buffered CLI input into a context array per the shared grammar.
 * Pure function — testable without a process.
 * @param {string} input - complete stdin text (post-EOF)
 * @returns {Array<object>} context array of messages
 */
export function parseContext(input) {
  // 2. whole input as one JSON context array
  const whole = tryJson(input);
  if (Array.isArray(whole)) return whole;

  // 3. per-line fallback
  const context = [];
  for (const line of input.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = tryJson(line);
    if (Array.isArray(parsed)) {
      // JSON array contributes structured context
      context.push(...parsed.filter(isMessage));
    } else if (isMessage(parsed)) {
      context.push(parsed);
    } else {
      // non-JSON (or non-message JSON scalar) line -> user message
      context.push({
        type: MessageType.User,
        content: [{ type: ContentType.Text, text: line }],
      });
    }
  }
  return context;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
