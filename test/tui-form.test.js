import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { createControls, controlInternals } from "../lib/app/gtui/controls.js";
import { layoutView } from "../lib/app/gtui/layout.js";
import { createForm, formView, updateForm, formErrors, FORM_INPUT_PREFIX, FORM_MENU_ID } from "../lib/app/tui/form.js";

const key = (name) => ({ type: "key", key: name });
const change = (name, value, extra = {}) => ({ type: "input.change", id: FORM_INPUT_PREFIX + name, value, ...extra });
const menuSelect = (type) => ({ type: "menu.select", id: FORM_MENU_ID, item: { value: { type } } });

function form(options = {}) {
  return createForm({ title: "Settings", fields: [{ name: "name", label: "Name", required: true }, { name: "token", label: "Password", secret: true }], action: { type: "save-settings" }, ...options });
}

function mount(root, { width = 60, height = 24 } = {}, events = []) {
  const controls = createControls((message) => events.push(message));
  const scene = layoutView(root, { width, height, controls });
  return { controls, scene, events };
}

function nodes(root) {
  return [root, ...(root.children ?? []).flatMap((child) => nodes(child))];
}

describe("reusable TUI form state", () => {
  test("copies descriptors and initial values, retaining only the explicitly borrowed back overlay", () => {
    const fields = [{ name: "mode", label: "Mode", value: "a", options: [{ label: "A", value: "a" }] }];
    const action = { type: "save", scope: "user" };
    const back = { type: "menu" };
    const overlay = form({ fields, action, back });
    fields[0].value = "changed";
    fields[0].options[0].label = "changed";
    action.type = "changed";
    expect(overlay).toMatchObject({ type: "form", values: { mode: "a" }, focus: 0, errors: {}, busy: false, action: { type: "save" } });
    expect(overlay.fields[0].options[0]).toEqual({ label: "A", value: "a" });
    expect(overlay.back).toBe(back);
  });

  test("rejects duplicate, unsafe, and malformed descriptors", () => {
    for (const name of ["__proto__", "constructor", "prototype", ""]) expect(() => form({ fields: [{ name, label: "Bad" }] })).toThrow(TypeError);
    expect(() => form({ fields: [{ name: "a", label: "A" }, { name: "a", label: "Again" }] })).toThrow(TypeError);
    expect(() => form({ fields: [{ name: "a", label: "A", options: [{}] }] })).toThrow(TypeError);
    expect(() => form({ action: null })).toThrow(TypeError);
  });

  test("retains actual values and controlled selection without mutating old states", () => {
    const initial = form();
    const selection = { anchor: 1, caret: 3 };
    const result = updateForm(initial, change("token", "real-secret", { caret: 3, selection }));
    selection.anchor = 0;
    expect(result.handled).toBe(true);
    expect(result.overlay.values.token).toBe("real-secret");
    expect(result.overlay.editors.token).toEqual({ caret: 3, selection: { anchor: 1, caret: 3 } });
    expect(initial.values.token).toBe("");
    expect(result.overlay.focus).toBe(1);
    expect(updateForm(initial, change("unknown", "no"))).toEqual({ overlay: initial, handled: false });
  });

  test("cycles all fields and the explicit action menu in both directions", () => {
    let overlay = form();
    overlay = updateForm(overlay, key("shift+tab")).overlay;
    expect(overlay.focus).toBe(2);
    overlay = updateForm(overlay, key("tab")).overlay;
    expect(overlay.focus).toBe(0);
    const advanced = updateForm(overlay, { type: "input.submit", id: FORM_INPUT_PREFIX + "name", value: "Ada" });
    expect(advanced.overlay.focus).toBe(1);
    expect(advanced.overlay.values.name).toBe("Ada");
    expect(advanced.submit).toBeUndefined();
    const menu = updateForm(advanced.overlay, { type: "input.submit", id: FORM_INPUT_PREFIX + "token", value: "secret" });
    expect(menu.overlay.focus).toBe(2);
    expect(menu.submit).toBeUndefined();
    expect(updateForm(menu.overlay, menuSelect("form.submit")).submit.values).toEqual({ name: "Ada", token: "secret" });
  });

  test("validation keeps every entered value, focuses the first error, and allows correction", () => {
    let overlay = updateForm(form(), change("token", "keep-me")).overlay;
    const failed = updateForm(overlay, key("ctrl+s"));
    expect(failed.submit).toBeUndefined();
    expect(failed.overlay).toMatchObject({ busy: false, focus: 0, errors: { name: "Name is required." }, values: { name: "", token: "keep-me" } });
    overlay = updateForm(failed.overlay, change("name", "Ada")).overlay;
    expect(overlay.errors).toEqual({});
    const saved = updateForm(overlay, key("ctrl+s"));
    expect(saved.overlay.busy).toBe(true);
    expect(saved.submit).toEqual({ action: { type: "save-settings" }, values: { name: "Ada", token: "keep-me" } });
    saved.submit.values.name = "mutated snapshot";
    expect(saved.overlay.values.name).toBe("Ada");
    const errors = formErrors(saved.overlay, { token: ["Not accepted", "Try again"], _form: "Operation failed", unknown: "ignored" });
    expect(errors).toMatchObject({ busy: false, focus: 1, values: { name: "Ada", token: "keep-me" }, errors: { token: "Not accepted · Try again", _form: "Operation failed" } });
    expect(formErrors(saved.overlay, "General failure").errors).toEqual({ _form: "General failure" });
  });

  test("busy state prevents duplicates and edits but retains cancellation and identity for async guards", () => {
    const ready = updateForm(form(), change("name", "Ada")).overlay;
    const pending = updateForm(ready, key("ctrl+s")).overlay;
    for (const message of [key("ctrl+s"), key("tab"), change("name", "overwrite"), menuSelect("form.submit"), { type: "input.submit", id: FORM_INPUT_PREFIX + "name", value: "overwrite" }]) {
      expect(updateForm(pending, message)).toEqual({ overlay: pending, handled: true });
    }
    for (const message of [key("escape"), key("ctrl+c"), menuSelect("form.cancel"), { type: "menu.cancel", id: FORM_MENU_ID }]) {
      expect(updateForm(pending, message)).toEqual({ overlay: pending, handled: true, cancel: true });
    }
    expect(updateForm(pending, { type: "task.done", key: "unrelated" })).toEqual({ overlay: pending, handled: false });
  });

  test("choice highlights survive state reconstruction without submitting and preserve defaults", () => {
    const initial = form({ fields: [{ name: "mode", label: "Mode", value: "safe", required: true, options: [{ label: "Safe", value: "safe" }, { label: "Full", value: "full" }] }] });
    const changed = updateForm(initial, key("down"));
    expect(changed.overlay.values.mode).toBe("full");
    expect(changed.submit).toBeUndefined();
    expect(initial.values.mode).toBe("safe");
    expect(nodes(formView(changed.overlay)).find((node) => node.id === FORM_INPUT_PREFIX + "mode").initialIndex).toBe(1);
    const selected = updateForm(changed.overlay, key("enter"));
    expect(selected.overlay.focus).toBe(1);
    expect(selected.submit).toBeUndefined();
    const blank = form({ fields: [{ name: "mode", label: "Mode", required: true, options: [{ label: "Safe", value: "safe" }] }] });
    expect(blank.values.mode).toBe("");
    expect(updateForm(blank, key("enter")).overlay).toMatchObject({ focus: 1, values: { mode: "safe" } });
  });

  test("closed choices omit custom entry without coercing their controlled defaults", () => {
    const overlay = form({ fields: [{ name: "mode", label: "Mode", value: "safe", custom: false, options: [{ label: "Safe", value: "safe" }, { label: "Full", value: "full" }] }] });
    const chooser = nodes(formView(overlay)).find((node) => node.id === FORM_INPUT_PREFIX + "mode");
    expect(chooser.items.map((item) => item.label)).toEqual(["Safe", "Full"]);
    expect(updateForm(overlay, key("up")).overlay.values.mode).toBe("full");
  });

  test("multiline values keep line breaks while ordinary fields stay single-line", () => {
    const overlay = form({ fields: [{ name: "plain", label: "Plain" }, { name: "notes", label: "Notes", multiline: true }] });
    expect(updateForm(overlay, change("plain", "a\nb\r\nc")).overlay.values.plain).toBe("a b c");
    expect(updateForm(overlay, change("notes", "a\nb")).overlay.values.notes).toBe("a\nb");
  });
});

