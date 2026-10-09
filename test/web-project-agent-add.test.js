import { expect, test } from "bun:test";

function node(tag, text = "") {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), className: "", textContent: text, children: [], listeners, style: { setProperty() {} },
    classList: { contains() { return false; } },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute() {}, addEventListener(type, listener) { listeners.set(type, listener); },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => child?.querySelectorAll ? [
        ...(child.className.split(" ").includes(selector.slice(1)) ? [child] : []),
        ...child.querySelectorAll(selector),
      ] : []);
    },
  };
}

test("agent project headings add with that project's last model without opening menus or toggling", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  globalThis.matchMedia = () => ({ matches: false });
  const lists = node("div");
  const messages = [];
  globalThis.document = {
    querySelector: (selector) => selector === "#sidebar-lists" ? lists : null,
    createElement: (tag) => node(tag), createTextNode: (text) => node("text", text), activeElement: null,
  };
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { mount, updateSidebar } = await import("../lib/app/web/public/app/views/shell/shell.js");
  const saved = { projects: state.projects, sessions: state.sessions, scope: state.scope };
  state.scope = "all";
  state.projects = [{ name: "Alpha", path: "/alpha", lastModel: "one/model" }, { name: "Beta", path: "/beta", lastModel: "two/model" }];
  state.sessions = { agents: [{ id: "a", project: "/alpha" }, { id: "b", project: "/beta" }], recent: [{ id: "s", project: "/alpha" }] };
  mount(null, { emit: (type, payload) => messages.push({ type, payload }) });
  try {
    updateSidebar();
    const buttons = lists.querySelectorAll(".project-agent-add");
    expect(buttons).toHaveLength(2);
    for (let i = 0; i < buttons.length; i++) {
      const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      buttons[i].listeners.get("click")(event);
      expect(event.prevented).toBe(true);
      expect(event.stopped).toBe(true);
    }
    expect(messages).toEqual([
      { type: "server", payload: { type: "session.add", project: "/alpha", model: "one/model" } },
      { type: "server", payload: { type: "session.add", project: "/beta", model: "two/model" } },
    ]);
  } finally {
    Object.assign(state, saved);
    if (original) Object.defineProperty(globalThis, "document", original); else delete globalThis.document;
    if (originalMedia) Object.defineProperty(globalThis, "matchMedia", originalMedia); else delete globalThis.matchMedia;
  }
});
