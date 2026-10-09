import { expect, test } from "bun:test";

function node(tag, text = "") {
  return {
    tagName: tag.toUpperCase(), textContent: text, children: [], className: "", style: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute() {}, addEventListener() {},
    contains() { return false; }, get childElementCount() { return this.children.length; },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => child?.querySelectorAll ? [
        ...(selector === ".endpoint-row" && child.className === "endpoint-row" ? [child] : []),
        ...child.querySelectorAll(selector),
      ] : []);
    },
  };
}

test("web settings alphabetizes endpoints including disabled policies and per-model rows", async () => {
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  globalThis.matchMedia = () => ({ matches: false });
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { renderSettingsBody } = await import("../lib/app/web/public/app/views/panels/panels.js");
  const beforeState = { endpoints: state.endpoints, settings: state.settings };
  const body = node("div");
  globalThis.document = {
    activeElement: null,
    querySelector: (selector) => selector === "#settings-panel .panel-body" ? body : null,
    createElement: (tag) => node(tag),
    createTextNode: (text) => node("text", text),
  };
  state.settings = { ...state.settings, models: [] };
  state.endpoints = {
    endpoints: [{ name: "zeta", models: ["z"] }, { name: "alpha", models: ["a"] }],
    policies: [{ name: "middle", disabled: true, models: [{ id: "z" }, { id: "a" }] }],
    removable: [], presets: [], providers: [],
  };
  try {
    renderSettingsBody();
    const rows = body.querySelectorAll(".endpoint-row");
    const text = (item) => item?.textContent || item?.children?.map(text).join(" ") || "";
    expect(rows.map((row) => text(row.children[0].children[0].children[0]))).toEqual(["alpha", "middle", "zeta"]);
    expect(text(rows[1])).toMatch(/disabled/);
    expect(text(rows[1]).indexOf("a")).toBeLessThan(text(rows[1]).lastIndexOf("z"));
  } finally {
    state.endpoints = beforeState.endpoints;
    state.settings = beforeState.settings;
    if (beforeDocument) Object.defineProperty(globalThis, "document", beforeDocument);
    else delete globalThis.document;
    if (beforeMatchMedia) Object.defineProperty(globalThis, "matchMedia", beforeMatchMedia);
    else delete globalThis.matchMedia;
  }
});
