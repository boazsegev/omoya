import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createTheme } from "../lib/gtui/theme.js";
import { GTUI } from "../lib/gtui/gtui.js";
import { createInlineTerminalRenderer, inlineHostInternals } from "../lib/gtui/terminal-inline-host.js";
import { TerminalScreen } from "./terminal-screen.js";

const plain = (bytes) => bytes.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const tick = () => new Promise((resolve) => setImmediate(resolve));
class FakeInput extends EventEmitter {
  isTTY = true;
  raw = [];
  setRawMode(value) { this.raw.push(value); }
  resume() {}
  pause() {}
}
class FakeOutput extends EventEmitter {
  columns = 20;
  rows = 8;
  chunks = [];
  write(chunk) { this.chunks.push(String(chunk)); }
  bytes() { return this.chunks.join(""); }
}

function app() {
  return {
    init: () => ({ model: { items: [{ key: "one", done: true, node: GTUI.view.text({}, "one") }], draft: "" }, effects: [] }),
    update(model, message) {
      if (message.type === "grow") return { model: { ...model, items: [...model.items, message.item] }, effects: [] };
      if (message.type === "refresh") return { model, effects: [GTUI.effect.refresh()] };
      return { model, effects: [] };
    },
    view: (model) => GTUI.view.column({}, [
      GTUI.view.feed({ id: "feed", items: model.items }),
      GTUI.view.input({ id: "draft", focus: true, value: model.draft, caret: 0 }),
    ]),
  };
}

