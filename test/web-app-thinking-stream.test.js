import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Minimal DOM boundary for the real transcript renderer; Markdown remains real. */
class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this.childNodes = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.textWrites = 0;
  }
  get firstElementChild() { return this.childNodes[0] ?? null; }
  get lastElementChild() { return this.childNodes.at(-1) ?? null; }
  get classList() { return { contains: (name) => this.className.split(" ").includes(name) }; }
  get textContent() { return this.text ?? this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.textWrites++; this.text = String(value); this.replaceChildren(); }
  get innerHTML() { return this.html ?? ""; }
  set innerHTML(value) { this.html = value; this.replaceChildren(); }
  matches(selector) { return selector.startsWith(".") ? this.classList.contains(selector.slice(1)) : this.tagName === selector.toUpperCase(); }
  querySelectorAll(selector) { return this.childNodes.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, next) {
    child.remove();
    this.childNodes.splice(next ? this.childNodes.indexOf(next) : this.childNodes.length, 0, child);
    child.parent = this;
  }
  remove() {
    if (this.parent) this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren(...children) { for (const child of [...this.childNodes]) child.remove(); this.append(...children); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  async dispatch(type) { for (const listener of this.listeners.get(type) ?? []) await listener({ stopPropagation() {} }); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

async function withBrowser(run) {
  const keys = ["document", "matchMedia", "setTimeout", "requestAnimationFrame", "cancelAnimationFrame"];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copies = [];
  globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => { const node = new Element("text"); node.textContent = text; return node; }, querySelector: () => null };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.setTimeout = () => 0;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => copies.push(text) } });
  try { await run(copies); }
  finally {
    for (const [index, key] of keys.entries()) if (previous[index]) Object.defineProperty(globalThis, key, previous[index]); else delete globalThis[key];
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else delete navigator.clipboard;
  }
}

async function renderer() {
  const view = await import("../lib/app/web/public/app/views/transcript/transcript.js");
  const { state } = await import("../lib/app/web/public/app/state.js");
  return { ...view, state };
}

describe("transcript message fork action", () => {
  it("forks through the selected message, not the block position, and skips virtual blocks", async () => withBrowser(async () => {
    const { blockControls, mount } = await renderer();
    const events = [];
    mount(null, { emit: (channel, packet) => events.push([channel, packet]) });
    const controls = blockControls({ kind: "text", text: "hello", messageIndex: 3, blockIndex: 2, done: true });
    const fork = controls.querySelectorAll("button").find((node) => node.getAttribute("aria-label")?.startsWith("Fork"));
    expect(fork).toBeDefined();
    await fork.dispatch("click");
    expect(events).toEqual([["server", { type: "session.fork", through: 4 }]]);
    const tool = blockControls({ kind: "tool", messageIndex: 5, resultIndex: 6, done: true });
    await tool.querySelectorAll("button").find((node) => node.getAttribute("aria-label")?.startsWith("Fork")).dispatch("click");
    expect(events.at(-1)).toEqual(["server", { type: "session.fork", through: 7 }]);
    const virtual = blockControls({ kind: "system", text: "Tools", messageIndex: -1 });
    expect(virtual.querySelectorAll("button").some((node) => node.getAttribute("aria-label")?.startsWith("Fork"))).toBe(false);
    const streaming = blockControls({ kind: "text", text: "partial", messageIndex: 4, done: false });
    expect(streaming.querySelectorAll("button").some((node) => node.getAttribute("aria-label")?.startsWith("Fork"))).toBe(false);
    mount(null, { emit() {} });
  }));
});

