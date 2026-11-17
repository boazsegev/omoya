import { test, expect } from "bun:test";

function node() {
  const listeners = new Map();
  return { value: "", style: {}, children: [], selectionStart: 0, selectionEnd: 0, scrollHeight: 24, clientWidth: 400,
    addEventListener(type, listener) { listeners.set(type, listener); },
    fire(type, event = {}) { listeners.get(type)?.({ preventDefault() {}, ...event }); },
    dispatchEvent(event) { this.fire(event.type, event); return true; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    setAttribute() {}, focus() {}, remove() {}, classList: { add() {}, remove() {} },
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; },
  };
}

test("dropping either a file or folder reference inserts into the draft without submitting", async () => {
  const previous = { document: globalThis.document, navigator: globalThis.navigator, matchMedia: globalThis.matchMedia, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { createElement: node, createTextNode: (text) => text, querySelector: () => null, body: node() };
  globalThis.navigator = { platform: "Linux" }; globalThis.matchMedia = () => ({ matches: false }); globalThis.getComputedStyle = () => ({});
  try {
    const { state } = await import("../lib/app/web/public/app/state.js");
    const { buildComposer, mount, composerRefs } = await import("../lib/app/web/public/app/views/composer/composer.js");
    state.agent = { id: "file-drop", project: "test" }; state.blocks = []; state.draftAttachments = []; state.composerByAgent.clear(); state.prefs.autocomplete = false;
    const sent = []; mount(null, { emit(type, packet) { if (type === "server") sent.push(packet); } });
    const form = buildComposer();
    for (const reference of ["[notes.md](<docs/notes.md>)", "[docs](<docs/>)"]) {
      composerRefs.textareaEl.value = "Review "; composerRefs.textareaEl.selectionStart = composerRefs.textareaEl.selectionEnd = 7;
      form.fire("drop", { dataTransfer: { getData: (type) => type === "application/x-omoya-reference" ? reference : "", files: [] } });
      expect(composerRefs.textareaEl.value).toBe(`Review ${reference}`);
    }
    let prevented = false;
    form.fire("drop", { preventDefault() { prevented = true; }, dataTransfer: { types: ["text/plain"], getData: () => "", files: [] } });
    expect(prevented).toBe(false);
    expect(sent).toEqual([]);
    await new Promise((resolve) => queueMicrotask(resolve));
  } finally { Object.assign(globalThis, previous); }
});
