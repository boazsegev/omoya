// test/text-safe.test.js — display sanitization of untrusted tool output.
import { describe, expect, test } from "bun:test";
const { sanitizeText, BashSanitizer } = await import(["..", "lib", "markdown.js"].join("/"));

describe("sanitizeText — escape/control stripping", () => {
  test("passes plain text through", () => {
    expect(sanitizeText("plain")).toBe("plain");
  });

  test("drops CSI sequences (clear screen, cursor home)", () => {
    expect(sanitizeText("\x1b[2Jclear\x1b[Hhome")).toBe("clearhome");
  });

  test("drops OSC hyperlinks (BEL- and ST-terminated)", () => {
    expect(sanitizeText("a\x1b]8;;http://evil\x07link\x1b]8;;\x07b")).toBe("alinkb");
    expect(sanitizeText("a\x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
  });

  test("drops DCS and charset/designate escapes", () => {
    expect(sanitizeText("\x1bP1;2|payload\x1b\\after")).toBe("after");
    expect(sanitizeText("\x1b(B\x1b#8x")).toBe("x");
  });

  test("normalizes CR and CRLF (progress bars) to newlines", () => {
    expect(sanitizeText("10%\r20%\rdone")).toBe("10%\n20%\ndone");
    expect(sanitizeText("a\r\nb")).toBe("a\nb");
  });

  test("drops C0 controls (except tab/LF), DEL, and C1", () => {
    expect(sanitizeText("bell\x07here")).toBe("bellhere");
    expect(sanitizeText("tab\tkept\nline")).toBe("tab\tkept\nline");
    expect(sanitizeText("del\x7fc1")).toBe("delc1");
  });

  test("drops a trailing incomplete escape", () => {
    expect(sanitizeText("tail\x1b[3")).toBe("tail");
    expect(sanitizeText("lone\x1b")).toBe("lone");
  });

  test("strips SGR by default (no markdown markers)", () => {
    expect(sanitizeText("x\x1b[1mbold\x1b[0my")).toBe("xboldy");
  });
});

describe("sanitizeText — SGR emphasis to Markdown", () => {
  test("converts bold, italic, underline", () => {
    expect(sanitizeText("x\x1b[1mbold\x1b[0my", { markdown: true })).toBe("x**bold**y");
    expect(sanitizeText("x\x1b[3mit\x1b[23my", { markdown: true })).toBe("x_it_y");
    expect(sanitizeText("x\x1b[4mu\x1b[24my", { markdown: true })).toBe("x__u__y");
  });

  test("nests styles bold-outmost, underline-innermost", () => {
    expect(sanitizeText("\x1b[1m\x1b[3mX\x1b[0m", { markdown: true })).toBe("**_X_**");
    expect(sanitizeText("\x1b[1m\x1b[4mX\x1b[0m", { markdown: true })).toBe("**__X__**");
    expect(sanitizeText("\x1b[3m\x1b[4mX\x1b[0m", { markdown: true })).toBe("___X___");
    expect(sanitizeText("\x1b[1m\x1b[3m\x1b[4mX\x1b[0m", { markdown: true })).toBe("**___X___**");
  });

  test("SGR is incremental: italic on preserves bold", () => {
    expect(sanitizeText("\x1b[1mA\x1b[3mB", { markdown: true })).toBe("**A_B_**");
  });

  test("drops SGR with untranslatable parameters (colors)", () => {
    expect(sanitizeText("\x1b[1;31mred\x1b[m", { markdown: true })).toBe("red");
    expect(sanitizeText("\x1b[32mgreen\x1b[0m", { markdown: true })).toBe("green");
  });
});

describe("BashSanitizer — streaming per-call instances", () => {
  test("holds a trailing lone ESC until the next chunk completes it", () => {
    const s = new BashSanitizer({ markdown: true });
    expect(s.push("part one\x1b")).toBe("part one");
    expect(s.push("[1mbold")).toBe("**bold");
    expect(s.push(" more\x1b[0m plain")).toBe(" more** plain");
    expect(s.end()).toBe("");
  });

  test("holds a partial CSI across chunks", () => {
    const s = new BashSanitizer();
    expect(s.push("a\x1b[32")).toBe("a");
    expect(s.push(";1mX")).toBe("X");
    expect(s.end()).toBe("");
  });

  test("holds a partial OSC across chunks and drops it", () => {
    const s = new BashSanitizer();
    expect(s.push("osc\x1b]8;;http://x")).toBe("osc");
    expect(s.push("\x07after")).toBe("after");
    expect(s.end()).toBe("");
  });

  test("drops an OSC that never terminates", () => {
    const s = new BashSanitizer();
    expect(s.push("unfinished\x1b]8;;http://x")).toBe("unfinished");
    expect(s.end()).toBe("");
  });

  test("balances a style left open when the stream ends", () => {
    const s = new BashSanitizer({ markdown: true });
    expect(s.push("\x1b[1mbold")).toBe("**bold");
    expect(s.end()).toBe("**");
  });

  test("concurrent instances keep separate look-back buffers and styles", () => {
    const a = new BashSanitizer({ markdown: true });
    const b = new BashSanitizer({ markdown: true });
    expect(a.push("a\x1b[1mb")).toBe("a**b");
    expect(b.push("c\x1b[3md")).toBe("c_d");
    expect(a.push("e\x1b[22mf")).toBe("e**f");
  });

  test("splitting input at ANY byte equals one-shot output", () => {
    const inputs = [
      "\x1b[1mA\x1b[3mB\x1b[23mC\x1b[22mD",
      "\x1b[1m\x1b[3m\x1b[4mX\x1b[0mY",
      "a\x1b]8;;http://x\x07b\x1b[1mc\x1b[0md",
      "10%\r\x1b[3m50%\x1b[23m\rdone",
    ];
    for (const input of inputs) {
      const expected = sanitizeText(input, { markdown: true });
      for (let cut = 0; cut <= input.length; cut++) {
        const s = new BashSanitizer({ markdown: true });
        expect(s.push(input.slice(0, cut)) + s.push(input.slice(cut)) + s.end()).toBe(expected);
      }
    }
  });
});
