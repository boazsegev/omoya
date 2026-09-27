import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("function messageFrame("), app.indexOf("function renderWorkingIndicator()"));

function element(tag, className = "", textContent = "") {
  const node = {
    tag, className, textContent, childNodes: [], attributes: {},
    get children() { return this.childNodes; },
    get firstElementChild() { return this.childNodes[0] ?? null; },
    matches(selector) { return selector === "summary" ? this.tag === "summary" : this.className.split(" ").includes(selector.slice(1)); },
    querySelector(selector) {
      for (const child of this.childNodes) {
        if (child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    append(...items) { for (const item of items) this.childNodes.push(item); },
    remove() { this.removals = (this.removals ?? 0) + 1; },
    insertBefore(item, next) {
      const previous = this.childNodes.indexOf(item);
      if (previous >= 0) this.childNodes.splice(previous, 1);
      const index = next ? this.childNodes.indexOf(next) : -1;
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, item);
    },
    replaceChildren(...items) {
      for (const child of this.childNodes) child.removals = (child.removals ?? 0) + 1;
      this.childNodes = items;
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? null; },
    classList: {
      add(value) { if (!this.contains(value)) node.className += ` ${value}`; },
      contains(value) { return node.className.split(" ").includes(value); },
    },
  };
  return node;
}

function harness(kind) {
  const block = { kind, state: "running", done: false, output: "first" };
  const blocks = [block];
  const nodes = [];
  const dirty = new Set();
  const children = [];
  let fullRender = true;
  const container = {
    append(node) { children.push(node); },
    replaceChildren() { children.length = 0; },
    insertBefore(node, next) { children.splice(next ? children.indexOf(next) : children.length, 0, node); },
    querySelector() { return null; },
    get lastElementChild() { return children.at(-1); },
  };
  const renderBlock = (item) => {
    const card = element("details", `msg msg-${item.kind}${item.kind === "tool" ? ` tool-${item.state}` : ""}`);
    const summary = element("summary");
    const head = element("span", "card-head");
    const icon = element("span", item.kind === "tool" ? "tool-state" : "block-kind", "running");
    head.append(icon, element("span", "tool-name", "bash"));
    if (item.args) head.append(element("span", "tool-args-summary", item.args));
    if (item.kind === "thinking") head.append(element("span", "shimmer-dots"));
    summary.append(head, element("span", "preview", item.output));
    card.append(summary, element("div", "body", item.output));
    return card;
  };
  const flush = new Function("scope", `with (scope) { ${source}; return flushRender; }`)({
    blocks, nodes, dirty, rowBlocks: new WeakMap(), resetTranscript: false, transcriptContainer: container, scrollEl: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, jumpBtn: {},
    get fullRender() { return fullRender; }, set fullRender(value) { fullRender = value; },
    frame: 0, frameTimer: 0, el: element, renderBlock, emptyState: () => element("welcome"),
    renderWorkingIndicator() {}, nearBottom: () => true,
    cancelAnimationFrame() {}, clearTimeout() {},
  });
  return { block, nodes, dirty, flush, refresh() { fullRender = true; flush(); } };
}

for (const kind of ["tool", "thinking"]) {
  test(`${kind} stream updates content without remounting its animated indicator`, () => {
    const view = harness(kind);
    view.flush();
    const row = view.nodes[0];
    const bubble = row.firstElementChild;
    const icon = bubble.querySelector(kind === "tool" ? ".tool-state" : ".shimmer-dots");
    view.block.output = "first\nsecond";
    view.block.args = "streaming arguments";
    view.dirty.add(view.block);
    view.flush();
    expect(view.nodes[0]).toBe(row);
    expect(row.classList.contains("entering")).toBe(true);
    expect(row.firstElementChild).toBe(bubble);
    expect(bubble.querySelector(kind === "tool" ? ".tool-state" : ".shimmer-dots")).toBe(icon);
    expect(icon.removals ?? 0).toBe(0); // detached/reinserted nodes restart CSS animation
    expect(bubble.querySelector(".preview").textContent).toBe("first\nsecond");
    view.block.args = "";
    view.refresh();
    expect(icon.removals ?? 0).toBe(0);
    expect(view.nodes[0]).toBe(row);
    expect(row.firstElementChild).toBe(bubble);
    expect(bubble.querySelector(kind === "tool" ? ".tool-state" : ".shimmer-dots")).toBe(icon);
  });
}

test("tool completion updates the icon and state", () => {
  const view = harness("tool");
  view.flush();
  const row = view.nodes[0];
  view.block.state = "ok";
  view.block.done = true;
  view.dirty.add(view.block);
  view.flush();
  expect(view.nodes[0]).toBe(row);
  expect(row.classList.contains("entering")).toBe(true);
  expect(view.nodes[0].className).toContain("tool-ok");
  expect(view.nodes[0].firstElementChild.className).toContain("tool-ok");
});
