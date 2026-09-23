/** Project an Agent pending queue into compact footer nodes. */
import { view as v } from "../gtui/gtui.js";

function textOf(message) {
  return message?.content?.filter?.((part) => part?.type === "text").map((part) => part.text ?? "").join("")
    ?? message?.content?.[0]?.text ?? "";
}

/** The queue is deliberately logical: GTUI owns wrapping, clipping and max rows. */
export function queueView(agent) {
  const pending = agent?.pending ?? [];
  if (pending.length === 0) return null;
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
  return v.column({ priority: 10, maxRows: 3 }, lines.map((line) =>
    v.text({ role: "queue", overflow: "clip-end", margin: 0 }, line)
  ));
}
