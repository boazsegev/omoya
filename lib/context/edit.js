/**
 * lib/context/edit.js — array/block addressing and edit / rollback /
 * pop over the CALLER-OWNED array (mutated in place).
 *
 * Edit identifier cleanup (frozen Decisions): the edit path constructs a
 * new Message populated only from recognized schema fields, inherently
 * dropping stale provider response/cache identifiers without a maintained
 * strip-list. Recognized fields:
 *   message: type, content, plus tool-result linkage (callId, name, error)
 *     only when type is ToolResult
 *   block text/image/binary: their documented fields only
 *     (including the optional non-metadata `mimetype` field)
 *   block thinking/toolCall: documented fields PLUS extra metadata —
 *     that metadata is part of their schema (replay data) and is preserved
 *   unknown block types: shallow-copied through untouched (tolerant reader)
 * Callers may mutate the array directly to skip cleanup; harness code
 * always edits through Context. There is no provider-shape validation.
 */

import { MessageType, ContentType } from "./types.js";
import { validateMessage, validateContext, hasError } from "./validate.js";

/**
 * Return a validated message at an index in the context.
 * @param {Array} context - Context array to validate.
 * @param {number} i - Zero-based message index; must be an integer in range.
 * @returns {object} The validated message at `context[i]`.
 * @throws {TypeError|RangeError} If the context/message shape is invalid or the index is out of range.
 */
export function at(context, i) {
  validateContext(context);
  if (!Number.isInteger(i) || i < 0 || i >= context.length) {
    throw new RangeError(`context[${i}]: out of range`);
  }
  return validateMessage(context[i], `context[${i}]`);
}

/**
 * Return a content block from a validated message in the context.
 * @param {Array} context - Context array to validate.
 * @param {number} i - Zero-based message index.
 * @param {number} j - Zero-based content-block index.
 * @returns {object} The validated content block.
 * @throws {TypeError|RangeError} If the context/message shape or either index is invalid.
 */
export function blockAt(context, i, j) {
  const msg = at(context, i);
  if (!Number.isInteger(j) || j < 0 || j >= msg.content.length) {
    throw new RangeError(`context[${i}].content[${j}]: out of range`);
  }
  return msg.content[j];
}

const LINKAGE_FIELDS = ["callId", "name", "error"];
const ASSISTANT_DISPLAY_FIELDS = ["draft"];

/**
 * Rebuild a message from recognized schema fields only — the stale
 * provider/cache identifier cleanup. See the module header for the
 * field policy.
 * @param {object} msg - Message to validate and rebuild.
 * @returns {object} A new message containing recognized fields only.
 * @throws {TypeError} If the message is invalid.
 */
export function rebuildMessage(msg) {
  validateMessage(msg);
  const clean = { type: msg.type, content: msg.content.map(rebuildBlock) };
  if (msg.type === 4) {
    for (const field of LINKAGE_FIELDS) {
      if (msg[field] !== undefined) clean[field] = msg[field];
    }
  }
  if (msg.type === 3) {
    for (const field of ASSISTANT_DISPLAY_FIELDS) {
      if (typeof msg[field] === "string" && msg[field] !== "") clean[field] = msg[field];
    }
  }
  return clean;
}

/**
 * Rebuild one content block per the module-header field policy.
 * @param {*} block - Content block to rebuild; unknown object types are shallow-copied.
 * @returns {object} A new block object.
 * @throws {TypeError} If block is null, an array, or not an object.
 */
export function rebuildBlock(block) {
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new TypeError(`content block: expected an object, got ${block}`);
  }
  switch (block.type) {
    case ContentType.Text:
      return { type: ContentType.Text, text: block.text };
    case ContentType.Image:
      return {
        type: ContentType.Image,
        ...(block.mimetype !== undefined ? { mimetype: block.mimetype } : {}),
        ...(block.mime !== undefined ? { mime: block.mime } : {}),
        content: block.content,
      };
    case ContentType.Binary:
      return {
        type: ContentType.Binary,
        ...(block.mimetype !== undefined ? { mimetype: block.mimetype } : {}),
        ...(block.mime !== undefined ? { mime: block.mime } : {}),
        ...(block.filename !== undefined ? { filename: block.filename } : {}),
        content: block.content,
      };
    case ContentType.Thinking:
      return { ...block, type: ContentType.Thinking, text: block.text };
    case ContentType.ToolCall:
      return {
        ...block,
        type: ContentType.ToolCall,
        callId: block.callId,
        name: block.name,
        arguments: block.arguments,
      };
    default:
      return { ...block }; // tolerant reader: unknown blocks pass through
  }
}

