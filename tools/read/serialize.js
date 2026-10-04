/** Payload serialization shared by read and write.source; operational status never enters saved data. */
import { toolRevision } from "../../lib/tool-runtime.js";
const revision = toolRevision();
const { infoBlock } = await import(`./util.js?revision=${revision}`);

function escapedPath(path) { return /[\r\n\t]/.test(path) ? JSON.stringify(path) : path; }

function infoText(result) {
  const { query, metadata } = result;
  if (query.search) {
    const files = result.matchingFiles.map((record) => `${escapedPath(record.path)}: ${record.count} selected lines`).join("\n");
    return infoBlock(query.path, metadata, result.kind,
      `search counted ${result.selected} selected lines${result.complete ? "" : " so far (incomplete)"}${files ? `\n${files}` : ""}`, result.totals ?? undefined);
  }
  if (result.kind === "folder") return infoBlock(query.path, metadata, "folder",
    `listing counted ${result.selected} entries${result.complete ? "" : " so far (incomplete)"}`);
  return infoBlock(query.path, metadata, "file",
    `read selects ${result.byteCount ?? Buffer.byteLength(result.payload)} bytes${result.descriptions?.length ? ` (${result.descriptions.join("; ")})` : ""}`, result.totals ?? undefined);
}

function recordsText(result) {
  const { query } = result;
  return result.records.map((record) => {
    const path = escapedPath(record.path);
    if (query.search) {
      if (!query.annotate) return record.text;
      const location = result.kind === "folder" ? `${path}:${record.line}` : String(record.line);
      return `${location}${record.context ? "- " : ": "}${record.text}`;
    }
    return query.annotate && record.size !== undefined ? `${path} (${record.size} bytes)` : path;
  }).join("\n");
}

function textPayload(result) {
  const { query } = result;
  if (query.info) return infoText(result);
  if (query.search) {
    const body = recordsText(result);
    if (!query.annotate) return body;
    return body ? `search ${query.path} (${result.returned} selected lines shown):\n${body}` : `search: no selected lines in ${query.path}${result.complete ? "" : " (scan incomplete)"}`;
  }
  if (result.kind === "folder") {
    const body = recordsText(result);
    if (!query.annotate) return body;
    return `${query.glob.length ? "find" : "ls"} ${query.path}${query.recursive ? " (recursive)" : ""}:\n${body}${result.hint ? `\n${result.hint}` : ""}`;
  }
  const header = query.annotate ? `[${result.mime}]\n${(result.descriptions ?? []).map((text) => `[${text}]\n`).join("")}` : "";
  return header + result.payload;
}

function capBuffer(buffer, result) {
  if (buffer.length <= result.outputLimit) return buffer;
  result.selectionComplete = false;
  if (!result.status.includes("serialized output budget exhausted; narrow the query")) result.status.push("serialized output budget exhausted; narrow the query");
  // Do not cut a UTF-8 code point in text output.
  let end = result.outputLimit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end);
}

/** Bytes to persist: raw binary or UTF-8 serialized payload. Does not include status blocks. */
export function serializeReadResult(result) {
  if (result.binary && !result.query.base64) return result.payload;
  const source = result.binary ? result.payload : Buffer.from(textPayload(result), "utf8");
  const encoded = result.query.base64 ? Buffer.from(source.toString("base64"), "utf8") : source;
  return capBuffer(encoded, result);
}

/** Model output includes status separately when necessary, even with annotate:false. */
export function readResponse(result) {
  const payload = serializeReadResult(result);
  const status = Object.entries(result.skips).filter(([, count]) => count).map(([name, count]) => `${count} ${name} skipped`);
  status.push(...result.status);
  const blocks = [];
  if (result.binary && !result.query.base64) {
    if (result.query.annotate) blocks.push({ type: "text", text: `[${result.mime}; ${(result.descriptions ?? []).join("; ")}]` });
    blocks.push({ type: "binary", mime: result.mime, content: payload.toString("base64") });
  } else {
    const text = `${result.query.base64 && result.query.annotate ? "[base64]\n" : ""}${payload.toString("utf8")}`;
    if (!status.length) return text;
    blocks.push({ type: "text", text });
  }
  if (status.length) blocks.push({ type: "text", text: `[read status: ${status.join("; ")}]` });
  return blocks;
}