describe("transcript message rollback actions", () => {
  it("creates each row's toolbar on its first pointer or keyboard interaction", async () => withBrowser(async () => {
    const { messageFrame } = await renderer();
    let index = 0;
    for (const block of [
      { kind: "user", text: "question", done: true },
      { kind: "text", text: "answer", done: true },
      { kind: "thinking", text: "thought", done: true, open: false },
      { kind: "tool", name: "read", args: "{}", output: "result", done: true, open: false },
      { kind: "system", text: "system", done: true, open: false },
      { kind: "error", text: "error", done: true },
      { kind: "command", text: "command", done: true },
    ]) {
      const row = messageFrame(block);
      expect(row.querySelector(".block-controls")).toBeNull();
      expect(row.tabIndex).toBe(0);
      await row.dispatch(index++ % 2 ? "focusin" : "pointerenter");
      expect(row.querySelector(".block-controls")?.parent).toBe(row);
      const controls = row.querySelector(".block-controls");
      await row.dispatch("pointerenter");
      expect(row.querySelector(".block-controls")).toBe(controls);
    }
  }));

  it("allocates no action buttons for 1000 untouched collapsed tools", async () => withBrowser(async () => {
    const { messageFrame } = await renderer();
    const rows = Array.from({ length: 1000 }, (_, messageIndex) => messageFrame({ kind: "tool", name: "read", done: true, open: false, messageIndex, resultIndex: messageIndex + 1 }));
    expect(rows.reduce((total, row) => total + row.querySelectorAll("button").length, 0)).toBe(0);
    await rows[0].dispatch("focusin");
    expect(rows[0].querySelectorAll("button")).toHaveLength(5);
    expect(rows.slice(1).reduce((total, row) => total + row.querySelectorAll("button").length, 0)).toBe(0);
  }));

  it("offers rollback on non-user messages, retaining the selected message", async () => withBrowser(async () => {
    const { blockControls, mount } = await renderer();
    const events = [];
    const previousConfirm = Object.getOwnPropertyDescriptor(globalThis, "confirm");
    globalThis.confirm = () => true;
    mount(null, { emit: (channel, packet) => events.push([channel, packet]) });
    try {
      for (const [block, messageIndex] of [
        [{ kind: "text", text: "answer", messageIndex: 2, blockIndex: 0, done: true }, 3],
        [{ kind: "thinking", text: "thought", messageIndex: 2, blockIndex: 0, done: true }, 3],
        [{ kind: "system", text: "system", messageIndex: 2, blockIndex: 0, done: true }, 3],
        [{ kind: "tool", messageIndex: 2, resultIndex: 3, done: true }, 4],
      ]) {
        const controls = blockControls(block);
        const rollback = controls.querySelectorAll("button").find((node) => node.getAttribute("aria-label") === "Roll back to here");
        expect(rollback).toBeDefined();
        await rollback.dispatch("click");
        expect(events.at(-1)).toEqual(["server", { type: "context.rollback", messageIndex }]);
      }
      expect(events.filter(([channel]) => channel === "composer.insert")).toEqual([]);

      const user = blockControls({ kind: "user", text: "question", messageIndex: 5, blockIndex: 0, done: true });
      expect(user.querySelectorAll("button").some((node) => node.getAttribute("aria-label") === "Roll back to here")).toBe(false);
      await user.querySelectorAll("button").find((node) => node.getAttribute("aria-label") === "Edit & resend from here").dispatch("click");
      expect(events.slice(-2)).toEqual([
        ["server", { type: "context.rollback", messageIndex: 5 }],
        ["composer.insert", ["question", true]],
      ]);
    } finally {
      mount(null, { emit() {} });
      if (previousConfirm) Object.defineProperty(globalThis, "confirm", previousConfirm); else delete globalThis.confirm;
    }
  }));
});

