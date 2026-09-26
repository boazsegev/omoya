/**
 * lib/markdown/text-safe.js — display sanitization for UNTRUSTED text (tool/bash
 * output) before a renderer consumes it. Pure, zero-dependency, shared by
 * the TUI and web app at their ingest boundaries.
 *
 * The Agent's persisted tool results and TOOL_DATA events stay byte-exact —
 * nothing here mutates them. Renderers run untrusted display text through
 * these functions so embedded escape sequences cannot corrupt GTUI's
 * geometry model, write to the real terminal, or litter the DOM with
 * control bytes.
 *
 * Two levels:
 *  - sanitizeText(): one-shot, for a COMPLETE string (persisted results).
 *  - BashSanitizer: a small CLASS holding one look-back buffer for a
 *    live chunk stream. Escape sequences may split across streamed
 *    chunks, so concurrent tool calls MUST NOT share the buffer — create
 *    one instance per call (per origin × callId) and call end() when the
 *    call finishes.
 *
 * SGR emphasis (bold/italic/underline and their resets) optionally becomes
 * Markdown markers — ** bold, _ italic, __ underline — so a renderer can
 * carry the intent without carrying the bytes. Markers nest bold-outmost,
 * underline-innermost (`**_text_**`); any SGR with other parameters
 * (colors etc.) and all non-SGR sequences are dropped.
 */

// The one SGR emphasis set we can translate (ECMA-48). Anything else in
// the sequence makes it untranslatable → dropped like other escapes.
const EMPHASIS_SGR = new Set([0, 1, 3, 4, 22, 23, 24]);
const MARKER = { bold: "**", italic: "_", underline: "__" };
// Outermost-first open order; closes run innermost-first (reverse).
const ORDER = ["bold", "italic", "underline"];

/**
 * Apply one SGR sequence's parameters to the CURRENT emphasis state
 * (mutated in place): SGR is incremental — `\x1b[3m` turns italic ON and
 * leaves bold untouched, only 0 resets. Returns false when the sequence
 * carries untranslatable parameters (caller drops it like other escapes).
 * Empty params mean reset (0) per ECMA-48.
 */
function sgrApply(params, state) {
  const values = (params === "" ? "0" : params).split(";").map((p) => Number(p));
  if (!values.every((v) => EMPHASIS_SGR.has(v))) return false;
  for (const value of values) {
    if (value === 0) { state.bold = state.italic = state.underline = false; }
    else if (value === 1) state.bold = true;
    else if (value === 22) state.bold = false;
    else if (value === 3) state.italic = true;
    else if (value === 23) state.italic = false;
    else if (value === 4) state.underline = true;
    else if (value === 24) state.underline = false;
  }
  return true;
}

/** Append close markers for every open style, innermost-first. */
function appendCloseAll(out, state) {
  for (const key of [...ORDER].reverse()) if (state[key]) out += MARKER[key];
  return out;
}

/** Append open markers for the styles on in `state`, outermost-first. */
function appendOpenAll(out, state) {
  for (const key of ORDER) if (state[key]) out += MARKER[key];
  return out;
}

/**
 * Append an emphasis transition as balanced Markdown markers. When any
 * style closes, every open style closes innermost-first and the survivors
 * reopen outermost-first — closed markers land OUTSIDE kept-open styles,
 * so markers never cross (`**a_b**` would be invalid nesting).
 * NOTE: a closing transition emits a "closes…opens" marker RUN, which can
 * visually merge with adjacent same-char markers (e.g. bold close `**`
 * followed by italic open `_` reads as `**_`); the SEQUENCE of markers is
 * what stays balanced, not any textual run boundary.
 */
function appendTransition(out, from, to) {
  const closes = ORDER.some((key) => from[key] && !to[key]);
  if (closes) {
    out = appendCloseAll(out, from);
    return appendOpenAll(out, to);
  }
  for (const key of ORDER) if (to[key] && !from[key]) out += MARKER[key];
  return out;
}

/**
 * Sanitize a COMPLETE untrusted string for display.
 *  - \r\n and lone \r (progress-bar carriage returns) become \n
 *  - ANSI escape sequences are removed: CSI, OSC (BEL- or ST-terminated),
 *    DCS/SOS/PM/APC (ST-terminated), charset/designate/short ESC forms
 *  - SGR bold/italic/underline become Markdown markers when markdown=true
 *    (balanced across style changes; nothing left open at the end)
 *  - C0 controls (except \t, \n), DEL, and C1 controls are dropped
 * A trailing INCOMPLETE escape is removed — this string is finished.
 * @param {string} text
 * @param {{markdown?: boolean, state?: object, open?: boolean}} [options]
 *   markdown: convert SGR emphasis to Markdown markers
 *   state: cross-chunk emphasis object (mutated in place) for streaming
 *     callers; omit for a one-shot string (starts fully closed)
 *   open: leave emphasis open at the end (streaming mid-chunks) instead
 *     of balancing it (one-shot strings and a stream's final flush)
 * @returns {string}
 */
