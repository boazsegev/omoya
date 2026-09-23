/** Context-owned media-type map and byte detection for content blocks. */

export const MIME_BY_EXTENSION = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
  txt: "text/plain", log: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", ts: "text/typescript", jsx: "text/jsx", tsx: "text/tsx", json: "application/json", jsonl: "application/x-ndjson", ndjson: "application/x-ndjson", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", wasm: "application/wasm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
});

/** Detect a media type from a filename extension or recognized leading bytes. */
export function detectMime({ path, buffer } = {}) {
  const name = typeof path === "string" ? path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) : "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
  if (MIME_BY_EXTENSION[extension]) return MIME_BY_EXTENSION[extension];
  if (buffer !== undefined) return sniffBytes(buffer);
  return "application/octet-stream";
}

function sniffBytes(buffer) {
  const has = (bytes, offset = 0) => bytes.every((byte, index) => buffer[offset + index] === byte);
  if (has([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (has([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (has([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (has([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (has([0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  return "application/octet-stream";
}

/** Build a canonical base64 binary Context block without leaking its source path. */
export function binaryContent(path, buffer) {
  if (typeof path !== "string" || path === "") throw new TypeError("binaryContent: path must be a non-empty string");
  if (!(buffer instanceof Uint8Array)) throw new TypeError("binaryContent: buffer must be bytes");
  // Context carries only a basename: local UI selection paths must never leak.
  const filename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return { type: "binary", mimetype: detectMime({ path: filename, buffer }), filename, content: Buffer.from(buffer).toString("base64") };
}

/** Wrap one local file's bytes as a canonical user message. */
export function fileMessage(path, buffer) {
  return { type: 2, content: [binaryContent(path, buffer)] };
}
