// test/gtui-clipboard.test.js — proof for lib/gtui/clipboard.js
// (ported from lib/tui-helpers/clipboard.js, AI-TUI MIGRATION.md
// Phase 01 step 2): OSC 52 is the PRIMARY clipboard mechanism
// (assumed supported), the pbcopy/wl-copy/xclip tools are the
// fallback, and the tmux passthrough framing applies inside tmux.
// Never throws.
import { describe, expect, test, afterEach } from "bun:test";
import { copyToClipboard, osc52Copy } from "../lib/gtui/clipboard.js";

const TMUX = process.env.TMUX;
afterEach(() => {
  if (TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = TMUX;
});

describe("clipboard: OSC 52 primary", () => {
  test("with a terminal sink the escape sequence is emitted and the tools never run", async () => {
    const written = [];
    let toolCalls = 0;
    const ok = await copyToClipboard("hello clipboard", {
      write: (chunk) => written.push(chunk),
      run: async () => { toolCalls++; return 0; },
    });
    expect(ok).toBe(true);
    expect(toolCalls).toBe(0); // primary won — no tool spawned
    const sequence = written.join("");
    expect(sequence.startsWith("\x1b]52;c;")).toBe(true);
    expect(sequence.endsWith("\x07")).toBe(true);
    const payload = sequence.slice("\x1b]52;c;".length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("hello clipboard");
  });

  test("osc52: false skips the sequence and falls back to the tools", async () => {
    const written = [];
    const runs = [];
    const ok = await copyToClipboard("text", {
      write: (chunk) => written.push(chunk),
      osc52: false,
      run: async (cmd) => { runs.push(cmd); return cmd === "pbcopy" ? 0 : 1; },
    });
    expect(ok).toBe(true);
    expect(written).toEqual([]);
    expect(runs).toEqual(["pbcopy"]); // first tool accepted it
  });

  test("no terminal sink falls back to the tools; none available resolves false", async () => {
    const runs = [];
    const ok = await copyToClipboard("text", { run: async (cmd) => { runs.push(cmd); return 1; } });
    expect(ok).toBe(false);
    expect(runs).toEqual(["pbcopy", "wl-copy", "xclip", "xsel", "clip.exe"]);
    // the legacy bare-function form (run injectable) still works
    expect(await copyToClipboard("text", async () => 0)).toBe(true);
  });

  test("a failing sink falls back to the tools (never throws)", async () => {
    const ok = await copyToClipboard("text", {
      write: () => { throw new Error("no terminal"); },
      run: async () => 0,
    });
    expect(ok).toBe(true);
  });

  test("inside tmux the sequence is DCS-wrapped with doubled escapes", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";
    const written = [];
    expect(osc52Copy("tmux text", (chunk) => written.push(chunk))).toBe(true);
    const framed = written.join("");
    expect(framed.startsWith("\x1bPtmux;")).toBe(true);
    expect(framed.endsWith("\x1b\\")).toBe(true);
    expect(framed).toContain("\x1b\x1b]52;c;"); // escapes doubled for the passthrough
    delete process.env.TMUX;
    const plain = [];
    osc52Copy("x", (chunk) => plain.push(chunk));
    expect(plain.join("").startsWith("\x1b]52;c;")).toBe(true); // no framing outside tmux
  });
});
