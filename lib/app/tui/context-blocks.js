/** Terminal-neutral context-to-block projection for transcript viewers and raw copy.
 *  Called once per rendered frame, so text extraction is memoized per
 *  message identity: a stored message's content array is only ever
 *  REPLACED (merge/edit), never mutated in place, so identity of the
 *  message + its content array is a sound cache key and steady frames
 *  never re-join/re-serialize megabytes of history. */

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
 * Read a message's textual content, reusing its cached extraction while its
 * content-array identity is unchanged.
 * @param {object|null|undefined} message Message whose content to extract.
 * @returns {string} Extracted text; non-object messages are not cached.
 */
function fullText(message) {
  const cached = textByMessage.get(message);
  if (cached?.content === message?.content) return cached.text;
  const text = contentText(message?.content);
  if (message !== null && typeof message === "object") textByMessage.set(message, { content: message.content, text });
  return text;
}

/** The full-text memo, keyed by message identity (see the header). */
const textByMessage = new WeakMap();

/** A tool call's display arguments, memoized per content-block identity
 *  (same mutation argument as fullText; stringifies once per block). */
const argsByContent = new WeakMap();
/**
 * Convert tool arguments to display text, memoizing serialization by block
 * identity and argument identity.
 * @param {object} content Tool-call content block.
 * @returns {string} Original string arguments or their JSON serialization.
 */
function toolArgsText(content) {
  if (typeof content.arguments === "string") return content.arguments;
  const cached = argsByContent.get(content);
  if (cached?.args === content.arguments) return cached.text;
  const text = JSON.stringify(content.arguments ?? {});
  argsByContent.set(content, { args: content.arguments, text });
  return text;
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
    if (content?.type === ContentType.Text) add("text", content.text ?? "", undefined, index, group, "Message", "assistant");
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
function addToolResult(blocks, calls, message, index) {
  const call = calls.get(message.callId);
  const group = call?.group ?? `message:${index}`;
  const owner = call?.message ?? index;
  const result = {
    type: message.error ? "toolerror" : "toolresult",
    // Untrusted tool output is display-sanitized at this render boundary
    // (SGR emphasis → Markdown); the persisted message stays byte-exact.
    text: sanitizeText(fullText(message), { markdown: true }),
    ...(message.name ? { label: message.name } : {}),
    open: false,
    message: owner,
    group,
    section: "Result",
    category: "tool",
  };
  const displays = message.display == null ? [] : [{
    type: "display", text: contentText(message.display), label: message.name ?? call?.call?.label ?? "display", open: false, message: owner, group, section: "Display", category: "tool",
  }];
  if (!call) {
    blocks.push(result, ...displays);
    return;
  }
  blocks.splice(blocks.lastIndexOf(call.call) + 1, 0, result, ...displays);
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
  const counts = new Map();
  const parts = new Map();
  const ordinals = new Map();
  for (const block of blocks) {
    counts.set(block.group, (counts.get(block.group) ?? 0) + 1);
    const ordinalKey = `${block.group}:${block.section ?? block.type}`;
    block.ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, block.ordinal + 1);
  }
  for (const block of blocks) {
    if (counts.get(block.group) <= 1) continue;
    const part = (parts.get(block.group) ?? 0) + 1;
    parts.set(block.group, part);
    block.messageNumber = block.message + 1;
    block.messagePart = part;
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
  const add = createBlockAdder(blocks);
  context.forEach((message, index) => {
    if (message?.type === MessageType.System) add("system", fullText(message), undefined, index);
    if (message?.type === MessageType.User) add("user", fullText(message), undefined, index);
    if (message?.type === MessageType.Assistant) addAssistantBlocks(blocks, calls, message, index);
    if (message?.type === MessageType.ToolResult) addToolResult(blocks, calls, message, index);
  });
  if (live && (live.content?.length ?? 0) > 0) {
    const before = blocks.length;
    addAssistantBlocks(blocks, calls, live, context.length);
    for (let index = before; index < blocks.length; index++) blocks[index].open = true;
  }
  for (const streamed of toolStreamBlocks(stream, context.length)) {
    const call = calls.get(streamed.callId)?.call;
    if (call) blocks.splice(blocks.lastIndexOf(call) + 1, 0, streamed);
    else blocks.push(streamed);
  }
  numberMultipartGroups(blocks);
  return blocks;
}
