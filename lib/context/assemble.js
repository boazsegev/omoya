/**
 * lib/context/assemble.js — response-event assembly: normalized IO
 * events → one (partial or complete) assistant message.
 */

import { MessageType, ContentType } from "./types.js";
import { isMessage } from "./validate.js";
import { callbackName } from "./events.js";

/**
 * Create an assembler that consumes normalized IO response events
 * into one assistant message. The message is partial until `done`;
 * at any point `message()` returns what has been assembled so far
 * (this is what cancellation persists).
 * @returns {{consume: (event: object) => void, message: () => object}}
 */
export function createAssembler() {
  let message = { type: MessageType.Assistant, content: [] };

  const blockAt = (i) => {
    while (message.content.length <= i) message.content.push(null);
    return message.content[i];
  };

  const appendDelta = (i, kind, text) => {
    let block = blockAt(i);
    if (!isMessageBlock(block, kind)) {
      block = { type: kind, text: "" };
      message.content[i] = block;
    }
    block.text += text ?? "";
  };

  /** Replace a streamed block with a provider-authoritative final snapshot. */
  const reconcileText = (i, kind, finalText) => {
    const text = String(finalText);
    const block = blockAt(i);
    const streamed = isMessageBlock(block, kind) ? block.text ?? "" : "";
    if (kind === ContentType.Text && streamed !== text && streamed !== "") message.draft = streamed;
    message.content[i] = { type: kind, text };
  };

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
      case "toolcall_start": {
        const i = event.contentIndex ?? message.content.length;
        message.content[i] = {
          type: ContentType.ToolCall,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments ?? "",
        };
        break;
      }
      case "toolcall_delta": {
        const block = blockAt(event.contentIndex ?? lastIndex(message));
        if (isMessageBlock(block, ContentType.ToolCall)) {
          block.arguments = String(block.arguments ?? "") + (event.arguments ?? "");
        }
        break;
      }
      case "toolcall_end": {
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
    consume,
    /** @returns {object} the assistant message assembled so far (partial or complete) */
    message: () => message,
  };
}

/**
 * The callback set (camelCase, matching lib/context/events.js) that
 * assembles a response — Context "supplies the callback set".
 * @param {ReturnType<typeof createAssembler>} assembler
 * @returns {Object} callbacks keyed onStart/onTextDelta/.../onDone/onError
 */
export function assemblyCallbacks(assembler) {
  const names = [
    "start",
    "text_start", "text_delta", "text_end",
    "thinking_start", "thinking_delta", "thinking_end",
    "toolcall_start", "toolcall_delta", "toolcall_end",
    "done", "error",
  ];
  const set = {};
  for (const name of names) {
    set[callbackName(name)] = (event) => assembler.consume(event);
  }
  return set;
}

function isMessageBlock(block, kind) {
  return block !== null && typeof block === "object" && block.type === kind;
}

function lastIndex(message) {
  return Math.max(0, message.content.length - 1);
}