describe("form composition and generic masked inputs", () => {
  test("renders real option controls and compact explicit Save/Cancel actions", () => {
    const overlay = form({ fields: [{ name: "mode", label: "Policy", value: "safe", hint: "Choose carefully", options: [{ label: "Safe", value: "safe" }, { label: "Full", value: "full" }] }], details: "Personal settings" });
    const tree = formView(overlay);
    const all = nodes(tree);
    expect(tree).toMatchObject({ type: "overlay", fill: true });
    const choices = all.find((node) => node.id === FORM_INPUT_PREFIX + "mode");
    expect(choices).toMatchObject({ type: "menu", focus: true, initialIndex: 0 });
    expect(choices.items.map((item) => item.label)).toEqual(["Safe", "Full", "Custom value…"]);
    const actions = all.find((node) => node.id === FORM_MENU_ID);
    expect(actions.type).toBe("toolbar");
    expect(actions.children.map((node) => node.content)).toEqual(["Save", "Cancel", "?"]);
    const visible = mount(tree).scene.snapshot.lines.join("\n");
    for (const text of ["Policy", "Choose carefully", "Safe", "Full", "Save", "Cancel"]) expect(visible).toContain(text);
    expect(visible).not.toContain("Choices:");
  });

  test("grouped options render endpoint headers that stay unselectable and labels clip only at the row end", () => {
    const overlay = form({ fields: [{ name: "model", label: "Model", value: "one/a", options: [
      { label: "one/a", value: "one/a", group: "one" },
      { label: "one/b", value: "one/b", group: "one" },
      { label: "two/c", value: "two/c", group: "two" },
    ] }] });
    const tree = formView(overlay);
    const choices = nodes(tree).find((node) => node.id === FORM_INPUT_PREFIX + "model");
    expect(choices.labelOverflow).toBe("clip-end");
    expect(choices.items.map((item) => `${item.kind}:${item.label}`)).toEqual([
      "header:one", "action:one/a", "action:one/b", "header:two", "action:two/c", "action:Custom value…",
    ]);
    // The selector lands on the selected OPTION's row, past its group header.
    expect(choices.initialIndex).toBe(1);
    // Selecting a header row is swallowed: the value never changes.
    const headerSelect = updateForm(overlay, { type: "menu.select", id: FORM_INPUT_PREFIX + "model", item: choices.items[0] });
    expect(headerSelect.handled).toBe(true);
    expect(headerSelect.overlay.values.model).toBe("one/a");
    const visible = mount(tree).scene.snapshot.lines.join("\n");
    expect(visible).toContain("one");
    expect(visible).toContain("two");
  });

  test("option groups must be strings when present", () => {
    expect(() => form({ fields: [{ name: "a", label: "A", options: [{ label: "x", value: "y", group: 42 }] }] })).toThrow(TypeError);
  });

  for (const dimensions of [{ width: 30, height: 10 }, { width: 40, height: 12 }]) {
    test(`${dimensions.width}x${dimensions.height} reserves the focused editor/choices and actions despite enormous metadata`, () => {
      const prose = "Explanatory text that must not displace editing. ".repeat(1000);
      let overlay = form({ title: prose, details: prose, fields: [
        { name: "model", label: "Model", value: "model-150", hint: prose, options: Array.from({ length: 300 }, (_, index) => ({ label: `Model ${index}`, value: `model-${index}` })) },
        { name: "notes", label: "Notes", value: "editable", multiline: true, hint: prose },
      ] });
      overlay = formErrors(overlay, { model: prose, _form: prose });
      for (let focus = 0; focus <= overlay.fields.length; focus++) {
        const tree = formView({ ...overlay, focus });
        const { scene } = mount(tree, dimensions);
        const visible = scene.snapshot.lines.join("\n");
        expect(scene.snapshot.focus).toBe(focus === 2 ? FORM_MENU_ID : FORM_INPUT_PREFIX + overlay.fields[focus].name);
        expect(visible).toContain(focus === 0 ? "Model 150" : focus === 1 ? "editable" : "Save");
        expect(visible).toContain("Save");
        expect(visible).toContain("Cancel");
        expect(nodes(tree).filter((node) => node.type === "input").every((node) => node.active === false)).toBe(true);
        expect(scene.snapshot.roles.some(({ role }) => role.includes("input.border.active"))).toBe(false);
      }
    });
  }

  test("focused ordinary editors use static borders, not working animation roles", () => {
    const tree = formView(form());
    expect(nodes(tree).find((node) => node.id === FORM_INPUT_PREFIX + "name").active).toBe(false);
    expect(mount(tree).scene.snapshot.roles.some(({ role }) => role.includes("input.border.active"))).toBe(false);
  });

  test("full details and hints have an explicit scroll reader and Escape returns without losing edits", async () => {
    const ending = "END OF FULL EXPLANATION";
    const hint = "Full field hint ending";
    let model = form({ details: "Details paragraph.\n".repeat(100) + ending, fields: [{ name: "name", label: "Name", value: "retained", hint }] });
    const host = GTUI.host.memory({ width: 30, height: 10 });
    const ui = new GTUI({ host });
    let cancelled = false;
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      bindings: () => ["tab", "shift+tab", "escape", "ctrl+c", "ctrl+s"],
      update: (current, message) => {
        const result = updateForm(current, message);
        model = result.overlay;
        cancelled ||= result.cancel === true;
        return { model, effects: [] };
      },
      view: formView,
    });
    try {
      host.send(key("shift+tab"));
      host.send(key("right"));
      host.send(key("right"));
      host.send(key("enter"));
      const reader = nodes(formView(model)).find((node) => node.type === "scroll" && node.focus);
      expect(reader).toBeDefined();
      expect(nodes(reader).some((node) => node.content?.includes(ending))).toBe(true);
      expect(nodes(reader).some((node) => node.content?.includes(hint))).toBe(true);
      for (let index = 0; index < 150; index++) host.send(key("pagedown"));
      expect(host.snapshot().lines.join("\n")).toContain("Full field hint");
      host.send(key("escape"));
      expect(cancelled).toBe(false);
      expect(model.values.name).toBe("retained");
      expect(host.snapshot().focus).toBe(FORM_MENU_ID);
    } finally {
      ui.stop();
      await running;
    }
  });

  test("hundreds of options navigate across rerenders, Enter advances, custom text remains editable, and save stays explicit", async () => {
    let model = form({ fields: [
      { name: "model", label: "Model", value: "model-150", options: Array.from({ length: 300 }, (_, index) => ({ label: `Model ${index}`, value: `model-${index}` })) },
      { name: "name", label: "Name", value: "Agent" },
    ] });
    const host = GTUI.host.memory({ width: 30, height: 10 });
    const ui = new GTUI({ host });
    const submissions = [];
    let cancelled = false;
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      bindings: () => ["tab", "shift+tab", "escape", "ctrl+c", "ctrl+s"],
      update: (current, message) => {
        const result = updateForm(current, message);
        model = result.overlay;
        if (result.submit) submissions.push(result.submit);
        cancelled ||= result.cancel === true;
        return { model, effects: [] };
      },
      view: formView,
    });
    try {
      host.send(key("down"));
      host.send(key("down"));
      expect(model.values.model).toBe("model-152");
      expect(host.snapshot().lines.join("\n")).toContain("Model 152");
      host.send(key("enter"));
      expect(model.focus).toBe(1);
      expect(submissions).toEqual([]);
      host.send(key("shift+tab"));
      host.send(key("up"));
      expect(model.values.model).toBe("model-151");
      // The custom row is adjacent to the first option through wraparound.
      for (let index = 0; index < 152; index++) host.send(key("up"));
      host.send(key("enter"));
      expect(model.focus).toBe(0);
      expect(nodes(formView(model)).find((node) => node.id === FORM_INPUT_PREFIX + "model").type).toBe("input");
      host.send(key("ctrl+u"));
      host.send({ type: "paste", text: "custom/provider-model" });
      expect(model.values.model).toBe("custom/provider-model");
      host.send(key("enter"));
      expect(model.focus).toBe(1);
      expect(submissions).toEqual([]);
      host.send(key("tab"));
      host.send(key("enter"));
      expect(submissions).toHaveLength(1);
      expect(submissions[0].values.model).toBe("custom/provider-model");
      host.send(key("right"));
      host.send(key("enter"));
      expect(cancelled).toBe(true);
    } finally {
      ui.stop();
      await running;
    }
  });

  test("typing filters long option IDs without changing values and keeps custom text available", async () => {
    const prefix = "provider/family-identical-long-prefix-model-";
    const options = Array.from({ length: 300 }, (_, index) => ({ label: prefix + index, value: prefix + index }));
    let model = form({ fields: [{ name: "model", label: "Model", value: prefix + "150", options }] });
    const host = GTUI.host.memory({ width: 30, height: 10 });
    const ui = new GTUI({ host });
    const submissions = [];
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      bindings: () => ["tab", "shift+tab", "escape", "ctrl+c", "ctrl+s"],
      update: (current, message) => {
        const result = updateForm(current, message);
        model = result.overlay;
        if (result.submit) submissions.push(result.submit);
        return { model, effects: [] };
      },
      view: formView,
    });
    try {
      for (const text of "299") host.send({ type: "key", key: text, text });
      expect(model.values.model).toBe(prefix + "150");
      expect(host.snapshot().lines.join("\n")).toContain("299");
      // Unrelated rerenders must not reset the query/highlight.
      host.send({ type: "task.done", key: "unrelated" });
      expect(host.snapshot().lines.join("\n")).toContain("299");
      host.send(key("enter"));
      expect(model.values.model).toBe(prefix + "299");
      expect(model.focus).toBe(1);
      expect(submissions).toEqual([]);
      host.send(key("shift+tab"));
      host.send(key("down"));
      host.send(key("enter"));
      expect(nodes(formView(model)).find((node) => node.id === FORM_INPUT_PREFIX + "model").type).toBe("input");
      expect(model.values.model).toBe(prefix + "299");
    } finally {
      ui.stop();
      await running;
    }
  });

  test("full selected model labels and values remain readable without entering custom edit", () => {
    const label = "Provider family with a very long identical prefix — distinct model release";
    const value = "provider/family-identical-prefix-distinct-model-release";
    const overlay = form({ fields: [{ name: "model", label: "Model", value, options: [{ label, value }] }] });
    const reading = updateForm(overlay, { type: "action.select", action: "form.details" }).overlay;
    const reader = nodes(formView(reading)).find((node) => node.type === "scroll");
    const text = nodes(reader).map((node) => node.content ?? "").join("\n");
    expect(text).toContain(label);
    expect(text).toContain(value);
    expect(reading.values.model).toBe(value);
  });

  test("custom defaults and choice validation keep controlled string values", () => {
    const initial = form({ fields: [{ name: "model", label: "Model", value: 42, options: [{ label: "Known", value: 7 }] }] });
    expect(initial.values.model).toBe("42");
    expect(nodes(formView(initial)).find((node) => node.id === FORM_INPUT_PREFIX + "model")).toMatchObject({ type: "input", value: "42" });
    const failed = formErrors(initial, { model: "Use an accepted model" });
    expect(failed.values.model).toBe("42");
    expect(updateForm(failed, change("model", "other/model")).overlay.errors).toEqual({});
  });

  test("preparation is static loading, not submitted work, and cancellation keeps busy identity", () => {
    const initial = { ...form({ fields: [] }), busy: true, preparing: true };
    const tree = formView(initial);
    const text = nodes(tree).map((node) => node.content ?? "").join("\n");
    expect(text).toContain("Loading options… · no changes submitted");
    expect(text).not.toContain("Working…");
    expect(nodes(tree).find((node) => node.id === FORM_MENU_ID).children.some((node) => node.content === "Cancel")).toBe(true);
    expect(updateForm(initial, key("escape"))).toEqual({ overlay: initial, handled: true, cancel: true });
  });

  test("Tab brings every field and the final menu into view on a small terminal", () => {
    let overlay = form({ fields: Array.from({ length: 8 }, (_, index) => ({ name: `field${index}`, label: `Field ${index}`, value: `value${index}` })) });
    for (let index = 0; index < 9; index++) {
      const { scene } = mount(formView(overlay), { width: 30, height: 12 });
      expect(scene.canvas.height).toBe(12);
      // Semantic snapshots omit trailing blank rows. A fill overlay uses
      // GTUI's centered safe area, so its text need not occupy every row.
      expect(scene.snapshot.lines.length).toBeGreaterThan(0);
      expect(scene.snapshot.lines.length).toBeLessThanOrEqual(scene.canvas.height);
      expect(scene.snapshot.focus).toBe(index === 8 ? FORM_MENU_ID : FORM_INPUT_PREFIX + `field${index}`);
      expect(scene.snapshot.lines.join("\n")).toContain(index === 8 ? "Save" : `value${index}`);
      overlay = updateForm(overlay, key("tab")).overlay;
    }
  });

  test("masking uses one cell per codepoint with real UTF-16 offsets and no secret in snapshots or debug views", () => {
    const secret = "a😀e\u0301中\n";
    const input = GTUI.view.input({ id: "password", value: secret, focus: true, mask: true, caret: secret.length, completions: [{ label: secret }] });
    expect(input.value).toBe(secret);
    expect(JSON.stringify(input)).not.toContain(secret);
    expect(inspect(input)).not.toContain(secret);
    const rows = controlInternals.inputRows(input, 8);
    expect(rows.rows.map((row) => row.text)).toEqual(["••••", "••"]);
    expect(rows.rows[0].tokens.map((token) => [token.start, token.end])).toEqual([[0, 1], [1, 3], [3, 4], [4, 5]]);
    const { scene, controls } = mount(input, { width: 12, height: 8 });
    expect(scene.snapshot.lines.join("\n")).toContain("••••••");
    expect(JSON.stringify(scene.snapshot)).not.toContain(secret);
    expect(JSON.stringify(scene.canvas.cells)).not.toContain(secret);
    expect(controls.resolvePoint({ x: 4, y: 1 })).toMatchObject({ control: "input", target: "password", index: 3 });
    expect(scene.snapshot.caret.index).toBe(secret.length);
  });

  test("custom masks remain safe and ordinary input wrapping is unchanged", () => {
    expect(controlInternals.inputRows({ value: "a😀中", mask: "*" }, 10).rows[0].text).toBe("***");
    expect(controlInternals.inputRows({ value: "abc", mask: "\x1b" }, 10).rows[0].text).toBe("•••");
    expect(controlInternals.inputRows({ value: "abc", mask: "中" }, 10).rows[0].text).toBe("•••");
    expect(controlInternals.inputRows({ value: "one two", mask: false }, 20).rows[0].text).toBe("one two");
    expect(JSON.stringify(GTUI.view.input({ value: "ordinary" }))).toContain("ordinary");
  });

  test("masked copy is consumed after both keyboard and mouse selection and never emits a password", () => {
    const secret = "no-copy-token";
    let input = GTUI.view.input({ id: "password", value: secret, mask: true, focus: true, selection: { anchor: 0, caret: secret.length } });
    let fixture = mount(input);
    expect(fixture.controls.handle(key("copy"))).toBe(true);
    expect(fixture.events).toEqual([]);
    const point = fixture.controls.resolvePoint({ x: 3, y: 1 });
    fixture.controls.handle({ type: "pointer", ...point, kind: "press", x: 3, y: 1, button: 0 });
    fixture.controls.handle({ type: "pointer", control: "input", target: "password", kind: "drag", index: 8, x: 10, y: 1, button: 0 });
    fixture.controls.handle({ type: "pointer", control: "input", target: "password", kind: "release", index: 8, x: 10, y: 1, button: 0 });
    const selected = fixture.events.findLast((message) => message.type === "input.change");
    expect(selected.value).toBe(secret);
    input = GTUI.view.input({ id: "password", mask: true, focus: true, value: selected.value, caret: selected.caret, selection: selected.selection });
    fixture = mount(input);
    fixture.controls.handle(key("copy"));
    expect(fixture.events.some((message) => message.type === "selection.copy")).toBe(false);
  });

  test("masked inputs retain immediate editing, grapheme deletion, vertical movement, and large paste values", () => {
    const input = GTUI.view.input({ id: "password", value: "a😀中bcdef", mask: true, caret: 4, focus: true });
    const { controls, events } = mount(input, { width: 8, height: 8 });
    controls.handle(key("backspace"));
    expect(events.at(-1)).toMatchObject({ type: "input.change", value: "a😀bcdef", caret: 3 });
    controls.handle(key("down"));
    expect(events.at(-1)).toMatchObject({ type: "input.change", value: "a😀中bcdef", caret: 8 });
    const pasted = "x".repeat(3000);
    controls.handle({ type: "paste", text: pasted });
    expect(events.at(-1).value).toBe("a😀中" + pasted + "bcdef");
    expect(events.at(-1).value).not.toContain("[Pasted");
  });

  test("form errors and metadata redact actual secret text without changing the submitted value", () => {
    const secret = "private-api-token";
    let overlay = form({ fields: [{ name: "token", label: "Password", value: secret, secret: true, hint: `Do not print ${secret}` }], details: `Rejected ${secret}` });
    overlay = formErrors(overlay, { token: `Invalid: ${secret}` });
    const tree = formView(overlay);
    expect(JSON.stringify(tree)).not.toContain(secret);
    expect(inspect(tree, { depth: null })).not.toContain(secret);
    expect(mount(tree).scene.snapshot.lines.join("\n")).not.toContain(secret);
    const reading = updateForm(overlay, { type: "action.select", action: "form.details" }).overlay;
    expect(JSON.stringify(formView(reading))).not.toContain(secret);
    expect(mount(formView(reading)).scene.snapshot.lines.join("\n")).not.toContain(secret);
    expect(updateForm(overlay, key("ctrl+s")).submit.values.token).toBe(secret);
  });

  test("multiline Shift+Enter is a real editor change while Enter advances without saving", () => {
    let model = form({ fields: [{ name: "notes", label: "Notes", value: "a", multiline: true }] });
    const host = GTUI.host.memory({ width: 40, height: 16 });
    const ui = new GTUI({ host });
    const submissions = [];
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      bindings: () => ["tab", "shift+tab", "escape", "ctrl+c", "ctrl+s"],
      update: (current, message) => {
        const result = updateForm(current, message);
        if (result.submit) submissions.push(result.submit);
        model = result.overlay;
        return { model, effects: [] };
      },
      view: formView,
    });
    host.send(GTUI.event.key({ key: "shift+enter" }));
    expect(model.values.notes).toBe("a\n");
    host.send(GTUI.event.key({ key: "enter" }));
    expect(model.focus).toBe(1);
    expect(submissions).toEqual([]);
    host.send(GTUI.event.key({ key: "enter" }));
    expect(submissions).toHaveLength(1);
    expect(submissions[0].values.notes).toBe("a\n");
    ui.stop();
    return running;
  });
});

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  resume() {}
  pause() {}
}
class FakeOutput extends EventEmitter {
  columns = 50;
  rows = 18;
  chunks = [];
  write(chunk) { this.chunks.push(String(chunk)); }
  bytes() { return this.chunks.join(""); }
}

