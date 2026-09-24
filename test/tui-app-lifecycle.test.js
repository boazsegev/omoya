// test/tui-app-lifecycle.test.js — proof for Phase 04 step 1's app-level
// additions closing gaps the parity run (Phase 03 step 6) left
// documented but unwired: Ctrl+C/Ctrl+D exit (the app previously had no
// way to end its own process), /continue and /session-new|/session-
// delete! reaching real effects (createApp's createCommands call was
// missing onContinue/onReseat/onFillInput/onExit entirely — every one
// of those commands silently no-op'd through the router's own graceful
// fallback text).
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { Agent, SessionStore } from "../lib/agent.js";
import { mkdtempSync, rmSync } from "node:fs";
import { createApp, msg } from "../lib/tui-app/app.js";
import { QUESTION_MENU_ID } from "../lib/tui-app/questionnaire-view.js";
import { scriptedIO, testEnv, TEXT } from "./fakes.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(fn, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await Bun.sleep(10);
  }
  return fn();
}

async function harness() {
  const env = await testEnv();
  const io = scriptedIO([[{ type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const app = createApp(agent, { env });
  const memory = GTUI.host.memory({ width: 80, height: 10 });
  const ui = new GTUI({ host: memory });
  const running = ui.run(app);
  return { env, agent, io, app, memory, ui, running };
}

describe("TUI agent navigation", () => {
  test("Alt+Ctrl+Left/Right pages the live Env registry and wraps", () => {
    return (async () => {
      const env = await testEnv();
      const first = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
      const second = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
      const third = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
      const app = createApp(first, { env });
      let model = app.init().model;
      model = app.update(model, { type: "key", key: "alt+ctrl+right" }).model;
      expect(app.currentAgent()).toBe(second);
      model = app.update(model, { type: "key", key: "alt+ctrl+right" }).model;
      expect(app.currentAgent()).toBe(third);
      model = app.update(model, { type: "key", key: "alt+ctrl+right" }).model;
      expect(app.currentAgent()).toBe(first);
      model = app.update(model, { type: "key", key: "alt+ctrl+left" }).model;
      expect(app.currentAgent()).toBe(third);
    })();
  });

  test("Alt+Ctrl+Up switches a child to its parent and otherwise does nothing", async () => {
    const env = await testEnv();
    const parent = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const child = parent.createChild({ model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(child, { env });
    let model = app.init().model;
    model = app.update(model, { type: "key", key: "alt+ctrl+up" }).model;
    expect(app.currentAgent()).toBe(parent);
    const unchanged = app.update(model, { type: "key", key: "alt+ctrl+up" });
    expect(app.currentAgent()).toBe(parent);
    expect(unchanged.model).toBe(model);
  });
});

describe("TUI login wizard", () => {
  test("/endpoint-login replaces an open non-menu overlay with the preset picker", async () => {
    const { memory, ui, running } = await harness();
    try {
      ui.dispatch({ type: "key", key: "ctrl+o" });
      await tick();
      ui.dispatch(msg.submit("/endpoint-login"));
      await until(() => memory.snapshot().lines.some((line) => line.includes("Login — choose an endpoint")));
      expect(memory.snapshot().lines.some((line) => line.includes("Login — choose an endpoint"))).toBe(true);
    } finally {
      ui.stop();
      await running;
    }
  });
});

describe("TUI status settings", () => {
  test("offers a session logging toggle for persisted sessions", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [], session: "persistent", createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(agent, { env });
    const opened = app.update(app.init().model, { type: "action.select", action: "status.settings" }).model;

    const items = opened.overlay.stack.at(-1).items;
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "header", label: "Session logging" }),
      expect.objectContaining({
        kind: "action",
        label: "session logging: on (toggle)",
        value: { type: "session-save", value: false },
      }),
    ]));
  });

  test("uses the current disabled state when toggling session logging", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [], session: "memory", sessionSave: false, createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(agent, { env });
    const opened = app.update(app.init().model, { type: "action.select", action: "status.settings" }).model;

    const items = opened.overlay.stack.at(-1).items;
    expect(items).toContainEqual(expect.objectContaining({
      label: "session logging: off (memory only) (toggle)",
      value: { type: "session-save", value: true },
    }));
  });

  test("omits session logging for anonymous sessions", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(agent, { env });
    const opened = app.update(app.init().model, { type: "action.select", action: "status.settings" }).model;

    expect(opened.overlay.stack.at(-1).items.some((item) => item.label === "Session logging")).toBe(false);
  });
});

