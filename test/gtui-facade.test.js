import { describe, expect, test } from "bun:test";
import { GTUI, effect, event, host, view } from "../lib/gtui/gtui.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function app(update, render = (model) => GTUI.view.text({ margin: 0 }, `count:${model.count}`)) {
  return { init: () => ({ model: { count: 0 }, effects: [] }), update, view: render };
}

const add = (model, message) => ({ model: { count: model.count + (message.by ?? 0) }, effects: [] });

describe("GTUI facade", () => {
  test("exports one frozen facade for views, effects, events, and hosts", () => {
    expect(GTUI.view).toBe(view);
    expect(GTUI.effect).toBe(effect);
    expect(GTUI.event).toBe(event);
    expect(GTUI.host).toBe(host);
    expect(Object.isFrozen(GTUI.view.row({}, []))).toBe(true);
    expect(Object.isFrozen(GTUI.effect.copy("x"))).toBe(true);
    expect(Object.isFrozen(GTUI.event.key({ key: "enter" }))).toBe(true);
  });

  test("memory host snapshots semantic lines, roles, focus, and caret without ANSI", async () => {
    const memory = GTUI.host.memory({ width: 40, height: 2 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app(add, () => GTUI.view.column({}, [
      GTUI.view.text({ margin: 0, role: "status" }, "ready"),
      GTUI.view.input({ id: "draft", focus: true, caret: 3, value: "abc" }),
    ])));
    expect(memory.snapshot()).toEqual({
      lines: ["ready", "───────────────────────────────────────"],
      roles: [
        { row: 0, start: 0, end: 5, role: "status" },
        { row: 1, start: 0, end: 39, role: "input.border" },
      ],
      links: [],
      sources: [],
      focus: "draft",
      caret: { id: "draft", index: 3, row: 2, column: 5, cursor: { shape: "line", blinkMs: 450 } },
      width: 40,
      height: 2,
    });
    expect(JSON.stringify(memory.snapshot())).not.toContain("\\u001b");
    ui.stop();
    await running;
  });

  test("coalesces synchronous background updates into one host view per frame", async () => {
    let views = 0;
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app(add, (model) => {
      views++;
      return GTUI.view.text({ margin: 0 }, `count:${model.count}`);
    }));
    ui.dispatch({ type: "add", by: 1 });
    ui.dispatch({ type: "add", by: 2 });
    await tick();
    expect(memory.snapshot().lines).toEqual(["count:3"]);
    expect(views).toBe(2);
    ui.stop();
    await expect(running).resolves.toEqual({ reason: "stop", code: 0 });
  });

  test("mounts each interactive control state before the next same-chunk key", async () => {
    const memory = GTUI.host.memory({ width: 30, height: 8 });
    const ui = new GTUI({ host: memory });
    const running = ui.run({
      init: () => ({ model: { draft: "", overlay: false }, effects: [] }),
      update(model, message) {
        if (message.type === "input.change") return { model: { ...model, draft: message.value }, effects: [] };
        if (message.type === "key" && message.key === "ctrl+x") return { model: { ...model, overlay: true }, effects: [] };
        if (message.type === "menu.cancel") return { model: { ...model, overlay: false }, effects: [] };
        return { model, effects: [] };
      },
      view: (model) => model.overlay
        ? GTUI.view.overlay({ fill: true }, [GTUI.view.menu({ id: "menu", focus: true, items: [{ label: "One" }] })])
        : GTUI.view.input({ id: "draft", focus: true, value: model.draft, caret: model.draft.length }),
      bindings: (model) => model.overlay ? [] : ["ctrl+x"],
    });

    // No ticks between events: readline may decode several keys from one
    // data chunk. Every controlled edit must see the preceding render.
    memory.send(GTUI.event.key({ key: "a", text: "a" }));
    memory.send(GTUI.event.key({ key: "b", text: "b" }));
    expect(memory.snapshot().lines.join("\n")).toContain("ab");

    // The key that opens a modal must mount its menu before Escape is
    // routed, rather than leaving the stale input in control.
    memory.send(GTUI.event.key({ key: "ctrl+x" }));
    memory.send(GTUI.event.key({ key: "escape" }));
    expect(memory.snapshot().focus).toBe("draft");
    expect(memory.snapshot().lines.join("\n")).toContain("ab");

    ui.stop();
    await running;
  });

  test("runs concurrent tasks, streams send messages, and cancels only the named task", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app((model, message) => {
      if (message.type === "start") return {
        model,
        effects: [
          GTUI.effect.task("held", async ({ send }) => { await held; send({ type: "add", by: 100 }); }),
          GTUI.effect.task("quick", async ({ send }) => { send({ type: "add", by: 2 }); return { type: "add", by: 3 }; }),
        ],
      };
      if (message.type === "cancel") return { model, effects: [GTUI.effect.cancel("held")] };
      return add(model, message);
    }));
    ui.dispatch({ type: "start" });
    await tick();
    ui.dispatch({ type: "cancel" });
    release();
    await tick();
    await tick();
    expect(memory.snapshot().lines).toEqual(["count:5"]);
    ui.stop();
    await running;
  });

  test("replacing a keyed task suppresses the earlier task's result", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app((model, message) => {
      if (message.type === "old") return { model, effects: [GTUI.effect.task("same", async () => { await held; return { type: "add", by: 100 }; })] };
      if (message.type === "new") return { model, effects: [GTUI.effect.task("same", async () => ({ type: "add", by: 4 }))] };
      return add(model, message);
    }));
    ui.dispatch({ type: "old" });
    await tick();
    ui.dispatch({ type: "new" });
    release();
    await sleep(1);
    await tick();
    expect(memory.snapshot().lines).toEqual(["count:4"]);
    ui.stop();
    await running;
  });

  test("converts rejected tasks into task.failed messages", async () => {
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app((model, message) => {
      if (message.type === "start") return { model, effects: [GTUI.effect.task("bad", async () => { throw new Error("bad task"); })] };
      if (message.type === "task.failed") return add(model, { by: message.key === "bad" && message.error.message === "bad task" ? 1 : 0 });
      return { model, effects: [] };
    }));
    ui.dispatch({ type: "start" });
    await sleep(5);
    await tick();
    expect(memory.snapshot().lines).toEqual(["count:1"]);
    ui.stop();
    await running;
  });

  test("menu back and close messages remain application-scoped", async () => {
    const seen = [];
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app((model, message) => {
      seen.push(message.type);
      return { model, effects: [] };
    }));

    for (const type of ["back", "close", "menu.back", "menu.close"]) ui.dispatch({ type });
    expect(seen).toEqual(["back", "close", "menu.back", "menu.close"]);
    expect(memory.restoreCount).toBe(0);
    ui.stop();
    await expect(running).resolves.toEqual({ reason: "stop", code: 0 });
  });

  test("after dispatches once; quit restores the host exactly once", async () => {
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app((model, message) => {
      if (message.type === "go") return { model, effects: [GTUI.effect.after(1, { type: "quit" })] };
      if (message.type === "quit") return { model, effects: [GTUI.effect.quit(7)] };
      return { model, effects: [] };
    }));
    ui.dispatch({ type: "go" });
    await expect(running).resolves.toEqual({ reason: "quit", code: 7 });
    expect(memory.restoreCount).toBe(1);
    ui.stop();
    expect(memory.restoreCount).toBe(1);
  });

  test("dispose runs before task cancellation and cannot prevent restoration", async () => {
    const order = [];
    let signal;
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const fixture = app((model, message) => message.type === "go" ? {
      model, effects: [GTUI.effect.task("held", async (context) => { signal = context.signal; await sleep(20); })],
    } : { model, effects: [] });
    fixture.dispose = () => { order.push(signal?.aborted); };
    const running = ui.run(fixture);
    ui.dispatch({ type: "go" });
    await tick();
    ui.stop();
    await running;
    expect(order).toEqual([false]);
    expect(signal.aborted).toBe(true);
    expect(memory.restoreCount).toBe(1);
  });

  test("stop aborts tasks and clears pending timers", async () => {
    let signal;
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app((model, message) => message.type === "go" ? {
      model,
      effects: [
        GTUI.effect.task("held", async (context) => { signal = context.signal; await sleep(20); return { type: "add", by: 10 }; }),
        GTUI.effect.after(5, { type: "add", by: 20 }),
      ],
    } : add(model, message)));
    ui.dispatch({ type: "go" });
    await tick();
    ui.stop();
    await running;
    expect(signal.aborted).toBe(true);
    await sleep(25);
    expect(memory.restoreCount).toBe(1);
  });

  test("update and view must be synchronous and throws restore once", async () => {
    const updateHost = GTUI.host.memory();
    const updateUi = new GTUI({ host: updateHost });
    const updateRun = updateUi.run(app(async () => ({ model: {}, effects: [] })));
    updateUi.dispatch({ type: "bad" });
    await expect(updateRun).rejects.toThrow("update must be synchronous");
    expect(updateHost.restoreCount).toBe(1);

    const viewHost = GTUI.host.memory();
    const viewUi = new GTUI({ host: viewHost });
    await expect(viewUi.run(app(add, async () => GTUI.view.text({}, "bad")))).rejects.toThrow("view must be synchronous");
    expect(viewHost.restoreCount).toBe(1);
  });

  test("an init, update, or view throw restores the host and rejects run", async () => {
    for (const broken of [
      { init: () => { throw new Error("init"); }, update: add, view: () => null },
      app(() => { throw new Error("update"); }),
      app(add, () => { throw new Error("view"); }),
    ]) {
      const memory = GTUI.host.memory();
      const ui = new GTUI({ host: memory });
      const running = ui.run(broken);
      if (broken.update !== add) ui.dispatch({ type: "bad" });
      await expect(running).rejects.toThrow();
      expect(memory.restoreCount).toBe(1);
    }
  });
});
