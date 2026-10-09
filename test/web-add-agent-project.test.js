import { expect, test } from "bun:test";

function node(tag, text = "") {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), className: "", textContent: text, children: [], style: {}, value: "", listeners,
    classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    focus() {}, scrollIntoView() {},
    close() {}, showModal() {}, remove() {},
    querySelectorAll(selector) {
      return this.children.flatMap((child) => child?.querySelectorAll ? [
        ...(child.className.split(" ").includes(selector.slice(1)) ? [child] : []),
        ...child.querySelectorAll(selector),
      ] : []);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
}

test("new agent project picker displays names only while preserving project paths for selection", async () => {
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  globalThis.matchMedia = () => ({ matches: false });
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { openAddAgent, mount } = await import("../lib/app/web/public/app/views/panels/panels.js");
  const beforeState = { projects: state.projects, scope: state.scope, settings: state.settings };
  const dialogs = [];
  const messages = [];
  globalThis.document = {
    body: node("body"),
    createElement: (tag) => node(tag),
    createTextNode: (text) => node("text", text),
    querySelector: () => null,
  };
  globalThis.document.body.append = (...children) => dialogs.push(...children);
  state.scope = "all";
  state.projects = [
    { name: "Alpha Project", path: "/work/opaque-alpha", current: true },
    { name: "Beta Project", path: "/work/opaque-beta", current: false, models: ["example/model"] },
  ];
  state.settings = { ...state.settings, models: ["example/model"] };
  mount(null, { emit: (type, message) => messages.push({ type, message }) });
  try {
    openAddAgent();
    const rows = dialogs[0].querySelectorAll(".picker-row");
    const visibleText = (item) => [item.textContent, ...item.children.map(visibleText)].join(" ");
    expect(rows.map(visibleText)).toEqual([expect.stringContaining("Alpha Project"), expect.stringContaining("Beta Project")]);
    expect(rows.map(visibleText).join(" ")).not.toContain("/work/");
    rows[1].listeners.get("click")();
    const modelRow = dialogs[1].querySelectorAll(".picker-row").at(-1);
    modelRow.listeners.get("click")();
    expect(messages.at(-1)).toEqual({ type: "server", message: { type: "session.add", model: "example/model", project: "/work/opaque-beta" } });
  } finally {
    state.projects = beforeState.projects;
    state.scope = beforeState.scope;
    state.settings = beforeState.settings;
    if (beforeDocument) Object.defineProperty(globalThis, "document", beforeDocument); else delete globalThis.document;
    if (beforeMatchMedia) Object.defineProperty(globalThis, "matchMedia", beforeMatchMedia); else delete globalThis.matchMedia;
  }
});
