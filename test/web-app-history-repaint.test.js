import { expect, it } from "bun:test";
import { reconcileRows } from "../lib/app/web/public/app/logic/transcript-rows.js";

it("does not repaint settled thinking when an authoritative history changes only the tail", async () => {
  const globals = ["matchMedia", "requestAnimationFrame", "cancelAnimationFrame", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  globalThis.matchMedia ??= () => ({ matches: false });
  globalThis.requestAnimationFrame ??= () => 1;
  globalThis.cancelAnimationFrame ??= () => {};
  globalThis.document = { querySelector: () => null };
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { setHistory } = await import("../lib/app/web/public/app/orchestrators/turn-state.js");
  const saved = { blocks: state.blocks, nodes: state.nodes, dirty: state.dirty, fullRender: state.fullRender, resetTranscript: state.resetTranscript, stickBottom: state.stickBottom, current: state.current };
  const nodes = [];
  const rowBlocks = new WeakMap();
  const patches = [];
  const makeFrame = (block) => { const row = { remove() {}, replaceWith() {} }; rowBlocks.set(row, block); return row; };
  const container = { append() {} };
  const paint = () => {
    reconcileRows({ blocks: state.blocks, nodes, rowBlocks, container, makeFrame, patch: (row, block) => { patches.push(block); rowBlocks.set(row, block); }, refresh: state.fullRender, dirty: state.dirty });
    state.fullRender = false;
    state.dirty.clear();
  };
  try {
    Object.assign(state, { blocks: [], nodes, dirty: new Set(), fullRender: false, current: null, resetTranscript: false, stickBottom: false });
    const thought = { kind: "thinking", text: "settled", done: true, messageIndex: 0, blockIndex: 0 };
    setHistory([thought, { kind: "text", text: "first", done: true, messageIndex: 0, blockIndex: 1 }], true);
    paint();
    const oldThought = state.blocks[0];
    setHistory([thought, { kind: "text", text: "second", done: true, messageIndex: 0, blockIndex: 1 }], true);
    paint();
    expect(state.blocks[0]).toBe(oldThought);
    expect(patches).toHaveLength(1);
    expect(patches[0].text).toBe("second");
    patches.length = 0;
    setHistory([{ ...thought, text: "corrected" }, { kind: "text", text: "second", done: true, messageIndex: 0, blockIndex: 1 }], true);
    paint();
    expect(patches).toHaveLength(1);
    expect(patches[0].text).toBe("corrected");
  } finally {
    const { flush } = await import("../lib/app/web/public/app/render.js");
    flush();
    const { flushRender } = await import("../lib/app/web/public/app/views/transcript/transcript.js");
    flushRender();
    Object.assign(state, saved);
    for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
