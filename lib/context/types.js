/**
 * lib/types.js — context/message/content types (concrete JSDoc).
 *
 * Own schema, no external dependency (Pi/OpenCode are prior art only).
 * A context is an ordered array of messages. Every message has a numeric
 * `type` and a `content` array; all other fields are optional metadata,
 * tolerated by readers (unknown fields never invalidate a value).
 *
 * Addressing is array/block based — messages have no local ids:
 *   message = context[i];  block = context[i].content[j]
 * Provider response/cache/block identifiers may ride as optional metadata
 * and are dropped by Context when an edit makes them stale.
 */

/** Numeric message types. 0 is reserved. */
export const MessageType = Object.freeze({
  Reserved: 0,
  System: 1,
  User: 2,
  Assistant: 3,
  ToolResult: 4,
});

/** Content block discriminators. */
export const ContentType = Object.freeze({
  Text: "text",
  Image: "image",
  Binary: "binary",
  Thinking: "thinking",
  ToolCall: "toolCall",
});

/** Return a content block's canonical media type. */
export function mimetypeOf(block) {
  return typeof block?.mimetype === "string" && block.mimetype !== ""
    ? block.mimetype
    : typeof block?.mime === "string" && block.mime !== "" ? block.mime : undefined;
}

/**
 * @typedef {Object} TextContent
 * @property {"text"} type
 * @property {string} text
 * @description Plain text — the universal block every provider speaks.
 */

/**
 * @typedef {Object} ImageContent
 * @property {"image"} type
 * @property {string} [mimetype] - media type, when known
 * @property {string} content
 */

/**
 * @typedef {Object} BinaryContent
 * @property {"binary"} type
 * @property {string} [mimetype] - media type (application/octet-stream fallback)
 * @property {string} [filename] - safe display/upload basename; never a source path
 * @property {string} content - base64-encoded bytes
 * @description Raw file bytes for models that accept binary input
 *   (vision models fail on base64 *text* but consume binary blocks).
 *   Providers map image/* blocks to their binary/image channels and
 *   tolerate the rest.
 */

/**
 * @typedef {Object} ThinkingContent
 * @property {"thinking"} type
 * @property {string} text
 * @description May carry provider metadata (e.g. replay signatures)
 *   as extra fields; preserved through Context edits.
 */

/**
 * @typedef {Object} ToolCallContent
 * @property {"toolCall"} type
 * @property {string} callId - provider call id
 * @property {string} name - flattened tool name
 * @property {*} arguments - tool arguments (string while streaming, parsed value after)
 * @description May carry provider metadata as extra fields; preserved
 *   through Context edits.
 */

/**
 * @typedef {TextContent|ImageContent|BinaryContent|ThinkingContent|ToolCallContent|Object} Content
 * @description Small discriminated objects keyed by `type`. Unknown block
 *   types are tolerated (tolerant reader).
 */

/**
 * @typedef {Object} Message
 * @property {number} type - one of MessageType (1..4)
 * @property {Content[]} content
 * @description System messages stay visible in ordered position.
 *   Assistant content is an ordered mix of text/thinking/toolCall blocks —
 *   thinking is a block, never a separate message.
 */

/**
 * @typedef {Object} ToolResultMessage
 * @property {4} type
 * @property {Content[]} content - result content
 * @property {string} callId - links to the ToolCallContent.callId
 * @property {string} [name] - tool name, when the provider requires it
 * @property {boolean} [error] - error status
 * @description A tool's answer, linked to its call; built by
 *   resultContent() (see the Tool schema contract).
 */

/** @typedef {Message[]} Context
 *  @description An ordered array of messages — the schema everyone talks. */

/** Wrap plain text in a text content block. @returns {TextContent} */
export function textContent(text) {
  return { type: ContentType.Text, text: String(text) };
}

/** @returns {Message} user message wrapping text or preserving ordered blocks */
export function userMessage(text, metadata = undefined) {
  const message = { type: MessageType.User, content: Array.isArray(text) ? text : [textContent(text)] };
  return metadata === undefined ? message : { ...message, ...metadata };
}

/** @returns {Message} system message wrapping plain text */
export function systemMessage(text) {
  return { type: MessageType.System, content: [textContent(text)] };
}

/** @returns {Message} assistant message from content blocks */
export function assistantMessage(content = []) {
  return { type: MessageType.Assistant, content };
}
