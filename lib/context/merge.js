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
import { isRecord, validateMessage, validateContext, hasContent, hasError } from "./validate.js";

const MESSAGE_CORE_FIELDS = new Set(["type", "content"]);
const BLOCK_CORE_FIELDS = new Set(["type", "text"]);
/**
 * Check whether an object contains only keys from a supplied core-field set.
 * A nullish object is treated as empty.
 * @param {object|null|undefined} obj - Object to inspect; defaults effectively to an empty object when nullish.
 * @param {Set<string>} core - Allowed own enumerable string keys.
 * @returns {boolean} Whether every key on `obj` belongs to `core`.
 */
const hasOnlyCoreFields = (obj, core) => Object.keys(obj ?? {}).every(/*
  * Test whether an enumerable object key is in the allowed core set.
  * @param {string} k - Key to test.
  * @returns {boolean} Whether the key is allowed.
  */ (k) => core.has(k));

/**
 * Determine whether two adjacent content blocks can merge. Only same-subtype
 * text or thinking blocks with no provider metadata on either side merge; tool
 * calls, images, binaries, and provider-bordered blocks remain separate.
 * @param {object|null|undefined} a - First block; nullish blocks are not mergeable.
 * @param {object|null|undefined} b - Second block; nullish blocks are not mergeable.
 * @returns {boolean} Whether the blocks may be folded together.
 * @throws {TypeError} If field inspection fails, for example on a throwing proxy.
 */
function mergeableBlocks(a, b) {
  if (a?.type !== b?.type) return false;
  if (a?.type !== ContentType.Text && a?.type !== ContentType.Thinking) return false;
  return hasOnlyCoreFields(a, BLOCK_CORE_FIELDS) && hasOnlyCoreFields(b, BLOCK_CORE_FIELDS);
}

/**
 * Join two block text values, separating nonempty fragments with a blank line,
 * except when the first already ends with a newline. Nullish values count as
 * empty strings.
 * @param {string|null|undefined} a - First text fragment; nullish defaults to `""`.
 * @param {string|null|undefined} b - Second text fragment; nullish defaults to `""`.
 * @returns {string} The joined text.
 */
function joinBlockText(a, b) {
  const ta = a ?? "";
  const tb = b ?? "";
  if (ta === "" || tb === "") return ta + tb;
  return ta.endsWith("\n") ? ta + tb : `${ta}\n\n${tb}`;
}

/**
 * Fold ADJACENT same-sub-type text/thinking blocks within one content
 * array (a stream with repeated indexes, or a cross-message merge,
 * can leave runs of them — one logical block should BE one block).
 * Returns a NEW array (blocks themselves are shared unless folded).
 * @param {Array<object>|null|undefined} content - Blocks to fold; nullish defaults to an empty array.
 * @returns {Array<object>} A new array with mergeable adjacent blocks folded; unfurled blocks are shared with the input.
 * @throws {TypeError} If the input is not iterable or block inspection fails.
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
 * @param {object|null|undefined} a - First message; nullish values have no type or metadata.
 * @param {object|null|undefined} b - Second message; nullish values have no type or metadata.
 * @returns {boolean} Whether the messages have the same non-ToolResult type and identical metadata.
 * @throws {TypeError} If metadata enumeration or deep comparison fails, for example on a throwing proxy.
 */
export function mergeableMessages(a, b) {
  if (a?.type !== b?.type || a?.type === MessageType.ToolResult) return false;
  /**
   * Extract message keys other than the harness-owned core fields.
   * @param {object|null|undefined} message - Message to inspect; nullish defaults to an empty object.
   * @returns {object} The message's non-core enumerable own properties.
   */
  const metadata = (message) => Object.fromEntries(
    Object.entries(message ?? {}).filter(/*
      * Select entries whose keys are not harness-owned message fields.
      * @param {[string, unknown]} entry - Enumerable own key/value pair.
      * @returns {boolean} Whether the key is a metadata key.
      */ ([key]) => !MESSAGE_CORE_FIELDS.has(key)),
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
 * @param {Array<object>} context - Caller-owned context array, mutated in place.
 * @param {object} message - Message or metadata record to append.
 * @param {{merge?: boolean}} [options={}] - Options object; `merge` defaults to `true`. Set `merge: false` to preserve a message boundary.
 * @returns {object} The stored message (the previous message when merged, otherwise the appended value).
 * @throws {TypeError} If context/message validation fails, or if an unmergeable empty message has no content or error payload.
 * @throws {TypeError} If folding or merge comparisons fail during processing.
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
  // never a silent drop. A failed response (hasError) is kept even when
  // nothing arrived: its error is its payload (IO still drops every
  // contentless message from provider requests).
  if (!hasContent(folded) && !hasError(folded)) {
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
