import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { createControls, controlInternals } from "../lib/gtui/controls.js";
import { layoutView } from "../lib/gtui/layout.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function controlled(initial, render) {
  let model = initial;
  const memory = GTUI.host.memory({ width: 20, height: 8 });
  const ui = new GTUI({ host: memory });
  const events = [];
  const running = ui.run({
    init: () => ({ model, effects: [] }),
    update: (current, message) => {
      events.push(message);
      if (message.type === "input.change") model = { ...current, value: message.value ?? current.value, caret: message.caret ?? current.caret, selection: message.selection ?? null };
      else if (message.type === "scroll.change") model = { ...current, offset: message.offset };
      else model = current;
      return { model, effects: [] };
    },
    view: render,
  });
  return { memory, ui, running, events, model: () => model };
}

test("input soft-wrap reserves both text margins", () => {
  const layout = controlInternals.inputRows({ value: "123456789012345", margin: 2 }, 20);
  expect(layout.textWidth).toBe(16);
  expect(layout.rows.map((row) => row.text)).toEqual(["123456789012345"]);
  expect(controlInternals.inputRows({ value: "12345678901234567", margin: 2 }, 20).rows).toHaveLength(2);
});

test("a textual shortcut cell resolves to its semantic action", () => {
  const events = [];
  const controls = createControls((event) => events.push(event));
  const root = GTUI.view.text({}, [{ text: "^X menu", action: "shortcut.ctrl+x" }]);
  controls.beginFrame();
  const scene = layoutView(root, { width: 20, height: 2, controls });
  controls.endFrame(root, scene.canvas);
  const resolved = controls.resolvePoint({ x: 2, y: 0 });
  expect(resolved).toEqual({ kind: "press", control: "action", action: "shortcut.ctrl+x" });
  expect(controls.handle({ type: "pointer", ...resolved, x: 2, y: 0, kind: "press", button: 0 })).toBe(true);
  expect(events).toEqual([{ type: "action.select", action: "shortcut.ctrl+x" }]);
});

test("pointer motion applies the theme-owned hover role to link cells", () => {
  const controls = createControls(() => {});
  const root = GTUI.view.text({}, [{ text: "docs", link: "https://example.test/docs" }]);
  controls.beginFrame();
  const scene = layoutView(root, { width: 20, height: 2, controls });
  controls.endFrame(root, scene.canvas);
  expect(controls.handle({ type: "pointer", kind: "move", x: 2, y: 0 })).toBe(true);
  expect(scene.canvas.cells[0][2].role).toBe("text link.hover");
  expect(controls.handle({ type: "pointer", kind: "move", x: 10, y: 0 })).toBe(true);
  expect(scene.canvas.cells[0][2].role).toBeUndefined();
});

test("a link cell resolves to a semantic open request instead of a text selection", () => {
  const events = [];
  const controls = createControls((event) => events.push(event));
  const root = GTUI.view.text({ selectionKey: "source" }, [{ text: "docs", link: "https://example.test/docs", source: { start: 0, end: 4 } }]);
  controls.beginFrame();
  const scene = layoutView(root, { width: 20, height: 2, controls });
  controls.endFrame(root, scene.canvas);
  const resolved = controls.resolvePoint({ x: 2, y: 0 });
  expect(resolved).toEqual({ kind: "press", control: "link", link: "https://example.test/docs" });
  expect(controls.handle({ type: "pointer", ...resolved, x: 2, y: 0, kind: "press", button: 0 })).toBe(true);
  expect(events).toEqual([{ type: "link.open", url: "https://example.test/docs" }]);
});

test("control disposal releases mounted-node state instead of retaining obsolete objects", () => {
  const controls = createControls(() => {});
  const before = controls.stateFor("obsolete");
  before.pastes.set("token", { large: new Array(1000).fill("held") });
  controls.dispose();
  const after = controls.stateFor("obsolete");
  expect(after).not.toBe(before);
  expect(after.pastes.size).toBe(0);
});

