/** Unified Git-diff recognition; internal implementation for Markdown.parseGitDiff. */
const FENCE = String.fromCharCode(96).repeat(3);
const METADATA = ["diff --git ", "index ", "new file mode ", "deleted file mode ", "similarity index ", "rename from ", "rename to "];

function startsMetadata(line) { return METADATA.some((prefix) => line.startsWith(prefix)); }
function filename(line) { return line.slice(4).replace(/\r$/, ""); }

/** Return null without line/offset allocation when text cannot begin a diff. */
export function parseGitDiff(text) {
  const source = String(text ?? "");
  const firstEnd = source.indexOf("\n");
  const firstLine = firstEnd < 0 ? source : source.slice(0, firstEnd);
  const fenced = firstLine.trim().toLowerCase() === `${FENCE}diff`;
  if (!fenced && !firstLine.startsWith("--- ") && !firstLine.startsWith("diff --git ")) return null;

  const raw = source.split("\n");
  let first = 0;
  let last = raw.length;
  if (fenced) {
    const close = raw.findIndex((line, index) => index > 0 && line.trim() === FENCE);
    if (close < 0 || !raw.slice(close + 1).every((line) => line === "")) return null;
    first = 1;
    last = close;
  }

  let header = first;
  while (header < last && startsMetadata(raw[header])) header++;
  if (!raw[header]?.startsWith("--- ") || !raw[header + 1]?.startsWith("+++ ")) return null;

  const headers = new Set();
  if (fenced) { headers.add(0); headers.add(last); }
  for (let index = first; index < last; index++) {
    if (startsMetadata(raw[index])) headers.add(index);
    if (raw[index].startsWith("--- ") && raw[index + 1]?.startsWith("+++ ")) {
      headers.add(index);
      headers.add(index + 1);
      index++;
    }
  }
  const offsets = [];
  let offset = 0;
  for (const line of raw) { offsets.push(offset); offset += line.length + 1; }
  const kind = (line, index) => {
    if (headers.has(index)) return fenced && (index === 0 || index === last) ? "fence" : "header";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "remove";
    return "context";
  };
  const sourceLines = raw.map((line, index) => ({ text: line, start: offsets[index], end: offsets[index] + line.length, kind: kind(line, index) }));
  const edits = raw.slice(header + 2, last);
  const bodyKinds = sourceLines.slice(header + 2, last).map((line) => line.kind);
  return {
    type: "gitdiff", aFilename: filename(raw[header]), bFilename: filename(raw[header + 1]),
    totalAdd: bodyKinds.filter((value) => value === "add").length,
    totalRemove: bodyKinds.filter((value) => value === "remove").length,
    lines: edits, sourceLines,
  };
}
