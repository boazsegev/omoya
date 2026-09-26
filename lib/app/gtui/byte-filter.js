/**
 * lib/gtui/byte-filter.js — the raw-byte pre-filter (generic terminal
 * primitive, ported from the retired lib/tui-helpers/byte-filter.js):
 * recognizes bracketed-paste markers, Shift+Enter encodings, kitty
 * CSI-u / modifyOtherKeys keys (translated back to legacy bytes
 * Node's own readline keypress decoder understands — including
 * SUPER+C, the terminal-forwarded copy event) and SGR mouse reports
 * BEFORE they'd reach the decoder. Everything else passes through
 * forward() unchanged. Markers may split across chunks — inPaste/carry
 * track that.
 *
 * Scope note: this is byte-level decode only (paste/kitty-key/mouse
 * extraction from the raw stream). The further step of turning
 * Node's decoded keypress events into a canonical key-name vocabulary
 * is app-shaped policy (which keys exist, what they mean) — that is
 * Phase 02's `input` control, not a Phase 01 primitive.
 */

import { MOUSE_RE, decodeMouse } from "./mouse.js";
import { FUNCTIONAL_KEYS, modifierBits } from "./key-sequences.js";
import { ALT, CTRL, META, SHIFT } from "./keymap.js";

// Bracketed paste (CSI ?2004) is near-universally supported (every major
// terminal emulator for 15+ years) — pasted text arrives wrapped in
// these markers, telling us definitively "this is a paste, not typing"
// so embedded newlines never trigger a submit, no matter how large.
// This is the guaranteed mechanism for pasting a large prompt.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Shift+Enter reporting is terminal-dependent (NOT universal — plain
// Terminal.app, for one, sends the same bytes as plain Enter and can't
// be made to say otherwise). These are the two common encodings modern
// terminals use when the reporting modes below are enabled: the kitty
// keyboard protocol's "CSI code ; modifier u" form, and xterm's
// modifyOtherKeys "CSI 27 ; modifier ; code ~" form. Both recognized;
// trailing-"\" continuation remains the universal fallback that works
// on every terminal regardless.
const SHIFT_ENTER_SEQUENCES = ["\x1b[13;2u", "\x1b[27;2;13~"];
const LONGEST_MARKER = Math.max(PASTE_START.length, PASTE_END.length, ...SHIFT_ENTER_SEQUENCES.map((s) => s.length));