describe("transcript streaming invalidation", () => {
  it("keeps every unchanged bubble mounted during text and tool streaming", async () => withBrowser(async () => {
    const view = await renderer();
    const { state } = view;
    const { register, flush } = await import("../lib/app/web/public/app/render.js");
    const turn = await import("../lib/app/web/public/app/orchestrators/turn-state.js");
    const tools = await import("../lib/app/web/public/app/orchestrators/turn-tools.js");
    const source = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
    const registration = source.split("\n").find((line) => line.startsWith('register("transcript",'));
    runInNewContext(registration, { register, transcript: view });
    const previous = { blocks: state.blocks, nodes: state.nodes, dirty: state.dirty, current: state.current, fullRender: state.fullRender, frame: state.frame, frameTimer: state.frameTimer, resetTranscript: state.resetTranscript, stickBottom: state.stickBottom };
    const container = new Element("div");
    document.querySelector = (selector) => selector === ".transcript" ? container : null;
    Object.assign(state, { blocks: [
      { kind: "thinking", text: "Finished thought", done: true, open: true },
      { kind: "text", text: "Finished answer", done: true },
      { kind: "tool", name: "bash", output: "Done", done: true, state: "ok", callId: "old", open: true },
      { kind: "user", text: "Question", done: true },
    ], nodes: [], dirty: new Set(), current: null, fullRender: false, frame: 0 });
    const paint = () => { flush(); view.renderMessages(state.fullRender); state.fullRender = false; state.frame = 0; state.dirty.clear(); };
    try {
      view.renderMessages(false);
      const mounted = state.nodes.map((row) => row.firstElementChild);
      turn.onDelta({ kind: "text", text: "New" });
      paint();
      const liveText = state.nodes.at(-1).querySelector(".md");
      turn.onDelta({ kind: "text", text: " answer" });
      paint();
      expect(state.nodes.at(-1).querySelector(".md").innerHTML).toContain("New answer");
      const textBodyRetained = state.nodes.at(-1).querySelector(".md") === liveText;
      tools.startToolCall({ name: "bash", index: 0 });
      tools.finishToolCall({ index: 0 });
      tools.startToolAnswer({ call: { name: "bash", callId: "live", arguments: {} } });
      paint();
      expect(state.nodes[4].firstElementChild.classList.contains("streaming")).toBe(false);
      const settledText = state.nodes[4].firstElementChild;
      tools.appendToolData({ call: { callId: "live" }, chunk: "Output" });
      paint();
      expect(state.nodes.at(-1).querySelector(".tool-preview").textContent).toBe("Output");
      for (const [index, bubble] of mounted.entries()) expect(state.nodes[index].firstElementChild === bubble).toBe(true);
      expect(state.nodes[4].firstElementChild === settledText).toBe(true);
      expect(textBodyRetained).toBe(true);
      turn.onTurnEnd({ busy: false });
      paint();
      expect(state.blocks.at(-1).state).toBe("skipped");
      expect(state.nodes.at(-1).firstElementChild.classList.contains("tool-skipped")).toBe(true);
      turn.onDelta({ kind: "thinking", text: "Next thought" });
      paint();
      const thinkingRow = state.nodes.at(-1);
      turn.onDelta({ kind: "text", text: "Next answer" });
      paint();
      expect(thinkingRow.querySelector(".block-kind").textContent).toMatch(/^Thought/);
      expect(thinkingRow.firstElementChild.classList.contains("streaming")).toBe(false);
      turn.setHistory([{ kind: "thinking", text: "Authoritative", done: true }], true);
      paint();
      expect(state.nodes[0].querySelector(".thinking-body").innerHTML).toContain("Authoritative");
    } finally { Object.assign(state, previous); flush(); }
  }));

  it("retains an expanded tool body during its own output deltas", async () => withBrowser(async () => {
    const { messageFrame, patchMessage } = await renderer();
    const block = { kind: "tool", name: "bash", args: "{}", output: "First", done: false, state: "running", open: true };
    const row = messageFrame(block);
    const body = row.querySelector(".tool-body");
    block.output += " second";
    patchMessage(row, block);
    expect(row.querySelector(".tool-body") === body).toBe(true);
    expect(body.textContent).toContain("First second");
  }));

  it("retains the assistant Markdown container during its own text deltas", async () => withBrowser(async () => {
    const { messageFrame, patchMessage, markdownSources } = await renderer();
    const block = { kind: "text", text: "First", done: false };
    const row = messageFrame(block);
    const bubble = row.firstElementChild;
    const body = row.querySelector(".md");
    block.text += " **second**";
    patchMessage(row, block);
    expect(row.firstElementChild === bubble).toBe(true);
    expect(row.querySelector(".md") === body).toBe(true);
    expect(markdownSources.get(body)).toBe(block.text);
    expect(body.innerHTML).toContain("<strong>second</strong>");
  }));
});

