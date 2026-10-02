/** Incremental text decoding and source-preserving range selection. */
import { toolRevision } from "../../lib/tool-runtime.js";
const revision = toolRevision();
const { isBinary } = await import(`./binary.js?revision=${revision}`);
const { readChunk, checkReadState, ReadBudgetError } = await import(`./fs.js?revision=${revision}`);
const CHUNK = 64 * 1024;

export function textEncoding(sample) {
  if (sample[0] === 0xff && sample[1] === 0xfe) return "utf-16le";
  if (sample[0] === 0xfe && sample[1] === 0xff) return "utf-16be";
  let even = 0;
  let odd = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) { if (!sample[i]) even++; if (!sample[i + 1]) odd++; }
  const pairs = Math.floor(sample.length / 2);
  if (pairs && odd / pairs > 0.3) return "utf-16le";
  if (pairs && even / pairs > 0.3) return "utf-16be";
  return "utf-8";
}

function binarySample(buffer, encoding) {
  if (encoding !== "utf-8") return false;
  // Samples may end within a valid multibyte sequence; decoder streaming ignores that suffix only.
  try { new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: true }); }
  catch { return isBinary(buffer); }
  return buffer.includes(0);
}

function positiveStop(query, characters, newlines) {
  if (query.info) return false;
  if (query.lines?.to > 0 && (query.lines.from ?? 1) > 0 && newlines >= query.lines.to) return true;
  return !query.lines && query.characters?.to >= 0 && (query.characters.from ?? 0) >= 0 && characters >= query.characters.to;
}

/** Read finite decoded chunks, stopping early for positive prefix ranges; whole/end-relative reads have fileBytes cap. */
export async function loadText(opened, query, state) {
  const sample = await readChunk(opened.handle, 0, Math.min(CHUNK, state.budgets.fileBytes, opened.metadata.size), state);
  const encoding = query.binary ? "latin1" : textEncoding(sample);
  const tailCount = query.lines?.last ?? (query.lines?.from < 0 && (query.lines.to === undefined || query.lines.to < 0) ? -query.lines.from : undefined);
  if (!query.info && tailCount !== undefined && !query.search && !query.characters) return await tailText(opened, tailCount, state, encoding);
  if (query.search && !query.binary && binarySample(sample, encoding)) throw new Error("Search applies only to text files; use binary: true to search bytes");
  const decoder = query.binary ? null : new TextDecoder(encoding, { fatal: true });
  let position = sample.length;
  let text;
  try { text = query.binary ? sample.toString("latin1") : decoder.decode(sample, { stream: true }); }
  catch { throw new Error("Invalid text encoding; use binary: true for bytes"); }
  let newlines = countNewlines(text);
  let characters = query.characters ? [...text].length : 0;
  while (position < opened.metadata.size && !positiveStop(query, characters, newlines)) {
    if (position >= state.budgets.fileBytes) throw new ReadBudgetError("read fileBytes budget exhausted; narrow the selection");
    const length = Math.min(CHUNK, opened.metadata.size - position, state.budgets.fileBytes - position);
    const buffer = await readChunk(opened.handle, position, length, state);
    if (!buffer.length) break;
    let chunk;
    try { chunk = query.binary ? buffer.toString("latin1") : decoder.decode(buffer, { stream: true }); }
    catch { throw new Error("Invalid text encoding; use binary: true for bytes"); }
    text += chunk;
    newlines += countNewlines(chunk);
    if (query.characters) characters += [...chunk].length;
    position += buffer.length;
  }
  const complete = position >= opened.metadata.size;
  if (decoder && complete) {
    try { text += decoder.decode(); }
    catch { throw new Error("Invalid text encoding; use binary: true for bytes"); }
  }
  checkReadState(state);
  return { text, complete, encoding };
}

/** Tail reads backwards in bounded blocks, aligns UTF-16 units, then uses the normal selector. */
async function tailText(opened, count, state, encoding) {
  if (!count) return { text: "", complete: false, encoding };
  let position = opened.metadata.size;
  const chunks = [];
  let read = 0;
  let newlines = 0;
  const wide = encoding.startsWith("utf-16");
  while (position > 0 && newlines <= count) {
    let length = Math.min(CHUNK, position, state.budgets.fileBytes - read);
    if (wide && position - length > 0 && (position - length) % 2) length--;
    if (length <= 0) throw new ReadBudgetError("read tail fileBytes budget exhausted");
    position -= length;
    const buffer = await readChunk(opened.handle, position, length, state);
    chunks.unshift(buffer);
    read += buffer.length;
    if (wide) {
      for (let i = 0; i + 1 < buffer.length; i += 2) {
        if (encoding === "utf-16le" ? buffer[i] === 10 && buffer[i + 1] === 0 : buffer[i] === 0 && buffer[i + 1] === 10) newlines++;
      }
    } else for (const byte of buffer) if (byte === 10) newlines++;
  }
  let buffer = Buffer.concat(chunks);
  // The omitted first partial line is irrelevant to the final N complete lines.
  if (position > 0 && wide) {
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      const newline = encoding === "utf-16le" ? buffer[i] === 10 && buffer[i + 1] === 0 : buffer[i] === 0 && buffer[i + 1] === 10;
      if (newline) { buffer = buffer.subarray(i + 2); break; }
    }
  }
  if (position > 0 && encoding === "utf-8") {
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    buffer = buffer.subarray(start);
  }
  return { text: encoding === "latin1" ? buffer.toString("latin1") : new TextDecoder(encoding, { fatal: true }).decode(buffer), complete: position === 0, encoding, tail: true };
}

export function countNewlines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") count++;
  return count;
}

export function sourceLines(text) {
  if (!text.length) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function rangeBounds(range, length, line = false) {
  if (range?.last !== undefined) return [Math.max(0, length - range.last), length];
  const index = (value, fallback, end) => {
    if (value === undefined) return fallback;
    if (value < 0) return length + value + (line && end ? 1 : 0);
    return value - (line && !end ? 1 : 0);
  };
  const rawFrom = index(range?.from, 0, false);
  const rawTo = index(range?.to, length, true);
  const from = Math.max(0, Math.min(length, rawFrom));
  const to = Math.max(0, Math.min(length, rawTo));
  if (from > to) throw new Error("range.from must not exceed range.to after resolving end-relative indexes");
  return [from, to];
}

/** Apply lines then characters, retaining original first source line. */
export function selectText(loaded, query) {
  const { text } = loaded;
  const lines = sourceLines(text);
  let selection = text;
  let lineOffset = 1;
  const descriptions = [];
  if (query.lines) {
    const [from, to] = rangeBounds(query.lines, lines.length, true);
    selection = lines.slice(from, to).join("\n");
    if (to > from && (to < lines.length || text.endsWith("\n"))) selection += "\n";
    lineOffset = from + 1;
    descriptions.push(loaded.tail && !loaded.complete ? `end-relative lines (tail scan)` : `lines ${from + 1}–${to}${loaded.complete ? ` of ${lines.length}` : " (prefix scan)"}`);
  }
  const characterRange = query.characters ?? (query.binary ? query.bytes : undefined);
  if (characterRange) {
    const points = [...selection];
    const [from, to] = rangeBounds(characterRange, points.length);
    lineOffset += countNewlines(points.slice(0, from).join(""));
    selection = points.slice(from, to).join("");
    descriptions.push(`${query.binary ? "bytes" : "characters"} ${from}–${to} (exclusive end)`);
  }
  return { text: selection, lineOffset, descriptions,
    totals: loaded.complete ? { characters: [...text].length, lines: lines.length } : null };
}
