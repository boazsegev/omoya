/** Combine context messages and unacknowledged local submissions, counting repeats. */
export function historyEntries(blocks, submitted) {
  const context = blocks.filter((block) => block.kind === "user" && typeof block.text === "string" && block.text).map((block) => block.text);
  const counts = new Map(context.map((text) => [text, 0]));
  for (const text of context) counts.set(text, counts.get(text) + 1);
  const extra = [];
  for (const text of submitted) {
    const count = counts.get(text) ?? 0;
    if (count) counts.set(text, count - 1);
    else extra.push(text);
  }
  return [...context, ...extra];
}

/** Determine whether an arrow should leave text editing for history browsing. */
export function onEdgeRow(value, index, direction, tops) {
  if (direction < 0 ? value.slice(0, index).includes("\n") : value.slice(index).includes("\n")) return false;
  return tops.caret === (direction < 0 ? tops.start : tops.end);
}

/** Return the next history entry and browsing state, or null for native caret movement. */
export function historyRecall({ value, caret, direction, entries, draft, tops }) {
  if (!entries.length || (direction > 0 && draft.historyIndex === null)) return null;
  if (!onEdgeRow(value, caret, direction, tops)) return null;
  const historyDraft = direction < 0 && draft.historyIndex === null ? value : draft.historyDraft;
  const index = direction < 0 ? (draft.historyIndex === null ? entries.length - 1 : draft.historyIndex - 1) : draft.historyIndex + 1;
  if (index < 0) return { value, index: draft.historyIndex, historyDraft };
  if (index >= entries.length) return { value: historyDraft ?? "", index: null, historyDraft: null };
  return { value: entries[index], index, historyDraft };
}

/** Editing a recalled message makes the edit the new working draft. */
export function editHistoryDraft(draft, value) {
  draft.historyIndex = null;
  draft.historyDraft = null;
  draft.text = value;
}
