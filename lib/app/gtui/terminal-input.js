import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { createByteFilter } from "./byte-filter.js";
import { ALT, CTRL, SHIFT, canonicalKey } from "./keymap.js";

/**
 * Normalize readline keypress details into a GTUI key message.
 * @param {object} target Message object to populate with the canonical key and non-enumerable details.
 * @param {string} string Raw keypress text; may be empty or undefined.
 * @param {object} [key={}] Readline key metadata, including name and modifier flags; may be mutated to clear redundant Shift.
 * @returns {object|null} The populated target, or null when no key name can be determined.
 */
function keyDetail(target, string, key = {}) {
  let name = key.name;
  if (name === "return") name = "enter";
  if (name === "undefined") name = null;
  const code = string?.length === 1 ? string.charCodeAt(0) : null;
  // Raw mode delivers C0 bytes. Some Bun/readline combinations name
  // the base letter but omit key.ctrl; infer Ctrl only where the byte
  // is not the indistinguishable Tab/Enter spelling.
  const rawCtrl = code >= 1 && code <= 26 && name !== "tab" && name !== "enter";
  if (rawCtrl) name = String.fromCharCode(code + 96);
  let modifiers = 0;
  // readline calls terminal Meta "meta"; the public GTUI spelling remains
  // alt for compatibility, while native decoded events may use META.
  if (key.meta) modifiers |= ALT;
  if (key.ctrl || rawCtrl) modifiers |= CTRL;
  // Shift survives on named keys AND on a printable whose DECODED letter
  // differs from the raw byte (a shifted "W" decodes as name "w" while the
  // string stays "W") — the old `!string` guard silently dropped Shift
  // from every shifted letter, so shift+letter could never be matched.
  // A single printable character IS text, not a named key — Shift there
  // is already expressed by the character itself ("W" needs no shift flag,
  // and a false one would poison plain typing). Only named keys (arrows,
  // home, …) and a printable whose DECODED letter differs from the raw
  // byte carry an explicit Shift modifier.
  if (key.shift && string && string.length === 1 && name === string) key.shift = false;
  if (key.shift) modifiers |= SHIFT;
  if (!name && code !== null && code < 32) name = String.fromCharCode(code + 96);
  if (!name) return null;
  target.key = canonicalKey(name, modifiers);
  Object.defineProperties(target, { code: { value: name }, modifiers: { value: modifiers } });
  return target;
}

/**
 * Return the canonical GTUI key spelling for a readline keypress.
 * @param {string} string Raw keypress text; may be empty or undefined.
 * @param {object} [key={}] Readline key metadata and modifier flags; may be mutated to clear redundant Shift.
 * @returns {string|null} Canonical key name, or null when the input has no key name.
 */
function keyName(string, key = {}) {
  const target = {};
  return keyDetail(target, string, key)?.key ?? null;
}

/**
 * Construct a GTUI key event with a canonical key and normalized details.
 * @param {string} name Key name to canonicalize.
 * @param {number} [modifiers=0] Modifier bitmask.
 * @returns {object} Key event whose `code` and `modifiers` properties are non-enumerable.
 */
function namedKey(name, modifiers = 0) {
  const message = { type: "key", key: canonicalKey(name, modifiers) };
  Object.defineProperties(message, { code: { value: name }, modifiers: { value: modifiers } });
  return message;
}

/**
 * Decode raw terminal input into GTUI key, paste, and pointer events.
 * @param {NodeJS.ReadableStream} input Optional readable stream; data listeners are attached when supported.
 * @param {function(object): void} emit Receives decoded semantic events. Exceptions propagate through the emitting callback.
 * @param {object} [options={}] Hooks for input burst boundaries and background notifications.
 * @param {function(): void} [options.beginBurst=()=>{}] Called before each input chunk is filtered.
 * @param {function(): void} [options.endBurst=()=>{}] Called after each chunk, even if filtering throws.
 * @param {function(...*): void} [options.onBackground=()=>{}] Receives background notifications from the byte filter.
 * @returns {function(): void} Cleanup function that detaches listeners and destroys the decoder.
 */
export function createTerminalInput(input, emit, { beginBurst = () => {}, endBurst = () => {}, onBackground = () => {} } = {}) {
  const decoder = new PassThrough();
  decoder.isTTY = true;
  emitKeypressEvents(decoder);
  const onKeypress = (string, key) => {
    const message = { type: "key", key: null, text: undefined };
    keyDetail(message, string, key);
    // macOS terminals commonly encode Option+Left/Right as ESC-b/ESC-f,
    // indistinguishable at the byte layer from Alt+B/F. Normalize those
    // readline events to the input control's semantic word-navigation keys.
    if (message.modifiers === ALT && (message.code === "b" || message.code === "f")) {
      return emit(namedKey(message.code === "b" ? "left" : "right", ALT));
    }
    const name = message.key;
    // Node's readline sets key.name for EVERY keypress, plain printable
    // characters included (name === the letter itself) — never a signal
    // that a key is "named" rather than text. The real test: no ctrl/meta,
    // and every code point is printable (excludes control bytes like
    // \r/\t/\x7f and the ESC that starts a multi-byte special sequence).
    const isText = Boolean(string) && !key?.ctrl && !key?.meta
      && [...string].every((ch) => ch.codePointAt(0) >= 32 && ch !== "\x7f");
    message.text = isText ? string : undefined;
    // Preserve the established enumerable public event shape while allowing
    // hot dispatch to use normalized fields without re-parsing key strings.
    emit(message);
  };
  decoder.on("keypress", onKeypress);
  const filter = createByteFilter({
    onPaste: (text) => emit({ type: "paste", text }),
    onShiftEnter: () => emit(namedKey("enter", SHIFT)),
    onCopy: () => emit(namedKey("copy")),
    onCtrlM: () => emit(namedKey("m", CTRL)),
    onModifiedKey: (key) => emit({ type: "key", key }),
    onEscape: () => emit(namedKey("escape")),
    onMouse: (mouse) => emit({ type: "pointer.raw", mouse }),
    onBackground,
    forward: (text) => decoder.write(text),
  });
  const onData = (chunk) => {
    beginBurst();
    try { filter(chunk); } finally { endBurst(); }
  };
  input?.on?.("data", onData);
  return () => {
    input?.off?.("data", onData);
    decoder.off("keypress", onKeypress);
    decoder.destroy();
  };
}

export { keyName };
