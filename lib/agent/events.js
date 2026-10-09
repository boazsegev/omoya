/** Agent event keys are distinct opaque Symbols, independent of callback handles. */
export const EVENT = Object.freeze(Object.fromEntries([
  "REQUEST_START", "TEXT_START", "TEXT_DELTA", "TEXT_END",
  "THINKING_START", "THINKING_DELTA", "THINKING_END",
  "TOOL_CALL_START", "TOOL_CALL_DELTA", "TOOL_CALL_END",
  "REQUEST_DONE", "REQUEST_ERROR", "MESSAGE_COMMITTED", "LOG",
  "TOOL_EXECUTE", "TOOL_DATA", "TOOL_RESULT", "CLOSE_MARKED",
  "CLOSED", "SENT_MESSAGE", "THROTTLED",
].map((name) => [name, Symbol(name)])));

/** IO callback property paired directly with its Agent event. */
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
