import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reconcileRows } from "../lib/app/web/public/app/logic/transcript-rows.js";

const css = readFileSync(new URL("../lib/app/web/public/style.css", import.meta.url), "utf8");

function harness(blocks) {
  const nodes = [];
  const children = [];
  const rowBlocks = new WeakMap();
  const dirty = new Set();
  const makeFrame = (block) => {
    const row = { className: "entering", block, removed: false,
      remove() { this.removed = true; children.splice(children.indexOf(this), 1); },
      replaceWith(next) { children.splice(children.indexOf(this), 1, next); },
    };
    rowBlocks.set(row, block);
    return row;
  };
  const container = { append: (row) => children.push(row) };
  const patch = (row, block) => { block.open ??= row.block.open; row.block = block; rowBlocks.set(row, block); };
  const flush = (refresh = false) => reconcileRows({ blocks, nodes, rowBlocks, container, makeFrame, patch, refresh, dirty });
  return { blocks, nodes, children, dirty, flush };
}

for (const kind of ["user", "text", "thinking", "tool", "system", "error", "command"]) {
  test(`${kind} bubbles animate at creation and retain their row on refresh`, () => {
    const blocks = [{ kind, done: true, callId: kind === "tool" ? "call-1" : undefined }];
    const view = harness(blocks);
    view.flush();
    const row = view.nodes[0];
    expect(row.className).toBe("entering");
    blocks[0] = { ...blocks[0], text: "authoritative final text" };
    blocks.push({ kind, done: true });
    view.flush(true);
    expect(view.nodes[0]).toBe(row);
    expect(view.nodes[1].className).toBe("entering");
    view.dirty.add(blocks[0]);
    view.flush();
    expect(view.nodes[0]).toBe(row);
  });
}

test("shorter histories remove stale rows and changed tool calls remount", () => {
  const blocks = [{ kind: "tool", callId: "one" }, { kind: "text" }];
  const view = harness(blocks);
  view.flush();
  const oldRow = view.nodes[0];
  const removedRow = view.nodes[1];
  blocks.splice(0, 2, { kind: "tool", callId: "two" });
  view.flush(true);
  expect(view.nodes[0]).not.toBe(oldRow);
  expect(removedRow.removed).toBe(true);
  expect(view.children).toHaveLength(1);
});

test("authoritative history keeps a card's expansion state on its existing row", () => {
  const blocks = [{ kind: "tool", callId: "one", open: true }];
  const view = harness(blocks);
  view.flush();
  const row = view.nodes[0];
  blocks[0] = { kind: "tool", callId: "one" };
  view.flush(true);
  expect(view.nodes[0]).toBe(row);
  expect(blocks[0].open).toBe(true);
});

test("motion is disabled when the user requests reduced motion", () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  expect(css).toContain(".message-row.entering");
});
