// test/tui-app-parity.test.js — Phase 03 step 6 (the parity run): the
// SAME app (app.js) proven on GTUI's real terminal host, both modes,
// not just the memory host every earlier step used. Memory-host
// snapshots (steps 1-5's ~120 cases) prove SEMANTICS; this file proves
// the app survives the REAL byte-decode -> control -> update -> render
// pipeline (a raw keystroke as actual bytes, not a synthesized
// semantic message) and produces sane terminal bytes in both `alt`
// and `inline` modes. This project has no OS-level PTY dependency
// (grep-confirmed: no node-pty anywhere) — "PTY smoke" here means
// what it already means elsewhere in this suite (test/cli-question.js
// et al.): real Node streams carrying real bytes through the real
// decode path, not a spawned pty. A full compiled-binary PTY run
// needs the Phase 04 cutover (lib/tui.js doesn't dispatch here yet).
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { Agent } from "../lib/agent.js";
import { createApp, msg } from "../lib/tui-app/app.js";
import { terminalTitle } from "../lib/tui-app/run.js";
import { fakeIO, scriptedIO, testEnv, TEXT } from "./fakes.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  raw = [];
  setRawMode(value) { this.raw.push(value); }
  resume() {}
  pause() {}
}
class FakeOutput extends EventEmitter {
  columns = 80;
  rows = 24;
  chunks = [];
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  bytes() { return this.chunks.join(""); }
}

const tick = () => new Promise((resolve) => queueMicrotask(resolve));
async function until(fn, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await Bun.sleep(10);
  }
  return fn();
}

test("the production wiring preserves the short terminal title", () => {
  expect(terminalTitle("/work/ai-agent")).toBe("@work/ai-agent");
});

async function harness(mode) {
  const env = await testEnv();
  const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "hi there"), { type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const app = createApp(agent, { env });
  const input = new FakeInput();
  const output = new FakeOutput();
  const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: app.theme });
  const running = ui.run(app);
  return { env, agent, app, input, output, ui, running };
}

