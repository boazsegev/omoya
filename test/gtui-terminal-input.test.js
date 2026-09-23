// test/gtui-terminal-input.test.js — proof for lib/gtui/terminal-input.js's
// createTerminalInput: raw bytes -> semantic key/paste events. Found and
// fixed during Phase 03 step 6 (the parity run): Node's readline sets
// `key.name` for EVERY keypress, plain printable characters included
// (name === the letter itself) — it is never a signal that a key is
// "named" rather than literal text, so the old `!key?.name` check
// treated every typed letter as a NAMED key and dropped its `text`
// field. No prior test fed raw bytes through this path (every earlier
// terminal-host test drove special keys or dispatched semantic
// messages directly), so nothing caught it until this file drove a
// real keystroke end to end.
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createTerminalInput, keyName } from "../lib/gtui/terminal-input.js";

class FakeInput extends EventEmitter {
  isTTY = true;
}

function harness() {
  const input = new FakeInput();
  const events = [];
  const stop = createTerminalInput(input, (event) => events.push(event));
  return { input, events, stop };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("createTerminalInput: plain printable keys carry text", () => {
  test("a letter, a digit, and space all attach `text` — not just a `key` name", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from("h"));
    input.emit("data", Buffer.from("5"));
    input.emit("data", Buffer.from(" "));
    await settle();
    expect(events).toEqual([
      { type: "key", key: "h", text: "h" },
      { type: "key", key: "5", text: "5" },
      { type: "key", key: "space", text: " " },
    ]);
  });

  test("control keys (Enter, Tab, Backspace) never carry text", async () => {
    // a bare Escape byte is deliberately excluded: Node's readline holds
    // it for ~500ms to see whether it's the START of a longer escape
    // sequence before deciding it's a lone key press — a real-terminal/
    // readline timing quirk unrelated to what this test proves.
    const { input, events } = harness();
    input.emit("data", Buffer.from("\r"));
    input.emit("data", Buffer.from("\t"));
    input.emit("data", Buffer.from("\x7f"));
    await settle();
    expect(events.map((e) => e.key)).toEqual(["enter", "tab", "backspace"]);
    expect(events.every((e) => e.text === undefined)).toBe(true);
  });

  test("bare and Kitty Escape emit immediately instead of waiting on readline", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from("\x1b"));
    input.emit("data", Buffer.from("\x1b[27u"));
    await settle();
    expect(events).toEqual([
      { type: "key", key: "escape" },
      { type: "key", key: "escape" },
    ]);
  });

  test("Ctrl/Alt modified keys never carry text, even when the base key is a plain letter", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from([0x18])); // ctrl+x
    await settle();
    expect(events).toEqual([{ type: "key", key: "ctrl+x", text: undefined }]);
  });

  test("terminal Option+arrow ESC-b/ESC-f spellings normalize to word-left/word-right", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from("\x1bb\x1bf"));
    await settle();
    expect(events).toEqual([
      { type: "key", key: "alt+left", text: undefined },
      { type: "key", key: "alt+right", text: undefined },
    ]);
  });

  test("multi-byte special sequences preserve canonical modifier order", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from("\x1b[A")); // up
    input.emit("data", Buffer.from("\x1b[1;4D")); // Alt+Shift+Left
    input.emit("data", Buffer.from("\x1b[1;7C")); // Alt+Ctrl+Right
    await settle();
    expect(events).toEqual([
      { type: "key", key: "up", text: undefined },
      { type: "key", key: "alt+shift+left", text: undefined },
      { type: "key", key: "alt+ctrl+right", text: undefined },
    ]);
  });

  test("raw C0 bytes remain Ctrl keys even when a decoder omits key.ctrl", () => {
    expect(keyName("\x03", { name: "c" })).toBe("ctrl+c");
    expect(keyName("\x17", { name: "w" })).toBe("ctrl+w");
    expect(keyName("\r", { name: "return" })).toBe("enter");
  });

  test("kitty Ctrl+Shift+Z reaches the redo binding", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from("\x1b[122;6u"));
    await settle();
    expect(events).toEqual([{ type: "key", key: "ctrl+shift+z", text: undefined }]);
  });

  test("kitty Cmd+C reaches the semantic copy binding", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from("\x1b[99;9u"));
    await settle();
    expect(events).toEqual([{ type: "key", key: "copy" }]);
  });

  test("kitty functional codes reach the same semantic bindings", async () => {
    const { input, events } = harness();
    input.emit("data", Buffer.from("\x1b[57350;4u"));
    input.emit("data", Buffer.from("\x1b[57351;7u"));
    input.emit("data", Buffer.from("\x1b[127;5u"));
    input.emit("data", Buffer.from("\x1b[9;2u"));
    input.emit("data", Buffer.from("\x1b[13;3u"));
    await settle();
    expect(events.map(({ key }) => key)).toEqual(["alt+shift+left", "alt+ctrl+right", "ctrl+w", "shift+tab", "alt+enter"]);
  });
});