export function sanitizeText(text, { markdown = false, state = null, open = false } = {}) {
  const s = String(text ?? "");
  // `state` lets a streaming caller pass its cross-chunk emphasis in and
  // receive the post-string emphasis back (mutated in place) — a one-shot
  // caller omits it and starts from "everything closed".
  const style = state ?? { bold: false, italic: false, underline: false };
  let out = "";
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x1b || code === 0x9b) { // ESC or 8-bit CSI
      const seq = readEscape(s, i);
      if (seq === null) break; // incomplete at end: drop the remainder
      if (seq.kind === "sgr" && markdown) {
        // Apply the sequence's deltas to the running emphasis, then emit
        // the transition markers for what actually changed.
        const next = { bold: style.bold, italic: style.italic, underline: style.underline };
        if (sgrApply(seq.params, next)) {
          out = appendTransition(out, style, next);
          style.bold = next.bold; style.italic = next.italic; style.underline = next.underline;
        }
      }
      i = seq.end;
      continue;
    }
    if (code === 0x0d) { // CR: part of CRLF or a progress-bar return
      if (s.charCodeAt(i + 1) === 0x0a) i++; // \r\n → one \n
      out += "\n";
      i++;
      continue;
    }
    if (code === 0x09 || code === 0x0a) { out += s[i]; i++; continue; } // tab/LF pass
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) { i++; continue; } // controls
    out += s[i];
    i++;
  }
  if (markdown && state === null && !open) out = appendCloseAll(out, style); // one-shot: balance at the end
  return out;
}

/**
 * Read one escape sequence starting at s[i] (ESC or 8-bit CSI).
 * Returns {kind: "sgr"|"other", end, params?} — `params` is the raw SGR
 * parameter string — or null when the sequence is INCOMPLETE: the rest of
 * the string may still finish it, so streaming callers hold the bytes
 * instead of dropping them.
 */
function readEscape(s, i) {
  let csi = s.charCodeAt(i) === 0x9b;
  if (!csi && s[i + 1] === "[") { csi = true; i++; }
  if (csi) {
    // CSI: parameter/intermediate bytes 0x20–0x3f, final byte 0x40–0x7e.
    let j = i + 1;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++;
    if (j >= s.length) return null; // incomplete
    const final = s.charCodeAt(j);
    if (final < 0x40 || final > 0x7e) return { kind: "other", end: j + 1 }; // malformed: drop bytes
    if (final === 0x6d) { // 'm' — SGR
      const params = s.slice(i + 1, j).replace(/^[\x20-\x2f]+/, ""); // intermediates are not parameters
      return { kind: "sgr", end: j + 1, params };
    }
    return { kind: "other", end: j + 1 };
  }
  const next = s[i + 1];
  if (next === undefined) return null; // lone trailing ESC
  // OSC (]), DCS (P), SOS (X), PM (^), APC (_): string sequences terminated
  // by BEL or ST (ESC \). Cap the scan at 64 KiB as defense in depth.
  if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
    let j = i + 2;
    const limit = Math.min(s.length, j + 65536);
    while (j < limit) {
      if (s.charCodeAt(j) === 0x07) return { kind: "other", end: j + 1 };
      if (s[j] === "\x1b" && s[j + 1] === "\\") return { kind: "other", end: j + 2 };
      j++;
    }
    return j >= s.length ? null : { kind: "other", end: limit };
  }
  // ESC ( … / ESC # … / ESC % … / ESC SP … consume one trailing byte;
  // every other short ESC form is exactly two bytes.
  if (next === "(" || next === ")" || next === "*" || next === "+" || next === "#" || next === "%" || next === " ") {
    return s.length >= i + 3 ? { kind: "other", end: i + 3 } : null;
  }
  return { kind: "other", end: i + 2 };
}

/** Length of a trailing INCOMPLETE escape sequence, or 0. */
function incompleteEscapeLength(text) {
  const start = Math.max(text.lastIndexOf("\x1b"), text.lastIndexOf("\u009b"));
  if (start === -1) return 0;
  // readEscape sees the suffix from that point: null means unfinished.
  return readEscape(text, start) === null ? text.length - start : 0;
}

/**
 * Streaming sanitizer — one instance PER LIVE TOOL CALL (typically one
 * bash command). Holds the look-back buffer that catches escape sequences
 * split across chunks, so concurrent calls must never share an instance.
 */
export class BashSanitizer {
  #pending = "";
  #markdown;
  // Cross-chunk emphasis: SGR bold/italic/underline opened in an earlier
  // chunk must close here (or be balanced at end()) — otherwise markers
  // cross chunks unbalanced or crossed.
  #style = { bold: false, italic: false, underline: false };

  /**
   * Create one sanitizer for one live tool call.
   * @param {{markdown?: boolean}} [options]
   */
  constructor({ markdown = false } = {}) {
    this.#markdown = markdown;
  }

  /**
   * Sanitize the next raw chunk. A trailing INCOMPLETE escape is held
   * back (not emitted) until the following chunk completes it — or end().
   * @param {string} chunk
   * @returns {string} display-safe text
   */
  push(chunk) {
    const text = this.#pending + String(chunk ?? "");
    const hold = incompleteEscapeLength(text);
    this.#pending = hold > 0 ? text.slice(text.length - hold) : "";
    return sanitizeText(hold > 0 ? text.slice(0, text.length - hold) : text, { markdown: this.#markdown, state: this.#style, open: true });
  }

  /** Flush held bytes (dropping an unfinished escape) when the call ends. */
  end() {
    const rest = this.#pending;
    this.#pending = "";
    let out = sanitizeText(rest, { markdown: this.#markdown, state: this.#style });
    if (this.#markdown) out = appendCloseAll(out, this.#style); // balance the STREAM at its end
    this.#style = { bold: false, italic: false, underline: false };
    return out;
  }
}
