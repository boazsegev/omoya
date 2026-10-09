/** Terminal-neutral context-to-block projection for transcript viewers and raw copy.
 * Live message/block edits remain visible; expensive sanitization is reused
 * only while the extracted immutable string value remains unchanged. */

import Context from "../../context.js";
import Markdown from "../markdown/index.js";
const { sanitizeText } = Markdown;
const { ContentType, MessageType, mimeOf, messageHasError, messageErrorText } = Context;

/**
 * Convert a display payload into readable text, preserving text blocks and
 * representing binary or structured blocks without changing the source.
 * @param {unknown} content A string or array of content blocks.
 * @returns {string} The joined, display-oriented text.
 */
function contentText(content) {
  if (typeof content === "string") return content; // legacy display payload
  return (content ?? []).map((block) => {
    if (typeof block === "string") return block; // legacy display string arrays
    if (block?.type === ContentType.Text || block?.type === "text") return block.text ?? "";
    if (block?.type === ContentType.Binary || block?.type === "binary" || block?.type === "image") {
      const bytes = typeof block.content === "string" ? Math.floor((block.content.length * 3) / 4) : 0;
      return `[${block.type}: ${mimeOf(block) ?? "unknown"}, ${bytes} bytes]`;
    }
    if (block && typeof block === "object") {
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return `\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``;
    }
    return String(block ?? "");
  }).join("\n\n");
}

/**
 * Read current live message content without assuming array/block immutability.
 * @param {object|null|undefined} message Message whose content to extract.
 * @returns {string} Extracted text.
 */
function fullText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (content?.length === 1 && (content[0]?.type === ContentType.Text || content[0]?.type === "text")) return content[0].text ?? "";
  return contentText(content);
}

const sanitizedByMessage = new WeakMap();
function sanitizedText(message) {
  const text = fullText(message);
  const cached = sanitizedByMessage.get(message);
  if (cached?.text === text) return cached.sanitized;
  const sanitized = sanitizeText(text, { markdown: true });
  sanitizedByMessage.set(message, { text, sanitized });
  return sanitized;
}

/**
 * Convert current live tool arguments to display text.
 * @param {object} content Tool-call content block.
 * @returns {string} Original string arguments or their JSON serialization.
 */
function toolArgsText(content) {
  if (typeof content.arguments === "string") return content.arguments;
  // Arguments objects are live too; identity alone cannot detect nested edits.
  return JSON.stringify(content.arguments ?? {});
}

/**
 * Append the displayable sections of an assistant message and register its
 * tool calls for later result placement.
 * @param {Array<object>} blocks Destination block array, mutated in place.
 * @param {Map<string, object>} calls Call-id lookup, mutated for tool calls.
 * @param {object} message Assistant message to project.
 * @param {number} index Message position used for block ownership and grouping.
 * @returns {void}
 */
function addAssistantBlocks(blocks, calls, message, index) {
  const group = `message:${index}`;
  const add = createBlockAdder(blocks);
  if (typeof message.draft === "string" && message.draft !== "") {
    add("draft", message.draft, "Assistant Draft", index, group, "Draft", "assistant");
  }
  (message.content ?? []).forEach((content, contentIndex) => {
    if (content?.type === ContentType.Thinking) add("thinking", content.text ?? "", undefined, index, group, "Thinking").contentIndex = contentIndex;
    if (content?.type === ContentType.Text) add("text", content.text ?? "", undefined, index, group, "Message", "assistant").contentIndex = contentIndex;
    if (content?.type === ContentType.ToolCall) addToolCall(blocks, calls, content, index);
  });
  if (message.display != null) add("display", contentText(message.display), "display", index, group, "Display", "assistant");
  // a failed response shows its error for as long as the message exists
  if (messageHasError(message)) add("error", messageErrorText(message), undefined, index, group, "Error", "assistant");
}

/**
 * Append a tool-call block and register its call ID for matching tool results.
 * @param {Array<object>} blocks Destination block array, mutated in place.
 * @param {Map<string, object>} calls Call-id lookup, mutated when an ID exists.
 * @param {object} content Tool-call content block.
 * @param {number} index Owning message index.
 * @returns {void}
 */
function addToolCall(blocks, calls, content, index) {
  const args = toolArgsText(content);
  const group = `call:${index}:${content.callId ?? blocks.length}`;
  const call = createBlockAdder(blocks)("toolcall", args, content.name, index, group, "Call", "tool");
  if (content.callId) {
    call.callId = content.callId;
    calls.set(content.callId, { group, call, message: index });
  }
}

/**
 * Create an appender that constructs normalized transcript blocks in `blocks`.
 * @param {Array<object>} blocks Destination block array, mutated by the appender.
 * @returns {Function} A function accepting type, text, optional label, message,
 *   group, section, and category; returns the appended block.
 */
function createBlockAdder(blocks) {
  return (type, text, label, message, group = `message:${message}`, section, category) => {
    const block = { type, text, ...(label ? { label } : {}), open: false, message, group, section, category: category ?? type };
    blocks.push(block);
    return block;
  };
}

/**
 * Append a sanitized tool result and any display payload, placing them directly
 * after their registered call when available.
 * @param {Array<object>} blocks Destination block array, mutated in place.
 * @param {Map<string, object>} calls Call-id lookup populated by assistant calls.
 * @param {object} message Tool-result message to project.
 * @param {number} index Tool-result message index, used when no call matches.
 * @returns {void}
 */
function addToolResult(blocks, calls, message, index, attached) {
  const call = calls.get(message.callId);
  const group = call?.group ?? `message:${index}`;
  const owner = call?.message ?? index;
  const result = {
    type: message.error ? "toolerror" : "toolresult",
    // Untrusted tool output is display-sanitized at this render boundary
    // (SGR emphasis → Markdown); the persisted message stays byte-exact.
    text: sanitizedText(message),
    ...(message.name ? { label: message.name } : {}),
    open: false,
    message: owner,
    sourceMessage: index,
    group,
    section: "Result",
    category: "tool",
  };
  const displays = message.display == null ? [] : [{
    type: "display", text: contentText(message.display), label: message.name ?? call?.call?.label ?? "display", open: false, message: owner, sourceMessage: index, group, section: "Display", category: "tool",
  }];
  if (!call) {
    blocks.push(result, ...displays);
    return;
  }
  const parts = attached.get(call.call) ?? [];
  parts.push([result, ...displays]);
  attached.set(call.call, parts);
}

/**
 * Ephemeral output from a running tool. This deliberately is not Context:
 * the Agent owns the final persisted tool result, while the TUI owns this
 * read-along projection and removes it as soon as that result arrives.
 * One block per call preserves distinct concurrent tools and gives the
 * transcript projector a stable open tool-result-shaped item.
 * @param {Array<{callId?: string, tool?: string, text?: string}>} [stream=[]] Ordered streamed tool-output entries; repeated call IDs are grouped.
 * @param {number} [message=Number.MAX_SAFE_INTEGER] Message index assigned to each generated block.
 * @returns {Array<object>} Sanitized, open tool-result-shaped blocks, one per call ID.
 */
export function toolStreamBlocks(stream = [], message = Number.MAX_SAFE_INTEGER) {
  const calls = new Map();
  for (const entry of stream) {
    const callId = String(entry?.callId ?? entry?.tool ?? "tool");
    const current = calls.get(callId) ?? { callId, tool: entry?.tool ?? "tool", lines: [] };
    current.lines.push(String(entry?.text ?? ""));
    calls.set(callId, current);
  }
  return [...calls.values()].map(({ callId, tool, lines }) => ({
    type: "toolresult", text: sanitizeText(lines.join("\n"), { markdown: true }), label: tool, open: true, callId,
    message, group: `stream:${callId}`, section: "Stream", category: "tool", ordinal: 0,
  }));
}

/**
 * Annotate blocks in multi-block groups with message/part numbers and assign
 * per-group, per-section ordinals. Mutates the supplied blocks.
 * @param {Array<object>} blocks Blocks to number in their existing order.
 * @returns {void}
 */
function numberMultipartGroups(blocks) {
  const groups = new Map();
  for (const block of blocks) {
    const section = block.section ?? block.type;
    let state = groups.get(block.group);
    if (!state) {
      state = { count: 1, section, ordinal: 1, otherSection: null, otherOrdinal: 0, sections: null, part: 0 };
      groups.set(block.group, state);
      block.ordinal = 0;
    } else {
      state.count++;
      if (state.sections) {
        block.ordinal = state.sections.get(section) ?? 0;
        state.sections.set(section, block.ordinal + 1);
      } else if (state.section === section) {
        block.ordinal = state.ordinal++;
      } else if (state.otherSection === section) {
        block.ordinal = state.otherOrdinal++;
      } else if (state.otherSection === null) {
        // Most tool groups are exactly Call + Result: avoid a per-group map.
        state.otherSection = section;
        state.otherOrdinal = 1;
        block.ordinal = 0;
      } else {
        state.sections = new Map([[state.section, state.ordinal], [state.otherSection, state.otherOrdinal], [section, 1]]);
        block.ordinal = 0;
      }
    }
  }
  for (const block of blocks) {
    const state = groups.get(block.group);
    if (state.count <= 1) continue;
    block.messageNumber = block.message + 1;
    block.messagePart = ++state.part;
  }
}

/**
 * Project context messages into semantic transcript blocks. Tool results stay
 * adjacent to their calls; live assistant blocks and streamed tool blocks are
 * marked open for read-along display. The input context/messages are not mutated.
 * @param {Array<object>} context Ordered context messages.
 * @param {object|null} [live=null] Optional live assistant message, included when it has content.
 * @param {Array<{callId?: string, tool?: string, text?: string}>} [stream=[]] Streamed tool-output entries grouped by call ID.
 * @returns {Array<object>} Ordered blocks with grouping and multipart metadata.
 * @throws {TypeError} If context is not an array or inputs contain values incompatible with their required operations.
 */
export function contextBlocks(context, live = null, stream = []) {
  const blocks = [];
  const calls = new Map();
  const attached = new Map();
  const add = createBlockAdder(blocks);
  context.forEach((message, index) => {
    if (message?.type === MessageType.System || message?.type === MessageType.User) {
      const block = add(message.type === MessageType.System ? "system" : "user", fullText(message), undefined, index);
      if (message.content?.length === 1 && [ContentType.Text, ContentType.Thinking].includes(message.content[0]?.type)) block.contentIndex = 0;
    }
    if (message?.type === MessageType.Assistant) addAssistantBlocks(blocks, calls, message, index);
    if (message?.type === MessageType.ToolResult) addToolResult(blocks, calls, message, index, attached);
  });
  if (live && (live.content?.length ?? 0) > 0) {
    const before = blocks.length;
    addAssistantBlocks(blocks, calls, live, context.length);
    for (let index = before; index < blocks.length; index++) blocks[index].open = true;
  }
  for (const streamed of toolStreamBlocks(stream, context.length)) {
    const call = calls.get(streamed.callId)?.call;
    if (call) {
      const parts = attached.get(call) ?? [];
      parts.push([streamed]);
      attached.set(call, parts);
    } else blocks.push(streamed);
  }
  // Match the old insert-after-call order without repeated history scans/shifts:
  // newer results/streams precede earlier ones attached to the same call.
  const ordered = [];
  for (const block of blocks) {
    ordered.push(block);
    const parts = attached.get(block);
    if (parts) for (let index = parts.length - 1; index >= 0; index--) ordered.push(...parts[index]);
  }
  numberMultipartGroups(ordered);
  return ordered;
}
