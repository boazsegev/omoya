import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { createBuffer } from "../lib/gtui/buffer.js";
import { renderDiff } from "../lib/gtui/render.js";
import { terminalHostInternals } from "../lib/gtui/terminal-host.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  raw = [];
  setRawMode(value) { this.raw.push(value); }
  resume() {}
  pause() {}
}
class FakeOutput extends EventEmitter {
  columns = 12;
  rows = 4;
  chunks = [];
  write(chunk) { this.chunks.push(String(chunk)); }
  bytes() { return this.chunks.join(""); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function application(view, update = (model) => ({ model, effects: [] })) {
  return { init: () => ({ model: {}, effects: [] }), update, view };
}

describe("GTUI terminal alt host", () => {
  test("renders configured scrollbar glyphs in overflowing alt scrolls and preserves teardown", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const host = GTUI.host.terminal({ input, output, mode: "alt", scrollBar: { track: "|", thumb: "#" } });
    const ui = new GTUI({ host, theme: { text: {}, "scroll.track": { fg: 2 }, "scroll.thumb": { fg: 3 } } });
    let model = { offset: 0 };
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change") model = { offset: message.offset };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "viewer", focus: true, offset: current.offset }, [
        GTUI.view.column({}, Array.from({ length: 10 }, (_, index) => GTUI.view.text({ margin: 0 }, `line ${index}`))),
      ]),
    });
    expect(output.bytes()).toContain("\x1b[38;5;2m|");
    expect(output.bytes()).toContain("\x1b[38;5;3m#");
    const beforeScroll = output.chunks.length;
    input.emit("data", Buffer.from("\x1b[<65;12;2M\x1b[<65;12;2M\x1b[<65;12;2M"));
    await tick();
    await tick();
    const diff = output.chunks.slice(beforeScroll).join("");
    expect(diff).toContain("\x1b[1;12H\x1b[0m\x1b[38;5;2m|");
    expect(diff).toContain("\x1b[3;12H\x1b[0m\x1b[38;5;3m#");
    ui.stop();
    await running;
    expect(output.bytes()).toEndWith("\x1b[?1049l");
  });

  test("applies a theme global background on the alternate screen then restores terminal defaults", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }), theme: { text: {}, background: { bg: "#102030" } } });
    const running = ui.run(application(() => GTUI.view.text({ margin: 0 }, "themed")));
    expect(output.bytes()).toContain("\x1b]11;#102030\x07");
    ui.stop();
    await running;
    expect(output.bytes()).toContain("\x1b]111\x07");
  });

  test("updates the alternate-screen canvas when a live theme effect changes background", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }), theme: { text: {}, background: { bg: "#102030" } } });
    const running = ui.run({
      init: () => ({ model: {}, effects: [GTUI.effect.theme({ text: {}, background: { bg: "#304050" } })] }),
      update: (model) => ({ model, effects: [] }), view: () => GTUI.view.text({ margin: 0 }, "themed"),
    });
    expect(output.bytes()).toContain("\x1b]11;#304050\x07");
    ui.stop();
    await running;
  });

  test("wheel over a sticky input scrolls the keyboard-enabled transcript", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let model = { offset: 2, value: "" };
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }) });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update(current, message) {
        if (message.type === "scroll.change") model = { ...current, offset: message.offset };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.column({}, [
        GTUI.view.scroll({ id: "history", anchor: "end", offset: current.offset, keyboard: true, priority: 0 }, [
          GTUI.view.column({}, Array.from({ length: 10 }, (_, index) => GTUI.view.text({ margin: 0 }, `line ${index}`))),
        ]),
        GTUI.view.input({ id: "draft", value: current.value, caret: 0, focus: true, priority: 10 }),
      ]),
    });
    // Row four belongs to the fixed input, not the transcript. A wheel there
    // must still drive the application's keyboard-enabled history viewport.
    input.emit("data", Buffer.from("\x1b[<65;2;4M"));
    expect(model.offset).toBe(1);
    ui.stop();
    await running;
  });

  test("fit content and show:false emit no scrollbar glyphs or gutter bytes", async () => {
    for (const scrollBar of [{ track: "|", thumb: "#" }, { show: false, track: "|", thumb: "#" }]) {
      const input = new FakeInput();
      const output = new FakeOutput();
      const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt", scrollBar }) });
      const running = ui.run(application(() => GTUI.view.scroll({ id: "fit" }, [GTUI.view.text({ margin: 0 }, "abcdefghijkl")])));
      expect(output.bytes()).not.toContain("|");
      expect(output.bytes()).not.toContain("#");
      expect(output.bytes()).toContain("abcdefghijkl");
      ui.stop();
      await running;
    }
  });

  test("resize toggles the alt scrollbar and repaints stale track cells", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.rows = 12;
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt", scrollBar: { track: "|", thumb: "#" } }) });
    const running = ui.run(application(() => GTUI.view.scroll({ id: "doc", anchor: "end" }, [
      GTUI.view.column({}, Array.from({ length: 6 }, (_, index) => GTUI.view.text({ margin: 0 }, `row ${index}`))),
    ])));
    expect(output.bytes()).not.toContain("#");
    output.rows = 4;
    output.emit("resize");
    await tick();
    expect(output.bytes()).toContain("#");
    const afterOverflow = output.bytes().length;
    output.rows = 12;
    output.emit("resize");
    await tick();
    expect(output.bytes().slice(afterOverflow)).not.toContain("#");
    ui.stop();
    await running;
  });

  test("wheel pointer resolution keeps wheel semantics and the resolved control target", () => {
    const controls = { resolvePoint: () => ({ kind: "press", target: "transcript", index: 4 }) };
    expect(terminalHostInternals.rawPointer(controls, { wheel: "up", x: 2, y: 3 })).toEqual({
      type: "pointer", kind: "wheel", direction: "up", target: "transcript", index: 4, x: 1, y: 2,
    });
  });

  test("idle alt animation writes its changed frame without an application render", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let time = 0;
    const timers = [];
    const terminal = GTUI.host.terminal({
      input, output, mode: "alt", now: () => time,
      setTimeout(callback, delay, state) { const timer = { callback, delay, state, cancelled: false }; timers.push(timer); return timer; },
      clearTimeout(timer) { timer.cancelled = true; },
    });
    const ui = new GTUI({ host: terminal, theme: { text: {}, busy: { fg: 1, animation: { type: "flash", role: "accent", period: 20 } }, accent: { fg: 2 } } });
    const running = ui.run(application(() => GTUI.view.text({ margin: 0, role: "busy" }, "idle")));
    const before = output.chunks.length;
    time = 20;
    const timer = timers.find((entry) => !entry.cancelled);
    timer.callback(timer.state);
    expect(output.chunks.length).toBeGreaterThan(before);
    expect(output.chunks.slice(before).join("")).toContain("\x1b[38;5;1m");
    ui.stop();
    await running;
  });

  test("host-clock animation frames reuse mounted geometry in both modes", async () => {
    for (const mode of ["inline", "alt"]) {
      const input = new FakeInput();
      const output = new FakeOutput();
      let childReads = 0;
      const children = [GTUI.view.input({ id: "draft", value: "", caret: 0, focus: true, active: true })];
      const root = { type: "column", get children() { childReads++; return children; } };
      const terminal = GTUI.host.terminal({ input, output, mode, animationInterval: 5 });
      const ui = new GTUI({ host: terminal, theme: {
        text: {}, accent: { fg: 6 },
        "input.border.active.top": { animation: { type: "flash", role: "accent", period: 1 } },
        "input.border.active.bottom": { animation: { type: "flash", role: "accent", period: 1 } },
      } });
      const running = ui.run(application(() => root));
      const mountedReads = childReads;
      await Bun.sleep(30);
      expect(childReads, `${mode} animation relaid out the view tree`).toBe(mountedReads);
      ui.stop();
      await running;
    }
  });

  test("one raw typing burst mounts each controlled key but commits one terminal frame", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }) });
    const running = ui.run({
      init: () => ({ model: { value: "", caret: 0 }, effects: [] }),
      update(model, message) {
        if (message.type === "input.change") return { model: { value: message.value, caret: message.caret }, effects: [] };
        return { model, effects: [] };
      },
      view: (model) => GTUI.view.input({ id: "draft", focus: true, ...model }),
    });
    const before = output.chunks.length;
    input.emit("data", Buffer.from("ab"));
    expect(output.chunks.length - before).toBe(1);
    expect(output.bytes()).toContain("ab");
    ui.stop();
    await running;
  });

  test("a quit in an input burst cannot paint after terminal restoration", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }) });
    const running = ui.run({
      init: () => ({ model: { value: "" }, effects: [] }),
      update(model, message) {
        if (message.type === "input.change") return { model: { value: message.value }, effects: [] };
        if (message.type === "key" && message.key === "ctrl+c") return { model, effects: [GTUI.effect.quit()] };
        return { model, effects: [] };
      },
      view: (model) => GTUI.view.input({ id: "draft", focus: true, caret: model.value.length, ...model }),
    });
    input.emit("data", Buffer.from("a\x03"));
    await running;
    const leave = output.bytes().lastIndexOf("\x1b[?1049l");
    expect(leave).toBeGreaterThan(0);
    expect(output.bytes().slice(leave)).not.toContain("\x1b[?2026h");
  });

  test("owns 1049 lifecycle, sync/title/cursor/mouse/raw mode, resize, and clean restoration", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = GTUI.host.terminal({ input, output, mode: "alt", title: "test" });
    const ui = new GTUI({ host: terminal });
    const running = ui.run(application(() => GTUI.view.text({ role: "accent" }, "hello")));
    expect(output.bytes()).toContain("\x1b[?1049h");
    expect(output.bytes()).toContain("\x1b[?2026h");
    expect(output.bytes()).toContain("\x1b]0;test\x07");
    expect(output.bytes()).toContain("\x1b[?1006h");
    const started = output.bytes();
    expect(started.indexOf("\x1b[?1049h")).toBeLessThan(started.indexOf("\x1b[=1u"));
    expect(input.raw).toEqual([true]);
    output.emit("resize");
    ui.stop();
    await running;
    expect(output.bytes()).toContain("\x1b[?1049l");
    expect(output.bytes()).toContain("\x1b[?1006l");
    const restored = output.bytes();
    expect(restored.lastIndexOf("\x1b[=0u")).toBeLessThan(restored.lastIndexOf("\x1b[?1049l"));
    expect(input.raw).toEqual([true, false]);
  });

  test("mouse drag plus terminal copy writes selected transcript text", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }) });
    const running = ui.run({
      init: () => ({ model: {}, effects: [] }),
      update: (model, message) => message.type === "selection.copy"
        ? { model, effects: [GTUI.effect.copy(message.text, "selected")] }
        : { model, effects: [] },
      view: () => GTUI.view.text({ margin: 0, selectionKey: "message", sourceText: "copy" }, [
        { text: "copy", source: { start: 0, end: 4 } },
      ]),
    });
    input.emit("data", Buffer.from("\x1b[<0;1;1M"));
    input.emit("data", Buffer.from("\x1b[<32;4;1M"));
    input.emit("data", Buffer.from("\x1b[<0;4;1m"));
    input.emit("data", Buffer.from("\x1b[99;9u")); // Kitty Super+C
    await tick();
    await tick();
    const encoded = /\x1b\]52;c;([^\x07]+)\x07/.exec(output.bytes())?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("copy");
    ui.stop();
    await running;
  });

  test("mouse drag plus terminal copy writes selected input text", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }) });
    const running = ui.run({
      init: () => ({ model: { value: "hello", caret: 5, selection: null }, effects: [] }),
      update(model, message) {
        if (message.type === "input.change") return { model: { ...model, caret: message.caret, selection: message.selection }, effects: [] };
        if (message.type === "key" && message.key === "copy" && model.selection) {
          const start = Math.min(model.selection.anchor, model.selection.caret);
          const end = Math.max(model.selection.anchor, model.selection.caret);
          return { model, effects: [GTUI.effect.copy(model.value.slice(start, end), "input-selected")] };
        }
        return { model, effects: [] };
      },
      view: (model) => GTUI.view.input({ id: "draft", focus: true, ...model }),
    });
    input.emit("data", Buffer.from("\x1b[<0;4;2M"));
    input.emit("data", Buffer.from("\x1b[<32;7;2M"));
    input.emit("data", Buffer.from("\x1b[<0;7;2m"));
    input.emit("data", Buffer.from("\x1b[99;9u"));
    await tick();
    await tick();
    const encoded = /\x1b\]52;c;([^\x07]+)\x07/.exec(output.bytes())?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("ell");
    ui.stop();
    await running;
  });

  test("input cursor properties select shape and the default 450 ms half-period", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }) });
    const running = ui.run(application(() => GTUI.view.input({ id: "draft", value: "x", caret: 1, focus: true })));
    // The host makes a line cursor steady and toggles visibility itself
    // every 450 ms, so the default does not inherit terminal blink speed.
    expect(output.bytes()).toContain("\x1b[6 q");
    ui.stop();
    await running;

    const customInput = new FakeInput();
    const customOutput = new FakeOutput();
    const custom = new GTUI({ host: GTUI.host.terminal({ input: customInput, output: customOutput, mode: "alt" }) });
    const customRunning = custom.run(application(() => GTUI.view.input({
      id: "draft", value: "x", caret: 1, focus: true, cursor: { shape: "underline", blinkMs: false },
    })));
    expect(customOutput.bytes()).toContain("\x1b[4 q");
    custom.stop();
    await customRunning;
  });

  test("diffs cells, renders panel borders, resets SGR, and supports 256/RGB colors", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = GTUI.host.terminal({ input, output, mode: "alt" });
    const ui = new GTUI({ host: terminal, theme: { text: {}, border: { fg: "ansi:33" }, accent: { fg: "#112233", bold: true } } });
    const running = ui.run(application(() => GTUI.view.panel({ title: "x" }, [GTUI.view.text({ role: "accent" }, "ok")])));
    const bytes = output.bytes();
    expect(bytes).toContain("┌");
    expect(bytes).toContain("38;5;33");
    expect(bytes).toContain("38;2;17;34;51");
    expect(bytes).toContain("\x1b[0m");
    ui.stop();
    await running;
  });

  test("restores and resolves on input end or signal", async () => {
    for (const ending of ["end", "signal"]) {
      const input = new FakeInput();
      const output = new FakeOutput();
      const signals = new EventEmitter();
      const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt", signals }) });
      const running = ui.run(application(() => GTUI.view.text({}, "ok")));
      if (ending === "end") input.emit("end");
      else signals.emit("SIGINT");
      await expect(running).resolves.toMatchObject({ reason: ending === "end" ? "input-end" : "signal" });
      expect(output.bytes()).toContain("\x1b[?1049l");
    }
  });

  test("restores after view throws", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "alt" }) });
    await expect(ui.run(application(() => { throw new Error("boom"); }))).rejects.toThrow("boom");
    expect(output.bytes()).toContain("\x1b[?1049l");
    expect(input.raw).toEqual([true, false]);
  });

  test("safe-final-column buffers never write a wide glyph past the edge", () => {
    const buffer = createBuffer(3, 1);
    buffer.text(2, 0, "界");
    const bytes = renderDiff(buffer);
    expect(bytes).not.toContain("界");
  });
});
