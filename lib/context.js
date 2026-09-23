/**
 * lib/context.js — Context: the shared conversation data model.
 *
 * PUBLIC MODULE (owner of lib/context/). At the bottom of the
 * dependency chain, it imports no other public module; Env, IO, Agent,
 * CLI, and TUI depend on it, never the reverse. Private helpers live
 * in lib/context/; consumers use this façade's named exports or its
 * static Context namespace.
 */

import * as Types from "./context/types.js";
import * as Mime from "./context/mime.js";
import * as Validate from "./context/validate.js";
import * as Events from "./context/events.js";
import * as Parse from "./context/parse.js";
import * as Assemble from "./context/assemble.js";
import * as Merge from "./context/merge.js";
import * as Edit from "./context/edit.js";
import * as Usage from "./context/usage.js";

const {
  MessageType, ContentType, textContent, userMessage, systemMessage, assistantMessage,
  mimetypeOf,
} = Types;
const { MIME_BY_EXTENSION, detectMime, binaryContent, fileMessage } = Mime;
const { isMessage, isRecord, isContext, hasContent, validateMessage, validateContext } = Validate;
const {
  EventType, callbackName, isResponseEvent, validateResponseEvent, normalizeCallbacks, dispatch,
} = Events;
const { parseContext } = Parse;
const { createAssembler, assemblyCallbacks } = Assemble;
const { foldContent, mergeableMessages, appendMessage } = Merge;
const {
  at, blockAt, rebuildMessage, rebuildBlock, editMessage, editBlock, rollbackTo, pop, removeMessages,
} = Edit;
const {
  TOKENS_PER_WORD, wordCount, estimateTokens, estimateContextTokens, estimateUsage,
  finalizeUsage, usageSummary,
} = Usage;

export {
  MessageType, ContentType, textContent, userMessage, systemMessage, assistantMessage,
  mimetypeOf,
} from "./context/types.js";
export { MIME_BY_EXTENSION, detectMime, binaryContent, fileMessage } from "./context/mime.js";
export { isMessage, isRecord, isContext, hasContent, validateMessage, validateContext } from "./context/validate.js";
export {
  EventType, callbackName, isResponseEvent, validateResponseEvent, normalizeCallbacks, dispatch,
} from "./context/events.js";
export { parseContext } from "./context/parse.js";
export { createAssembler, assemblyCallbacks } from "./context/assemble.js";
export { foldContent, mergeableMessages, appendMessage } from "./context/merge.js";
export {
  at, blockAt, rebuildMessage, rebuildBlock, editMessage, editBlock, rollbackTo, pop, removeMessages,
} from "./context/edit.js";
export {
  TOKENS_PER_WORD, wordCount, estimateTokens, estimateContextTokens, estimateUsage,
  finalizeUsage, usageSummary,
} from "./context/usage.js";

/** Parse a buffered input string (such as CLI input after EOF) into a context array. */
export function parseInput(input) {
  return parseContext(input);
}

/** Canonical context module namespace; its API is exposed as static members. */
export class Context {}
Object.assign(Context, {
  MessageType, ContentType, textContent, userMessage, systemMessage, assistantMessage,
  mimetypeOf, MIME_BY_EXTENSION, detectMime, binaryContent, fileMessage,
  isMessage, isRecord, isContext, hasContent, validateMessage, validateContext,
  EventType, callbackName, isResponseEvent, validateResponseEvent, normalizeCallbacks, dispatch,
  parseContext, parseInput, createAssembler, assemblyCallbacks,
  foldContent, mergeableMessages, appendMessage,
  at, blockAt, rebuildMessage, rebuildBlock, editMessage, editBlock, rollbackTo, pop, removeMessages,
  TOKENS_PER_WORD, wordCount, estimateTokens, estimateContextTokens, estimateUsage,
  finalizeUsage, usageSummary,
});
export default Context;