describe("thinking stream DOM updates", () => {
  it("applies declarative collapse and preview changes to mounted cards while retaining streaming controls", async () => withBrowser(async () => {
    const { messageFrame, patchMessage, state } = await renderer();
    const { session } = await import("../lib/app/web/public/app/orchestrators/session.js");
    const previous = { blocks: state.blocks, prefs: state.prefs, envSettings: state.envSettings, settings: state.settings, fullRender: state.fullRender };
    try {
      state.prefs = { ...state.prefs, collapse: { thinking: true, tools: true }, previewRows: { default: { thinking: 8, tool: 7 } } };
      state.blocks = [
        { kind: "thinking", text: "head\nsecond\nthird\nfourth\nfifth", done: false, open: false },
        { kind: "tool", name: "bash", args: "{}", output: "head\nsecond\nthird\nfourth\nfifth", done: false, state: "running", open: false },
      ];
      const rows = state.blocks.map(messageFrame);
      const mounted = rows.map((row) => row.firstElementChild);
      const shimmer = rows[0].querySelector(".shimmer-dots");
      session.packets.settings({ state, invalidate() {} }, { settings: {}, prefs: { ...state.prefs, collapse: { thinking: false, tools: false }, previewRows: { default: { thinking: 2, tool: 2 } } } });
      for (const [index, block] of state.blocks.entries()) patchMessage(rows[index], block);
      expect(rows[0].firstElementChild).toBe(mounted[0]);
      expect(rows[1].firstElementChild).toBe(mounted[1]);
      expect(rows[0].querySelector(".shimmer-dots")).toBe(shimmer);
      for (const row of rows) {
        expect(row.firstElementChild.open).toBe(true);
        expect(row.querySelector(".preview-gap").textContent).toBe("⋯ 4 more lines");
      }
    } finally { Object.assign(state, previous); }
  }));
  for (const open of [false, true]) {
    it(`updates only text inside a ${open ? "expanded" : "collapsed"} thinking card`, async () => withBrowser(async () => {
      const { messageFrame, patchMessage, markdownSources } = await renderer();
      const block = { kind: "thinking", text: "First **thought**.", done: false, open };
      const row = messageFrame(block);
      const card = row.firstElementChild;
      const selectors = ["summary", ".card-head", ".block-kind", ".shimmer-dots", ".thinking-preview", ".thinking-body"];
      const mounted = selectors.map((selector) => card.querySelector(selector));
      await row.dispatch("pointerenter");
      const controls = row.querySelector(".block-controls");
      const labelWrites = card.querySelector(".block-kind").textWrites;
      for (const delta of ["\nSecond `thought`.", "\nThird thought."]) {
        block.text += delta;
        patchMessage(row, block);
        expect(row.firstElementChild).toBe(card);
        for (const [index, selector] of selectors.entries()) expect(card.querySelector(selector)).toBe(mounted[index]);
        expect(row.querySelector(".block-controls")).toBe(controls);
        expect(card.open).toBe(open);
        expect(card.querySelector(".thinking-body").innerHTML).toContain("<strong>thought</strong>");
        expect(card.querySelector(".thinking-body").innerHTML).toContain("<code>thought</code>");
        expect(markdownSources.get(card.querySelector(".thinking-body"))).toBe(block.text);
        expect(markdownSources.get(card.querySelector(".thinking-preview").firstElementChild)).toBe(block.text);
      }
      expect(card.querySelector(".block-kind").textWrites).toBe(labelWrites);
    }));
  }

  it("preserves the copy button while copying the latest streamed source", async () => withBrowser(async (copies) => {
    const { messageFrame, patchMessage } = await renderer();
    const block = { kind: "thinking", text: "First", done: false };
    const row = messageFrame(block);
    await row.dispatch("pointerenter");
    const copy = row.querySelector(".block-controls").firstElementChild;
    block.text += " **second**";
    patchMessage(row, block);
    expect(row.querySelector(".block-controls").firstElementChild).toBe(copy);
    await copy.dispatch("click");
    expect(copies).toEqual([block.text]);
  }));

  it("settles thinking and refreshes authoritative history with fresh handlers", async () => withBrowser(async () => {
    const { messageFrame, patchMessage, markdownSources } = await renderer();
    const block = { kind: "thinking", text: "Draft", done: false, open: true, started: 1000 };
    const row = messageFrame(block);
    const streaming = row.firstElementChild;
    Object.assign(block, { done: true, ended: 3000 });
    patchMessage(row, block);
    expect(row.firstElementChild).not.toBe(streaming);
    expect(row.firstElementChild.classList.contains("streaming")).toBe(false);
    expect(row.querySelector(".block-kind").textContent).toBe("Thought for 2s");
    expect(row.querySelector(".shimmer-dots")).toBeNull();
    const history = { kind: "thinking", text: "**Final** $x^2$", done: true, messageIndex: 1 };
    patchMessage(row, history);
    expect(row.firstElementChild.open).toBe(true);
    expect(markdownSources.get(row.querySelector(".thinking-body"))).toBe(history.text);
    expect(row.querySelector(".thinking-body").innerHTML).toContain("<strong>Final</strong>");
    expect(row.querySelector(".thinking-body").innerHTML).toContain('role="math"');
    await row.dispatch("focusin");
    expect(row.querySelector(".block-controls").childNodes.length).toBe(5); // copy, view, rollback, fork, delete
  }));

  it("updates the capped Markdown preview from head-only to head and tail", async () => withBrowser(async () => {
    const { messageFrame, patchMessage, state, markdownSources } = await renderer();
    const rows = state.prefs.previewRows.default.thinking;
    state.prefs.previewRows.default.thinking = 4;
    try {
      const block = { kind: "thinking", text: "**head**", done: false };
      const row = messageFrame(block);
      const preview = row.querySelector(".thinking-preview");
      block.text += "\n```js\nconst x = 1;\nline\n- last";
      patchMessage(row, block);
      expect(row.querySelector(".thinking-preview")).toBe(preview);
      expect(preview.querySelector(".preview-gap").textContent).toBe("⋯ 2 more lines");
      expect(markdownSources.get(preview.firstElementChild)).toBe("**head**");
      expect(markdownSources.get(preview.lastElementChild)).toBe("line\n- last");
      expect(preview.lastElementChild.innerHTML).toContain("<li>last</li>");
    } finally { state.prefs.previewRows.default.thinking = rows; }
  }));
});
