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

import { ContentType } from "./types.js";
import { validateMessage, validateContext } from "./validate.js";

/**
 * Address a message: context[i], validated (throws on a bad integer index or shape).
 * @param {Array} context
 * @param {number} i
 * @returns {object} context[i], validated
 */
export function at(context, i) {
  validateContext(context);
  if (!Number.isInteger(i) || i < 0 || i >= context.length) {
    throw new RangeError(`context[${i}]: out of range`);
  }
  return validateMessage(context[i], `context[${i}]`);
}

/**
 * Address a content block: context[i].content[j], validated (RangeError
 * when j is out of range).
 * @param {Array} context
 * @param {number} i
 * @param {number} j
 * @returns {object} context[i].content[j], validated
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
 * @param {object} msg
 * @returns {object} a NEW message object
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
 * @param {*} block
 * @returns {object} a NEW block object
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
 * @param {Array} context - caller-owned array
 * @param {number} i - message index
 * @param {object} newMessage - the edited message
 * @returns {object} the stored (rebuilt) message
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
 * @param {Array} context
 * @param {number} i
 * @param {number} j
 * @param {object} newBlock
 * @returns {object} the stored (rebuilt) block
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
 * @param {Array} context
 * @param {number} i
 * @returns {Array} the removed messages
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
 * @param {Array} context
 * @returns {object|undefined} the removed message
 */
export function pop(context) {
  validateContext(context);
  return context.pop();
}

/** Remove selected message indexes and return them in source order. */
export function removeMessages(context, indexes) {
  validateContext(context);
  if (!Array.isArray(indexes) || indexes.length === 0) throw new TypeError("removeMessages: indexes must be non-empty");
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  for (const index of unique) at(context, index);
  const removed = unique.map((index) => context[index]);
  for (const index of unique.toReversed()) context.splice(index, 1);
  return removed;
}
