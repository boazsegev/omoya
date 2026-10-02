/**
 * lib/context/assemble.js — response-event assembly: normalized IO
 * events → one (partial or complete) assistant message.
 */

import { MessageType, ContentType } from "./types.js";
import { isMessage } from "./validate.js";
import { callbackName } from "./events.js";

/**
 * Create a per-request content-block indexer for a provider translator. `of`
 * reuses an index for a previously seen wire-item key, while `next` always
 * reserves a fresh index; indexes are dense and follow first appearance.
 * @returns {{of: (key: *) => number, next: () => number}} Indexing operations.
 */
export function contentIndexer() {
  const byKey = new Map();
  let count = 0;
  return {
    /**
     * Return the stable index assigned to a wire-item key, assigning the next
     * dense index the first time that key is seen.
     * @param {*} key Wire-item identity; Map key equality rules apply. No default.
     * @returns {number} The stable content-block index.
     * @throws May propagate an error from the underlying Map operation.
     */
    of(key) {
      if (!byKey.has(key)) byKey.set(key, count++);
      return byKey.get(key);
    },
    /**
     * Reserve and return a fresh content-block index that is not associated
     * with any key.
     * @returns {number} The next dense content-block index.
     */
    next() {
      return count++;
    },
  };
}

/**
 * Create an assembler that folds normalized response events into one
 * assistant message. Events mutate the in-progress message; valid message
 * snapshots on `start`, `done`, or `error` replace it. Unknown event types are
 * ignored, and malformed tool-call JSON is retained as raw text. The returned
 * message remains partial until completion and is exposed by reference.
 * @returns {{consume: (event: object) => void, message: () => object}} The
 *   event consumer and accessor for the current message.
 * @throws Creating the assembler does not intentionally throw. Its returned
 *   `consume` method can propagate errors from malformed events or message
 *   mutations; JSON parse errors for tool arguments are suppressed.
 */
export function createAssembler() {
  let message = { type: MessageType.Assistant, content: [] };

  /**
   * Get a content block by index, padding the message with null entries when
   * necessary.
   * @param {number} i Zero-based content-block index; no default or validation.
   * @returns {*} The indexed value (normally an existing block or null).
   * @throws Throws if the current message has no usable content array or
   *   padding the array fails.
   */
  const blockAt = (i) => {
    while (message.content.length <= i) message.content.push(null);
    return message.content[i];
  };

  /**
   * Append streamed text to a block, creating or replacing the block when its
   * type does not match. A nullish `text` contributes an empty string.
   * @param {number} i Zero-based content-block index; no default.
   * @param {string} kind Block type, normally text or thinking; no default.
   * @param {*} text Delta to append; null and undefined default to "".
   * @returns {void}
   * @effects Pads and mutates `message.content` and the selected block.
   * @throws Invalid message state or value coercion can cause native errors.
   */
  const appendDelta = (i, kind, text) => {
    let block = blockAt(i);
    if (!isMessageBlock(block, kind)) {
      block = { type: kind, text: "" };
      message.content[i] = block;
    }
    block.text += text ?? "";
  };

  /**
   * Replace a streamed block with a provider-authoritative final snapshot.
   * For text blocks, preserve a non-empty differing streamed value in
   * `message.draft` before replacing it. The final value is stringified.
   * @param {number} i Zero-based content-block index; no default.
   * @param {string} kind Block type to reconcile; no default.
   * @param {*} finalText Authoritative snapshot; converted with String().
   * @returns {void}
   * @effects Mutates the selected content block and possibly message.draft.
   * @throws String conversion may propagate an error from finalText.
   */
  const reconcileText = (i, kind, finalText) => {
    const text = String(finalText);
    const block = blockAt(i);
    const streamed = isMessageBlock(block, kind) ? block.text ?? "" : "";
    if (kind === ContentType.Text && streamed !== text && streamed !== "") message.draft = streamed;
    message.content[i] = { type: kind, text };
  };

  /**
   * Consume one normalized response event, updating or replacing the current
   * assistant message according to its event type. Missing contentIndex uses
   * the current content length for starts and the last content slot (minimum
   * zero) for deltas/ends. Unknown event types are ignored.
   * @param {object} event Response event; expected to have a recognized `type`
   *   and fields appropriate to that event. No default is applied.
   * @returns {void}
   * @effects Mutates assembler state and may replace the current message.
   * @throws Nullish/non-object events or invalid values may cause native
   *   property-access or mutation errors. Invalid JSON in tool_call_end is
   *   deliberately caught, leaving the raw arguments unchanged.
   */
  const consume = (event) => {
    switch (event.type) {
      case "start":
        if (isMessage(event.message)) message = event.message;
        break;
      case "text_start":
      case "thinking_start": {
        const i = event.contentIndex ?? message.content.length;
        const kind = event.type === "text_start" ? "text" : "thinking";
        if (!isMessageBlock(blockAt(i), kind)) {
          message.content[i] = { type: kind, text: "" };
        }
        break;
      }
      case "text_delta":
        appendDelta(event.contentIndex ?? lastIndex(message), "text", event.text);
        break;
      case "thinking_delta":
        appendDelta(event.contentIndex ?? lastIndex(message), "thinking", event.text);
        break;
      case "text_end": {
        const i = event.contentIndex ?? lastIndex(message);
        if (event.text != null) reconcileText(i, ContentType.Text, event.text);
        break;
      }
      case "thinking_end": {
        const i = event.contentIndex ?? lastIndex(message);
        if (event.text != null) reconcileText(i, ContentType.Thinking, event.text);
        break;
      }
      case "tool_call_start": {
        const i = event.contentIndex ?? message.content.length;
        message.content[i] = {
          type: ContentType.ToolCall,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments ?? "",
        };
        break;
      }
      case "tool_call_delta": {
        const block = blockAt(event.contentIndex ?? lastIndex(message));
        if (isMessageBlock(block, ContentType.ToolCall)) {
          block.arguments = String(block.arguments ?? "") + (event.arguments ?? "");
        }
        break;
      }
      case "tool_call_end": {
        const i = event.contentIndex ?? lastIndex(message);
        const block = blockAt(i);
        if (isMessageBlock(block, ContentType.ToolCall)) {
          if (event.arguments !== undefined) {
            block.arguments = event.arguments;
          } else if (typeof block.arguments === "string") {
            try { block.arguments = JSON.parse(block.arguments); } catch { /* keep raw */ }
          }
        }
        break;
      }
      case "done":
      case "error":
        if (isMessage(event.message)) message = event.message;
        break;
      default:
        break; // tolerant reader: unknown events ignored
    }
  };

  return {
    /**
     * Consume one normalized response event.
     * @param {object} event Event forwarded to the assembler; no default.
     * @returns {void}
     * @effects Updates the assembler's current message; see consume's behavior.
     * @throws Propagates errors from event processing.
     */
    consume,
    /**
     * Return the assistant message assembled so far, whether partial or
     * complete.
     * @returns {object} The live message object; it is not cloned.
     * @effects None beyond exposing the current object by reference.
     */
    message: () => message,
  };
}

