// test/gtui-toolbar.test.js — GTUI view.toolbar/view.button: layout (whole
// buttons drop by priority), state roles, host-owned roving focus, keyboard
// and pointer activation, hover, and the inline pointer policy.
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { createControls } from "../lib/app/gtui/controls.js";
import { layoutView } from "../lib/app/gtui/layout.js";

const { toolbar, button } = GTUI.view;

const bar = (props = {}) => toolbar({ id: "tools", ...props }, [
  button({ action: "model", icon: "◇", priority: 20 }, "gpt"),
  button({ action: "think", priority: 10 }, "think"),
  button({ action: "safe", pressed: true, tone: "warn", priority: 40 }, "read only"),
]);

function mount(root, width = 40) {
  const events = [];
  const controls = createControls((event) => events.push(event));
  const frame = (next = root) => {
    controls.beginFrame();
    const scene = layoutView(next, { width, height: 2, controls });
    controls.endFrame(next, scene.canvas);
    return scene;
  };
  return { events, controls, frame };
}

const roleAt = (scene, x) => scene.canvas.cells[0][x]?.role;

describe("toolbar layout", () => {
  test("draws padded buttons separated by one column", () => {
    const { frame } = mount(bar());
    expect(frame().snapshot.lines[0]).toBe(" ◇ gpt   think   read only");
  });

  test("drops whole buttons, lowest priority first, when narrow", () => {
    const { frame } = mount(bar(), 20);
    expect(frame().snapshot.lines[0]).toBe(" ◇ gpt   read only");
    const { frame: tiny } = mount(bar(), 12);
    expect(tiny().snapshot.lines[0]).toBe(" read only");
  });

  test("natural width lets a row give the toolbar exactly its buttons", () => {
    const root = GTUI.view.row({ columns: ["fill", "auto"] }, [GTUI.view.text({ margin: 0 }, "cwd"), bar()]);
    const { frame } = mount(root, 40);
    expect(frame().snapshot.lines[0]).toBe("cwd           ◇ gpt   think   read only");
  });

  test("state roles: pressed → button.on, tone → button.<tone>, focus only while focused", () => {
    const { frame } = mount(bar());
    let scene = frame();
    expect(roleAt(scene, 1)).toBe("button");
    expect(roleAt(scene, 18)).toBe("button button.on button.warn");
    scene = frame(bar({ focus: true }));
    expect(roleAt(scene, 1)).toBe("button button.focus");
    expect(scene.snapshot.focus).toBe("tools");
  });
});

describe("toolbar keyboard", () => {
  test("arrows and Tab rove (wrapping) with toolbar.change; Enter and Space activate", () => {
    const { events, controls, frame } = mount(bar({ focus: true }));
    frame();
    expect(controls.handle({ type: "key", key: "right" })).toBe(true);
    expect(events.at(-1)).toEqual({ type: "toolbar.change", id: "tools", key: "think", action: "think" });
    let scene = frame(bar({ focus: true }));
    expect(roleAt(scene, 9)).toBe("button button.focus");
    controls.handle({ type: "key", key: "tab" });
    controls.handle({ type: "key", key: "tab" }); // wraps to the first button
    expect(events.at(-1).key).toBe("model");
    controls.handle({ type: "key", key: "shift+tab" });
    expect(events.at(-1).key).toBe("safe");
    frame(bar({ focus: true }));
    controls.handle({ type: "key", key: "home" });
    frame(bar({ focus: true }));
    expect(controls.handle({ type: "key", key: "enter" })).toBe(true);
    expect(events.at(-1)).toEqual({ type: "action.select", id: "tools", action: "model" });
    controls.handle({ type: "key", key: "end" });
    frame(bar({ focus: true }));
    expect(controls.handle({ type: "key", key: "space" })).toBe(true);
    expect(events.at(-1)).toEqual({ type: "action.select", id: "tools", action: "safe" });
    scene = frame(bar({ focus: true }));
    expect(roleAt(scene, 18)).toBe("button button.on button.warn button.focus");
  });

  test("focus follows the button by key when labels change", () => {
    const { controls, frame } = mount(bar({ focus: true }));
    frame();
    controls.handle({ type: "key", key: "end" });
    const relabeled = toolbar({ id: "tools", focus: true }, [
      button({ action: "model" }, "gpt"), button({ action: "think" }, "think"), button({ action: "safe" }, "read/write"),
    ]);
    const scene = frame(relabeled);
    expect(scene.snapshot.lines[0]).toBe(" gpt   think   read/write");
    expect(roleAt(scene, 18)).toBe("button button.focus");
  });

  test("keys the toolbar does not use bubble to the app", () => {
    const { controls, frame } = mount(bar({ focus: true }));
    frame();
    expect(controls.handle({ type: "key", key: "up" })).toBe(false);
    expect(controls.handle({ type: "key", key: "escape" })).toBe(false);
    expect(controls.handle({ type: "key", key: "a", text: "a" })).toBe(false);
  });

  test("an unfocused toolbar takes no keys", () => {
    const { controls, frame } = mount(bar());
    frame();
    expect(controls.handle({ type: "key", key: "right" })).toBe(false);
  });
});

