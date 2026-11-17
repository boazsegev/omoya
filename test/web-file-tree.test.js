import { expect, test } from "bun:test";

/** Minimal DOM surface for exercising the production row renderer, not its network shell. */
function fakeDOM() {
  const nodes = [];
  function node(tag, className, text) {
    const element = {
      tag, className, text, dataset: {}, children: [], listeners: {},
      classList: { toggle() {} },
      append(...children) { this.children.push(...children); },
      setAttribute() {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
    };
    nodes.push(element);
    return element;
  }
  return { node, nodes, rows: () => nodes.filter((element) => element.className === "files-row") };
}

test("large file disclosures render 100-entry batches while preserving nested context and focus", async () => {
  const source = await Bun.file(new URL("../lib/app/web/public/app/views/shell/files.js", import.meta.url)).text();
  const batch = Number(source.match(/const ENTRY_BATCH = (\d+);/)[1]);
  const start = source.indexOf("  entry(entry, root = false) {");
  const end = source.indexOf("  newFolderForm(draft) {", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const dom = fakeDOM();
  const entries = Array.from({ length: 22748 }, (_, index) => ({ name: `folder-${index}`, path: `ai-tmp/folder-${index}`, directory: true }));
  const rootEntries = [
    { name: "ai-tmp", path: "ai-tmp", directory: true },
    { name: "sibling", path: "sibling", directory: true },
  ];
  const model = { project: "demo", selected: "ai-tmp", expanded: new Set(["", "ai-tmp"]), folders: new Map(), revealSupported: false };
  const folderFor = (model, path) => {
    if (!model.folders.has(path)) model.folders.set(path, {
      id: path, entries: path === "" ? rootEntries : path === "ai-tmp" ? entries : null,
      visibleCount: batch, loading: null, error: "",
    });
    return model.folders.get(path);
  };
  // Compile the real method so a regression back to rendering every entry fails this test.
  const renderer = new Function("node", "icon", "button", "folderFor", "ENTRY_BATCH", `return ({${source.slice(start, end)}})`)(
    dom.node, () => dom.node("svg"), () => dom.node("button"), folderFor, batch,
  );
  renderer.model = model;
  renderer.addControl = () => dom.node("button");
  renderer.dropTarget = () => {};
  renderer.render = (key) => { renderer.focusKey = key; };
  const root = { name: "root", path: "", directory: true };
  const draw = () => { dom.nodes.length = 0; renderer.entry(root, true); };

  draw();
  expect(batch).toBe(100);
  expect(dom.rows()).toHaveLength(103); // Root, ai-tmp, sibling, and 100 children.
  const more = dom.nodes.find((element) => element.className === "files-more");
  expect(more.text).toContain("Show next 100");
  expect(more.text).toContain((22748 - batch).toLocaleString());
  expect(dom.nodes.some((element) => element.text === "sibling")).toBe(true);
  more.listeners.click();
  expect(folderFor(model, "ai-tmp").visibleCount).toBe(200);
  expect(renderer.focusKey).toBe("entry:ai-tmp/folder-100");
  draw();
  expect(dom.rows()).toHaveLength(203);

  model.expanded.delete("ai-tmp");
  draw();
  expect(dom.rows()).toHaveLength(3);
  expect(dom.nodes.some((element) => element.className === "files-more")).toBe(false);
  model.expanded.add("ai-tmp");
  draw();
  expect(dom.rows()).toHaveLength(203); // Previously revealed batch is retained.

  folderFor(model, "ai-tmp").visibleCount = Math.floor(entries.length / batch) * batch;
  draw();
  const lastBatch = dom.nodes.find((element) => element.className === "files-more");
  expect(lastBatch.text).toContain("Show next 48");
});
