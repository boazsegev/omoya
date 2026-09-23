// test/gtui-byte-filter.test.js — proof for lib/gtui/byte-filter.js
// (ported from lib/tui-helpers/byte-filter.js, AI-TUI MIGRATION.md
// Phase 01 step 2): bracketed-paste and Shift+Enter recognition,
// kitty CSI-u / modifyOtherKeys translation, SGR mouse extraction —
// all before the raw bytes would otherwise reach a keypress decoder.
import { describe, expect, test } from "bun:test";
import { createByteFilter } from "../lib/gtui/byte-filter.js";

describe("createByteFilter (paste / Shift-Enter recognition)", () => {
  const harness = () => {
    const pastes = [];
    const shiftEnters = [];
    const forwarded = [];
    const filter = createByteFilter({
      onPaste: (t) => pastes.push(t),
      onShiftEnter: () => shiftEnters.push(true),
      forward: (t) => forwarded.push(t),
    });
    return { filter, pastes, shiftEnters, forwarded, text: () => forwarded.join("") };
  };

  test("plain text with no markers forwards unchanged, in one call, no holdback", () => {
    const { filter, forwarded, text } = harness();
    filter("hello world");
    expect(forwarded).toEqual(["hello world"]); // one call = no latency from holdback
    expect(text()).toBe("hello world");
  });

  test("a bracketed paste (single chunk) is captured whole and never forwarded", () => {
    const { filter, pastes, forwarded } = harness();
    filter("before\x1b[200~pasted\ntext\x1b[201~after");
    expect(pastes).toEqual(["pasted\ntext"]);
    expect(forwarded.join("")).toBe("beforeafter"); // paste content never reaches the decoder
  });

  test("a paste split across many chunks is still captured whole", () => {
    const { filter, pastes } = harness();
    filter("\x1b[200~line one");
    filter("\nline two");
    filter("\nline three\x1b[201~");
    expect(pastes).toEqual(["line one\nline two\nline three"]);
  });

  test("the paste END marker split across chunks is still recognized", () => {
    const { filter, pastes } = harness();
    filter("\x1b[200~hi\x1b[201"); // marker cut mid-sequence
    filter("~"); // rest arrives next chunk
    expect(pastes).toEqual(["hi"]);
  });

  test("CRLF and lone-CR line endings in pasted text normalize to \\n", () => {
    const { filter, pastes } = harness();
    filter("\x1b[200~a\r\nb\rc\x1b[201~");
    expect(pastes).toEqual(["a\nb\nc"]);
  });

  test("both Shift+Enter encodings (kitty and xterm modifyOtherKeys) are recognized", () => {
    const { filter, shiftEnters, forwarded } = harness();
    filter("a\x1b[13;2ub\x1b[27;2;13~c");
    expect(shiftEnters).toEqual([true, true]);
    expect(forwarded.join("")).toBe("abc");
  });

  test("a marker split exactly at a chunk boundary doesn't leak partial bytes to forward()", () => {
    const { filter, shiftEnters, forwarded } = harness();
    filter("x\x1b[13;2"); // holds back the whole partial sequence
    filter("uy");
    expect(shiftEnters).toEqual([true]);
    expect(forwarded.join("")).toBe("xy");
  });

  test("an escape sequence that ISN'T one of ours (e.g. an arrow key) forwards through untouched", () => {
    const { filter, forwarded } = harness();
    filter("\x1b[A"); // up-arrow — not a recognized marker
    expect(forwarded.join("")).toBe("\x1b[A");
  });

  test("mixed: paste, then Shift+Enter, then plain typing, in the same stream", () => {
    const { filter, pastes, shiftEnters, forwarded } = harness();
    filter("\x1b[200~pasted\x1b[201~");
    filter("\x1b[13;2u");
    filter("typed");
    expect(pastes).toEqual(["pasted"]);
    expect(shiftEnters).toEqual([true]);
    expect(forwarded.join("")).toBe("typed");
  });
});