describe("TUI add-agent", () => {
  test("selecting an endpoint/model creates and views an additional Agent", async () => {
    const env = await testEnv();
    const original = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(original, { env });
    const model = app.init().model;
    const opened = app.update(model, { type: "app.overlay.openMaster" }).model;

    const transition = app.update(opened, {
      type: "menu.select", id: "menu",
      item: { value: { type: "session-add", endpoint: "p", model: "m" } },
    });

    const added = app.currentAgent();
    expect(added).toBeInstanceOf(Agent);
    expect(added).not.toBe(original);
    expect(added).toMatchObject({ env, endpoint: "p", model: "m" });
    expect(env.agents()).toEqual([original, added]);
    expect(transition.model.overlay).toBeNull();
  });
});

describe("TUI close-agent menu action", () => {
  test("closes a selected non-focused Agent without changing the viewed session", async () => {
    const env = await testEnv();
    const current = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const other = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(current, { env });
    const opened = app.update(app.init().model, { type: "app.overlay.openMaster" }).model;
    const transition = app.update(opened, { type: "menu.select", id: "menu", item: { value: { type: "agent.close", agent: other } } });
    expect(other.closed).toBe(true);
    expect(env.agents()).toEqual([current]);
    expect(app.currentAgent()).toBe(current);
    expect(transition.model.overlay).toBeNull();
  });

  test("closes the focused Agent and switches to another active session", async () => {
    const env = await testEnv();
    const current = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const other = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(current, { env });
    const opened = app.update(app.init().model, { type: "app.overlay.openMaster" }).model;
    const transition = app.update(opened, { type: "menu.select", id: "menu", item: { value: { type: "agent.close", agent: current } } });
    expect(current.closed).toBe(true);
    expect(env.agents()).toEqual([other]);
    expect(app.currentAgent()).toBe(other);
    expect(transition.model.overlay).toBeNull();
  });
});

describe("Ctrl+C: idle draft clear, then a two-press exit", () => {
  test("a non-empty draft clears on the first ^C; the app keeps running", async () => {
    const { memory, ui, running } = await harness();
    memory.send(GTUI.event.key({ key: "h", text: "h" }));
    await tick();
    expect(memory.snapshot().caret).toMatchObject({ id: "draft", index: 1 });
    memory.send(GTUI.event.key({ key: "ctrl+c" }));
    await tick();
    expect(memory.snapshot().caret).toMatchObject({ id: "draft", index: 0 }); // cleared, not quit
    ui.stop();
    await running;
  });

  test("^C shows a bold colored action notice; a SECOND consecutive ^C quits", async () => {
    const { memory, ui, running } = await harness();
    memory.send(GTUI.event.key({ key: "ctrl+c" })); // shows "press ^C again to exit"
    await tick();
    expect(memory.snapshot().lines.some((l) => l.includes("press ^C again to exit"))).toBe(true);
    expect(memory.snapshot().roles.some((span) => span.role === "notice.action")).toBe(true);
    memory.send(GTUI.event.key({ key: "ctrl+c" })); // the second press
    const result = await running;
    expect(result).toMatchObject({ reason: "quit", code: 0 });
    void ui;
  });

  test("any other key between the two presses dismisses the notice AND retracts its line — a third ^C starts over, never skipping straight to quit", async () => {
    const { memory, ui, running } = await harness();
    memory.send(GTUI.event.key({ key: "ctrl+c" }));
    await tick();
    memory.send(GTUI.event.key({ key: "x", text: "x" })); // dismisses the notice AND types
    await tick();
    expect(memory.snapshot().lines.some((l) => l.includes("press ^C again to exit"))).toBe(false); // retracted, not just disarmed
    memory.send(GTUI.event.key({ key: "ctrl+c" })); // clears the non-empty draft, does NOT quit
    await tick();
    expect(memory.snapshot().caret).toMatchObject({ id: "draft", index: 0 });
    ui.stop();
    await running;
  });

});