/**
 * Build the camelCase callback set used by Context to feed response events to
 * an assembler. Includes callbacks for start, text/thinking block events,
 * tool-call events, done, and error.
 * @param {ReturnType<typeof createAssembler>} assembler Assembler receiving
 *   the events; no default is provided.
 * @returns {Object<string, function(object): void>} Callbacks keyed by names
 *   such as `onStart`, `onTextDelta`, `onDone`, and `onError`.
 * @effects Creates a new callback object; each callback delegates to
 *   assembler.consume and therefore mutates that assembler.
 * @throws Throws if assembler is missing or does not provide consume, or if
 *   event processing throws when a callback is invoked.
 */
export function assemblyCallbacks(assembler) {
  const names = [
    "start",
    "text_start", "text_delta", "text_end",
    "thinking_start", "thinking_delta", "thinking_end",
    "tool_call_start", "tool_call_delta", "tool_call_end",
    "done", "error",
  ];
  const set = {};
  for (const name of names) {
    /**
     * Forward this callback's response event to the supplied assembler.
     * @param {object} event Response event; no default is applied.
     * @returns {void}
     * @effects Delegates state changes to assembler.consume.
     * @throws Propagates errors from assembler.consume.
     */
    set[callbackName(name)] = (event) => assembler.consume(event);
  }
  return set;
}

/**
 * Test whether a value is a non-null object whose `type` matches `kind`.
 * @param {*} block Candidate content block; no default.
 * @param {*} kind Expected block type; no default.
 * @returns {boolean} True when the candidate has the requested type.
 * @effects None.
 */
function isMessageBlock(block, kind) {
  return block !== null && typeof block === "object" && block.type === kind;
}

/**
 * Return the last content index, using zero when the message has no blocks.
 * @param {object} message Message with a `content` array; no default.
 * @returns {number} Math.max(0, content.length - 1).
 * @effects None.
 * @throws Throws if message.content is missing or its length cannot be read.
 */
function lastIndex(message) {
  return Math.max(0, message.content.length - 1);
}