describe("GTUI controlled input", () => {
  test("Alt+Left/Right remain word navigation and never bubble to app shortcuts", async () => {
    const fixture = controlled({ value: "one two", caret: 3, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    fixture.memory.send(GTUI.event.key({ key: "alt+right" }));
    await tick();
    expect(fixture.model()).toMatchObject({ value: "one two", caret: 7 });
    expect(fixture.events.some((event) => event.type === "key" && event.key === "alt+right")).toBe(false);
    fixture.ui.stop();
    await fixture.running;
  });

  test("edits, selects, deletes, submits, and bubbles an unused visual Up", async () => {
    const fixture = controlled({ value: "one two", caret: 7, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    fixture.memory.send(GTUI.event.key({ key: "alt+left" }));
    await tick();
    fixture.memory.send(GTUI.event.key({ key: "shift+right" }));
    await tick();
    fixture.memory.send(GTUI.event.key({ key: "backspace" }));
    await tick();
    fixture.memory.send(GTUI.event.key({ key: "enter" }));
    await tick();
    expect(fixture.model()).toMatchObject({ value: "one wo", caret: 4, selection: null });
    expect(fixture.events.at(-1)).toEqual({ type: "input.submit", id: "draft", value: "one wo" });
    fixture.memory.send(GTUI.event.key({ key: "up" }));
    expect(fixture.events.at(-1)).toMatchObject({ type: "key", key: "up" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("coalesces single non-whitespace insertions, keeps other changes bounded, and clears redo/submitted history", async () => {
    const fixture = controlled({ value: "", caret: 0, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    for (const text of ["a", "b", "c"]) fixture.memory.send(GTUI.event.key({ key: text, text }));
    fixture.memory.send(GTUI.event.key({ key: "meta+z" }));
    expect(fixture.model()).toMatchObject({ value: "", caret: 0, selection: null });
    fixture.memory.send(GTUI.event.key({ key: "ctrl+shift+z" }));
    expect(fixture.model()).toMatchObject({ value: "abc", caret: 3, selection: null });
    // Whitespace remains its own undo boundary.
    fixture.memory.send(GTUI.event.key({ key: "space", text: " " }));
    fixture.memory.send(GTUI.event.key({ key: "meta+z" }));
    expect(fixture.model().value).toBe("abc");
    fixture.memory.send(GTUI.event.key({ key: "meta+z" }));
    fixture.memory.send(GTUI.event.key({ key: "x", text: "x" }));
    fixture.memory.send(GTUI.event.key({ key: "ctrl+shift+z" }));
    expect(fixture.model().value).toBe("x"); // first non-redo edit discarded "abc"
    // A single insertion in the middle preserves its constant postfix and
    // coalesces with the state before it.
    fixture.memory.send(GTUI.event.key({ key: "meta+z" }));
    fixture.memory.send(GTUI.event.key({ key: "a", text: "a" }));
    fixture.memory.send(GTUI.event.key({ key: "c", text: "c" }));
    fixture.memory.send(GTUI.event.key({ key: "left" }));
    fixture.memory.send(GTUI.event.key({ key: "b", text: "b" }));
    fixture.memory.send(GTUI.event.key({ key: "meta+z" }));
    expect(fixture.model().value).toBe("");
    // Multi-character changes remain independent, so the 20-state bound is
    // still enforced even after character insertion coalescing.
    for (let index = 0; index < 25; index++) fixture.memory.send(GTUI.event.key({ key: "xy", text: "xy" }));
    for (let index = 0; index < 25; index++) fixture.memory.send(GTUI.event.key({ key: "meta+z" }));
    expect(fixture.model().value).toBe("xy".repeat(5)); // only 20 changes retained
    fixture.memory.send(GTUI.event.key({ key: "enter" }));
    fixture.memory.send(GTUI.event.key({ key: "meta+z" }));
    expect(fixture.model().value).toBe("xy".repeat(5)); // submit cleared both streams
    fixture.ui.stop();
    await fixture.running;
  });

  test("Cmd+arrows jump paragraph and input boundaries; Shift selects the covered text", () => {
    const edit = (value, caret, key, selection = null) => controlInternals.inputEdit({ value, caret, selection }, { type: "key", key }, 20);
    const multi = "first paragraph\nsecond paragraph\nthird";
    // Cmd+Left/Right: current paragraph (line) start/end.
    expect(edit(multi, 25, "meta+left").caret).toBe(16); // "second paragraph" starts at 16
    expect(edit(multi, 25, "meta+right").caret).toBe(32);
    expect(edit(multi, 16, "meta+right").caret).toBe(32); // at the start: still the boundary
    expect(edit("one two", 3, "meta+left").caret).toBe(0); // single line: the input boundary
    // Cmd+Up/Down: the whole input's start/end.
    expect(edit(multi, 25, "meta+up").caret).toBe(0);
    expect(edit(multi, 25, "meta+down").caret).toBe(multi.length);
    // Shift extends the selection over the covered text.
    expect(edit(multi, 25, "meta+shift+left").selection).toEqual({ anchor: 25, caret: 16 });
    expect(edit(multi, 25, "meta+shift+down").selection).toEqual({ anchor: 25, caret: multi.length });
    expect(edit(multi, 25, "meta+shift+up", { anchor: 20, caret: 25 }).selection).toEqual({ anchor: 20, caret: 0 });
    // Plain movement still collapses the selection.
    expect(edit(multi, 25, "meta+left", { anchor: 20, caret: 25 }).selection).toBeNull();
  });

  test("supports terminal aliases, modified selection, soft breaks, and Ctrl+W line deletion", () => {
    const edit = (value, caret, key) => controlInternals.inputEdit({ value, caret, selection: null }, { type: "key", key }, 20);
    expect(edit("one two", 7, "alt+b").caret).toBe(4);
    expect(edit("one two", 7, "alt+shift+left").selection).toEqual({ anchor: 7, caret: 4 });
    expect(edit("one", 3, "alt+enter")).toMatchObject({ value: "one\n", caret: 4 });
    expect(edit("keep\nremove", 8, "ctrl+w")).toMatchObject({ value: "keep\n", caret: 5 });
    expect(edit("a👨‍👩‍👧‍👦b", "a👨‍👩‍👧‍👦".length, "backspace")).toMatchObject({ value: "ab", caret: 1 });
  });

  test("readline/Emacs aliases share the declarative editing map: Ctrl+A/E/K/U, Alt+D", () => {
    const edit = (value, caret, key, selection = null) => controlInternals.inputEdit({ value, caret, selection }, { type: "key", key }, 20);
    // Line boundaries.
    expect(edit("one two\nthree", 8, "ctrl+a").caret).toBe(8); // start of the second line
    expect(edit("one two\nthree", 8, "ctrl+e").caret).toBe(13);
    expect(edit("one two", 3, "ctrl+a").caret).toBe(0);
    // Kill to line end / start; the newline survives either way.
    expect(edit("one two\nthree", 4, "ctrl+k")).toMatchObject({ value: "one \nthree", caret: 4 });
    expect(edit("one two\nthree", 4, "ctrl+u")).toMatchObject({ value: "two\nthree", caret: 0 });
    // Forward word deletion: Alt+D to the word END, Alt+Delete over the whole word.
    expect(edit("one two three", 4, "alt+d")).toMatchObject({ value: "one  three", caret: 4 });
    expect(edit("one two three", 3, "alt+d")).toMatchObject({ value: "one two three", caret: 3 }); // at a separator: nothing to kill (option+delete parity)
    expect(edit("one two three", 3, "alt+delete")).toMatchObject({ value: "one three", caret: 3 });
    expect(edit("one two three", 7, "alt+backspace")).toMatchObject({ value: "one  three", caret: 4 }); // word before the caret, separator kept
    // Shift selection composes with the same aliases.
    expect(edit("one two", 0, "ctrl+shift+e").selection).toEqual({ anchor: 0, caret: 7 });
    // Every entry is one declarative {keys, run} pair compiled through
    // keymap.js's contexts — the same matching app bindings(model) uses.
    expect(controlInternals.EDITING_MAP.every((entry) => Array.isArray(entry.keys) && typeof entry.run === "function" && entry.context)).toBe(true);
    // Selection is an explicit, immutable editor binding state — inputs do
    // not rely on each screen to reimplement replacement/collapse behavior.
    expect(Object.isFrozen(controlInternals.SELECTED_EDITING_MAP)).toBe(true);
    expect(controlInternals.SELECTED_EDITING_MAP).not.toBe(controlInternals.EDITING_MAP);
  });

  test("selection semantics: plain moves collapse to the named edge, typing/deletion replace", () => {
    const edit = (value, caret, key, selection = null) => controlInternals.inputEdit({ value, caret, selection }, { type: "key", key }, 20);
    const sel = { anchor: 4, caret: 7 }; // "two" in "one two three" (start=4, end=7)
    // Plain arrows collapse to the selection's OWN edge on the walked side.
    expect(edit("one two three", 7, "left", sel)).toMatchObject({ caret: 4, selection: null });
    expect(edit("one two three", 4, "right", sel)).toMatchObject({ caret: 7, selection: null });
    // A reversed selection collapses the same way (the edge, never inside).
    expect(edit("one two three", 4, "left", { anchor: 7, caret: 4 })).toMatchObject({ caret: 4, selection: null });
    // Word moves land on the selection's edge, not a spot inside it.
    expect(edit("one two three", 7, "alt+left", sel)).toMatchObject({ caret: 4, selection: null });
    expect(edit("one two three", 4, "alt+right", sel)).toMatchObject({ caret: 7, selection: null });
    // Home/End (and readline Ctrl+A/E) collapse to the line-ward edge.
    expect(edit("one two three", 7, "home", sel)).toMatchObject({ caret: 0, selection: null });
    expect(edit("one two three", 4, "end", sel)).toMatchObject({ caret: 13, selection: null });
    expect(edit("one two three", 7, "ctrl+a", sel)).toMatchObject({ caret: 0, selection: null });
    expect(edit("one two three", 4, "ctrl+e", sel)).toMatchObject({ caret: 13, selection: null });
    // Vertical moves collapse to the row-ward edge when there IS a row
    // that way; at the first/last visual row the plain vertical BUBBLES
    // (null — app policy, e.g. the questionnaire's cross-to-menu, runs).
    expect(edit("one two\nthree four", 12, "up", { anchor: 9, caret: 12 })).toMatchObject({ caret: 9, selection: null });
    expect(edit("one two\nthree four", 3, "down", { anchor: 3, caret: 6 })).toMatchObject({ caret: 6, selection: null });
    expect(edit("one two", 3, "up", { anchor: 0, caret: 3 })).toBeNull(); // first row: bubbles to the app
    // Cmd+Up/Down (whole-input boundaries) collapse to the named end.
    expect(edit("one two three", 7, "meta+up", sel)).toMatchObject({ caret: 0, selection: null });
    expect(edit("one two three", 4, "meta+down", sel)).toMatchObject({ caret: 13, selection: null });
    // Typing replaces the selection; Backspace/Delete remove it.
    expect(controlInternals.inputEdit({ value: "one two three", caret: 7, selection: sel }, { type: "key", key: "x", text: "x" }, 20))
      .toMatchObject({ value: "one x three", caret: 5, selection: null });
    expect(edit("one two three", 7, "backspace", sel)).toMatchObject({ value: "one  three", caret: 4, selection: null });
    expect(edit("one two three", 4, "delete", sel)).toMatchObject({ value: "one  three", caret: 4, selection: null });
  });

  test("renders RTL input visually while submit retains logical text order", async () => {
    const fixture = controlled({ value: "שלום", caret: 4, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    expect(fixture.memory.snapshot().lines.join("\n")).toContain("םולש");
    expect(fixture.memory.snapshot().caret).toMatchObject({ id: "draft", index: 4, column: 2 });
    fixture.memory.send(GTUI.event.key({ key: "enter" }));
    await tick();
    expect(fixture.events.at(-1)).toEqual({ type: "input.submit", id: "draft", value: "שלום" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("collapses large pastes for display and expands them exactly once on submit", async () => {
    const fixture = controlled({ value: "", caret: 0, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    const pasted = `${"large line\n".repeat(300)}tail`;
    fixture.memory.send(GTUI.event.paste({ text: pasted }));
    await tick();
    expect(fixture.model().value).toMatch(/^\[Pasted 301 lines #1\]$/);
    expect(fixture.memory.snapshot().lines.join("\n")).not.toContain("large line");
    fixture.memory.send(GTUI.event.key({ key: "enter" }));
    await tick();
    expect(fixture.events.at(-1)).toEqual({ type: "input.submit", id: "draft", value: pasted });
    fixture.ui.stop();
    await fixture.running;
  });

  test("moves vertically over host-owned wrapped rows", async () => {
    const fixture = controlled({ value: "one two three four five six", caret: 27 }, (model) => GTUI.view.input({ id: "draft", focus: true, margin: 2, ...model }));
    fixture.memory.send(GTUI.event.key({ key: "up" }));
    await tick();
    expect(fixture.model().caret).toBeLessThan(27);
    expect(fixture.memory.snapshot().caret).toMatchObject({ id: "draft", index: fixture.model().caret });
    fixture.ui.stop();
    await fixture.running;
  });

  test("resolves pointer locations to text indices", async () => {
    const fixture = controlled({ value: "hello", caret: 5 }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", target: "draft", index: 2 }));
    expect(fixture.events.at(-1)).toMatchObject({ type: "input.change", id: "draft", caret: 2 });
    fixture.ui.stop();
    await fixture.running;
  });

  test("double/triple click selection survives an unmoved or one-letter release", async () => {
    const fixture = controlled({ value: "hello brave world\nnext", caret: 22, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    const pointer = (kind, index) => fixture.memory.send(GTUI.event.pointer({ kind, control: "input", target: "draft", index, button: 0, x: index + 2, y: 1 }));
    pointer("press", 8);
    pointer("release", 8);
    pointer("press", 8);
    expect(fixture.model().selection).toEqual({ anchor: 6, caret: 11 });
    pointer("release", 8);
    expect(fixture.model().selection).toEqual({ anchor: 6, caret: 11 });
    pointer("press", 8);
    expect(fixture.model().selection).toEqual({ anchor: 0, caret: 17 });
    pointer("release", 9);
    expect(fixture.model().selection).toEqual({ anchor: 0, caret: 17 });
    fixture.ui.stop();
    await fixture.running;
  });

  test("a multi-click selection extends only after moving more than one letter", async () => {
    const fixture = controlled({ value: "hello brave world", caret: 17, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    const pointer = (kind, index) => fixture.memory.send(GTUI.event.pointer({ kind, control: "input", target: "draft", index, button: 0, x: index + 2, y: 1 }));
    pointer("press", 8);
    pointer("release", 8);
    pointer("press", 8);
    pointer("drag", 12);
    // Input drag preview is host-local; word-mode expands through the word.
    expect(fixture.memory.snapshot().roles.some(({ role }) => role === "input.selection")).toBe(true);
    pointer("release", 12);
    expect(fixture.model().selection).toEqual({ anchor: 6, caret: 17 });
    fixture.ui.stop();
    await fixture.running;
  });

  test("mouse drags select input text in logical indexes", async () => {
    const fixture = controlled({ value: "hello", caret: 5, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "input", target: "draft", index: 1, button: 0, x: 3, y: 1 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "input", target: "draft", index: 4, button: 0, x: 6, y: 1 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "input", target: "draft", index: 4, button: 0, x: 6, y: 1 }));
    expect(fixture.model().selection).toEqual({ anchor: 1, caret: 4 });
    expect(fixture.memory.snapshot().roles.some(({ role }) => role === "input.selection")).toBe(true);
    fixture.ui.stop();
    await fixture.running;
  });

  test("mouse drags select transcript source in logical bidi order", async () => {
    const fixture = controlled({}, () => GTUI.view.text({ margin: 0, selectionKey: "message" }, [
      { text: "שלום", source: { start: 0, end: 4 } },
    ]));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "message", button: 0, x: 0, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "message", button: 0, x: 3, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "message", button: 0, x: 3, y: 0 }));
    expect(fixture.memory.snapshot().roles.some(({ role }) => role.includes("selection"))).toBe(true);
    fixture.memory.send(GTUI.event.key({ key: "copy" }));
    expect(fixture.events.at(-1)).toEqual({ type: "selection.copy", text: "שלום" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("mouse text drag repaints only after moving more than 0.75 cell and resolves on release", async () => {
    const fixture = controlled({}, () => GTUI.view.text({ margin: 0, selectionKey: "message" }, [
      { text: "hello world", source: { start: 0, end: 11 } },
    ]));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "message", button: 0, x: 0, y: 0 }));
    const afterPress = fixture.events.filter((event) => event.type === "selection.change").length;
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "message", button: 0, x: 0.5, y: 0 }));
    expect(fixture.events.filter((event) => event.type === "selection.preview")).toHaveLength(0);
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "message", button: 0, x: 1, y: 0 }));
    expect(fixture.events.filter((event) => event.type === "selection.preview")).toHaveLength(1);
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "message", button: 0, x: 1.5, y: 0 }));
    expect(fixture.events.filter((event) => event.type === "selection.preview")).toHaveLength(1);
    expect(fixture.events.filter((event) => event.type === "selection.change")).toHaveLength(afterPress);
    fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "message", button: 0, x: 10, y: 0 }));
    const changes = fixture.events.filter((event) => event.type === "selection.change");
    expect(changes).toHaveLength(afterPress + 1);
    expect(changes.at(-1)).toEqual({ type: "selection.change", text: "hello world" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("mouse text selection primes the app's Copy key with its source text", async () => {
    const fixture = controlled({}, () => GTUI.view.text({ margin: 0, selectionKey: "message" }, [
      { text: "hello", source: { start: 0, end: 5 } },
    ]));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "message", button: 0, x: 0, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "message", button: 0, x: 4, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "message", button: 0, x: 4, y: 0 }));
    const changes = fixture.events.filter((event) => event.type === "selection.change");
    expect(changes.at(-1)).toEqual({ type: "selection.change", text: "hello" });
    fixture.memory.send(GTUI.event.key({ key: "copy" }));
    expect(fixture.events.at(-1)).toEqual({ type: "selection.copy", text: "hello" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("edge-zone drag scrolls only on outward movement and never on the terminal edge", async () => {
    let model = { offset: 4 };
    const memory = GTUI.host.memory({ width: 12, height: 8 });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change") model = { offset: message.offset };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "history", offset: current.offset }, [GTUI.view.column({},
        Array.from({ length: 16 }, (_, index) => GTUI.view.text({ margin: 0, selectionKey: `m${index}`, sourceText: `row${index}` }, [{ text: `row${index}`, source: { start: 0, end: 4 } }])),
      )]),
    });
    const drag = (y) => memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: `m${y}`, button: 0, x: 1, y }));
    memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "m7", index: 0, sourceText: "row7", button: 0, x: 0, y: 3 }));
    drag(2); // first movement enters activation zone: establish direction only
    expect(model.offset).toBe(4);
    drag(1); // another outward row restores the four-row margin
    expect(model.offset).toBeLessThan(4);
    const afterScroll = model.offset;
    drag(0); // absolute terminal edge never initiates another scroll
    expect(model.offset).toBe(afterScroll);
    memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "m1", button: 0, x: 1, y: 0 }));
    const settled = model.offset;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(model.offset).toBe(settled); // no autonomous timer remains
    ui.stop();
    await running;
  });

  test("a text selection stays attached to source offsets when its scroll viewport moves", async () => {
    let model = { offset: 0 };
    const memory = GTUI.host.memory({ width: 12, height: 2 });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change" || message.type === "set-offset") model = { offset: message.offset };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "history", offset: current.offset }, [GTUI.view.column({}, [
        GTUI.view.text({ margin: 0, selectionKey: "one", sourceText: "alpha" }, [{ text: "alpha", source: { start: 0, end: 5 } }]),
        GTUI.view.text({ margin: 0, selectionKey: "two", sourceText: "bravo" }, [{ text: "bravo", source: { start: 0, end: 5 } }]),
        GTUI.view.text({ margin: 0, selectionKey: "three", sourceText: "charlie" }, [{ text: "charlie", source: { start: 0, end: 7 } }]),
      ])]),
    });
    memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "one", index: 0, sourceText: "alpha", button: 0, x: 0, y: 0 }));
    memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "two", index: 4, sourceText: "bravo", button: 0, x: 4, y: 1 }));
    memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "two", index: 4, sourceText: "bravo", button: 0, x: 4, y: 1 }));
    expect(memory.snapshot().roles.filter(({ role }) => role.includes("selection")).map(({ row }) => row)).toEqual([0, 1]);
    ui.dispatch({ type: "set-offset", offset: 1 });
    await tick();
    expect(memory.snapshot().lines[0]).toContain("bravo");
    expect(memory.snapshot().roles.filter(({ role }) => role.includes("selection")).map(({ row }) => row)).toEqual([0]);
    ui.stop();
    await running;
  });

  test("an empty mouse text selection never shadows the input selection's Copy", async () => {
    const fixture = controlled({ value: "hello", caret: 5, selection: { anchor: 0, caret: 5 } }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    // A press on the input clears its keyboard selection first (same as a
    // fresh click in any editor), so re-select with the keyboard.
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "other", button: 0, x: 0, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "other", button: 0, x: 0, y: 0 }));
    fixture.memory.send(GTUI.event.key({ key: "copy" }));
    // No text was actually selected by the collapsed drag: Copy belongs to
    // the input's selection, which GTUI's text channel must not claim.
    expect(fixture.events.some((event) => event.type === "selection.copy")).toBe(false);
    expect(fixture.events.at(-1)).toMatchObject({ type: "key", key: "copy" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("an input press clears a mounted mouse text selection like a fresh caret gesture", async () => {
    const fixture = controlled({ value: "hello", caret: 5, selection: null }, (model) => GTUI.view.column({}, [
      GTUI.view.text({ margin: 0, selectionKey: "message" }, [{ text: "world", source: { start: 0, end: 5 } }]),
      GTUI.view.input({ id: "draft", focus: true, ...model }),
    ]));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "message", button: 0, x: 0, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "message", button: 0, x: 4, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "message", button: 0, x: 4, y: 0 }));
    expect(fixture.memory.snapshot().roles.some(({ role }) => role.includes(" selection"))).toBe(true);
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "input", target: "draft", index: 2, button: 0, x: 4, y: 1 }));
    const changes = fixture.events.filter((event) => event.type === "selection.change");
    expect(changes.at(-1)).toEqual({ type: "selection.change", text: "" });
    expect(fixture.memory.snapshot().roles.some(({ role }) => role.includes(" selection"))).toBe(false);
    fixture.ui.stop();
    await fixture.running;
  });

  test("an input drag leaving the row holds the last resolved index", async () => {
    const fixture = controlled({ value: "hello", caret: 5, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "input", target: "draft", index: 1, button: 0, x: 3, y: 1 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "input", target: "draft", index: 3, button: 0, x: 5, y: 1 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", button: 0, x: 40, y: 0 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "release", button: 0, x: 40, y: 0 }));
    expect(fixture.model().selection).toEqual({ anchor: 1, caret: 3 });
    fixture.ui.stop();
    await fixture.running;
  });

  test("a mouse-selected word behaves like a keyboard selection: Backspace deletes it, arrows land on its sides", async () => {
    const fixture = controlled({ value: "one two three", caret: 13, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    const select = (from, to) => {
      fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "input", target: "draft", index: from, button: 0, x: 2 + from, y: 1 }));
      fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "input", target: "draft", index: to, button: 0, x: 2 + to, y: 1 }));
      fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "input", target: "draft", index: to, button: 0, x: 2 + to, y: 1 }));
    };
    // Drag-select "two" (4..7) and delete it with one Backspace.
    select(4, 7);
    expect(fixture.model().selection).toEqual({ anchor: 4, caret: 7 });
    fixture.memory.send(GTUI.event.key({ key: "backspace" }));
    expect(fixture.model()).toMatchObject({ value: "one  three", caret: 4, selection: null });

    // A right-drag selection then plain Left collapses to the LEFT side.
    fixture.memory.send(GTUI.event.key({ key: "right" })); // caret 5
    select(5, 8);
    fixture.memory.send(GTUI.event.key({ key: "left" }));
    expect(fixture.model()).toMatchObject({ value: "one  three", caret: 5, selection: null });
    // A left-drag selection then plain Right collapses to the RIGHT side.
    select(8, 5);
    fixture.memory.send(GTUI.event.key({ key: "right" }));
    expect(fixture.model()).toMatchObject({ value: "one  three", caret: 8, selection: null });
    fixture.ui.stop();
    await fixture.running;
  });

  test("plain arrows collapse a keyboard-made selection to its sides too", async () => {
    const fixture = controlled({ value: "one two three", caret: 4, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    fixture.memory.send(GTUI.event.key({ key: "shift+right" }));
    fixture.memory.send(GTUI.event.key({ key: "shift+right" }));
    fixture.memory.send(GTUI.event.key({ key: "shift+right" }));
    expect(fixture.model().selection).toEqual({ anchor: 4, caret: 7 });
    fixture.memory.send(GTUI.event.key({ key: "left" }));
    expect(fixture.model()).toMatchObject({ caret: 4, selection: null });
    fixture.ui.stop();
    await fixture.running;
  });

  test("the visible caret tracks a right-drag selection's active end", async () => {
    const fixture = controlled({ value: "hello world", caret: 11, selection: null }, (model) => GTUI.view.input({ id: "draft", focus: true, ...model }));
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "input", target: "draft", index: 0, button: 0, x: 2, y: 1 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "drag", control: "input", target: "draft", index: 5, button: 0, x: 7, y: 1 }));
    fixture.memory.send(GTUI.event.pointer({ kind: "release", control: "input", target: "draft", index: 5, button: 0, x: 7, y: 1 }));
    expect(fixture.memory.snapshot().caret.index).toBe(5);
    fixture.ui.stop();
    await fixture.running;
  });

  test("completion popup is bounded, follows selection, and does not overwrite the status below", async () => {
    const completions = Array.from({ length: 12 }, (_, index) => `item-${index}`);
    const fixture = controlled({ value: "/", caret: 1 }, (model) => GTUI.view.column({}, [
      GTUI.view.text({ margin: 0, priority: 0 }, "history-0\nhistory-1\nhistory-2\nhistory-3"),
      GTUI.view.input({ id: "draft", focus: true, priority: 10, completions, completionIndex: 8, ...model }),
      GTUI.view.text({ margin: 0, priority: 20 }, "STATUS"),
    ]));
    const lines = fixture.memory.snapshot().lines;
    expect(lines.some((line) => line.includes("item-8"))).toBe(true);
    expect(lines.some((line) => line.includes("item-0"))).toBe(false);
    expect(lines.at(-1)).toBe("STATUS");
    fixture.memory.send(GTUI.event.pointer({ kind: "press", control: "completion", target: "draft", index: 8 }));
    expect(fixture.events.at(-1)).toMatchObject({ type: "input.change", id: "draft", completion: "item-8", completionIndex: 8 });
    fixture.ui.stop();
    await fixture.running;
  });
});

