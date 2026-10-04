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

function expressions(search) {
  const flags = `g${search.ignoreCase ? "i" : ""}`;
  const patterns = [];
  if (search.text !== undefined) patterns.push(new RegExp(search.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags));
  if (search.regex !== undefined) patterns.push(new RegExp(search.regex, `${flags}m`));
  return patterns;
}

function matching(text, search) {
  const patterns = expressions(search);
  // Find initial occurrences before allocating/indexing lines; reuse them rather than scan twice.
  const firstMatches = text.length ? patterns.map((pattern) => pattern.exec(text)) : [];
  if (!text.length || (!search.invert && !firstMatches.some(Boolean))) return { indexes: [], positions: [], lineCount: 0 };
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
    if (starts.length > 200000) throw new Error("Search line budget exhausted (200000 lines per file)");
  }
  const selected = new Uint8Array(text === "" ? 0 : starts.length);
  const positions = new Map();
  let steps = 0;
  for (const [index, re] of patterns.entries()) {
    let match = firstMatches[index];
    while (match !== null) {
      if (++steps > 1000000) throw new Error("Search occurrence budget exhausted");
      mark(starts, selected, positions, match.index, match[0].length);
      if (!match[0].length) re.lastIndex++;
      match = re.exec(text);
    }
  }
  const indexes = [];
  for (let i = 0; i < selected.length; i++) if (Boolean(selected[i]) !== search.invert) indexes.push(i);
  return { indexes, positions: [...positions], lineCount: starts.length - Number(text.endsWith("\n")) };
}

parentPort?.on("message", ({ text, search }) => {
  try { parentPort.postMessage({ value: matching(text, search) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
