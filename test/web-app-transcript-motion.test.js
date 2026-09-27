import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../lib/app/web/public/style.css", import.meta.url), "utf8");
const source = app.slice(app.indexOf("function messageFrame("), app.indexOf("function renderWorkingIndicator()"));

function harness(blocks) {
  const children = [];
  const transcriptContainer = {
    children,
    get lastElementChild() { return children.at(-1); },
    get firstElementChild() { return children[0]; },
    querySelector(selector) { return children.find((node) => node.kind === selector.slice(1)) ?? null; },
    append(node) { const index = children.indexOf(node); if (index >= 0) children.splice(index, 1); children.push(node); },
    insertBefore(node, next) {
      const previous = children.indexOf(node);
      if (previous >= 0) children.splice(previous, 1);
      const index = next ? children.indexOf(next) : -1;
      children.splice(index < 0 ? children.length : index, 0, node);
    },
    replaceChildren() { children.length = 0; },
  };
  const makeNode = (kind) => {
    const node = { kind, className: "" };
    node.classList = {
      add(value) { if (!this.contains(value)) node.className = `${node.className} ${value}`.trim(); },
      contains(value) { return node.className.split(" ").includes(value); },
    };
    node.remove = () => { const index = children.indexOf(node); if (index >= 0) children.splice(index, 1); };
    node.replaceWith = (next) => { const index = children.indexOf(node); if (index >= 0) children.splice(index, 1, next); };
    Object.defineProperty(node, "nextElementSibling", { get: () => children[children.indexOf(node) + 1] ?? null });
    Object.defineProperty(node, "firstElementChild", { get: () => node.content });
    node.append = (next) => { node.content = next; };
    node.replaceChildren = (next) => { node.content = next; };
    return node;
  };
  const nodes = [];
  const dirty = new Set();
  const state = { fullRender: true, resetTranscript: false, frame: 0, frameTimer: 0 };
  const scrollEl = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const flush = new Function("scope", `with (scope) { ${source}; return flushRender; }`)({
    transcriptContainer, blocks, nodes, dirty, rowBlocks: new WeakMap(), scrollEl, jumpBtn: { hidden: false },
    get resetTranscript() { return state.resetTranscript; }, set resetTranscript(value) { state.resetTranscript = value; },
    get fullRender() { return state.fullRender; }, set fullRender(value) { state.fullRender = value; },
    get frame() { return state.frame; }, set frame(value) { state.frame = value; },
    get frameTimer() { return state.frameTimer; },
    renderBlock: (block) => ({ ...makeNode(block.kind), className: `msg msg-${block.kind}` }), emptyState: () => makeNode("empty-state"),
    el: (_tag, className) => Object.assign(makeNode("message-row"), { className }),
    renderWorkingIndicator: () => {}, nearBottom: () => true,
    cancelAnimationFrame: () => {}, clearTimeout: () => {},
  });
  return { children, nodes, dirty, flush, state };
}

for (const kind of ["user", "text", "thinking", "tool", "system", "error", "command"]) {
  test(`${kind} bubbles animate at creation, including initial history and full-render appends`, () => {
    const blocks = [{ kind, done: true, callId: kind === "tool" ? "call-1" : undefined }];
    const view = harness(blocks);
    view.flush();
    const row = view.nodes[0];
    expect(row.classList.contains("entering")).toBe(true);
    blocks[0] = { ...blocks[0], text: "authoritative final text" };
    blocks.push({ kind, done: true });
    view.state.fullRender = true;
    view.flush();
    expect(view.nodes[0]).toBe(row);
    expect(view.nodes[1].classList.contains("entering")).toBe(true);
    view.dirty.add(blocks[0]);
    view.flush();
    expect(view.nodes[0]).toBe(row);
    expect(row.classList.contains("entering")).toBe(true);
  });
}

test("a different transcript scope creates new rows, and shorter histories remove stale rows", () => {
  const blocks = [{ kind: "user", done: true }, { kind: "text", done: true }];
  const view = harness(blocks);
  view.flush();
  const oldRow = view.nodes[0];
  const oldWelcome = view.children.find((node) => node.kind === "empty-state");
  view.state.resetTranscript = true;
  view.state.fullRender = true;
  view.flush();
  expect(view.nodes[0]).not.toBe(oldRow);
  expect(view.nodes[0].classList.contains("entering")).toBe(true);
  expect(view.children.find((node) => node.kind === "empty-state")).not.toBe(oldWelcome);
  blocks.length = 1;
  view.state.fullRender = true;
  view.flush();
  expect(view.nodes).toHaveLength(1);
  expect(view.children).toHaveLength(2);
});

