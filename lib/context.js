/**
 * lib/context.js — Context: the shared conversation data model.
 *
 * PUBLIC MODULE (owner of lib/context/). At the bottom of the
 * dependency chain, it imports no other public module; Env, IO, Agent,
 * CLI, and TUI depend on it, never the reverse. Private helpers live
 * in lib/context/; consumers use this façade's named exports or the
 * Context class (instances are stateful contexts; statics are the data model).
 */

import { Context } from "./context/store.js";
import {
  MessageType, ContentType, textContent, userMessage, systemMessage, assistantMessage, mimetypeOf,
} from "./context/types.js";
import { MIME_BY_EXTENSION, detectMime, binaryContent, fileMessage } from "./context/mime.js";
import { isMessage, isRecord, isContext, hasContent, hasError, errorText, validateMessage, validateContext } from "./context/validate.js";
import {
  EventType, callbackName, isResponseEvent, validateResponseEvent, normalizeCallbacks, dispatch,
} from "./context/events.js";
import { parseContext } from "./context/parse.js";
import { createAssembler, assemblyCallbacks, contentIndexer } from "./context/assemble.js";
import { appendMessage } from "./context/merge.js";
import { rebuildMessage } from "./context/edit.js";
import {
  TOKENS_PER_WORD, wordCount, estimateTokens, estimateContextTokens, estimateUsage, finalizeUsage, usageSummary,
  FALLBACK_CONTEXT_WINDOWS, fallbackContextWindow,
} from "./context/usage.js";

// Names read noun-first so related helpers sort together: message*,
// messages* (a message array), content*, event*, callbacks*, assembler*,
// mime*, tokens*, usage*. Editing a message list is the Context
// instance's job (append/edit/rollback/…); the array editors stay private.
export { Context };
export {
  MessageType, ContentType, textContent as contentText, userMessage as messageUser,
  systemMessage as messageSystem, assistantMessage as messageAssistant, mimetypeOf as mimeOf,
} from "./context/types.js";
export {
  MIME_BY_EXTENSION, detectMime as mimeDetect, binaryContent as contentBinary, fileMessage as messageFile,
} from "./context/mime.js";
export {
  isMessage as messageValid, isRecord as messageIsRecord, isContext as messagesValid,
  hasContent as messageHasContent, hasError as messageHasError, errorText as messageErrorText, validateMessage as messageValidate,
  validateContext as messagesValidate,
} from "./context/validate.js";
export {
  EventType, callbackName as eventCallbackName, isResponseEvent as eventValid,
  validateResponseEvent as eventValidate, normalizeCallbacks as callbacksNormalize, dispatch as eventDispatch,
} from "./context/events.js";
export { parseContext as messagesParse } from "./context/parse.js";
export { createAssembler as assemblerCreate, assemblyCallbacks as assemblerCallbacks, contentIndexer } from "./context/assemble.js";
export { appendMessage as messageAppend } from "./context/merge.js";
export { rebuildMessage as messageRebuild } from "./context/edit.js";
export {
  TOKENS_PER_WORD, wordCount, estimateTokens as tokensEstimate, estimateContextTokens as tokensEstimateMessages,
  estimateUsage as usageEstimate, finalizeUsage as usageFinalize, usageSummary,
  FALLBACK_CONTEXT_WINDOWS, fallbackContextWindow,
} from "./context/usage.js";

Object.assign(Context, {
  MessageType, ContentType, EventType, MIME_BY_EXTENSION, TOKENS_PER_WORD,
  messageUser: userMessage, messageSystem: systemMessage, messageAssistant: assistantMessage, messageFile: fileMessage,
  contentText: textContent, contentBinary: binaryContent,
  messageValid: isMessage, messageValidate: validateMessage, messageIsRecord: isRecord, messageHasContent: hasContent,
  messageHasError: hasError, messageErrorText: errorText,
  messageRebuild: rebuildMessage, messageAppend: appendMessage,
  messagesValid: isContext, messagesValidate: validateContext, messagesParse: parseContext,
  eventValid: isResponseEvent, eventValidate: validateResponseEvent, eventCallbackName: callbackName, eventDispatch: dispatch,
  callbacksNormalize: normalizeCallbacks, assemblerCreate: createAssembler, assemblerCallbacks: assemblyCallbacks, contentIndexer,
  mimeDetect: detectMime, mimeOf: mimetypeOf,
  tokensEstimate: estimateTokens, tokensEstimateMessages: estimateContextTokens, wordCount,
  usageEstimate: estimateUsage, usageFinalize: finalizeUsage, usageSummary,
  FALLBACK_CONTEXT_WINDOWS, fallbackContextWindow,
});
export default Context;