/**
 * Replace context[i] with an edited message, rebuilt from recognized
 * fields (stale provider/cache identifiers dropped). Mutates in place.
 * @param {Array} context - Caller-owned context array, mutated in place.
 * @param {number} i - Zero-based existing message index.
 * @param {object} newMessage - Replacement message to validate and rebuild.
 * @returns {object} The stored rebuilt message.
 * @throws {TypeError|RangeError} If the context, index, or replacement message is invalid.
 */
export function editMessage(context, i, newMessage) {
  at(context, i); // validates context + index
  const clean = rebuildMessage(newMessage);
  context[i] = clean;
  return clean;
}

/**
 * Replace context[i].content[j] with an edited block. The containing
 * message is rebuilt as well (stale message-level identifiers dropped);
 * other blocks are preserved through block rebuild.
 * @param {Array} context - Caller-owned context array, mutated in place.
 * @param {number} i - Zero-based existing message index.
 * @param {number} j - Zero-based existing content-block index.
 * @param {object} newBlock - Replacement block, validated while rebuilding the containing message.
 * @returns {object} The stored rebuilt block.
 * @throws {TypeError|RangeError} If the context/index or rebuilt message is invalid.
 */
export function editBlock(context, i, j, newBlock) {
  const msg = at(context, i);
  if (!Number.isInteger(j) || j < 0 || j >= msg.content.length) {
    throw new RangeError(`context[${i}].content[${j}]: out of range`);
  }
  const edited = { ...msg, content: msg.content.slice() };
  edited.content[j] = newBlock;
  const clean = rebuildMessage(edited);
  context[i] = clean;
  return clean.content[j];
}

/**
 * Roll back to index i: remove messages at index >= i. Mutates in place.
 * Valid targets are exactly the existing indexes 0..length-1 — passing
 * the count is out of range (never a silent no-op).
 * @param {Array} context - Caller-owned context array, mutated in place.
 * @param {number} i - Zero-based existing message index; the context length is not a valid target.
 * @returns {Array} Messages removed from index `i` through the end, in source order.
 * @throws {TypeError|RangeError} If the context is invalid or `i` is not an existing integer index.
 */
export function rollbackTo(context, i) {
  validateContext(context);
  if (!Number.isInteger(i) || i < 0 || i >= context.length) {
    throw new RangeError(
      context.length === 0
        ? "rollbackTo: the context is empty"
        : `rollbackTo: index ${i} out of range (valid: 0..${context.length - 1})`,
    );
  }
  return context.splice(i);
}

/**
 * Remove and return the last message. Mutates in place.
 * @param {Array} context - Caller-owned context array, mutated in place.
 * @returns {object|undefined} The former last message, or `undefined` when empty.
 * @throws {TypeError} If the context is invalid.
 */
export function pop(context) {
  validateContext(context);
  return context.pop();
}

/**
 * Remove and return a trailing FAILED RESPONSE — the last message, when it
 * is an assistant message carrying an error (validate.js hasError). Only
 * that one message goes; anything else leaves the context untouched.
 * @param {Array} context - Caller-owned context array, mutated only when the final message qualifies.
 * @returns {object|undefined} The removed failed assistant response, or `undefined` when none qualifies.
 * @throws {TypeError} If the context is invalid.
 */
export function popError(context) {
  validateContext(context);
  const last = context.at(-1);
  return last?.type === MessageType.Assistant && hasError(last) ? context.pop() : undefined;
}

/**
 * Remove selected messages and return them in their original source order.
 * Indexes are validated before mutation; duplicate indexes are treated once.
 * @param {Array} context - Caller-owned context array, mutated in place.
 * @param {Array<number>} indexes - Non-empty list of existing integer message indexes.
 * @returns {Array<object>} Removed messages in ascending original-index order.
 * @throws {TypeError|RangeError} If the index list is empty or not an array, or an index is invalid/out of range.
 */
export function removeMessages(context, indexes) {
  validateContext(context);
  if (!Array.isArray(indexes) || indexes.length === 0) throw new TypeError("removeMessages: indexes must be non-empty");
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  for (const index of unique) at(context, index);
  const removed = unique.map((index) => context[index]);
  for (const index of unique.toReversed()) context.splice(index, 1);
  return removed;
}