describe("session deletion confirmation", () => {
  test("/session-delete-all! uses the TUI question bridge and deletes after confirmation", async () => {
    const env = await testEnv();
    const dir = mkdtempSync("./ai-tmp/tui-delete-");
    const session = new SessionStore({ id: "live", dir, context: [] });
    const saved = new SessionStore({ id: "saved", dir, context: [] });
    saved.append({ type: 2, content: [{ type: "text", text: "keep me" }] });
    saved.close();
    const agent = new Agent({ env, model: "p/m", context: [], session, createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(agent, { env });
    const memory = GTUI.host.memory({ width: 100, height: 12 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);
    try {
      ui.dispatch(msg.submit("/session-delete-all!"));
      await until(() => memory.snapshot().lines.some((line) => line.includes("Delete ALL 1 session file(s)")));
      ui.dispatch({ type: "menu.select", id: QUESTION_MENU_ID, item: { value: "Delete all" } });
      ui.dispatch({ type: "menu.submit", id: QUESTION_MENU_ID, item: { value: "Delete all" } });
      await until(() => memory.snapshot().lines.some((line) => line.includes("deleted 1 session file(s)")));
      expect(SessionStore.list({ dir })).toHaveLength(0);
    } finally {
      ui.stop();
      await running;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clipboard effects", () => {
  test("/context-copy reaches the host instead of reporting a missing OSC 52 sink", async () => {
    const { agent, memory, ui, running } = await harness();
    agent.append({ type: 3, content: [{ type: "text", text: "logical response" }] });
    ui.dispatch(msg.submit("/context-copy"));
    await until(() => memory.snapshot().lines.some((line) => line.includes("copied the last response")));
    expect(memory.effects.find((entry) => entry.type === "copy")).toMatchObject({ text: "logical response" });
    expect(memory.snapshot().lines.some((line) => line.includes("clipboard unavailable"))).toBe(false);
    ui.stop();
    await running;
  });

  test("repeated copies stack one notice that expires; the failure notice expires too", async () => {
    const { app } = await harness();
    let model = app.init().model;
    const copy = (ok) => {
      const transition = app.update(model, { type: "copy.done", id: `transcript-copy:${Math.random()}`, ok });
      model = transition.model;
      return transition;
    };
    // Three successful copies: ONE on-screen notice, refreshed each time.
    copy(true); copy(true);
    const third = copy(true);
    const copies = model.notices.filter((n) => n.text === "copied selection to the clipboard");
    expect(copies).toHaveLength(1);
    expect(third.effects).toEqual([{ type: "after", ms: 8_000, message: { type: "app.notice.expire", id: copies[0].id } }]);
    // Its expiry message removes exactly that notice.
    model = app.update(model, { type: "app.notice.expire", id: copies[0].id }).model;
    expect(model.notices).toHaveLength(0);
    // A stale timer (from an occurrence the newer copy replaced) is a no-op.
    model = app.update({ ...model, notices: [{ id: 99, text: "unrelated", kind: "notice" }] }, { type: "app.notice.expire", id: copies[0].id }).model;
    expect(model.notices).toHaveLength(1);
    // Failures expire like any other notice (an HTTP 401 that lingers
    // forever is exactly what must NOT happen); identical failures still
    // collapse to one line like any same-text notice, and their expiry
    // timer restarts from the latest occurrence.
    const failed = copy(false);
    expect(failed.effects).toEqual([{ type: "after", ms: 8_000, message: { type: "app.notice.expire", id: failed.model.notices.at(-1).id } }]);
    expect(model.notices.at(-1)).toMatchObject({ text: "clipboard unavailable (OSC 52 and system tools failed)", kind: "error" });
    const again = app.update(failed.model, { type: "copy.done", id: "transcript-copy:x", ok: false });
    expect(again.model.notices.filter((n) => n.kind === "error")).toHaveLength(1);
    expect(again.effects).toEqual([{ type: "after", ms: 8_000, message: { type: "app.notice.expire", id: again.model.notices.at(-1).id } }]);
    // The expiry message removes the error like any other notice.
    const expired = app.update(again.model, { type: "app.notice.expire", id: again.model.notices.at(-1).id }).model;
    expect(expired.notices.some((n) => n.kind === "error")).toBe(false);
  });

  test("a turn error notice expires on the shared TTL but still surfaces", async () => {
    const { app } = await harness();
    const model = app.init().model;
    const transition = app.update(model, { type: "agent.turn.failed", error: new Error("boom") });
    expect(transition.model.notices.at(-1)).toMatchObject({ text: "turn failed: boom", kind: "error" });
    expect(transition.effects).toEqual([{ type: "after", ms: 8_000, message: { type: "app.notice.expire", id: transition.model.notices.at(-1).id } }]);
  });

  test("Cmd+C copies a keyboard selection in logical bidi order", async () => {
    const { memory, ui, running } = await harness();
    for (const character of "abc שלום") {
      memory.send(GTUI.event.key({ key: character, text: character }));
      await tick();
    }
    for (let count = 0; count < 4; count++) {
      memory.send(GTUI.event.key({ key: "shift+left" }));
      await tick();
    }
    memory.send(GTUI.event.key({ key: "copy" }));
    await until(() => memory.snapshot().lines.some((line) => line.includes("copied selection")));
    expect(memory.effects.findLast((entry) => entry.type === "copy")).toMatchObject({ text: "שלום" });
    ui.stop();
    await running;
  });
});

describe("visible notifications", () => {
  test("a failed command task becomes an error notice instead of disappearing", async () => {
    const { app, memory, ui, running } = await harness();
    const initial = app.init().model;
    const transition = app.update({ ...initial, turnRunning: true }, { type: "task.failed", key: "agent.turn", error: new Error("socket broke") });
    expect(transition.model.turnRunning).toBe(false);

    ui.dispatch({ type: "task.failed", key: "agent.command", error: new Error("bad command") });
    await tick();
    expect(memory.snapshot().lines.some((line) => line.includes("command failed: bad command"))).toBe(true);
    expect(memory.snapshot().roles.some((span) => span.role === "notice.error")).toBe(true);
    ui.stop();
    await running;
  });

  test("the two-press exit prompt is transient footer state, not transcript history", async () => {
    const { memory, ui, running } = await harness();
    memory.send(GTUI.event.key({ key: "ctrl+c" }));
    await tick();
    const shown = memory.snapshot();
    const promptRow = shown.lines.findIndex((line) => line.includes("press ^C again to exit"));
    expect(promptRow).toBeGreaterThan(shown.caret.row);
    memory.send(GTUI.event.key({ key: "x", text: "x" }));
    await tick();
    expect(memory.snapshot().lines.some((line) => line.includes("press ^C again to exit"))).toBe(false);
    ui.stop();
    await running;
  });
});

describe("Ctrl+D: EOF on empty, forward-delete otherwise", () => {
  test("^D on an empty draft quits", async () => {
    const { memory, running } = await harness();
    memory.send(GTUI.event.key({ key: "ctrl+d" }));
    const result = await running;
    expect(result).toMatchObject({ reason: "quit", code: 0 });
  });

  test("^D quits even mid-turn — deliberately, unlike ^C (parity with input-keys.js's un-guarded IS_EOF branch)", async () => {
    const { ui, running } = await harness();
    ui.dispatch(msg.submit("go")); // turnRunning becomes true
    await tick();
    ui.dispatch({ type: "key", key: "ctrl+d" });
    const result = await running;
    expect(result).toMatchObject({ reason: "quit", code: 0 });
  });

  test("^D with text forward-deletes at the caret instead of quitting", async () => {
    const { ui, memory, running } = await harness();
    for (const ch of "hi") { memory.send(GTUI.event.key({ key: ch, text: ch })); await tick(); }
    ui.dispatch({ type: "input.change", id: "draft", value: "hi", caret: 0 }); // caret before "h"
    await tick();
    memory.send(GTUI.event.key({ key: "ctrl+d" }));
    await tick();
    expect(memory.snapshot().caret).toMatchObject({ id: "draft", index: 0 });
    expect(memory.snapshot().lines.some((l) => l.trim() === "i")).toBe(true); // "hi" minus the "h"
    ui.stop();
    await running;
  });

  test("^D with an active selection deletes the WHOLE selection, not just the char at the caret", async () => {
    const { ui, memory, running } = await harness();
    for (const ch of "hello") { memory.send(GTUI.event.key({ key: ch, text: ch })); await tick(); }
    ui.dispatch({ type: "input.change", id: "draft", value: "hello", caret: 5, selection: { anchor: 1, caret: 4 } }); // marks "ell"
    await tick();
    memory.send(GTUI.event.key({ key: "ctrl+d" }));
    await tick();
    expect(memory.snapshot().lines.some((l) => l.trim() === "ho")).toBe(true); // "h" + "o", "ell" gone
    ui.stop();
    await running;
  });
});

describe("/continue, /session-new, and /context-edit reach real effects (not the router's graceful no-op text)", () => {
  test("/continue runs a fresh turn (io actually invoked) with no new user message", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "ok"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent, { env });
    const memory = GTUI.host.memory({ width: 80, height: 10 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    for (const ch of "/continue") { memory.send(GTUI.event.key({ key: ch, text: ch })); await tick(); }
    memory.send(GTUI.event.key({ key: "enter" }));
    await until(() => io.turns() === 1); // the router didn't just print "not available"
    await until(() => memory.snapshot().lines.some((l) => l.includes("ok"))); // the scripted reply actually rendered
    expect(agent.context.some((m) => m.type === 2)).toBe(false); // it re-activated the Agent — no NEW user message
    ui.stop();
    await running;
  });

  test("whitespace-only input behaves like /continue: a fresh turn runs, no message is printed or appended", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "ok"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent, { env });
    const memory = GTUI.host.memory({ width: 80, height: 10 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    memory.send(GTUI.event.key({ key: "space", text: " " }));
    memory.send(GTUI.event.key({ key: "space", text: " " }));
    memory.send(GTUI.event.key({ key: "enter" }));
    await until(() => io.turns() === 1); // the turn actually ran — exactly like /continue
    await until(() => memory.snapshot().lines.some((l) => l.includes("ok")));
    expect(agent.context.some((m) => m.type === 2)).toBe(false); // NO user message was appended
    expect(memory.snapshot().lines.some((l) => l.trim() === "")).toBe(true); // nothing printed for the empty turn
    ui.stop();
    await running;
  });

  test("/session-new reseats an idle agent onto a genuinely different Agent instance", async () => {
    const { env, agent, memory, ui, running } = await harness();
    const before = agent.context.length;
    for (const ch of "/session-new") { memory.send(GTUI.event.key({ key: ch, text: ch })); await tick(); }
    memory.send(GTUI.event.key({ key: "enter" }));
    await until(() => memory.snapshot().lines.some((l) => l.includes("new session")));
    expect(memory.snapshot().lines.some((l) => l.includes("not available"))).toBe(false);
    // A submit now must land on whatever's CURRENTLY viewed, never on the
    // OLD `agent` reference directly — proving the view actually moved
    // to a different instance rather than resetting the same one in place.
    ui.dispatch(msg.submit("hi"));
    await until(() => memory.snapshot().lines.some((l) => l.includes("hi")));
    expect(agent.context.length).toBe(before); // the OLD instance never saw it
    expect(env.agents()).toHaveLength(1); // /new replaces; it never accumulates abandoned Agents
    expect(env.agents()[0]).not.toBe(agent);
    expect(agent.closed).toBe(true);
    ui.stop();
    await running;
  });

  test("/context-edit (bare) moves the last message into the draft via onFillInput", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [{ type: 2, content: [{ type: "text", text: "earlier message" }] }], createIO: () => io });
    const before = agent.context.length;
    const app = createApp(agent, { env });
    const memory = GTUI.host.memory({ width: 80, height: 10 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    for (const ch of "/context-edit") { memory.send(GTUI.event.key({ key: ch, text: ch })); await tick(); }
    memory.send(GTUI.event.key({ key: "enter" }));
    await until(() => agent.context.length === before - 1); // popped out of the context
    // by now the transcript's own copy is gone (it was popped), so the
    // text can only still be showing up because it landed in the draft
    expect(memory.snapshot().lines.some((l) => l.includes("earlier message"))).toBe(true);
    ui.stop();
    await running;
  });
});