describe("toolbar pointer", () => {
  test("a click on a button selects its action, focused or not", () => {
    const { events, controls, frame } = mount(bar());
    frame();
    const resolved = controls.resolvePoint({ x: 10, y: 0 });
    expect(resolved).toEqual({ kind: "press", control: "action", target: "tools", index: 1 });
    expect(controls.handle({ type: "pointer", ...resolved, x: 10, y: 0, button: 0 })).toBe(true);
    expect(events).toEqual([{ type: "action.select", id: "tools", action: "think" }]);
  });

  test("a button's own id names the selection", () => {
    const { events, controls, frame } = mount(toolbar({ id: "tools" }, [button({ id: "save", action: "file.save" }, "save")]));
    frame();
    const resolved = controls.resolvePoint({ x: 2, y: 0 });
    controls.handle({ type: "pointer", ...resolved, x: 2, y: 0, button: 0 });
    expect(events).toEqual([{ type: "action.select", id: "save", action: "file.save" }]);
  });

  test("pointer motion highlights the whole hovered button", () => {
    const { controls, frame } = mount(bar());
    const scene = frame();
    expect(controls.handle({ type: "pointer", kind: "move", x: 10, y: 0 })).toBe(true);
    for (let x = 8; x <= 14; x++) expect(roleAt(scene, x)).toBe("button button.hover");
    expect(roleAt(scene, 1)).toBe("button");
    controls.handle({ type: "pointer", kind: "move", x: 39, y: 1 });
    expect(roleAt(scene, 10)).toBe("button");
  });
});

describe("toolbar hosts", () => {
  test("memory host: focused toolbar keys reach the app as action.select", async () => {
    const memory = GTUI.host.memory({ width: 40, height: 3 });
    const ui = new GTUI({ host: memory });
    const seen = [];
    const running = ui.run({
      init: () => ({ model: {}, effects: [] }),
      update: (model, message) => { seen.push(message.type === "key" ? `key:${message.key}` : `${message.type}:${message.action ?? ""}`); return { model, effects: [] }; },
      view: () => bar({ focus: true }),
    });
    memory.send({ type: "key", key: "right" });
    memory.send({ type: "key", key: "enter" });
    memory.send({ type: "key", key: "up" });
    expect(seen).toEqual(["toolbar.change:think", "action.select:think", "key:up"]);
    ui.stop();
    await running;
  });
});

test("align end keeps the remaining buttons against the right edge", () => {
  const { frame } = mount(bar({ align: "end" }), 22);
  expect(frame().snapshot.lines[0]).toBe("    ◇ gpt   read only");
});
