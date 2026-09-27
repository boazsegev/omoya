/** Canonical numeric Agent event vocabulary. Values are dense array indexes. */
export const EVENT = Object.freeze({
  REQUEST_START: 0,
  TEXT_START: 1,
  TEXT_DELTA: 2,
  TEXT_END: 3,
  THINKING_START: 4,
  THINKING_DELTA: 5,
  THINKING_END: 6,
  TOOL_CALL_START: 7,
  TOOL_CALL_DELTA: 8,
  TOOL_CALL_END: 9,
  REQUEST_DONE: 10,
  REQUEST_ERROR: 11,
  MESSAGE_COMMITTED: 12,
  LOG: 13,
  TOOL_EXECUTE: 14,
  TOOL_DATA: 15,
  TOOL_RESULT: 16,
  CLOSE_MARKED: 17,
  CLOSED: 18,
  SENT_MESSAGE: 19,
  THROTTLED: 20,
});

/** IO callback property paired directly with its numeric Agent event. */
export const RESPONSE_CALLBACK_EVENTS = Object.freeze([
  ["onStart", EVENT.REQUEST_START],
  ["onTextStart", EVENT.TEXT_START],
  ["onTextDelta", EVENT.TEXT_DELTA],
  ["onTextEnd", EVENT.TEXT_END],
  ["onThinkingStart", EVENT.THINKING_START],
  ["onThinkingDelta", EVENT.THINKING_DELTA],
  ["onThinkingEnd", EVENT.THINKING_END],
  ["onToolCallStart", EVENT.TOOL_CALL_START],
  ["onToolCallDelta", EVENT.TOOL_CALL_DELTA],
  ["onToolCallEnd", EVENT.TOOL_CALL_END],
  ["onDone", EVENT.REQUEST_DONE],
  ["onError", EVENT.REQUEST_ERROR],
]);

export const EVENT_COUNT = Object.keys(EVENT).length;
