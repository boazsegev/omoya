/** Context-viewer actions. Presentation is pure; only the explicit apply functions mutate Context. */
import { ContentType, MessageType } from "../../context.js";
import { createForm } from "./form.js";
import { openMenu } from "./overlay-controller.js";

const MESSAGE_TYPES = new Set(Object.values(MessageType).filter((type) => type !== MessageType.Reserved));
const RESULT_TYPES = new Set(["toolresult", "toolerror"]);

function idleReason(agent) {
  if (!agent?.context) return "Agent is unavailable.";
  if (agent.closed || agent.closeMarked || agent.env?.closed) return "Agent is closed or closing.";
  if (agent.busy) return "Agent is busy; wait until it is idle.";
  return undefined;
}

function idleRequire(agent) {
  const reason = idleReason(agent);
  if (reason) throw new Error(reason);
}

function messageAt(agent, index) {
  const context = agent?.context;
  if (!Number.isInteger(index) || index < 0 || index >= (context?.length ?? 0)) {
    throw new RangeError("Choose an existing, non-virtual context message index.");
  }
  const message = context.at(index);
  if (!message || !MESSAGE_TYPES.has(message.type) || message.virtual || message.open) {
    throw new Error("Only persisted, non-virtual context messages can be changed.");
  }
  return message;
}

function textEditable(block) {
  return block && !block.virtual && !block.open
    && (block.type === ContentType.Text || block.type === ContentType.Thinking)
    && typeof block.text === "string";
}

/** Resolve message metadata, never the viewer's sourceIndex (which is a display-block ordinal). */
function sourceTarget(agent, block) {
  if (!block) throw new Error("No context block is selected.");
  if (block.virtual) throw new Error("Virtual blocks are not persisted context messages.");
  if (block.open) throw new Error("Open blocks are still being generated.");
  // Results/displays may be grouped under their tool CALL's message. Only
  // explicit source-message metadata can override that presentation ownership.
  const source = block.sourceMessage ?? block.resultMessage ?? block.sourceMessageIndex;
  if (block.type === "display" && block.category === "tool" && source === undefined) {
    throw new Error("This tool display block has no persisted source-message index.");
  }
  const index = source ?? block.message;
  const message = messageAt(agent, index);
  if (RESULT_TYPES.has(block.type) && message.type !== MessageType.ToolResult) {
    throw new Error("The tool result's persisted source message is unavailable.");
  }
  return { index, message };
}

/** Select only a proven source block, not a flattened/sanitized display payload. */
function editTarget(block, target) {
  const { message } = target;
  let blockIndex = block.contentIndex;
  if (block.type === "text" || block.type === "thinking") {
    if (message.type !== MessageType.Assistant || !Number.isInteger(blockIndex)) {
      throw new Error("The assistant text block has no persisted content index.");
    }
    if (message.content?.[blockIndex]?.type !== block.type) throw new Error("The selected text block has changed; refresh the viewer.");
  } else if (block.type === "user" || block.type === "system") {
    const expectedType = block.type === "user" ? MessageType.User : MessageType.System;
    if (message.type !== expectedType) throw new Error("The selected message has changed; refresh the viewer.");
    if (blockIndex === undefined) {
      const texts = (message.content ?? []).map((content, index) => ({ content, index }))
        .filter(({ content }) => textEditable(content));
      if (texts.length !== 1) throw new Error("This message contains multiple or no text blocks; choose a specific content block to edit.");
      blockIndex = texts[0].index;
    }
  } else {
    throw new Error("Only persisted text/thinking blocks can be edited, not display or tool output.");
  }
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || !textEditable(message.content?.[blockIndex])) {
    throw new Error("The selected content block is not editable text/thinking.");
  }
  return { ...target, blockIndex };
}

function menuRow(label, value, reason) {
  return reason ? { kind: "info", label: `${label} — ${reason}`, note: reason }
    : { kind: "action", label, value };
}

/**
 * Build the selected viewer block's Actions menu; never mutates the Agent or viewer.
 * @param {object} agent Borrowed Agent, with public context/busy/closed/closeMarked APIs.
 * @param {object} block Borrowed projected block. Assistant edits require contentIndex;
 *   message actions use sourceMessage ?? message (legacy resultMessage/sourceMessageIndex
 *   metadata is also accepted). Tool-result targets must actually be ToolResult messages.
 *   sourceIndex is deliberately NOT a message index. Multi-text aggregates without contentIndex cannot edit.
 * @param {object} viewer Borrowed viewer restored by Back and carried by action descriptors.
 * @returns {object} New openMenu("Actions", ...) overlay. Copy remains available while busy,
 *   open or virtual; unavailable operations are informational rows with a reason. Fork's
 *   through is exclusive (source message index + 1); rollback removes the selected message onward.
 *   Edit descriptors retain the selected block; callers use sourceMessage ?? message and
 *   contentIndex for contextEditForm. Mutation descriptors capture expectedMessage for
 *   confirmation-time stale-target validation.
 * @throws {*} Unexpected errors from Agent/context getters propagate. Expected unavailable
 *   targets become informational rows; rebuilding the menu is safe.
 * @example contextActionMenu(agent, selectedBlock, viewer); // render; execute nothing
 */