for (const mode of ["inline", "alt"]) {
  test(`${mode} terminal output never contains a masked token, including immediate typed and pasted updates`, async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const host = GTUI.host.terminal({ input, output, mode, colorfgbg: "0;0", themeDetectMs: 0 });
    const ui = new GTUI({ host });
    let model = form({ fields: [{ name: "token", label: "Password", secret: true, value: "INITIAL_PRIVATE_TOKEN" }] });
    const running = ui.run({
      init: () => ({ model, effects: [] }),
      bindings: () => ["tab", "shift+tab", "escape", "ctrl+c", "ctrl+s"],
      update: (current, message) => {
        const result = updateForm(current, message);
        model = result.overlay;
        return { model, effects: [] };
      },
      view: formView,
    });
    try {
      input.emit("data", Buffer.from("TYPED_PRIVATE_TOKEN"));
      expect(model.values.token).toBe("INITIAL_PRIVATE_TOKENTYPED_PRIVATE_TOKEN");
      input.emit("data", Buffer.from("\x1b[200~PASTED_PRIVATE_TOKEN\x1b[201~"));
      expect(model.values.token).toContain("PASTED_PRIVATE_TOKEN");
      for (const token of ["INITIAL_PRIVATE_TOKEN", "TYPED_PRIVATE_TOKEN", "PASTED_PRIVATE_TOKEN"]) expect(output.bytes()).not.toContain(token);
      expect(output.bytes()).toContain("•");
    } finally {
      ui.stop();
      await running;
    }
  });
}
