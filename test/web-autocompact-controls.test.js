import { expect, test } from "bun:test";

function node(tag, text = "") {
  return {
    tagName: tag.toUpperCase(), textContent: text, className: "", children: [], listeners: {}, style: {}, dataset: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(key, value) { this[key] = value; },
    removeAttribute(key) { delete this[key]; },
    contains() { return false; },
    get childElementCount() { return this.children.length; },
  };
}
const walk = (entry) => [entry, ...(entry.children ?? []).flatMap(walk)];
const text = (entry) => `${entry.textContent ?? ""} ${entry.children?.map(text).join(" ") ?? ""}`;

test("auto-compaction accepts custom limits and keeps presets as shortcuts", async () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  globalThis.matchMedia = () => ({ matches: false });
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { renderSettingsBody, mount } = await import("../lib/app/web/public/app/views/panels/panels.js");
  const original = state.settings;
  const body = node("div");
  const events = [];
  globalThis.document = { activeElement: null, querySelector: (selector) => selector === "#settings-panel .panel-body" ? body : null,
    createElement: (tag) => node(tag), createTextNode: (value) => node("text", value) };
  mount(null, { emit: (channel, packet) => events.push([channel, packet]) });
  try {
    state.settings = { ...original, settings: { ...original.settings, context: { autocompact: 0.43, autocompactMax: 234009 } } };
    renderSettingsBody();
    const row = (name) => walk(body).find((entry) => entry.className === "settings-row" && text(entry).includes(name));
    const tokens = row("Token limit");
    const input = walk(tokens).find((entry) => entry.tagName === "INPUT");
    const select = walk(tokens).find((entry) => entry.tagName === "SELECT");
    const form = walk(tokens).find((entry) => entry.tagName === "FORM");
    expect(input.value).toBe("234009");
    expect(select).toBeDefined();
    input.value = "345678";
    form.listeners.submit({ preventDefault() {} });
    expect(events.pop()).toEqual(["server", { type: "settings.autocompact", change: { autocompactMax: 345678 } }]);
    input.value = "-1";
    form.listeners.submit({ preventDefault() {} });
    expect(events).toHaveLength(0);
    expect(walk(tokens).some((entry) => entry.role === "alert")).toBe(true);
    select.value = "50000";
    select.listeners.change();
    expect(input.value).toBe("50000");
    expect(events.pop()).toEqual(["server", { type: "settings.autocompact", change: { autocompactMax: 50000 } }]);
    const windowRow = row("Window threshold");
    const percent = walk(windowRow).find((entry) => entry.tagName === "INPUT");
    const windowForm = walk(windowRow).find((entry) => entry.tagName === "FORM");
    expect(percent.value).toBe("43");
    percent.value = "12.5";
    windowForm.listeners.submit({ preventDefault() {} });
    expect(events.pop()).toEqual(["server", { type: "settings.autocompact", change: { autocompact: 0.125 } }]);
  } finally {
    state.settings = original;
    mount(null, { emit() {} });
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else delete globalThis.document;
    if (savedMatchMedia) Object.defineProperty(globalThis, "matchMedia", savedMatchMedia); else delete globalThis.matchMedia;
  }
});
