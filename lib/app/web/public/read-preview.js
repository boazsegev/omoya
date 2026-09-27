// The read tool prefixes direct file text with a detected MIME type.
// Never infer Markdown mode from a filename, arguments, or output content.
const HEADER = /^\[([^\]\r\n]+\/[^\]\r\n]+)\]\n/;
const MARKDOWN_TYPES = new Set(["text/markdown", "text/plain"]);

/** Split a read result into its MIME label and display content. */
export function readPreview(name, output) {
  if (name !== "read") return { text: output, mime: null, markdown: false };
  const match = HEADER.exec(output);
  if (!match) return { text: output, mime: null, markdown: false };
  const mime = match[1];
  return { text: output.slice(match[0].length), mime, markdown: MARKDOWN_TYPES.has(mime) };
}
