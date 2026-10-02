/** Isolated bounded matching. Parent terminates this worker on deadline/cancellation. */
import { parentPort } from "node:worker_threads";

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle; else high = middle;
  }
  return low;
}

function mark(starts, selected, positions, index, length) {
  const first = lineAt(starts, index);
  const last = lineAt(starts, index + Math.max(0, length - 1));
  for (let line = first; line <= last; line++) {
    selected[line] = 1;
    if (!positions.has(line)) positions.set(line, Math.max(0, index - starts[line]));
  }
}

function matching(text, search) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
    if (starts.length > 200000) throw new Error("Search line budget exhausted (200000 lines per file)");
  }
  const selected = new Uint8Array(text === "" ? 0 : starts.length);
  const positions = new Map();
  let steps = 0;
  if (search.text !== undefined) {
    // Escaping the literal uses the same Unicode case-folding semantics as regex, without metacharacters.
    const escaped = search.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, `g${search.ignoreCase ? "i" : ""}`);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (++steps > 1000000) throw new Error("Search occurrence budget exhausted");
      mark(starts, selected, positions, match.index, match[0].length);
    }
  }
  if (search.regex !== undefined && text !== "") {
    const re = new RegExp(search.regex, `gm${search.ignoreCase ? "i" : ""}`);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (++steps > 1000000) throw new Error("Search occurrence budget exhausted");
      mark(starts, selected, positions, match.index, match[0].length);
      if (!match[0].length) re.lastIndex++;
    }
  }
  const indexes = [];
  for (let i = 0; i < selected.length; i++) if (Boolean(selected[i]) !== search.invert) indexes.push(i);
  return { indexes, positions: [...positions] };
}

parentPort?.on("message", ({ text, search }) => {
  try { parentPort.postMessage({ value: matching(text, search) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