test("authoritative history keeps a card's expansion state on its existing row", () => {
  const blocks = [{ kind: "tool", callId: "one", done: true, open: true }];
  const view = harness(blocks);
  view.flush();
  const row = view.nodes[0];
  blocks[0] = { kind: "tool", callId: "one", done: true };
  view.state.fullRender = true;
  view.flush();
  expect(view.nodes[0]).toBe(row);
  expect(blocks[0].open).toBe(true);
});

test("a different tool call at the same position creates a new bubble", () => {
  const blocks = [{ kind: "tool", callId: "one", done: true }];
  const view = harness(blocks);
  view.flush();
  const oldRow = view.nodes[0];
  blocks[0] = { kind: "tool", callId: "two", done: true };
  view.state.fullRender = true;
  view.flush();
  expect(view.nodes[0]).not.toBe(oldRow);
  expect(view.nodes[0].classList.contains("entering")).toBe(true);
});

test("welcome marks the first user message after any opening system messages", () => {
  const system = { kind: "system" };
  const blocks = [system];
  const view = harness(blocks);
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["system", "empty-state"]);
  expect(view.nodes[0].classList.contains("entering")).toBe(true);
  blocks.push({ kind: "system" });
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["system", "system", "empty-state"]);
  const user = { kind: "user" };
  blocks.push(user);
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["system", "system", "empty-state", "user"]);
  expect(view.nodes[2].classList.contains("entering")).toBe(true);
  const welcome = view.children[2];
  view.state.fullRender = true;
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["system", "system", "empty-state", "user"]);
  expect(view.children[2]).toBe(welcome);
  blocks.push({ kind: "user" });
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["system", "system", "empty-state", "user", "user"]);
});

test("welcome stays before the first user even if earlier non-user blocks exist", () => {
  const blocks = [{ kind: "system" }, { kind: "text" }, { kind: "user" }];
  const view = harness(blocks);
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["system", "text", "empty-state", "user"]);
  view.state.fullRender = true;
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["system", "text", "empty-state", "user"]);
});

test("newly created bubbles reveal; streaming and same-scope refresh keep their mounted rows", () => {
  const blocks = [];
  const view = harness(blocks);
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["empty-state"]);
  const text = { kind: "text" };
  blocks.push(text);
  view.flush();
  expect(view.children.map((node) => node.content?.kind ?? node.kind)).toEqual(["empty-state", "text"]);
  expect(view.nodes[0].classList.contains("entering")).toBe(true);
  const frame = view.nodes[0];
  const oldBubble = frame.content;
  view.dirty.add(text);
  view.flush();
  expect(view.nodes[0]).toBe(frame);
  expect(frame.content).not.toBe(oldBubble);
  expect(view.nodes[0].classList.contains("entering")).toBe(true);
  view.state.fullRender = true;
  view.flush();
  expect(view.nodes[0]).toBe(frame);
  expect(view.nodes[0].classList.contains("entering")).toBe(true);
  expect(css).toContain(".message-row.entering { animation: welcome-rise var(--entrance-motion)");
  expect(css).toContain(".empty-state > * { animation: welcome-rise var(--entrance-motion)");
  expect(css).not.toContain("@keyframes bubble-reveal");
  expect(css).toContain(".message-row:hover::before, .message-row:focus-within::before { opacity: .45; }");
  expect(css).toContain("--hover-motion: 300ms");
  expect(css).toContain("transition: opacity var(--hover-motion) var(--motion-ease)");
  expect(css).toContain(".message-row.message-user { align-self: flex-end; width: fit-content; max-width: min(85%, 40rem); border-radius: 16px 16px 4px 16px; }");
  expect(css).toContain("box-shadow: inset .1875rem 0 0 var(--rail-color); opacity: .6");
  expect(css).not.toMatch(/\.msg-(?:user|thinking|system|tool)(?:\.tool-ok|\.tool-error)?\s*\{[^}]*box-shadow:/);
  expect(css).toContain(".message-row.message-tool.tool-ok { --rail-color:");
  expect(css).not.toContain(".message-row.message-tool:has(");
  expect(css).toContain(".message-row.message-user { --rail-color:");
  expect(css).toContain("inset: 0; border-radius: inherit;");
  expect(css).toContain(".message-row:hover .block-controls, .message-row:focus-within .block-controls");
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none !important/);
});
