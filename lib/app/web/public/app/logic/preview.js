/** Window a collapsed preview before Markdown rendering, so broken fences cannot hide the tail. */
export function previewWindow(text, rows) {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  if (rows === false || lines.length <= rows) return { head: lines.join("\n"), hidden: 0, tail: "" };
  const tail = Math.max(0, rows - 2);
  return { head: lines[0], hidden: lines.length - 1 - tail, tail: tail ? lines.slice(-tail).join("\n") : "" };
}