describe("createByteFilter — kitty CSI-u / modifyOtherKeys translation", () => {
  const harness = () => {
    const pastes = [];
    const shiftEnters = [];
    const forwarded = [];
    const filter = createByteFilter({
      onPaste: (t) => pastes.push(t),
      onShiftEnter: () => shiftEnters.push(true),
      forward: (t) => forwarded.push(t),
    });
    return { filter, pastes, shiftEnters, forwarded, text: () => forwarded.join("") };
  };

  test("kitty Alt+Cmd arrows stay semantic instead of losing Super", () => {
    const keys = [];
    const filter = createByteFilter({ onPaste() {}, onShiftEnter() {}, onModifiedKey: (key) => keys.push(key), forward() {} });
    filter("\x1b[57350;11u\x1b[57351;11u\x1b[57352;11u\x1b[57353;11u");
    expect(keys).toEqual(["alt+meta+left", "alt+meta+right", "alt+meta+up", "alt+meta+down"]);
  });

  test("kitty Cmd and Cmd+Shift arrows stay semantic too (legacy bytes top out at ctrl)", () => {
    const keys = [];
    const filter = createByteFilter({ onPaste() {}, onShiftEnter() {}, onModifiedKey: (key) => keys.push(key), forward() {} });
    // mod 9 = super; mod 10 = shift+super; mod 12 = alt+shift+super
    filter("\x1b[57350;9u\x1b[57351;9u\x1b[57352;10u\x1b[57353;10u\x1b[57350;12u");
    expect(keys).toEqual(["meta+left", "meta+right", "meta+shift+up", "meta+shift+down", "alt+meta+shift+left"]);
  });

  test("kitty protocol: ctrl+letter keys translate to control bytes", () => {
    const { filter, text } = harness();
    filter("\x1b[99;5u\x1b[100;5u\x1b[111;5u\x1b[120;5u"); // ^C ^D ^O ^X
    expect(text()).toBe("\x03\x04\x0f\x18");
  });

  test("kitty protocol: Enter/Backspace/Tab/Escape translate to legacy bytes", () => {
    const { filter, text } = harness();
    filter("\x1b[13u\x1b[127u\x1b[9u\x1b[27u");
    expect(text()).toBe("\r\x7f\t\x1b");
  });

  test("kitty protocol: functional keys preserve their specified order and modifiers", () => {
    const { filter, text } = harness();
    filter("\x1b[57350u\x1b[57351u\x1b[57352u\x1b[57353u"); // left, right, up, down
    expect(text()).toBe("\x1b[D\x1b[C\x1b[A\x1b[B");
    filter("\x1b[57350;4u\x1b[57351;7u\x1b[57354u\x1b[57357u");
    expect(text()).toEndWith("\x1b[1;4D\x1b[1;7C\x1b[5~\x1b[F");
  });

  test("kitty protocol: Alt+Backspace is ESC+DEL, Ctrl+Backspace is the ^W sentinel", () => {
    const { filter, text } = harness();
    filter("\x1b[127;3u\x1b[127;5u");
    expect(text()).toBe("\x1b\x7f\x17");
  });

  test("kitty protocol: Alt+letter/Enter keep Alt; Shift+Enter fires the callback", () => {
    const { filter, text, shiftEnters } = harness();
    filter("\x1b[98;3u\x1b[13;3u"); // alt+b, alt+enter
    expect(text()).toBe("\x1bb\x1b\r");
    filter("\x1b[13;2u"); // shift+enter
    expect(shiftEnters).toHaveLength(1);
  });

  test("modifyOtherKeys: ctrl keys translate; text around them is preserved in order", () => {
    const { filter, text } = harness();
    filter("ab\x1b[27;5;111~cd"); // typed ^O between letters
    expect(text()).toBe("ab\x0fcd");
  });

  test("a kitty sequence split across chunks still translates", () => {
    const { filter, text } = harness();
    filter("\x1b[99;");
    expect(text()).toBe(""); // held as an incomplete CSI
    filter("5u");
    expect(text()).toBe("\x03");
  });

  test("a lone ESC is forwarded immediately (never held hostage)", () => {
    const { filter, text } = harness();
    filter("\x1b");
    expect(text()).toBe("\x1b");
  });
});

describe("createByteFilter: SGR mouse reports", () => {
  test("a report becomes a mouse event and never reaches the decoder; split reports are held", () => {
    const forwarded = [];
    const mice = [];
    const filter = createByteFilter({ onPaste: () => {}, onShiftEnter: () => {}, forward: (b) => forwarded.push(b), onMouse: (e) => mice.push(e) });
    filter("ab\x1b[<0;12;3Mcd");
    expect(forwarded.join("")).toBe("abcd");
    expect(mice).toHaveLength(1);
    expect(mice[0]).toMatchObject({ x: 12, y: 3, press: true, button: 0 });
    filter("\x1b[<65;4"); // split across chunks
    filter(";9Mz");
    expect(mice[1]).toMatchObject({ wheel: "down", x: 4, y: 9 });
    expect(forwarded.join("")).toBe("abcdz");
  });
});