describe("GTUI menu, scroll, and overlay", () => {
  test("aligns menu notes after the widest label and retains descriptions", async () => {
    const items = [
      { label: "A", note: "first", description: "first session line" },
      { label: "Long", note: "second", decription: "alias spelling" }, // the accepted decription alias
    ];
    const fixture = controlled({}, () => GTUI.view.menu({ id: "menu", focus: true, filter: false, items }));
    const lines = fixture.memory.snapshot().lines;
    expect(lines.find((line) => line.includes("first"))).toContain("A      first");
    expect(lines.find((line) => line.includes("second"))).toContain("Long   second");
    expect(lines.some((line) => line.includes("first session"))).toBe(true);
    expect(lines.some((line) => line.includes("alias spelling"))).toBe(true);
    fixture.ui.stop();
    await fixture.running;
  });

  test("filters/navigates a controlled menu and emits semantic selection", async () => {
    const items = [{ id: "head", kind: "header", label: "Main" }, { id: "a", label: "Alpha" }, { id: "b", label: "Beta" }];
    const fixture = controlled({}, () => GTUI.view.overlay({ id: "dialog" }, [GTUI.view.menu({ id: "menu", focus: true, items })]));
    fixture.memory.send(GTUI.event.key({ key: "down" }));
    await tick();
    fixture.memory.send(GTUI.event.key({ key: "enter" }));
    expect(fixture.events.at(-1)).toMatchObject({ type: "menu.select", id: "menu", itemId: "b" });
    fixture.memory.send(GTUI.event.key({ key: "z", text: "z" }));
    fixture.memory.send(GTUI.event.key({ key: "escape" }));
    expect(fixture.events.at(-1)).toEqual({ type: "menu.cancel", id: "menu" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("overlay captures unhandled keys while app bindings reach update first", async () => {
    const fixture = controlled({}, () => GTUI.view.overlay({ id: "dialog" }, [GTUI.view.menu({ id: "menu", focus: true, items: [] })]));
    fixture.memory.send(GTUI.event.key({ key: "z" }));
    expect(fixture.events).toEqual([]);
    fixture.ui.dispatch(GTUI.event.key({ key: "ctrl+x" }));
    expect(fixture.events.at(-1)).toMatchObject({ key: "ctrl+x" });
    fixture.ui.stop();
    await fixture.running;
  });

  test("scroll shares the menu viewport frame and emits controlled offsets for wheel/page keys", async () => {
    const fixture = controlled({}, () => GTUI.view.scroll({ id: "viewer", focus: true, title: " Viewer [1/2] ", footer: " keys " }, [GTUI.view.column({}, Array.from({ length: 20 }, (_, i) => GTUI.view.text({ margin: 0 }, `line ${i}`)))]));
    expect(fixture.memory.snapshot().lines[0]).toContain("Viewer [1/2]");
    expect(fixture.memory.snapshot().lines.at(-1)).toContain("keys");
    fixture.memory.send(GTUI.event.pointer({ kind: "wheel", target: "viewer", direction: "down" }));
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "viewer", offset: 1 });
    fixture.memory.send(GTUI.event.key({ key: "pagedown" }));
    // Five body rows retain four rows of context; a page advances one.
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "viewer", offset: 2 });
    expect(JSON.stringify(fixture.events)).not.toContain("\"x\"");
    fixture.ui.stop();
    await fixture.running;
  });

  test("a focused input falls through to transcript scrolling on Alt/Meta+Up/Down", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => GTUI.view.text({ margin: 0 }, `line ${i}`));
    const fixture = controlled({ value: "hi", caret: 2, offset: 0 }, (current) => GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", offset: current.offset, keyboard: true, priority: 0 }, [GTUI.view.column({}, lines)]),
      GTUI.view.input({ id: "draft", value: current.value, caret: current.caret, focus: true, priority: 10 }),
    ]));
    // Alt+Up/Down scroll the transcript one line; the input caret never moves.
    fixture.memory.send(GTUI.event.key({ key: "alt+up" }));
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 1 });
    fixture.memory.send(GTUI.event.key({ key: "alt+up" }));
    fixture.memory.send(GTUI.event.key({ key: "alt+down" }));
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 1 });
    // Meta+Up/Down remain the input's whole-value caret jump (an
    // intentional editing contract) — they never reach the transcript.
    fixture.memory.send(GTUI.event.key({ key: "meta+up" }));
    expect(fixture.events.at(-1)).toMatchObject({ type: "input.change", id: "draft", caret: 0 });
    // Alt+Meta+Up/Down remain line scrolling (Alt wins over Meta).
    fixture.memory.send(GTUI.event.key({ key: "alt+up" }));
    fixture.memory.send(GTUI.event.key({ key: "alt+meta+up" }));
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 3 });
    fixture.memory.send(GTUI.event.key({ key: "alt+meta+down" }));
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 2 });
    fixture.ui.stop();
    await fixture.running;
  });

  test("wheel over a focused input scrolls the keyboard transcript", () => {
    const events = [];
    const controls = createControls((event) => events.push(event));
    const root = GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", keyboard: true }, [
        GTUI.view.column({}, Array.from({ length: 40 }, (_, i) => GTUI.view.text({ margin: 0 }, `line ${i}`))),
      ]),
      GTUI.view.input({ id: "draft", value: "hi", focus: true }),
    ]);
    layoutView(root, { width: 20, height: 34, controls });
    controls.handle({ type: "pointer", kind: "wheel", target: "draft", direction: "up" });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 1 });
    controls.handle({ type: "pointer", kind: "wheel", target: "draft", direction: "down" });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 0 });
  });

  test("wheel over an input border row resolves to the input, not null", () => {
    // resolvePoint used to return null for the input's top/bottom border
    // rows (only text rows register an "input" target), so a wheel there
    // dropped instead of scrolling the keyboard transcript.
    const events = [];
    const controls = createControls((event) => events.push(event));
    const root = GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", keyboard: true, priority: 0 }, [
        GTUI.view.feed({ id: "feed", items: Array.from({ length: 40 }, (_, i) => ({ key: `m${i}`, done: true, node: GTUI.view.text({ margin: 0, priority: i }, `line ${i}`) })) }),
      ]),
      GTUI.view.input({ id: "draft", value: "hi", caret: 2, focus: true, priority: 10 }),
    ]);
    const { canvas } = layoutView(root, { width: 20, height: 18, controls });
    // Find the input's text row (the "input" caret target), then probe the
    // row directly above it (the top border, which used to resolve to null).
    let textRow = -1;
    for (let y = canvas.cells.length - 1; y >= 0; y--) {
      if (controls.resolvePoint({ x: 5, y })?.control === "input") { textRow = y; break; }
    }
    expect(textRow).toBeGreaterThan(0);
    const border = controls.resolvePoint({ x: 5, y: textRow - 1 }, { wheel: true });
    expect(border?.target).toBe("draft");
    controls.handle({ type: "pointer", kind: "wheel", target: border?.target, direction: "up" });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 1 });
  });

  test("wheel over an input scrollbar region still scrolls the transcript", () => {
    // A wheel whose resolved target is the input's scrollbar control id
    // (control "scroll", target = the input id) must still fall back to the
    // keyboard transcript — the input is not a scroll container.
    const events = [];
    const controls = createControls((event) => events.push(event));
    layoutView(GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", keyboard: true }, [
        GTUI.view.column({}, Array.from({ length: 40 }, (_, i) => GTUI.view.text({ margin: 0 }, `line ${i}`))),
      ]),
      GTUI.view.input({ id: "draft", value: "hi", focus: true }),
    ]), { width: 20, height: 34, controls });
    controls.handle({ type: "pointer", kind: "wheel", control: "scroll", target: "draft", direction: "up" });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 1 });
  });

  test("fractional wheel over an input accumulates toward the transcript", () => {
    // The accumulator must live on the resolved (transcript) entry, not the
    // pointed input — otherwise sub-row wheel deltas over the input vanish.
    const events = [];
    const controls = createControls((event) => events.push(event));
    layoutView(GTUI.view.column({}, [
      GTUI.view.scroll({ id: "history", anchor: "end", keyboard: true }, [
        GTUI.view.column({}, Array.from({ length: 40 }, (_, i) => GTUI.view.text({ margin: 0 }, `line ${i}`))),
      ]),
      GTUI.view.input({ id: "draft", value: "hi", focus: true }),
    ]), { width: 20, height: 34, controls });
    // Move away from the end first so fractional "down" ticks have room.
    controls.handle({ type: "pointer", kind: "wheel", target: "draft", direction: "up" });
    controls.handle({ type: "pointer", kind: "wheel", target: "draft", direction: "up" });
    expect(events.filter((e) => e.type === "scroll.change").map((e) => e.offset)).toEqual([1, 2]);
    events.length = 0;
    controls.handle({ type: "pointer", kind: "wheel", target: "draft", direction: "down", amount: 0.4 });
    controls.handle({ type: "pointer", kind: "wheel", target: "draft", direction: "down", amount: 0.4 });
    expect(events).toEqual([]); // 0.8 accumulated, not yet a full row
    controls.handle({ type: "pointer", kind: "wheel", target: "draft", direction: "down", amount: 0.4 });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 1 });
  });

  test("a wheel burst accumulates offsets but coalesces painting, including an immediate direction change", async () => {
    let views = 0;
    const fixture = controlled({}, () => {
      views++;
      return GTUI.view.scroll({ id: "history", anchor: "end", focus: true }, [GTUI.view.column({}, Array.from({ length: 20 }, (_, i) => GTUI.view.text({ margin: 0 }, `line ${i}`)))]);
    });
    fixture.memory.send(GTUI.event.pointer({ kind: "wheel", target: "history", direction: "up" }));
    fixture.memory.send(GTUI.event.pointer({ kind: "wheel", target: "history", direction: "up" }));
    fixture.memory.send(GTUI.event.pointer({ kind: "wheel", target: "history", direction: "down" }));
    expect(fixture.events.filter(({ type }) => type === "scroll.change").map(({ offset }) => offset)).toEqual([1, 2, 1]);
    expect(views).toBe(1);
    await tick();
    expect(views).toBe(2);
    fixture.ui.stop();
    await fixture.running;
  });

  test("end-anchored scroll makes Up reveal older content", async () => {
    const fixture = controlled({}, () => GTUI.view.scroll({ id: "history", anchor: "end", focus: true }, [GTUI.view.column({}, Array.from({ length: 20 }, (_, i) => GTUI.view.text({ margin: 0 }, `line ${i}`)))]));
    fixture.memory.send(GTUI.event.pointer({ kind: "wheel", target: "history", direction: "up" }));
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 1 });
    fixture.memory.send(GTUI.event.key({ key: "pageup" }));
    expect(fixture.events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 4 });
    fixture.ui.stop();
    await fixture.running;
  });

  test("a scrolled end-anchored viewport stays on the same rows while content streams", async () => {
    let model = { count: 20, offset: 0 };
    const memory = GTUI.host.memory({ width: 20, height: 5 });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change") model = { ...current, offset: message.offset };
        else if (message.type === "grow") model = { ...current, count: current.count + 2 };
        else model = current;
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "history", anchor: "end", offset: current.offset, focus: true }, [
        GTUI.view.column({}, Array.from({ length: current.count }, (_, index) => GTUI.view.text({ margin: 0 }, `line ${index}`))),
      ]),
    });
    memory.send(GTUI.event.pointer({ kind: "wheel", target: "history", direction: "up" }));
    await tick();
    const before = memory.snapshot().lines;
    ui.dispatch({ type: "grow" });
    await tick();
    expect(memory.snapshot().lines).toEqual(before); // no jump toward the growing tail
    memory.send(GTUI.event.key({ key: "pagedown" }));
    await tick();
    expect(memory.snapshot().lines.at(-1)).toBe("line 19"); // advances one row, retaining four
    memory.send(GTUI.event.key({ key: "pagedown" }));
    memory.send(GTUI.event.key({ key: "pagedown" }));
    await tick();
    expect(memory.snapshot().lines.at(-1)).toBe("line 21"); // repeated paging catches up to the tail
    ui.stop();
    await running;
  });

  test("fractional wheel movement repaints only after a complete row", () => {
    const events = [];
    const controls = createControls((event) => events.push(event));
    layoutView(GTUI.view.scroll({ id: "history" }, [GTUI.view.column({}, Array.from({ length: 20 }, (_, index) => GTUI.view.text({ margin: 0 }, `row ${index}`)))]), { width: 10, height: 4, controls });
    controls.handle({ type: "pointer", kind: "wheel", target: "history", direction: "down", amount: 0.4 });
    controls.handle({ type: "pointer", kind: "wheel", target: "history", direction: "down", amount: 0.4 });
    expect(events).toEqual([]);
    controls.handle({ type: "pointer", kind: "wheel", target: "history", direction: "down", amount: 0.4 });
    expect(events).toEqual([{ type: "scroll.change", id: "history", offset: 1 }]);
    controls.handle({ type: "pointer", kind: "wheel", target: "history", direction: "up", amount: 0.6 });
    expect(events).toHaveLength(1);
    controls.handle({ type: "pointer", kind: "wheel", target: "history", direction: "up", amount: 0.6 });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "history", offset: 0 });
  });

  test("scrollbar track coordinates resolve wheel only in the framed body", () => {
    const events = [];
    const controls = createControls((event) => events.push(event), { scrollBar: { track: "|", thumb: "#" } });
    layoutView(GTUI.view.scroll({ id: "viewer", title: "title", footer: "footer", focus: true }, [
      GTUI.view.text({ margin: 0 }, "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"),
    ]), { width: 10, height: 6, controls });
    const track = controls.resolvePoint({ x: 9, y: 2 }, { wheel: true });
    expect(track).toMatchObject({ control: "scroll", target: "viewer" });
    expect(controls.resolvePoint({ x: 9, y: 0 }, { wheel: true })).toBeNull();
    expect(controls.resolvePoint({ x: 9, y: 5 }, { wheel: true })).toBeNull();
    controls.handle({ type: "pointer", ...track, kind: "wheel", direction: "down" });
    expect(events).toEqual([{ type: "scroll.change", id: "viewer", offset: 1 }]);
  });

  test("scrollbar track click and drag set scroll without beginning text selection", () => {
    const events = [];
    const controls = createControls((event) => events.push(event), { scrollBar: { track: "|", thumb: "#" } });
    const root = GTUI.view.scroll({ id: "source", anchor: "end" }, [GTUI.view.column({}, Array.from({ length: 12 }, (_, index) => GTUI.view.text({ margin: 0, selectionKey: `text-${index}`, sourceText: `row ${index}` }, `row ${index}`)))]);
    layoutView(root, { width: 10, height: 4, controls });
    const press = controls.resolvePoint({ x: 9, y: 0 });
    expect(press).toMatchObject({ control: "scrollbar", target: "source" });
    controls.handle({ type: "pointer", ...press, kind: "press", button: 0, x: 9, y: 0 });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "source", offset: 8 });
    controls.handle({ type: "pointer", kind: "drag", button: 0, x: 9, y: 3 });
    expect(events.at(-1)).toEqual({ type: "scroll.change", id: "source", offset: 0 });
    controls.handle({ type: "pointer", kind: "release", button: 0, x: 9, y: 3 });
    expect(events.filter((event) => event.type === "selection.change")).toEqual([]);
  });

  test("scrollbar overlays the right text margin without changing wrapping", async () => {
    const content = "12345 67890";
    const child = () => GTUI.view.column({}, [GTUI.view.text({}, content), GTUI.view.text({}, "extra"), GTUI.view.text({}, "more"), GTUI.view.text({}, "last")]);
    const without = GTUI.host.memory({ width: 12, height: 6, scrollBar: { show: false } });
    const withoutUi = new GTUI({ host: without });
    const withoutRun = withoutUi.run({ init: () => ({ model: {} }), update: (model) => model, view: () => GTUI.view.scroll({ id: "plain" }, [child()]) });
    const withBar = GTUI.host.memory({ width: 12, height: 3, scrollBar: { track: "|", thumb: "#" } });
    const withUi = new GTUI({ host: withBar });
    const withRun = withUi.run({ init: () => ({ model: {} }), update: (model) => model, view: () => GTUI.view.scroll({ id: "bar" }, [child()]) });
    expect(withBar.snapshot().lines.map((line) => line.padEnd(12).slice(0, 11).trimEnd())).toEqual(without.snapshot().lines.slice(0, 3));
    expect(withBar.snapshot().roles.filter(({ role }) => role.startsWith("scroll.")).every(({ start }) => start === 11)).toBe(true);
    withoutUi.stop(); withUi.stop(); await withoutRun; await withRun;
  });

  test("scrollbar opt-in reserves before wrapping, stays body-only, and supports wheel at its track", async () => {
    let model = { offset: 0 };
    const memory = GTUI.host.memory({ width: 8, height: 6, scrollBar: { track: "|", thumb: "#" } });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change") model = { offset: message.offset };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "viewer", focus: true, title: "title", footer: "footer", offset: current.offset }, [
        GTUI.view.text({ margin: 0, source: "abcdefghijklmnopqrstuvwxy" }, "abcdefghijklmnopqrstuvwxy"),
      ]),
    });
    const snapshot = memory.snapshot();
    expect(snapshot.lines[0]).toBe("title");
    expect(snapshot.lines.at(-1)).toBe("footer");
    expect(snapshot.lines.slice(1, -1).some((line) => line.endsWith("|") || line.endsWith("#"))).toBe(true);
    memory.send(GTUI.event.pointer({ kind: "wheel", target: "viewer", direction: "down" }));
    expect(model.offset).toBe(1);
    ui.stop();
    await running;
  });

  test("scrollbar opt-out leaves fitting and overflowing memory scrolls without a gutter", async () => {
    const memory = GTUI.host.memory({ width: 8, height: 4, scrollBar: { show: false } });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model: {}, effects: [] }),
      update: (model) => ({ model, effects: [] }),
      view: () => GTUI.view.scroll({ id: "viewer" }, [GTUI.view.text({ margin: 0 }, "abcdefghabcdefgh")]),
    });
    expect(memory.snapshot().lines.some((line) => line.includes("│") || line.includes("█"))).toBe(false);
    ui.stop();
    await running;
  });

  test("scrollbar thumb reaches both endpoints, is monotonic, and handles one-row overflow", async () => {
    let model = { offset: 0 };
    const memory = GTUI.host.memory({ width: 10, height: 5, scrollBar: { track: "|", thumb: "#" } });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "set") model = { ...current, offset: message.offset };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "history", anchor: "end", offset: current.offset }, [
        GTUI.view.column({}, Array.from({ length: 10 }, (_, index) => GTUI.view.text({ margin: 0 }, `row ${index}`))),
      ]),
    });
    const thumbRows = () => memory.snapshot().roles.filter((span) => span.role === "scroll.thumb").map((span) => span.row);
    expect(thumbRows().at(-1)).toBe(4); // end anchor: offset 0 reaches the bottom
    ui.dispatch({ type: "set", offset: 3 });
    await tick();
    const middle = thumbRows();
    expect(middle[0]).toBeGreaterThan(0);
    expect(middle.at(-1)).toBeLessThan(4);
    ui.dispatch({ type: "set", offset: 5 });
    await tick();
    expect(thumbRows()[0]).toBe(0); // max offset reaches the top
    ui.stop();
    await running;

    const oneRow = GTUI.host.memory({ width: 8, height: 3, scrollBar: { track: "|", thumb: "#" } });
    const oneUi = new GTUI({ host: oneRow });
    const oneRunning = oneUi.run({ init: () => ({ model: {}, effects: [] }), update: (value) => ({ model: value, effects: [] }), view: () => GTUI.view.scroll({ id: "one" }, [GTUI.view.text({ margin: 0 }, "abcdefghijklmnopqrstuvwxy")]) });
    expect(oneRow.snapshot().roles.some((span) => span.role === "scroll.thumb")).toBe(true);
    oneUi.stop();
    await oneRunning;
  });

  test("scrollbar safely disappears for tiny boxes and an empty child", async () => {
    for (const [width, height] of [[2, 4], [3, 4], [8, 1], [8, 2]]) {
      const memory = GTUI.host.memory({ width, height, scrollBar: { track: "|", thumb: "#" } });
      const ui = new GTUI({ host: memory });
      const running = ui.run({ init: () => ({ model: {}, effects: [] }), update: (model) => ({ model, effects: [] }), view: () => GTUI.view.scroll({ id: "tiny" }, []) });
      expect(memory.snapshot().roles.some((span) => span.role.startsWith("scroll."))).toBe(false);
      ui.stop();
      await running;
    }
  });

  test("scrollbar roles and sources keep its reserved column non-selectable", async () => {
    const memory = GTUI.host.memory({ width: 10, height: 4, scrollBar: { track: "|", thumb: "#" } });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model: {}, effects: [] }), update: (model) => ({ model, effects: [] }),
      view: () => GTUI.view.scroll({ id: "source" }, [GTUI.view.text({ margin: 0, source: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz" }, "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz")]),
    });
    const snapshot = memory.snapshot();
    const bars = snapshot.roles.filter((span) => span.role === "scroll.track" || span.role === "scroll.thumb");
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((span) => span.start === 9 && span.end === 10)).toBe(true);
    expect(snapshot.sources.every((span) => span.end <= 9)).toBe(true);
    ui.stop();
    await running;
  });

  test("end-anchored scrollbar preserves historical rows while streamed content grows", async () => {
    let model = { count: 12, offset: 0 };
    const memory = GTUI.host.memory({ width: 12, height: 4, scrollBar: { track: "|", thumb: "#" } });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change") model = { ...current, offset: message.offset };
        else if (message.type === "grow") model = { ...current, count: current.count + 3 };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "stream", anchor: "end", offset: current.offset, focus: true }, [
        GTUI.view.column({}, Array.from({ length: current.count }, (_, index) => GTUI.view.text({ margin: 0 }, `row ${index}`))),
      ]),
    });
    memory.send(GTUI.event.pointer({ kind: "wheel", target: "stream", direction: "up" }));
    await tick();
    const before = memory.snapshot().lines.map((line) => line.slice(0, -1));
    const thumbBefore = memory.snapshot().roles.find((span) => span.role === "scroll.thumb").row;
    ui.dispatch({ type: "grow" });
    await tick();
    expect(memory.snapshot().lines.map((line) => line.slice(0, -1))).toEqual(before);
    expect(memory.snapshot().roles.find((span) => span.role === "scroll.thumb").row).toBeLessThanOrEqual(thumbBefore);
    memory.send(GTUI.event.key({ key: "pagedown" }));
    memory.send(GTUI.event.key({ key: "pagedown" }));
    memory.send(GTUI.event.key({ key: "pagedown" }));
    await tick();
    const bottom = memory.snapshot().roles.filter((span) => span.role === "scroll.thumb").at(-1);
    expect(bottom.row).toBe(3);
    ui.stop();
    await running;
  });

  test("scrollbar rounding follows the remembered scroll direction", async () => {
    let model = { offset: 0 };
    const memory = GTUI.host.memory({ width: 10, height: 5, scrollBar: { track: "|", thumb: "#" } });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change") model = { offset: message.offset };
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.scroll({ id: "directional", offset: current.offset }, [
        GTUI.view.column({}, Array.from({ length: 11 }, (_, index) => GTUI.view.text({ margin: 0 }, `row ${index}`))),
      ]),
    });
    memory.send(GTUI.event.pointer({ kind: "wheel", target: "directional", direction: "down" }));
    const down = memory.snapshot().roles.find((span) => span.role === "scroll.thumb").row;
    memory.send(GTUI.event.pointer({ kind: "wheel", target: "directional", direction: "up" }));
    const up = memory.snapshot().roles.find((span) => span.role === "scroll.thumb").row;
    expect(down).toBeGreaterThanOrEqual(up);
    ui.stop();
    await running;
  });

  test("an external scroll change is not mistaken for streamed content growth", async () => {
    let model = { offset: 0 };
    const memory = GTUI.host.memory({ width: 20, height: 5 });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      update: (current, message) => {
        if (message.type === "scroll.change") model = { offset: message.offset };
        else model = current;
        return { model, effects: [] };
      },
      view: (current) => GTUI.view.column({}, [
        GTUI.view.scroll({ id: "history", anchor: "end", offset: current.offset, keyboard: true }, [
          GTUI.view.column({}, Array.from({ length: current.offset === 0 ? 3 : 20 }, (_, index) => GTUI.view.text({ margin: 0 }, `line ${index}`))),
        ]),
        GTUI.view.input({ id: "draft", value: "", caret: 0, focus: true }),
      ]),
    });
    memory.send(GTUI.event.key({ key: "pageup" }));
    await tick();
    expect(memory.snapshot().lines.some((line) => line === "line 18")).toBe(true);
    expect(memory.snapshot().lines.some((line) => line === "line 0")).toBe(false);
    ui.stop();
    await running;
  });
});
