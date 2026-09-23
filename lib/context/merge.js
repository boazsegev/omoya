/**
 * lib/context/merge.js — append with MERGING.
 *
 * Core fields are the ONLY harness-owned fields: {type, content} on a
 * message, {type, text} on a text/thinking block. The harness never
 * adds metadata — so ANY further field is provider data (a replay
 * signature, a cache id): a provider-defined BORDER. Continuations
 * merge; bordered messages/blocks never do.
 */

import { isDeepStrictEqual } from "node:util";
import { MessageType, ContentType } from "./types.js";
import { isRecord, validateMessage, validateContext, hasContent } from "./validate.js";

const MESSAGE_CORE_FIELDS = new Set(["type", "content"]);
const BLOCK_CORE_FIELDS = new Set(["type", "text"]);
const hasOnlyCoreFields = (obj, core) => Object.keys(obj ?? {}).every((k) => core.has(k));

/**
 * Can two ADJACENT content blocks merge into one? Only same-sub-type
 * text-bearing blocks (text+text, thinking+thinking) with NO metadata
 * on either side — tool calls, images and binaries each carry their
 * own payload/linkage and never merge, and a block carrying provider
 * metadata is a border (the provider may need it back verbatim).
 */
function mergeableBlocks(a, b) {
  if (a?.type !== b?.type) return false;
  if (a?.type !== ContentType.Text && a?.type !== ContentType.Thinking) return false;
  return hasOnlyCoreFields(a, BLOCK_CORE_FIELDS) && hasOnlyCoreFields(b, BLOCK_CORE_FIELDS);
}

/** Join two block texts; a newline separates whole messages/fragments. */
function joinBlockText(a, b) {
  const ta = a ?? "";
  const tb = b ?? "";
  if (ta === "" || tb === "") return ta + tb;
  return ta.endsWith("\n") ? ta + tb : `${ta}\n${tb}`;
}

/**
 * Fold ADJACENT same-sub-type text/thinking blocks within one content
 * array (a stream with repeated indexes, or a cross-message merge,
 * can leave runs of them — one logical block should BE one block).
 * Returns a NEW array (blocks themselves are shared unless folded).
 * @param {Array} content
 * @returns {Array} folded content
 */
export function foldContent(content) {
  const out = [];
  for (const block of content ?? []) {
    const last = out[out.length - 1];
    if (mergeableBlocks(last, block)) {
      out[out.length - 1] = {
        ...block,
        type: last.type,
        text: joinBlockText(last.text, block.text),
      };
    } else {
      out.push(block);
    }
  }
  return out;
}

/**
 * Can two CONSECUTIVE messages merge into one? Same numeric type,
 * never a ToolResult (each result's callId/name/error linkage is its
 * own — merging would destroy call→answer addressing), and exactly
 * matching metadata. Metadata is a message boundary when it differs:
 * in particular, a `subtype: "chat"` message cannot merge with normal
 * user input. System, user and assistant continuations may merge only
 * when their non-message keys match.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function mergeableMessages(a, b) {
  if (a?.type !== b?.type || a?.type === MessageType.ToolResult) return false;
  const metadata = (message) => Object.fromEntries(
    Object.entries(message ?? {}).filter(([key]) => !MESSAGE_CORE_FIELDS.has(key)),
  );
  return isDeepStrictEqual(metadata(a), metadata(b));
}

/**
 * Append a message to a caller-owned context, MERGING when possible:
 * the message's own adjacent same-sub-type blocks fold first; when the
 * context's last message is mergeable with it (same type, no linkage),
 * their content concatenates (and re-folds) instead of appending a new
 * message. Consecutive same-type text messages — queued user input,
 * repeated /system, a cancel-partial assistant followed by the next
 * turn's — become ONE message, so the context (and every replay of
 * it) shows one merged block per sub-type, not a chain of fragments.
 * Mutates the array in place.
 * @param {Array} context - caller-owned array
 * @param {object} message
 * @param {{merge?: boolean}} [options] - set merge:false to preserve a message boundary
 * @returns {object} the stored message (the PREVIOUS one when merged)
 */
export function appendMessage(context, message, { merge = true } = {}) {
  validateContext(context);
  // a metadata RECORD (string `type`) passes through untouched — it
  // is harness/tool-owned data riding the context, never a message:
  // no validation, no folding, and it never merges (a record can only
  // ever be adjacent to a numeric-typed message, and mergeableMessages
  // requires equal types)
  if (isRecord(message)) {
    context.push(message);
    return message;
  }
  validateMessage(message);
  const folded = { ...message, content: foldContent(message.content) };
  const last = context[context.length - 1];
  // EMPTY-MESSAGE REFUSAL: a message with no consumable payload
  // (hasContent — empty content, or only payload-less blocks like a
  // text_start block that never produced a delta) can never enter
  // the context: chat-completions dialects serialize an empty
  // assistant message as `content: null` and providers 400 the whole
  // request over it. A MERGEABLE empty message (a pure continuation
  // — e.g. a cancel-partial that produced nothing, followed by the
  // next turn's first deltas) merges away silently into the previous
  // message, which keeps its own payload; an UNMERGEABLE one throws
  // — a caller pushing explicit emptiness is a bug worth surfacing,
  // never a silent drop.
  if (!hasContent(folded)) {
    if (merge && last !== undefined && mergeableMessages(last, folded)) return last;
    throw new TypeError("appendMessage: empty message — no provider dialect can carry contentless blocks");
  }
  if (merge && last !== undefined && mergeableMessages(last, folded)) {
    last.content = foldContent([...last.content, ...folded.content]);
    return last;
  }
  context.push(folded);
  return folded;
}