// When the reporting modes below ARE honored (kitty, WezTerm, Ghostty,
// foot, iTerm2-kitty, modifyOtherKeys-forced xterms), EVERY non-text
// key — ^C/^D/^O/^X, Alt+letters, even plain Enter/Backspace/Tab/Esc —
// arrives in one of these CSI encodings, which the legacy keypress
// decoder CANNOT parse. They must be translated back to legacy bytes
// here, before the decoder, or all modifier keys are dead there.
const KITTY_RE = /\x1b\[(\d+)(?:;(\d+))?u/;
const MODOTHER_RE = /\x1b\[27;(\d+);(\d+)~/;

/**
 * Translate one kitty CSI-u / modifyOtherKeys key to its legacy byte
 * equivalent. The named-key spellings come from key-sequences.js's
 * declarative tables (one semantic key ↔ every protocol's spelling); the
 * modifier convention is shared (1=none, 2=shift, 3=alt, 5=ctrl; kitty
 * adds bit 8 for SUPER — Cmd on macOS). Returns the legacy bytes, the
 * string "shift+enter", the string "copy" (Cmd+C — the one clipboard
 * gesture a terminal may forward), or null (unrecognized — forwarded
 * unchanged for the decoder to attempt).
 */
export function translateCsiU(code, mod) {
  // Kitty's PUA functional-key block is sequential: insert, delete,
  // left, right, up, down, page-up, page-down, home, end. Convert it to
  // the standard legacy CSI spellings Node's decoder understands while
  // preserving the modifier value (the old mapping both reordered the
  // arrows and erased every modifier).
  const descriptor = FUNCTIONAL_KEYS.get(code);
  if (descriptor) {
    const superKey = mod !== undefined && ((mod - 1) & 8) !== 0;
    const altKey = mod !== undefined && ((mod - 1) & 2) !== 0;
    const shiftKey = mod !== undefined && ((mod - 1) & 1) !== 0;
    if (superKey && (code === 57350 || code === 57351 || code === 57352 || code === 57353)) {
      // Cmd+arrows (kitty SUPER) have NO legacy byte spelling: legacy
      // modifier values top out at ctrl, so a translated sequence would
      // decode as ctrl+arrow — a DIFFERENT binding (line boundary vs
      // paragraph boundary in the input control). Named tokens carry
      // the modifiers through untouched ("copy" above sets the pattern).
      const name = code === 57350 ? "left" : code === 57351 ? "right" : code === 57352 ? "up" : "down";
      return `${altKey ? "alt+" : ""}meta+${shiftKey ? "shift+" : ""}${name}`;
    }
    const [kind, value] = descriptor;
    const modifier = mod === undefined || mod === 1 ? "" : `;${mod}`;
    return kind === "final"
      ? `\x1b[${modifier ? `1${modifier}` : ""}${value}`
      : `\x1b[${value}${modifier}~`;
  }
  if (code === 13) { // Enter
    if (mod === 2) return "shift+enter";
    if (mod === 3) return "\x1b\r"; // Alt+Enter: legacy soft-break spelling
    return "\r";
  }
  // Cmd+C (kitty SUPER bit): copy an app-owned selection — terminal
  // emulators usually eat Cmd+C for their native selection, but a
  // kitty-protocol terminal can forward it, and then it means us.
  if (code === 99 && mod !== undefined && ((mod - 1) & 8) !== 0) return "copy";
  if (code === 9) return mod === 2 ? "\x1b[Z" : "\t"; // Tab / Shift-Tab
  if (code === 27) return "\x1b"; // Escape
  // ^M (Ctrl+M): legacy bytes can't say it (CR IS Enter — \x0d decodes
  // as "return", no ctrl flag), but the CSI encodings CAN: keep the
  // token distinct on kitty / modifyOtherKeys terminals. On legacy
  // terminals ^M is simply Enter.
  if (code === 109 && mod === 5) return "ctrl+m";
  if (code === 127) { // Backspace: keep the modifier meaningful
    if (mod === 3) return "\x1b\x7f"; // Alt+Backspace (ESC DEL)
    if (mod === 5) return "\x17"; // Ctrl+Backspace (^W sentinel)
    return "\x7f";
  }
  if (code >= 97 && code <= 122 && (modifierBits(mod) & CTRL)) {
    // A lone Ctrl letter has an equivalent C0 byte that readline decodes.
    // Combined Ctrl modifiers do not: emitting C0 loses Shift/Alt, so carry
    // their normalized semantic spelling directly to terminal-input.
    if (mod === 5) return String.fromCharCode(code - 96); // ^A..^Z
    const bits = modifierBits(mod);
    const prefixes = `${bits & ALT ? "alt+" : ""}ctrl+${bits & META ? "meta+" : ""}${bits & SHIFT ? "shift+" : ""}`;
    return `${prefixes}${String.fromCharCode(code)}`;
  }
  if (mod === 3 && code >= 32 && code < 127) return "\x1b" + String.fromCharCode(code); // Alt+key
  // Plain and Shift: modifyOtherKeys reports the ALREADY-SHIFTED codepoint
  // (Shift+w arrives as code 87 = "W"), so mod===2 needs no transform here —
  // without this branch every shifted letter/symbol falls through to null
  // and gets forwarded raw, showing up as literal "87~" style text.
  if ((mod === undefined || mod === 1 || mod === 2) && code >= 32 && code < 127) return String.fromCharCode(code);
  return null;
}

/** Length of a trailing INCOMPLETE CSI escape (split across chunks).
 *  A lone "\x1b" is deliberately NOT held: a bare Esc arrives as its own
 *  chunk and must reach the decoder immediately (pty reads deliver real
 *  sequences atomically, so "\x1b["-or-longer partials are insurance). */
function incompleteCsiLength(text) {
  const m = /(?:\x1b\[<?\d*(?:;\d*){0,2}|\x1b\[)$/.exec(text);
  return m ? m[0].length : 0;
}

// Best-effort mode enables sent once at session start, and their
// disables at teardown — standard DECSET-style private sequences that
// terminals which don't understand them silently ignore, so it's safe
// to always send them.
export const ENABLE_PASTE = "\x1b[?2004h";
export const DISABLE_PASTE = "\x1b[?2004l";
// Kitty's standard `CSI = flags u` SET form avoids the `CSI > u` stack:
// a crash or short write therefore cannot strand a pushed keyboard mode.
export const ENABLE_KITTY_KEYS = "\x1b[=1u";
export const DISABLE_KITTY_KEYS = "\x1b[=0u";
export const ENABLE_MODIFY_OTHER_KEYS = "\x1b[>4;2m";
export const DISABLE_MODIFY_OTHER_KEYS = "\x1b[>4;0m";

/** Normalize pasted line endings to plain "\n" (clipboards are often CRLF). */
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Longest suffix of `text` that is a proper PREFIX of some pattern —
 * used to hold back only bytes that could still turn into a recognized
 * marker once more data arrives. Ordinary typed text never starts with
 * ESC, so this returns 0 for it: no added latency for normal typing.
 */
function partialMatchLength(text, patterns) {
  const max = Math.min(text.length, LONGEST_MARKER - 1);
  for (let n = max; n > 0; n--) {
    const suffix = text.slice(text.length - n);
    if (patterns.some((p) => p.startsWith(suffix))) return n;
  }
  return 0;
}

/**
 * A stateful raw-byte filter recognizing bracketed-paste markers and
 * Shift+Enter sequences BEFORE they'd otherwise reach the keypress
 * decoder (which understands neither). Everything else passes through
 * `forward()` unchanged, for the normal decoder to handle exactly as
 * before. Markers may split across chunks — `inPaste`/`carry` track
 * that; a large paste is buffered in full before `onPaste` fires once.
 * @param {Object} options
 * @param {(text: string) => void} options.onPaste - full pasted text, newlines normalized
 * @param {() => void} options.onShiftEnter
 * @param {() => void} [options.onCopy] - Cmd+C forwarded by the terminal (kitty SUPER)
 * @param {() => void} [options.onCtrlM] - ^M in a CSI encoding (kitty
 *   /modifyOtherKeys — legacy bytes cannot distinguish ^M from Enter)
 * @param {() => void} [options.onEscape] - bare/Kitty Escape, emitted
 *   directly so readline cannot delay modal dismissal
 * @param {(text: string) => void} options.forward - bytes for the normal keypress decoder
 * @param {(event: object) => void} [options.onMouse] - decoded SGR mouse
 *   reports (./mouse.js's decodeMouse); without it they are dropped
 * @returns {(chunk: Buffer|string) => void}
 */
export function createByteFilter({ onPaste, onShiftEnter, onCopy = () => {}, onCtrlM = () => {}, onModifiedKey = () => {}, onEscape, forward, onMouse = () => {} }) {
  let inPaste = false;
  let pasteText = "";
  let carry = "";
  const allMarkers = [PASTE_START, PASTE_END, ...SHIFT_ENTER_SEQUENCES];

  return (chunk) => {
    let text = carry + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    carry = "";

    for (;;) {
      if (inPaste) {
        const end = text.indexOf(PASTE_END);
        if (end === -1) {
          const keep = Math.min(text.length, PASTE_END.length - 1);
          pasteText += text.slice(0, text.length - keep);
          carry = text.slice(text.length - keep);
          return;
        }
        pasteText += text.slice(0, end);
        onPaste(normalizeNewlines(pasteText));
        pasteText = "";
        inPaste = false;
        text = text.slice(end + PASTE_END.length);
        continue;
      }

      const pasteAt = text.indexOf(PASTE_START);
      let seAt = -1, seLen = 0;
      for (const seq of SHIFT_ENTER_SEQUENCES) {
        const i = text.indexOf(seq);
        if (i !== -1 && (seAt === -1 || i < seAt)) { seAt = i; seLen = seq.length; }
      }
      // kitty CSI-u / modifyOtherKeys keys (see translateCsiU): take the
      // EARLIEST encoded key in the buffer, if any.
      let csi = null; // {at, len, legacy}
      for (const re of [KITTY_RE, MODOTHER_RE]) {
        const m = re.exec(text);
        if (!m) continue;
        const legacy = re === MODOTHER_RE
          ? translateCsiU(Number(m[2]), Number(m[1])) // 27 ; mod ; code ~
          : translateCsiU(Number(m[1]), m[2] === undefined ? undefined : Number(m[2]));
        if (legacy === null) continue; // unrecognized: leave for the decoder
        if (csi === null || m.index < csi.at) csi = { at: m.index, len: m[0].length, legacy };
      }

      // SGR mouse reports (CSI < b ; x ; y M|m) decode to mouse events
      let mouse = null; // {at, len, event}
      const mm = MOUSE_RE.exec(text);
      if (mm) mouse = { at: mm.index, len: mm[0].length, event: decodeMouse(Number(mm[1]), Number(mm[2]), Number(mm[3]), mm[4]) };

      if (pasteAt === -1 && seAt === -1 && csi === null && mouse === null) {
        let keep = Math.max(partialMatchLength(text, allMarkers), incompleteCsiLength(text));
        // A trailing LONE ESC is never held: a bare Esc press arrives as
        // exactly this byte and must decode immediately (the alternative
        // — holding it as a possible marker prefix — hostage-takes Esc
        // until the NEXT keypress).
        if (keep === 1 && text.endsWith("\x1b")) keep = 0;
        if (keep > 0) {
          if (text.length > keep) forward(text.slice(0, text.length - keep));
          carry = text.slice(text.length - keep);
        } else if (text === "\x1b" && typeof onEscape === "function") {
          // readline deliberately waits ~500ms before deciding whether a
          // lone ESC starts an Alt/CSI sequence. The byte filter already
          // knows this complete chunk is a bare Escape, so emit it now.
          onEscape();
        } else if (text !== "") {
          forward(text);
        }
        return;
      }

      if (pasteAt !== -1 && (seAt === -1 || pasteAt < seAt) && (csi === null || pasteAt < csi.at) && (mouse === null || pasteAt < mouse.at)) {
        if (pasteAt > 0) forward(text.slice(0, pasteAt));
        inPaste = true;
        text = text.slice(pasteAt + PASTE_START.length);
        continue;
      }

      if (mouse !== null && (seAt === -1 || mouse.at < seAt) && (csi === null || mouse.at < csi.at)) {
        if (mouse.at > 0) forward(text.slice(0, mouse.at));
        onMouse(mouse.event);
        text = text.slice(mouse.at + mouse.len);
        continue;
      }

      if (csi !== null && (seAt === -1 || csi.at < seAt)) {
        if (csi.at > 0) forward(text.slice(0, csi.at));
        if (csi.legacy === "shift+enter") onShiftEnter();
        else if (csi.legacy === "copy") onCopy();
        else if (typeof csi.legacy === "string" && csi.legacy.includes("+")) onModifiedKey(csi.legacy);
        else if (csi.legacy === "ctrl+m") onCtrlM();
        else if (csi.legacy === "\x1b" && typeof onEscape === "function") onEscape();
        else forward(csi.legacy); // legacy bytes: the decoder understands these
        text = text.slice(csi.at + csi.len);
        continue;
      }

      if (seAt > 0) forward(text.slice(0, seAt));
      onShiftEnter();
      text = text.slice(seAt + seLen);
    }
  };
}
