/** Project an Agent pending queue into compact footer nodes. */
import { view as v } from "../gtui/gtui.js";

/**
 * Extract text from a queued message's content parts.
 * @param {object|null|undefined} message Message whose content may contain text parts.
 * @returns {string} Joined text parts, or the first content item's text / an empty string as fallback.
 * @throws Propagates errors from malformed content values or their filter/map/join methods.
 */
function textOf(message) {
  return message?.content?.filter?.((part) => part?.type === "text").map((part) => part.text ?? "").join("")
    ?? message?.content?.[0]?.text ?? "";
}

/**
 * Project an Agent's pending queue into compact footer nodes. GTUI owns wrapping,
 * clipping and maximum rows; each logical row is returned as an independent node.
 * @param {object|null|undefined} agent Agent-like object; `pending` defaults to an empty array.
 * @returns {object|null} GTUI column with queue rows, or `null` when no messages are pending.
 * @throws Propagates errors from queue access and GTUI node construction.
 */
export function queueView(agent) {
  const pending = agent?.pending ?? [];
  if (pending.length === 0) return null;
  /**
   * Reduce one queued message to its first line, marking multiline content.
   * @param {object|null|undefined} message Queued message to summarize.
   * @returns {string} First text line, followed by an ellipsis marker when multiline.
   * @throws Propagates errors from text extraction or string operations.
   */
  const snippet = (message) => {
    const text = textOf(message);
    const first = text.split("\n")[0];
    return first + (text.includes("\n") ? " …" : "");
  };
  const lines = [`Queued${pending.length > 1 ? ` (${pending.length})` : ""}: ${snippet(pending[0])}`];
  if (pending.length > 1) lines.push(`  ${snippet(pending[1])}${pending.length > 2 ? ` … +${pending.length - 2} more` : ""}`);
  lines.push("  Alt+Shift+↑ unqueues into the input area");
  // One no-wrap text node per logical row. The column owns the row cap;
  // each child clips at the viewport edge without physically truncating data.
  return v.column({ priority: 10, maxRows: 3 }, lines.map(
    /** @param {string} line Logical queue row. @returns {object} GTUI text node. @throws Propagates errors from GTUI text-node construction. */
    (line) => v.text({ role: "queue", overflow: "clip-end", margin: 0 }, line)
  ));
}
