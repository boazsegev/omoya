/**
 * tools/edit/diff.js — git-style unified diffs for the `edit` tool
 * (private to the tool): a zero-dependency unified patch generator
 * (`--- a/<path>` / `+++ b/<path>` / `@@ -s,c +s,c @@` hunks, 3
 * context lines, the "\ No newline at end of file" marker) and the
 * EDIT RECORD that makes an edit reversible: `edit { rollback:
 * "<toolCallID>" }` restores exactly the recorded regions (the
 * record keeps each match's start offset and the file's dominant
 * line ending, so drift that merely DUPLICATED the replacement text
 * elsewhere never blocks the restore, and the rewrite never changes
 * the file's line-ending style).
 *
 * The record is SESSION-SCOPED: it lives in the calling agent's
 * toolStorage (context.agent.toolStorage("edit")), so one agent can
 * never see, guess, or consume another agent's edit ids. Direct
 * callers without an agent (tests, scripts) fall back to one shared
 * module store. A store is size-capped (oldest entries drop). A
 * rollback consumes its record only after the rewrite SUCCEEDED — a
 * failed rollback (file drifted, missing file) restores the record,
 * so it can be retried after the file is reconciled.
 */

const CONTEXT_LINES = 3;
const MAX_RECORDED = 200;
const LCS_CELL_CAP = 4_000_000; // middle-region DP budget (m * n)
const DIFF_START_MARKER = "```diff";
const DIFF_END_MARKER = "```";


const STORAGE_KEY = "records";

/** The fallback store for direct callers without an agent (tests, scripts). */
const fallback = new Map();

/**
 * The calling session's record store. An agent's store lives in its
 * OWN toolStorage (session-scoped — never shared across agents);
 * agentless callers share one module-level fallback store.
 * @param {Object} [context] - harness tool context ({agent})
 * @returns {Map<string, {path: string, edits: Array, ending: string}>}
 */
function storeFor(context) {
  const storage = context?.agent && typeof context.agent.toolStorage === "function"
    ? context.agent.toolStorage("edit")
    : null;
  return storage ? (storage[STORAGE_KEY] ??= new Map()) : fallback;
}

/**
 * Record an applied edit for a later rollback.
 * @param {string} callId - the tool call's id (Agent-owned)
 * @param {{path: string, edits: Array<{oldText: string, newText: string, at?: number}>, ending?: string}} entry
 * @param {Object} [context] - harness tool context ({agent})
 */
export function recordEdit(callId, entry, context) {
  if (typeof callId !== "string" || callId === "") return;
  const store = storeFor(context);
  if (store.has(callId)) store.delete(callId); // re-insert: freshest last
  store.set(callId, entry);
  while (store.size > MAX_RECORDED) store.delete(store.keys().next().value);
}

/**
 * Look a recorded edit up WITHOUT consuming it (the rollback path
 * consumes it only after the rewrite succeeded).
 * @param {string} callId
 * @param {Object} [context] - harness tool context ({agent})
 * @returns {{path: string, edits: Array, ending?: string}|undefined}
 */
export function peekEdit(callId, context) {
  return storeFor(context).get(callId);
}

/** Remove a recorded edit (a successful rollback consumes its record). */
export function removeEdit(callId, context) {
  storeFor(context).delete(callId);
}

/** Drop every recorded edit in the FALLBACK store (tests). */
export function clearRecordedEdits() {
  fallback.clear();
}

/**
 * Line-level edit operations between two texts: LCS over the middle
 * region after trimming the common prefix/suffix lines (an edit tool
 * changes bounded regions — the DP stays small; a pathological
 * middle over the cell budget degrades to remove-all + add-all,
 * still a correct diff). Every op carries its old/new line numbers
 * (1-based; 0 when the side doesn't own the line).
 * @param {string[]} a - old lines
 * @param {string[]} b - new lines
 * @returns {Array<{type: " "|"-"|"+", line: string, old: number, new: number}>}
 */
function diffOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = []; // {type, line} for the changed region
  if (midA.length * midB.length > LCS_CELL_CAP) {
    for (const line of midA) middle.push({ type: "-", line });
    for (const line of midB) middle.push({ type: "+", line });
  } else {
    const m = midA.length;
    const n = midB.length;
    // LCS length table, row-major (m+1) x (n+1)
    const table = new Uint32Array((m + 1) * (n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        table[i * (n + 1) + j] = midA[i] === midB[j]
          ? table[(i + 1) * (n + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (n + 1) + j], table[i * (n + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) { middle.push({ type: " ", line: midA[i] }); i++; j++; }
      else if (table[(i + 1) * (n + 1) + j] >= table[i * (n + 1) + j + 1]) { middle.push({ type: "-", line: midA[i] }); i++; }
      else { middle.push({ type: "+", line: midB[j] }); j++; }
    }
    while (i < m) { middle.push({ type: "-", line: midA[i] }); i++; }
    while (j < n) { middle.push({ type: "+", line: midB[j] }); j++; }
  }
  const seq = [
    ...a.slice(0, start).map((line) => ({ type: " ", line })),
    ...middle,
    ...a.slice(endA).map((line) => ({ type: " ", line })),
  ];
  // assign the 1-based line numbers of each side
  let oldNo = 1;
  let newNo = 1;
  return seq.map((op) => ({
    ...op,
    old: op.type === "+" ? 0 : oldNo++,
    new: op.type === "-" ? 0 : newNo++,
  }));
}

/** The hunk-header span: git omits the count when it is exactly 1. */
function span(start, count) {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * A git-style unified patch of one file's before/after text. "" when
 * the texts are identical. LF-normalized input is assumed (the edit
 * tool diffs its normalized content).
 * @param {string} path - the file's path (the a/ b/ headers carry it)
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [context] - context lines around each change (default 3)
 * @returns {string}
 */
export function unifiedPatch(path, oldText, newText, context = CONTEXT_LINES) {
  if (oldText === newText) return "";
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // a trailing "\n" yields a phantom empty last element — drop it and
  // remember the newline state for the "\ No newline" marker
  const oldNoEol = oldText !== "" && !oldText.endsWith("\n");
  const newNoEol = newText !== "" && !newText.endsWith("\n");
  if (oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines[newLines.length - 1] === "") newLines.pop();
  const ops = diffOps(oldLines, newLines);
  // Context is also Markdown inside the enclosing diff fence. Never
  // include a line that could close that fence (or open another diff
  // fence): markdown permits up to three leading spaces, and unified
  // context adds one. Shrink each changed line's context window at a
  // delimiter, then merge only touching windows. This retains as much
  // useful context as possible without emitting a false delimiter.
  const isDelimiter = (op) => op.type === " " && /^(?: {0,2}```diff| {0,2}```)/.test(op.line);
  const changed = ops.map((op, i) => (op.type === " " ? -1 : i)).filter((i) => i >= 0);
  const groups = [];
  for (const index of changed) {
    let start = index;
    let end = index;
    for (let count = 0; count < context && start > 0 && !isDelimiter(ops[start - 1]); count++) start--;
    for (let count = 0; count < context && end < ops.length - 1 && !isDelimiter(ops[end + 1]); count++) end++;
    const last = groups[groups.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else groups.push({ start, end });
  }
  // only the trailing NEWLINE differs (same lines, one side no-EOL):
  // git shows the last line with the "\ No newline" marker
  if (groups.length === 0) {
    if (oldNoEol === newNoEol || ops.length === 0) return "";
    const last = ops.length - 1;
    groups.push({ start: last, end: last });
  }
  const out = [DIFF_START_MARKER, `--- a/${path}`, `+++ b/${path}`];
  for (const group of groups) {
    const from = group.start;
    const to = group.end;
    const hunk = ops.slice(from, to + 1);
    const oldStart = (hunk.find((op) => op.old > 0)?.old) ?? (from > 0 ? ops[from - 1].old + 1 : 1);
    const newStart = (hunk.find((op) => op.new > 0)?.new) ?? (from > 0 ? ops[from - 1].new + 1 : 1);
    const oldCount = hunk.filter((op) => op.type !== "+").length;
    const newCount = hunk.filter((op) => op.type !== "-").length;
    out.push(`@@ -${span(oldStart, oldCount)} +${span(newStart, newCount)} @@`);
    for (const op of hunk) out.push(`${op.type}${op.line}`);
  }
  // the "\ No newline" marker attaches right after the LAST content
  // line of the side that lacks the trailing newline
  const lastOf = (kinds) => {
    for (let i = out.length - 1; i >= 2; i--) {
      if (out[i].startsWith("@@")) continue;
      if (kinds.includes(out[i][0])) return i;
    }
    return -1;
  };
  const marks = [];
  if (newNoEol) marks.push(lastOf([" ", "+"]));
  if (oldNoEol) marks.push(lastOf([" ", "-"]));
  for (const i of marks.filter((i) => i >= 0).sort((x, y) => y - x)) {
    out.splice(i + 1, 0, "\\ No newline at end of file");
  }
  out.push(DIFF_END_MARKER);
  return out.join("\n");
}
