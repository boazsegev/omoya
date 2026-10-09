import { expect, test } from "bun:test";
import { filteredMenu } from "../lib/app/gtui/controls/menu.js";
import { createControls } from "../lib/app/gtui/controls.js";
import { layoutView } from "../lib/app/gtui/layout.js";
import { view } from "../lib/app/gtui/gtui.js";

test("menu search indexes nested action rows without crowding the empty-query root", () => {
  const root = { kind: "action", label: "Settings" };
  const nested = { kind: "action", label: "Thinking: high", note: "Settings › Agent" };
  const node = { items: [root], searchItems: [root, nested] };
  expect(filteredMenu({ query: "" }, node)).toEqual([root]);
  expect(filteredMenu({ query: "thinking" }, node)).toEqual([nested]);
  expect(filteredMenu({ query: "agent" }, node)).toEqual([nested]);
  expect(filteredMenu({ query: "absent" }, node)).toEqual([]);
});

test("filtering preserves explicit escape-hatch choices without retaining headers", () => {
  const custom = { kind: "action", label: "Custom value…", alwaysVisible: true };
  const header = { kind: "header", label: "Header", alwaysVisible: true };
  expect(filteredMenu({ query: "unlisted model" }, { items: [header, custom] })).toEqual([custom]);
});

test("compact labels preserve model prefixes and suffixes in one row without changing searchable values", () => {
  const label = "provider/identical-family-prefix-distinct-release-299";
  const controls = createControls(() => {});
  const scene = layoutView(view.menu({ id: "models", focus: true, labelOverflow: "clip-middle", items: [{ label, value: "selected" }] }), { width: 30, height: 8, controls });
  const visible = scene.snapshot.lines.join("\n");
  expect(visible).toContain("provider/");
  expect(visible).toContain("299");
  expect(visible).toContain("…");
  expect(filteredMenu({ query: "family-prefix" }, { items: [{ label }] })).toHaveLength(1);
});

test("menu change events distinguish filtering from navigation and expose the current query", () => {
  const events = [];
  const controls = createControls((event) => events.push(event));
  const node = view.menu({ id: "choice", focus: true, items: [
    { label: "Alpha", value: "a" }, { label: "Beta", value: "b" },
  ] });
  const mount = () => layoutView(node, { width: 40, height: 12, controls });
  mount();
  controls.handle({ type: "key", key: "b", text: "b" });
  expect(events.at(-1)).toMatchObject({ type: "menu.change", id: "choice", query: "b", reason: "filter" });
  mount();
  controls.handle({ type: "key", key: "down" });
  expect(events.at(-1)).toMatchObject({ query: "b", reason: "navigation", item: { value: "b" } });
  controls.handle({ type: "key", key: "backspace" });
  expect(events.at(-1)).toMatchObject({ query: "", reason: "filter" });
});
