import { expect, test } from "bun:test";
import Agent from "../lib/agent.js";
import Env from "../lib/env.js";
import { createApp } from "../lib/app/tui/app.js";
import { MENU_ID } from "../lib/app/tui/overlay-view.js";
import { resolveTheme } from "../lib/app/tui/theme-data.js";
import { layoutView } from "../lib/app/gtui/layout.js";
import { testEnv } from "./fakes.js";

const openThemes = (app, model) => {
  const opened = app.update(model, { type: "key", key: "ctrl+x" }).model;
  return app.update(opened, { type: "menu.select", id: MENU_ID,
    item: opened.overlay.stack.at(-1).searchItems.find((item) => item.value?.type === "themes") }).model;
};

test("settings refresh preserves the highlighted theme preview and draft while updating the saved theme", async () => {
  const env = await testEnv({ tui: { theme: "first" }, themes: { first: { accent: { fg: 12 } }, preview: { accent: { fg: 13 } } } });
  await env.ready();
  const agent = await Agent.create({ env });
  const app = createApp(agent);
  try {
    let model = openThemes(app, app.init().model);
    model = app.update(model, { type: "menu.change", id: MENU_ID,
      item: model.overlay.stack.at(-1).items.find((item) => item.value?.value === "preview") }).model;
    model = { ...model, input: { ...model.input, value: "keep draft", caret: 3 }, focus: "toolbar" };
    env.settings.tui.theme = "default";
    const result = app.update(model, { type: "settings.ready" });
    expect(result.model.input).toBe(model.input);
    expect(result.model.focus).toBe("toolbar");
    expect(result.model.overlay.stack.at(-1).preview).toEqual({ type: "theme", name: "preview" });
    expect(result.effects.find((item) => item.type === "theme")?.tokens).toEqual(resolveTheme({ tui: { theme: "preview" }, themes: env.settings.themes }));
    expect(app.theme).toEqual(resolveTheme(env.settings));
    const unchanged = app.update(result.model, { type: "settings.ready" });
    expect(unchanged.effects.some((item) => item.type === "theme")).toBe(false);
    const closed = app.update(unchanged.model, { type: "menu.cancel", id: MENU_ID });
    expect(closed.effects.find((item) => item.type === "theme")?.tokens).toEqual(app.theme);
  } finally { app.dispose(); agent.close(); env.close(); }
});

test("settings listeners are released if the TUI stops before the ready barrier settles", async () => {
  const env = await testEnv();
  await env.ready();
  const agent = await Agent.create({ env });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const borrowed = { settings: env.settings, ready: () => pending,
    onEvent: env.onEvent.bind(env), offEvent: env.offEvent.bind(env) };
  const app = createApp(agent, { env: borrowed });
  const controller = new AbortController();
  const messages = [];
  try {
    const task = app.init().effects.find((item) => item.key === "settings");
    const running = task.run({ signal: controller.signal, send: (message) => messages.push(message) });
    controller.abort();
    await running;
    env._emitEvent(Env.EVENT.SETTINGS_LOADED, {});
    release();
    await pending;
    expect(messages).toEqual([]);
  } finally { release(); app.dispose(); agent.close(); env.close(); }
});

test("late theme preview caps replace the transcript projection without altering its messages", async () => {
  const env = await testEnv({ themes: { compact: { "message.thinking.preview": { maxRows: 3 } } } });
  await env.ready();
  const agent = await Agent.create({ env });
  agent.context.append({ type: 3, content: [{ type: "thinking", text: Array.from({ length: 12 }, (_, index) => `row ${index}`).join("\n") }] });
  const app = createApp(agent);
  try {
    const model = app.init().model;
    const feed = () => app.view(model).children[0].children[0];
    const before = feed();
    env.settings.tui.theme = "compact";
    app.update(model, { type: "settings.ready" });
    const after = feed();
    expect(after.id).not.toBe(before.id);
    const thinking = after.items.find((item) => item.key.endsWith(":Thinking:0"));
    const lines = layoutView(thinking.node, { width: 40, height: 20 }).snapshot.lines.map((line) => line.trim()).filter(Boolean);
    expect(lines).toEqual(["Thought", "row 0", "...", "row 11"]);
    expect(agent.context.length).toBe(1);
    app.update(model, { type: "settings.ready" });
    expect(feed().id).toBe(after.id);
  } finally { app.dispose(); agent.close(); env.close(); }
});
