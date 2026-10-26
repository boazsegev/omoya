import { expect, test } from "bun:test";

function element(tag = "div") {
  const attributes = {};
  return {
    tagName: tag.toUpperCase(), children: [], attributes, dataset: {}, hidden: false, textContent: "", innerHTML: "",
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(key, value) { attributes[key] = value; },
    querySelectorAll() { return []; },
  };
}

test("tool data bubble shows the viewed agent's notes and hides on an empty snapshot", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  const toggle = element("button"), details = element();
  globalThis.document = { querySelector: (selector) => ({ "#app": element(), "#tool-data-toggle": toggle, "#tool-data-details": details })[selector] ?? null, createElement: element };
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const { state } = await import("../lib/app/web/public/app/state.js");
    const { updateToolData } = await import("../lib/app/web/public/app/views/shell/shell.js");
    state.toolMessages = [{ name: "note", text: "🔵**Plan** — ship notes" }, { name: "status", text: "Ready" }];
    state.toolDataExpanded = true;
    updateToolData();
    expect(toggle.hidden).toBe(false);
    expect(toggle.attributes["aria-expanded"]).toBe("true");
    expect(details.children.map((section) => section.children[0].textContent)).toEqual(["note", "status"]);
    expect(details.children[0].children[1].innerHTML).toContain("Plan");
    state.toolMessages = [];
    updateToolData();
    expect(toggle.hidden).toBe(true);
    expect(details.hidden).toBe(true);
    expect(details.children).toEqual([]);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
    if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia); else delete globalThis.matchMedia;
  }
});