describe("GTUI terminal inline host", () => {
  test("retains completed feed nodes only while an end-anchored scroll is above the tail", () => {
    const root = (offset) => GTUI.view.scroll({ id: "history", anchor: "end", offset }, [GTUI.view.feed({ items: [{ key: "old", done: true, node: GTUI.view.text({}, "old") }] })]);
    const retained = [];
    inlineHostInternals.transform(root(0), (items, state) => { retained.push(state.retain); return items; });
    inlineHostInternals.transform(root(10), (items, state) => { retained.push(state.retain); return items; });
    expect(retained).toEqual([false, true]);
  });

  test("measures committed nodes compactly and bottom-aligns the live viewport", () => {
    const theme = { resolve: () => ({}) };
    const oneLine = inlineHostInternals.rowsFor(GTUI.view.text({ margin: 0 }, "one"), 80, theme);
    expect(oneLine.rows).toEqual(["one"]);
    expect(oneLine.scene.canvas.height).toBe(1); // committed nodes never allocate a 4096-row canvas
    const live = inlineHostInternals.rowsFor(GTUI.view.text({ margin: 0 }, "bottom"), 20, theme, undefined, 6, 0, "end");
    expect(live.rows).toEqual(["", "", "", "", "", "bottom"]);
  });

  test("fills a styled text row with its background in inline mode", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 2 });
    const theme = createTheme({ text: {}, highlighted: { fg: "#ffffff", bg: "#123456" } });
    renderer.render(GTUI.view.text({ margin: 0, role: "highlighted" }, "x"), theme, { width: 6, height: 1 });
    expect(writes.at(-1)).toContain("\x1b[38;2;255;255;255;48;2;18;52;86m");
    expect(plain(writes.at(-1))).toContain("x    ");
  });

  test("leaves the physical final column unused so repaint cannot autowrap", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 20;
    output.rows = 4;
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "inline" }) });
    const running = ui.run({
      init: () => ({ model: {}, effects: [] }),
      update: (model) => ({ model, effects: [] }),
      view: () => GTUI.view.text({ margin: 0 }, "x".repeat(20)), 
    });
    expect(output.bytes()).toContain("x".repeat(19));
    expect(output.bytes()).not.toContain("x".repeat(20));
    ui.stop();
    await running;
  });

  test("one raw typing burst mounts both keys and commits one inline frame", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "inline" }) });
    const running = ui.run({
      init: () => ({ model: { draft: "", caret: 0 }, effects: [] }),
      update(model, message) {
        if (message.type === "input.change") return { model: { draft: message.value, caret: message.caret }, effects: [] };
        return { model, effects: [] };
      },
      view: (model) => GTUI.view.input({ id: "draft", focus: true, value: model.draft, caret: model.caret }),
    });
    const before = output.chunks.length;
    input.emit("data", Buffer.from("ab"));
    expect(output.chunks.length - before).toBe(1);
    expect(output.bytes()).toContain("ab");
    ui.stop();
    await running;
  });

  test("an inline render throw clears frame buffering before terminal restoration", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "inline" }) });
    const running = ui.run({
      init: () => ({ model: { crash: false }, effects: [] }),
      update: (model, message) => message.type === "input.change"
        ? { model: { crash: true }, effects: [] }
        : { model, effects: [] },
      view: (model) => {
        if (model.crash) throw new Error("inline frame failure");
        return GTUI.view.input({ id: "draft", focus: true, value: "", caret: 0 });
      },
    });
    input.emit("data", Buffer.from("a"));
    await expect(running).rejects.toThrow("inline frame failure");
    expect(input.raw).toEqual([true, false]);
    expect(output.bytes()).toContain("\x1b[?2004l");
    expect(output.bytes()).toContain("\x1b[=0u");
  });

  test("an unused input-boundary arrow does not repaint the live region", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "inline" }) });
    const running = ui.run(app());
    const before = output.chunks.length;
    input.emit("data", Buffer.from("\x1b[A"));
    await tick();
    expect(output.chunks.length).toBe(before);
    ui.stop();
    await running;
  });

  test("sizes an under-full live canvas to content without blank history gaps", () => {
    const output = new TerminalScreen(20, 8);
    const renderer = createInlineTerminalRenderer({ write: (bytes) => output.write(bytes), rows: () => 8 });
    const root = (count) => GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", offset: 0 }, [GTUI.view.feed({ id: "feed", items: [{
        key: "assistant", revision: count, done: false,
        node: GTUI.view.column({}, Array.from({ length: count }, (_, index) => GTUI.view.text({ margin: 0 }, `stream ${index}`))),
      }] })]),
      GTUI.view.input({ id: "draft", focus: true, value: "", caret: 0 }),
    ]);
    renderer.render(root(3), createTheme(), { width: 20, height: 8 });
    expect(output.lines().slice(0, 4)).toEqual(["stream 0", "stream 1", "stream 2", ""]);
    renderer.render(root(4), createTheme(), { width: 20, height: 8 });
    const physical = [...output.history, ...output.lines()].filter(Boolean);
    expect(physical).toEqual(["stream 0", "stream 1", "stream 2", "stream 3"]);
  });

  test("commits a live oversized message without capping native history", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 4 });
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`);
    const item = { key: "large", done: false, node: GTUI.view.column({}, lines.map((line) => GTUI.view.text({ margin: 0 }, line))) };
    const root = GTUI.view.column({}, [
      GTUI.view.feed({ id: "feed", items: [item] }),
      GTUI.view.input({ id: "draft", focus: true, value: "", caret: 0 }),
    ]);
    renderer.render(root, createTheme(), { width: 20, height: 4 });
    const first = plain(writes.at(-1));
    for (const line of lines) expect(first.match(new RegExp(`${line}(?!\\d)`, "g"))?.length).toBe(1);
    renderer.render(root, createTheme(), { width: 20, height: 4 });
    expect(writes.at(-1)).toBe("");
  });

  test("streams a soft-wrapped message prefix into native history", () => {
    const output = new TerminalScreen(20, 4);
    const renderer = createInlineTerminalRenderer({ write: (bytes) => output.write(bytes), rows: () => 4 });
    const root = (words) => GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", offset: 0 }, [GTUI.view.feed({ id: "feed", items: [{
        key: "assistant", revision: words.length, done: false,
        node: GTUI.view.column({}, [GTUI.view.text({ margin: 0 }, words.join(" "))]),
      }] })]),
      GTUI.view.input({ id: "draft", focus: true, value: "", caret: 0 }),
    ]);
    const words = Array.from({ length: 24 }, (_, index) => `word${index}`);
    for (let count = 4; count <= words.length; count += 4) renderer.render(root(words.slice(0, count)), createTheme(), { width: 20, height: 4 });
    const physical = `${output.history.join("\n")}\n${output.text()}`;
    expect(physical).toContain("word0");
    expect(physical).toContain("word23");
  });

  test("preserves native history while an oversized live message streams", () => {
    const output = new TerminalScreen(20, 4);
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => { writes.push(bytes); output.write(bytes); }, rows: () => 4 });
    const root = (count) => GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", offset: 0 }, [GTUI.view.feed({ id: "feed", items: [{
        key: "assistant", revision: count, done: false,
        node: GTUI.view.column({}, Array.from({ length: count }, (_, index) => GTUI.view.text({ margin: 0 }, `stream ${index}`))),
      }] })]),
      GTUI.view.input({ id: "draft", focus: true, value: "", caret: 0 }),
    ]);
    renderer.render(root(6), createTheme(), { width: 20, height: 4 });
    const afterFirst = writes.length;
    renderer.render(root(7), createTheme(), { width: 20, height: 4 });
    renderer.render(root(8), createTheme(), { width: 20, height: 4 });
    expect(writes.slice(afterFirst).join("")).not.toContain("\x1b[3J\x1b[2J\x1b[H");
    const all = `${output.history.join("\n")}\n${output.text()}`;
    for (let index = 0; index < 8; index++) {
      expect(all.match(new RegExp(`stream ${index}(?!\\d)`, "g"))?.length).toBe(1);
    }
  });

  test("commits a completed oversized message through the real scroll viewport", () => {
    const output = new TerminalScreen(20, 5);
    const renderer = createInlineTerminalRenderer({ write: (bytes) => output.write(bytes), rows: () => 5 });
    const lines = Array.from({ length: 10 }, (_, index) => `answer ${index}`);
    const item = { key: "assistant", done: true, node: GTUI.view.column({}, lines.map((line) => GTUI.view.text({ margin: 0 }, line))) };
    const root = GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", offset: 0 }, [GTUI.view.feed({ id: "feed", items: [item] })]),
      GTUI.view.input({ id: "draft", focus: true, value: "", caret: 0 }),
    ]);
    renderer.render(root, createTheme(), { width: 20, height: 5 });
    expect(output.history.join("\n")).toContain("answer 0");
    expect(output.text()).toContain("answer 9");
  });

  test("moves an oversized message tail into history without losing a transition row", () => {
    const output = new TerminalScreen(20, 5);
    const renderer = createInlineTerminalRenderer({ write: (bytes) => output.write(bytes), rows: () => 5 });
    const answer = { key: "assistant", done: true, node: GTUI.view.column({},
      Array.from({ length: 8 }, (_, index) => GTUI.view.text({ margin: 0 }, `answer ${index}`))) };
    const root = (later = []) => GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", offset: 0 }, [GTUI.view.feed({ id: "feed", items: [answer, ...later] })]),
      GTUI.view.input({ id: "draft", focus: true, value: "", caret: 0 }),
    ]);
    renderer.render(root(), createTheme(), { width: 20, height: 5 });
    renderer.render(root([{ key: "next", done: true, node: GTUI.view.text({ margin: 0 }, "next") }]), createTheme(), { width: 20, height: 5 });
    const visible = `${output.history.join("\n")}\n${output.text()}`;
    for (let index = 0; index < 8; index++) expect(visible).toContain(`answer ${index}`);
    expect(visible).toContain("next");
  });

  test("commits an evicted completed prefix once while retaining the visible tail", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 2 });
    const root = (items) => GTUI.view.feed({ id: "feed", items });
    const items = ["old", "visible", "live"].map((key, index) => ({ key, done: index < 2, node: GTUI.view.text({ margin: 0 }, key) }));
    renderer.render(root(items), createTheme(), { width: 20, height: 2 });
    expect(writes.at(-1)).toContain("old\n");
    expect(plain(writes.at(-1))).toContain("visible");
    renderer.render(root(items), createTheme(), { width: 20, height: 2 });
    expect(writes.at(-1)).toBe("");
  });

  test("commits an evicted prefix from the real scroll/feed shape once", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 8 });
    const items = Array.from({ length: 40 }, (_, index) => ({ key: `item:${index}`, done: true, node: GTUI.view.text({ margin: 0 }, `item ${index}`) }));
    const root = GTUI.view.scroll({ id: "history", anchor: "end", offset: 0 }, [GTUI.view.feed({ id: "feed", items })]);
    renderer.render(root, createTheme(), { width: 20, height: 8 });
    expect(writes.at(-1)).toContain("item 0\n");
    expect(plain(writes.at(-1))).toContain("item 39");
    renderer.render(root, createTheme(), { width: 20, height: 8 });
    expect(writes.at(-1)).not.toContain("item 0\n");
  });

  test("does not commit a completed item after an evicted live predecessor", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 1 });
    const items = [
      { key: "old", done: true, node: GTUI.view.text({ margin: 0 }, "old") },
      { key: "live", done: false, node: GTUI.view.text({ margin: 0 }, "live") },
      { key: "later", done: true, node: GTUI.view.text({ margin: 0 }, "later") },
      { key: "tail", done: true, node: GTUI.view.text({ margin: 0 }, "tail") },
    ];
    renderer.render(GTUI.view.feed({ id: "feed", items }), createTheme(), { width: 20, height: 1 });
    expect(writes.at(-1)).not.toContain("later\n");
  });

  test("uses an anonymous feed's node identity so it does not recommit visible items", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 1 });
    const feed = GTUI.view.feed({ items: [
      { key: "old", done: true, node: GTUI.view.text({ margin: 0 }, "old") },
      { key: "tail", done: true, node: GTUI.view.text({ margin: 0 }, "tail") },
    ] });
    renderer.render(feed, createTheme(), { width: 20, height: 1 });
    renderer.render(feed, createTheme(), { width: 20, height: 1 });
    expect(writes.at(-1)).toBe("");
  });

  test("scrolling back does not commit newer rows below the viewport", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 1 });
    const items = ["old", "middle", "tail"].map((key) => ({ key, done: true, node: GTUI.view.text({ margin: 0 }, key) }));
    const root = GTUI.view.scroll({ id: "history", anchor: "end", offset: 2 }, [GTUI.view.feed({ id: "feed", items })]);
    renderer.render(root, createTheme(), { width: 20, height: 1 });
    expect(writes.at(-1)).not.toContain("tail\n");
    expect(plain(writes.at(-1))).toContain("old");
  });

  test("does not clear or recommit history while scrolling away and back", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 1 });
    const items = ["old", "tail"].map((key) => ({ key, done: true, node: GTUI.view.text({ margin: 0 }, key) }));
    const root = (offset) => GTUI.view.scroll({ id: "history", anchor: "end", offset }, [GTUI.view.feed({ id: "feed", items })]);
    renderer.render(root(0), createTheme(), { width: 20, height: 1 });
    renderer.render(root(1), createTheme(), { width: 20, height: 1 });
    expect(writes.at(-1)).not.toContain("\x1b[3J\x1b[2J\x1b[H");
    renderer.render(root(0), createTheme(), { width: 20, height: 1 });
    expect(writes.at(-1)).not.toContain("old\n");
  });

  test("keeps the tail of an oversized feed item live", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 2 });
    const root = GTUI.view.feed({ id: "feed", items: [{ key: "large", done: true,
      node: GTUI.view.column({}, [GTUI.view.text({ margin: 0 }, "head"), GTUI.view.text({ margin: 0 }, "tail")]) } ] });
    renderer.render(root, createTheme(), { width: 20, height: 2 });
    expect(plain(writes.at(-1))).toContain("tail");
    expect(writes.at(-1)).not.toContain("large\n");
  });

  test("rebuilds evicted history once when a committed item is revised", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 1 });
    const root = (old) => GTUI.view.feed({ id: "feed", items: [
      { key: "old", done: true, node: GTUI.view.text({ margin: 0 }, old) },
      { key: "tail", done: true, node: GTUI.view.text({ margin: 0 }, "tail") },
    ] });
    renderer.render(root("before"), createTheme(), { width: 20, height: 1 });
    renderer.render(root("after"), createTheme(), { width: 20, height: 1 });
    expect(writes.at(-1)).toContain("\x1b[3J\x1b[2J\x1b[H");
    expect(plain(writes.at(-1))).toContain("after");
  });

  test("refresh and resize clear then reprint completed feed items", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "inline" }) });
    const running = ui.run(app());
    const before = output.chunks.length;
    ui.dispatch({ type: "refresh" });
    await tick();
    const refreshed = output.chunks.slice(before).join("");
    expect(refreshed).toContain("\x1b[3J\x1b[2J\x1b[H");
    expect(refreshed).toContain("one\n");
    output.columns = 16;
    output.emit("resize");
    await tick();
    expect(output.bytes().split("one\n").length).toBeGreaterThan(2);
    ui.stop();
    await running;
  });

  test("enables pointer reporting only while completion or overlay is visible", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const host = GTUI.host.terminal({ input, output, mode: "inline" });
    let visible = false;
    const ui = new GTUI({ host });
    const running = ui.run({
      init: () => ({ model: false, effects: [] }),
      update: (_, message) => ({ model: message.type === "show", effects: [] }),
      view: (show) => GTUI.view.input({ id: "x", focus: true, value: "", caret: 0, completions: show ? ["a"] : [] }),
    });
    ui.dispatch({ type: "show" });
    await tick();
    expect(output.bytes()).toContain("\x1b[?1006h");
    ui.dispatch({ type: "hide" });
    await tick();
    expect(output.bytes()).toContain("\x1b[?1006l");
    ui.stop();
    await running;
  });

  test("mouse drag plus copy uses source text", async () => {
    const input = new FakeInput(); const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "inline", mouse: "always" }) });
    const running = ui.run({ init: () => ({ model: {}, effects: [] }),
      update: (model, message) => message.type === "selection.copy" ? { model, effects: [GTUI.effect.copy(message.text)] } : { model, effects: [] },
      view: () => GTUI.view.panel({ title: "decoration" }, [GTUI.view.text({ margin: 0, selectionKey: "message", sourceText: "copy" }, [{ text: "copy", source: { start: 0, end: 4 } }])]), });
    input.emit("data", Buffer.from("\x1b[<0;2;2M\x1b[<32;5;2M\x1b[<0;5;2m\x1b[99;9u"));
    await tick(); await tick();
    const match = output.bytes().match(new RegExp("\\x1b\\]52;c;([^\\x07]+)\\x07"));
    expect(Buffer.from(match?.[1] ?? "", "base64").toString("utf8")).toBe("copy");
    ui.stop(); await running;
  });

  test("leave restores cursor and advances below the live region", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode: "inline" }) });
    const running = ui.run(app());
    ui.stop();
    await running;
    expect(output.bytes()).toContain("\r\n");
    expect(input.raw).toEqual([true, false]);
  });
});
