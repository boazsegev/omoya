// The read tool prefixes direct file text with a detected MIME type.
// Never infer Markdown mode from a filename, arguments, or output content.
const HEADER = /^\[([^\]\r\n]+\/[^\]\r\n]+)\]\n/;
const MARKDOWN_TYPES = new Set(["text/markdown", "text/plain"]);

/**
 * Split a read-command result into its display text and optional MIME metadata.
 *
 * @param {string} name - Command name; only `"read"` enables header parsing.
 * @param {string} output - Command output. For `"read"`, a leading `[type/subtype]\n`
 *   header is removed; other output is returned unchanged.
 * @returns {{text: string, mime: string|null, markdown: boolean}} Display text,
 *   the parsed MIME type (or `null` when not parsed), and whether that MIME type
 *   is `text/markdown` or `text/plain`.
 * @throws {TypeError} If `output` is not a string (when read-command parsing
 *   attempts to inspect it).
 */
export function readPreview(name, output) {
  if (name !== "read") return { text: output, mime: null, markdown: false };
  const match = HEADER.exec(output);
  if (!match) return { text: output, mime: null, markdown: false };
  const mime = match[1];
  return { text: output.slice(match[0].length), mime, markdown: MARKDOWN_TYPES.has(mime) };
}
