import { expect, test } from "bun:test";

function node(tag, text = "") {
  return {
    tagName: tag.toUpperCase(), textContent: text, className: "", children: [], style: {}, listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute() {}, contains() { return false; },
    get childElementCount() { return this.children.length; },
    querySelector(selector) {
      if (selector === ".app-exit-button" && this.className.split(" ").includes("app-exit-button")) return this;
      for (const child of this.children) { const found = child.querySelector?.(selector); if (found) return found; }
      return null;
    },
  };
}

test("Exit app closes Settings before sending the exit request, preventing an accidental Crash now click", async () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  globalThis.matchMedia = () => ({ matches: false });
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { renderSettingsBody, mount } = await import("../lib/app/web/public/app/views/panels/panels.js");
  const canManageProjects = state.canManageProjects;
  const body = node("div");
  const events = [];
  const dialog = { close() { events.push("closed"); } };
  globalThis.document = {
    activeElement: null,
    querySelector: (selector) => selector === "#settings-panel .panel-body" ? body : selector === "#settings-panel" ? dialog : null,
    createElement: (tag) => node(tag), createTextNode: (text) => node("text", text),
  };
  state.canManageProjects = true;
  mount(null, { emit: (channel, message) => events.push([channel, message]) });
  try {
    renderSettingsBody();
    const exit = body.querySelector(".app-exit-button");
    expect(exit).not.toBeNull();
    exit.listeners.click();
    expect(events).toEqual(["closed", ["server", { type: "app.exit" }]]);
  } finally {
    state.canManageProjects = canManageProjects;
    mount(null, { emit() {} });
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else delete globalThis.document;
    if (savedMatchMedia) Object.defineProperty(globalThis, "matchMedia", savedMatchMedia); else delete globalThis.matchMedia;
  }
});

test("a supervised app labels the exit control Restart app, still switching to Crash now once requested", async () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  globalThis.matchMedia = () => ({ matches: false });
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { renderSettingsBody, mount } = await import("../lib/app/web/public/app/views/panels/panels.js");
  const canManageProjects = state.canManageProjects;
  const restarts = state.settings.restarts;
  const exitRequested = state.settings.exitRequested;
  const body = node("div");
  globalThis.document = {
    activeElement: null,
    querySelector: (selector) => selector === "#settings-panel .panel-body" ? body : null,
    createElement: (tag) => node(tag), createTextNode: (text) => node("text", text),
  };
  state.canManageProjects = true;
  mount(null, { emit: () => {} });
  try {
    state.settings.restarts = false;
    state.settings.exitRequested = false;
    // The mock DOM keeps the button label in a child text node (dom.js button()).
    const label = () => body.querySelector(".app-exit-button").children[0]?.textContent;
    renderSettingsBody();
    expect(label()).toBe("Exit app");
    state.settings.restarts = true;
    renderSettingsBody();
    expect(label()).toBe("Restart app");
    state.settings.exitRequested = true;
    renderSettingsBody();
    expect(label()).toBe("Crash now");
  } finally {
    state.canManageProjects = canManageProjects;
    state.settings.restarts = restarts;
    state.settings.exitRequested = exitRequested;
    mount(null, { emit() {} });
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else delete globalThis.document;
    if (savedMatchMedia) Object.defineProperty(globalThis, "matchMedia", savedMatchMedia); else delete globalThis.matchMedia;
  }
});
