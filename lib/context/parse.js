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
 * Parse buffered CLI input into a context array using the shared grammar.
 * First, the entire input is parsed as JSON; if that is an array, it is
 * returned unchanged. Otherwise, each nonblank line is parsed independently:
 * message objects and valid messages in arrays are included, while other
 * values become user text messages containing the original line.
 *
 * @param {string} input - Complete stdin text after EOF; there is no default.
 * @returns {Array<object>} The resulting context array. This is synchronous
 *   and returns no Promise.
 * @throws {TypeError} If input is not a string and line processing attempts
 *   to call `split` on it.
 * @effects Pure parser: does not read stdin or otherwise perform I/O. JSON
 *   parse errors are caught and treated as non-JSON input.
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

/**
 * Attempt to parse text as JSON without propagating syntax errors.
 *
 * @param {string} text - Text to parse; there is no default.
 * @returns {*} The parsed JSON value, or `undefined` when parsing fails.
 *   This is synchronous and returns no Promise.
 * @effects Does not mutate state or perform I/O; any JSON parse exception is
 *   swallowed and represented as `undefined`.
 */
function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