export function contextActionMenu(agent, block, viewer) {
  const unavailable = idleReason(agent);
  let target;
  let reason = unavailable;
  if (!reason) {
    try { target = sourceTarget(agent, block); } catch (error) { reason = error.message; }
  }
  let editReason = reason;
  if (!editReason) {
    try { editTarget(block, target); } catch (error) { editReason = error.message; }
  }
  return openMenu("Actions", [
    menuRow("Copy", { type: "access.context.copy", agent, block, viewer }),
    menuRow("Edit text", { type: "access.context.edit", agent, block, viewer }, editReason),
    menuRow("Fork through here", { type: "access.context.fork", agent, through: target ? target.index + 1 : undefined, viewer }, reason),
    menuRow("Roll back", { type: "access.context.rollback", agent, index: target?.index, expectedMessage: target?.message, viewer }, reason),
    menuRow("Delete message", { type: "access.context.delete", agent, index: target?.index, expectedMessage: target?.message, viewer }, reason),
    menuRow("← back", { type: "access.context.back", viewer }),
  ]);
}

/**
 * Open a non-destructive text editor using actual Context content, not viewer text.
 * @param {object} agent Borrowed idle, open Agent.
 * @param {number} [index] Existing nonnegative message index; defaults to the last message.
 * @param {number} [blockIndex] Existing Text/Thinking content index; defaults to the first
 *   such block. Details visibly identify the single-block scope when other blocks exist.
 * @param {object} [back] Borrowed overlay restored on cancellation/success; never mutated.
 * @returns {object} New createForm state with one multiline text field and an
 *   access.context.save action capturing the actual message reference and original text.
 * @throws {Error|RangeError} Busy/closing/closed Agent, virtual/open message, invalid index,
 *   or non-text content. No mutation occurs; retry after waiting/choosing a valid target.
 * @example const form = contextEditForm(agent, 0, undefined, viewer); // cancellation is safe
 */
export function contextEditForm(agent, index, blockIndex, back) {
  idleRequire(agent);
  if (index === undefined) index = agent.context.length - 1;
  const message = messageAt(agent, index);
  if (!Array.isArray(message.content)) throw new Error("This message has no editable content blocks.");
  if (blockIndex === undefined) blockIndex = message.content.findIndex((content) => textEditable(content));
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || !textEditable(message.content[blockIndex])) {
    throw new Error("Choose a persisted text/thinking content block to edit.");
  }
  const original = message.content[blockIndex].text;
  return createForm({
    title: "Edit context message", back,
    details: `Message ${index}, content block ${blockIndex}.${message.content.length > 1 ? " Only this text block will change; other blocks and attachments are preserved." : " Context is unchanged until Save."}`,
    fields: [{ name: "text", label: "Message text", value: original, multiline: true }],
    action: { type: "access.context.save", agent, index, blockIndex, expectedMessage: message, expectedText: original, back },
  });
}

/**
 * Save exactly one content block and return the borrowed previous viewer/overlay.
 * @param {object} action Save descriptor from contextEditForm; captures message identity/text.
 * @param {{text:string}} values Submitted values, borrowed and never mutated; empty text is valid.
 * @returns {object|undefined} action.back after synchronous context.editBlock succeeds.
 * @throws {Error|TypeError|RangeError} Wrong action/values, busy or closed Agent, invalid/virtual
 *   target, or stale message/text. Failures leave context untouched; retain the parent's form
 *   and attach formErrors there (this helper never replaces form state or clears errors).
 *   Context.editBlock errors propagate. Retry only after correcting values or reopening a stale form.
 * @example const back = applyContextSave(form.action, { text: "Updated" });
 * @example try { applyContextSave(form.action, values); } catch (error) { /* parent uses formErrors *\/ }
 */
export function applyContextSave(action, values) {
  if (action?.type !== "access.context.save") throw new TypeError("Expected a context save action.");
  idleRequire(action.agent);
  const message = messageAt(action.agent, action.index);
  if (message !== action.expectedMessage) throw new Error("This message changed while editing; reopen the editor.");
  const content = message.content?.[action.blockIndex];
  if (!Number.isInteger(action.blockIndex) || action.blockIndex < 0 || !textEditable(content)) {
    throw new Error("The edited text block is no longer available; reopen the editor.");
  }
  if (typeof action.expectedText !== "string" || content.text !== action.expectedText) {
    throw new Error("This text changed while editing; reopen the editor.");
  }
  if (typeof values?.text !== "string") throw new TypeError("Message text must be a string.");
  action.agent.context.editBlock(action.index, action.blockIndex, { ...content, text: values.text });
  return action.back;
}

/**
 * Apply an explicitly confirmed rollback/delete synchronously; never presents confirmation.
 * @param {object} action access.context.rollback/delete descriptor, with agent/index, optional
 *   expectedMessage reference, and optional viewer. Parent MUST confirm before calling.
 * @returns {object|undefined} Borrowed action.viewer after mutation; parent refreshes its projection.
 * @throws {Error|TypeError|RangeError} Unsupported operation, busy/closing/closed Agent,
 *   invalid/virtual/open target, or mismatched expectedMessage. Validation failures do not mutate;
 *   Context errors propagate. These commands are NOT retry-safe after success (indexes shift).
 * @example applyContextMutation(confirmedDeleteAction); // context.remove([index])
 */
export function applyContextMutation(action) {
  if (!["access.context.rollback", "access.context.delete"].includes(action?.type)) {
    throw new TypeError("Expected a context rollback or delete action.");
  }
  idleRequire(action.agent);
  const message = messageAt(action.agent, action.index);
  if (action.expectedMessage !== undefined && message !== action.expectedMessage) {
    throw new Error("This message changed before confirmation; reopen Actions.");
  }
  if (action.type === "access.context.rollback") action.agent.context.rollback(action.index);
  else action.agent.context.remove([action.index]);
  return action.viewer;
}