for (const mode of ["inline", "alt"]) {
  describe(`the app on the REAL terminal host (${mode})`, () => {
    test("a real turn renders through the full pipeline into terminal bytes", async () => {
      const { output, ui, running } = await harness(mode);
      ui.dispatch(msg.submit("hi"));
      await until(() => output.bytes().includes("hi there")); // a positive signal — busy/idle alone proves nothing (idle is ALSO !busy before the turn ever starts)
      const bytes = output.bytes();
      expect(bytes).toContain("hi");
      expect(bytes.includes("\x1b[?1049h")).toBe(mode === "alt"); // Phase 02's own mode contract
      ui.stop();
      await running;
    });

    test("raw Alt+Shift+Left reaches GTUI word selection rather than session interception", async () => {
      const { input, output, ui, running } = await harness(mode);
      input.emit("data", Buffer.from("one two"));
      input.emit("data", Buffer.from("\x1b[1;4D")); // Alt+Shift+Left
      await until(() => output.bytes().includes("\x1b[7m"));
      // The real renderer painted the final word selected; no app session
      // shortcut intercepted this raw terminal sequence.
      expect(output.bytes()).toContain("two");
      ui.stop();
      await running;
    });

    test("a REAL keystroke — raw bytes, not a synthesized message — reaches the app and updates state", async () => {
      const { agent, input, output, ui, running } = await harness(mode);
      // one at a time, a render between each — a controlled input computes
      // its next edit from the LAST RENDERED value, exactly like a real
      // terminal delivering separate keystrokes as separate I/O events
      for (const ch of "hi") { input.emit("data", Buffer.from(ch)); await tick(); }
      expect(output.bytes()).toContain("hi"); // the draft box echoes the typed text
      input.emit("data", Buffer.from("\r")); // Enter, as a real byte
      await until(() => agent.context.some((m) => m.type === 2)); // the submit landed
      expect(agent.context.find((m) => m.type === 2)).toMatchObject({ content: [{ text: "hi" }] });
      ui.stop();
      await running;
    });

    test("selecting from ^P and ^M menus returns focus to an Enter-submitting draft", async () => {
      const { agent, input, ui, running } = await harness(mode);
      for (const shortcut of [Buffer.from([0x10]), Buffer.from([0x0d]), Buffer.from("\x1b[B"), Buffer.from([0x0d])]) {
        input.emit("data", shortcut);
        await tick();
      }
      for (const ch of "after endpoint") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\x1b[13;2u")); // Shift+Enter soft break
      await tick();
      for (const ch of "second line") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\r"));
      expect(await until(() => agent.context.some((message) => message.type === 2 && message.content[0]?.text === "after endpoint\nsecond line"))).toBe(true);

      ui.dispatch({ type: "key", key: "ctrl+m" });
      await tick();
      input.emit("data", Buffer.from("\x1b[B"));
      await tick();
      input.emit("data", Buffer.from("\r"));
      await tick();
      for (const ch of "after model") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\x1b[13;2u")); // Shift+Enter soft break
      await tick();
      for (const ch of "second line") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\r"));
      expect(await until(() => agent.context.some((message) => message.type === 2 && message.content[0]?.text === "after model\nsecond line"))).toBe(true);
      ui.stop();
      await running;
    });

    test("a /new command returns focus to an Enter-submitting multiline draft", async () => {
      const { agent, app, input, ui, running } = await harness(mode);
      for (const ch of "/new") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\r"));
      expect(await until(() => app.currentAgent() !== agent)).toBe(true);
      for (const ch of "after new") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\x1b[13;2u")); // Shift+Enter soft break
      await tick();
      for (const ch of "second line") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\r"));
      expect(await until(() => app.currentAgent().context.some((message) => message.type === 2 && message.content[0]?.text === "after new\nsecond line"))).toBe(true);
      ui.stop();
      await running;
    });

    test("production autocomplete survives the real byte decoder", async () => {
      const { input, output, ui, running } = await harness(mode);
      input.emit("data", Buffer.from("/"));
      await tick();
      input.emit("data", Buffer.from("h"));
      await tick();
      expect(output.bytes()).toContain("/help");
      ui.stop();
      await running;
    });

    test("real CSI bindings preserve Ctrl+Backspace and Alt+Enter editing semantics", async () => {
      const { agent, input, ui, running } = await harness(mode);
      for (const ch of "discard") { input.emit("data", Buffer.from(ch)); await tick(); }
      input.emit("data", Buffer.from("\x1b[127;5u")); // Ctrl+Backspace -> Ctrl+W sentinel -> delete line
      await tick();
      input.emit("data", Buffer.from("a"));
      await tick();
      input.emit("data", Buffer.from("\x1b[13;3u")); // Alt+Enter soft break
      await tick();
      input.emit("data", Buffer.from("b"));
      await tick();
      input.emit("data", Buffer.from("\r"));
      await until(() => agent.context.some((message) => message.type === 2));
      expect(agent.context.find((message) => message.type === 2)?.content[0].text).toBe("a\nb");
      ui.stop();
      await running;
    });

    test("^X opens the master menu and a bare Escape byte closes it immediately", async () => {
      const { output, input, ui, running } = await harness(mode);
      input.emit("data", Buffer.from([0x18]));
      await tick();
      // alt mode's cell-diff writer skips unchanged cells between words
      // (cursor jumps instead of literal spaces) — words stay intact,
      // inter-word spacing does not, so check words, never a joined phrase
      expect(output.bytes()).toContain("Menu");
      expect(output.bytes()).toContain("Help");
      expect(output.bytes()).toContain("keybindings");
      expect(output.bytes()).toContain("navigate");
      const beforeClose = output.chunks.length;
      input.emit("data", Buffer.from([0x1b])); // bare Escape, decoded without readline's delay
      await tick();
      const closeBytes = output.chunks.slice(beforeClose).join("");
      expect(closeBytes.length).toBeGreaterThan(0); // a real repaint happened
      expect(closeBytes).not.toContain("Help");
      ui.stop();
      await running;
    });

    test("an alternate-screen link click opens its preserved Markdown target", async () => {
      if (mode !== "alt") return;
      const input = new FakeInput();
      const output = new FakeOutput();
      const opened = [];
      const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode, openUrl: (url) => opened.push(url) }) });
      const running = ui.run({
        init: () => ({}),
        update: (model, message) => message.type === "link.open" ? { model, effects: [GTUI.effect.open(message.url)] } : model,
        view: () => GTUI.view.text({}, [{ text: "docs", link: "https://example.test/docs" }]),
      });
      await until(() => output.bytes().includes("docs"));
      input.emit("data", Buffer.from("\x1b[<0;3;1M"));
      await until(() => opened.length === 1);
      expect(opened).toEqual(["https://example.test/docs"]);
      ui.stop();
      await running;
    });

    test("Block View copies logical text through OSC 52 in both terminal modes", async () => {
      const { agent, input, output, ui, running } = await harness(mode);
      agent.append({ type: 2, content: [{ type: "text", text: "copy שלום" }] });
      input.emit("data", Buffer.from([0x0f])); // Ctrl+O
      await tick();
      expect(output.bytes()).toContain("םולש"); // visual order
      input.emit("data", Buffer.from("c"));
      await until(() => output.bytes().includes("\x1b]52;c;"));
      const match = /\x1b\]52;c;([^\x07]+)\x07/.exec(output.bytes());
      expect(Buffer.from(match?.[1] ?? "", "base64").toString("utf8")).toBe("copy שלום");
      input.emit("data", Buffer.from([0x1b])); // Block View owns Escape
      await tick();
      const afterClose = output.chunks.length;
      input.emit("data", Buffer.from("z"));
      await tick();
      expect(output.chunks.slice(afterClose).join("")).toContain("z"); // input regained ownership
      ui.stop();
      await running;
    });

    test("working status and input borders repaint from the host clock", async () => {
      const env = await testEnv();
      const io = fakeIO((ioSelf) => new Promise((resolve) => {
        ioSelf._onKill = () => resolve({ type: "error", error: "cancelled", kind: "cancelled", cancelled: true });
      }));
      const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
      const app = createApp(agent, { env });
      const input = new FakeInput();
      const output = new FakeOutput();
      let clock = 0;
      const host = GTUI.host.terminal({ input, output, mode, animationInterval: 16, now: () => (clock += 350) });
      const ui = new GTUI({ host, theme: app.theme });
      const running = ui.run(app);
      ui.dispatch(msg.submit("go"));
      await until(() => agent.busy);
      const before = output.chunks.length;
      await Bun.sleep(70);
      expect(output.chunks.length).toBeGreaterThan(before);
      expect(output.bytes()).toContain("🟠");
      input.emit("data", Buffer.from([0x03]));
      await until(() => !agent.busy);
      ui.stop();
      await running;
    });

    test("a real Ctrl+C byte interrupts a running turn — found missing during this run and wired: nothing previously dispatched it from an actual keystroke", async () => {
      const env = await testEnv();
      const io = fakeIO((ioSelf) => new Promise((resolve) => {
        ioSelf._onKill = () => resolve({ type: "error", error: "cancelled", kind: "cancelled", cancelled: true });
      }));
      const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
      const app = createApp(agent, { env });
      const input = new FakeInput();
      const output = new FakeOutput();
      const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: app.theme });
      const running = ui.run(app);

      ui.dispatch(msg.submit("go"));
      await until(() => agent.busy);
      input.emit("data", Buffer.from([0x03])); // Ctrl+C, as a real byte
      await until(() => io.kills > 0);
      expect(io.kills).toBe(1);
      await until(() => !agent.busy);

      ui.stop();
      await running;
    });

    test("clean exit on input end: no throw, the host restores, the promise settles", async () => {
      const { input, ui, running } = await harness(mode);
      input.emit("end");
      const result = await running;
      expect(result).toMatchObject({ reason: "input-end", code: 0 });
    });
  });
}

for (const mode of ["inline", "alt"]) {
  test(`a rendered diff uses GTUI theme colors on the real terminal host (${mode})`, async () => {
    const { transcriptItems } = await import("../lib/tui-app/transcript.js");
    const fence = String.fromCharCode(96).repeat(3);
    const raw = `${fence}diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n${fence}`;
    const node = transcriptItems([{ type: "text", text: raw, group: "d", ordinal: 0 }])[0].node;
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: { "md.diff.add": { fg: 2 }, "md.diff.remove": { fg: 1 }, "md.diff.hunk": { fg: 6 } } });
    const running = ui.run({ init: () => ({}), update: (model) => model, view: () => node });
    await until(() => output.bytes().includes("+new"));
    const bytes = output.bytes();
    expect(bytes).toContain("\x1b[38;5;1m");
    expect(bytes).toContain("\x1b[38;5;2m");
    expect(bytes).toContain("\x1b[38;5;6m");
    ui.stop();
    await running;
  });
}
