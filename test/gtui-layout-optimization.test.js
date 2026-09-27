import { expect, test } from "bun:test";
import { layoutInternals, layoutView } from "../lib/app/gtui/layout.js";
import { GTUI } from "../lib/app/gtui/gtui.js";

const text = (content, priority = 0) => ({ type: "text", content, margin: 0, priority });

test("long wrapped token ranges retain every logical grapheme in order", () => {
  const node = text(Array.from({ length: 300 }, (_, i) => String(i % 10)).join(""));
  const rows = layoutInternals.textRows(node, 7);
  expect(rows.flat().map((token) => token.text).join("")).toBe(node.content);
  expect(rows).toHaveLength(Math.ceil(node.content.length / 7));
});

test("tight equal-priority tracks discard later children first", async () => {
  const host = GTUI.host.memory({ width: 20, height: 2 });
  const ui = new GTUI({ host });
  const run = ui.run({ init: () => ({ model: null }), update: (model) => model, view: () => GTUI.view.column({}, [text("first"), text("second"), text("third")]) });
  expect(host.snapshot().lines).toEqual(["first", "second"]);
  ui.stop(); await run;
});

test("many fill tracks split available columns without loss", () => {
  const tracks = Array.from({ length: 101 }, () => "fill");
  const sizes = layoutInternals.trackSizes(tracks, 1000, Array(101).fill(0));
  expect(sizes.reduce((sum, width) => sum + width, 0)).toBe(1000);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("mutable source metadata invalidates cached text rows and retains mapping", () => {
  const source = { itemKey: "old", start: 4 };
  const node = { type: "text", margin: 0, selectionKey: "message", source, content: "😀x" };
  expect(layoutView(node, { width: 3, height: 1 }).snapshot.sources).toContainEqual({ row: 0, start: 0, end: 2, source: { itemKey: "old", start: 4, end: 6 } });
  source.itemKey = "new";
  source.start = 9;
  expect(layoutView(node, { width: 3, height: 1 }).snapshot.sources).toContainEqual({ row: 0, start: 0, end: 2, source: { itemKey: "new", start: 9, end: 11 } });
});

test("frozen rows cache only frozen data properties, never accessor content", () => {
  let reads = 0;
  const accessor = { type: "text", margin: 0 };
  Object.defineProperty(accessor, "content", { enumerable: true, get() { return ++reads === 1 ? "old" : "new"; } });
  Object.freeze(accessor);
  expect(layoutView(accessor, { width: 8, height: 1 }).snapshot.lines).toEqual(["old"]);
  expect(layoutView(accessor, { width: 8, height: 1 }).snapshot.lines).toEqual(["new"]);

  const immutable = deepFreeze({ type: "text", margin: 0, source: { itemKey: "frozen", start: 0 }, content: "same rows" });
  expect(layoutView(immutable, { width: 4, height: 3 }).snapshot.lines).toEqual(["same", "rows"]);
  expect(layoutView(immutable, { width: 4, height: 3 }).snapshot.sources).toContainEqual({ row: 0, start: 0, end: 1, source: { itemKey: "frozen", start: 0, end: 1 } });
});

test("remembered frozen verdicts never make a node with a mutable part cacheable", () => {
  const shared = deepFreeze({ itemKey: "shared", start: 0 });
  // Remember `shared` as deep-frozen through a fully frozen node first.
  const frozen = deepFreeze({ type: "text", margin: 0, source: shared, content: "frozen" });
  expect(layoutView(frozen, { width: 10, height: 1 }).snapshot.lines).toEqual(["frozen"]);
  // A frozen shell around the same frozen part plus a mutable span.
  const span = { text: "before" };
  const node = Object.freeze({ type: "text", margin: 0, source: shared, content: Object.freeze([span]) });
  expect(layoutView(node, { width: 10, height: 1 }).snapshot.lines).toEqual(["before"]);
  span.text = "after";
  expect(layoutView(node, { width: 10, height: 1 }).snapshot.lines).toEqual(["after"]);
  // Freezing it later makes it cacheable; the content is now fixed.
  Object.freeze(span);
  expect(layoutView(node, { width: 10, height: 1 }).snapshot.lines).toEqual(["after"]);
  expect(layoutView(node, { width: 10, height: 1 }).snapshot.lines).toEqual(["after"]);
});

test("cached text rows re-wrap on every width change (resize and back)", () => {
  const node = deepFreeze({ type: "text", margin: 0, content: "alpha beta gamma delta" });
  const at = (width) => layoutView(node, { width, height: 6 }).snapshot.lines;
  expect(at(30)).toEqual(["alpha beta gamma delta"]);
  expect(at(12)).toEqual(["alpha beta", "gamma delta"]);
  expect(at(30)).toEqual(["alpha beta gamma delta"]);
  expect(at(6)).toEqual(["alpha", "beta", "gamma", "delta"]);
  expect(at(12)).toEqual(["alpha beta", "gamma delta"]);
  // Mutable content at an unchanged width is never served stale.
  const mutable = { type: "text", margin: 0, content: "one" };
  expect(layoutView(mutable, { width: 12, height: 1 }).snapshot.lines).toEqual(["one"]);
  mutable.content = "two";
  expect(layoutView(mutable, { width: 12, height: 1 }).snapshot.lines).toEqual(["two"]);
});

test("layout builds the semantic snapshot only when it is read", () => {
  const scene = layoutView({ type: "text", margin: 0, content: "lazy" }, { width: 8, height: 1 });
  expect(Object.getOwnPropertyDescriptor(scene, "snapshot").get).toBeFunction();
  expect(scene.snapshot).toBe(scene.snapshot); // built once
  expect(scene.snapshot.lines).toEqual(["lazy"]);
});

test("scroll culls historical rows while preserving visible source mappings", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ node: {
    type: "text", margin: 0, selectionKey: `m${index}`, sourceText: `line ${index}`,
    source: { itemKey: `m${index}`, start: 0 }, content: `line ${index}`,
  } }));
  const result = layoutView({ type: "scroll", anchor: "end", children: [{ type: "column", children: items.map(({ node }) => node) }] }, { width: 10, height: 2 });
  expect(result.snapshot.lines).toEqual(["line 18", "line 19"]);
  expect(result.snapshot.sources.every(({ source }) => source.itemKey === "m18" || source.itemKey === "m19")).toBe(true);
});
