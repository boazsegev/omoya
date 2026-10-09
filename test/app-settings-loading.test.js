import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import Agent from "../lib/agent.js";
import Env from "../lib/env.js";
import { createApp } from "../lib/app/tui/app.js";
import { createWorkspace } from "../lib/app/web/workspace.js";
import { resolveTheme } from "../lib/app/tui/theme-data.js";
import { MENU_ID } from "../lib/app/tui/overlay-view.js";

const key = (app, model, value) => app.update(model, { type: "key", key: value }).model;
const select = (app, model, type) => app.update(model, { type: "menu.select", id: MENU_ID,
  item: [...model.overlay.stack.at(-1).items, ...(model.overlay.stack.at(-1).searchItems ?? [])].find((item) => item.value?.type === type) }).model;

async function fixture() {
  const root = await mkdtemp("./ai-tmp/app-settings-loading-");
  await mkdir(join(root, "themes"));
  await writeFile(join(root, "settings.json"), JSON.stringify({ tui: { theme: "late", keys: { sessionsMenu: "ctrl+g" } } }));
  await writeFile(join(root, "themes", "late.json"), JSON.stringify({
    late: { accent: { fg: 12 }, "tool.preview": { maxRows: 2 } }, other: { accent: { fg: 13 } },
  }));
  return { root, env: await Env.open(root, { dir: root, settingsDir: null, themes: true }) };
}

function listen(app, initial) {
  let model = initial.model;
  const effects = [];
  const controller = new AbortController();
  const tasks = initial.effects.filter((item) => item.type === "task" && ["context.windows", "settings"].includes(item.key));
  const running = tasks.map((task) => task.run({ signal: controller.signal, send: (message) => {
    const result = app.update(model, message);
    model = result.model;
    effects.push(...result.effects);
  } }));
  return { model: () => model, set: (next) => { model = next; }, effects,
    stop: async () => { controller.abort(); await Promise.all(running); } };
}

test("TUI updates an already-open theme picker, active theme, and keymap after disk settings load", async () => {
  const { root, env } = await fixture();
  const agent = await Agent.create({ env });
  const app = createApp(agent);
  const live = listen(app, app.init());
  try {
    live.set(select(app, key(app, live.model(), "ctrl+x"), "themes"));
    expect(live.model().overlay.stack.at(-1).items.filter((item) => item.value?.type === "theme.set").map((item) => item.value.value)).toEqual(["default", "late", "other"]);
    await env.ready();
    await new Promise((resolve) => setImmediate(resolve));
    expect(Object.keys(env.settings.themes)).toEqual(["late", "other"]);
    expect(live.model().overlay.stack.at(-1).items.filter((item) => item.value?.type === "theme.set").map((item) => item.value.value)).toEqual(["default", "late", "other"]);
    expect(live.effects.findLast((item) => item.type === "theme")).toBeUndefined();
    expect(app.bindings(live.model())).toContain("ctrl+g");
    expect(app.theme).toEqual(resolveTheme(env.settings));
    expect(live.effects.some((item) => item.key === "completion.catalog")).toBe(true);
    await live.stop();
    const count = live.effects.length;
    env._emitEvent(Env.EVENT.SETTINGS_CHANGED, {});
    env._emitEvent(Env.EVENT.SETTINGS_LOADED, {});
    expect(live.effects).toHaveLength(count);
  } finally { await live.stop(); app.dispose(); agent.close(); env.close(); await rm(root, { recursive: true, force: true }); }
});

test("TUI refreshes cached prompt, tool, and session menus without dismissing the draft or focus", async () => {
  const { root, env } = await fixture();
  await env.ready();
  const agent = await Agent.create({ env });
  let catalog = { prompts: ["early"], sessions: [{ id: "early" }], tools: [{ name: "early", schema: { description: "Early" } }] };
  const sources = Object.assign(() => ({}), { catalog: () => catalog });
  const app = createApp(agent, { env, sources });
  try {
    for (const type of ["prompts", "tools", "sessions"]) {
      const rootModel = key(app, app.init().model, "ctrl+x");
      const opened = type === "tools"
        ? select(app, rootModel, "access.tools.list")
        : type === "sessions"
          ? app.update(rootModel, { type: "menu.select", id: MENU_ID, item: { value: { type: "sessions", sessions: catalog.sessions } } }).model
          : select(app, rootModel, type);
      const model = { ...opened, focus: "toolbar", input: { ...opened.input, value: "keep draft", caret: 4 } };
      catalog = { prompts: ["early", "late"], sessions: [{ id: "early" }, { id: "late" }], tools: [{ name: "early", schema: {} }, { name: "late", schema: {} }] };
      const next = app.update(model, { type: "completion.catalog.ready" }).model;
      expect(JSON.stringify(next.overlay.stack.at(-1).items)).toContain("late");
      expect(next.overlay.stack).toHaveLength(2);
      expect(next.input).toBe(model.input);
      expect(next.focus).toBe("toolbar");
      catalog = { prompts: ["early"], sessions: [{ id: "early" }], tools: [{ name: "early", schema: {} }] };
    }
  } finally { app.dispose(); agent.close(); env.close(); await rm(root, { recursive: true, force: true }); }
});

test("Web publishes newly loaded theme and web preference after a disk poll", async () => {
  const { root, env } = await fixture();
  await env.ready();
  const workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
  const packets = [];
  const loaded = [];
  const changedHandle = env.onEvent(Env.EVENT.SETTINGS_CHANGED, () => loaded.push("changed"));
  const handle = env.onEvent(Env.EVENT.SETTINGS_LOADED, () => loaded.push("loaded"));
  const ws = { readyState: WebSocket.OPEN, send: (data) => packets.push(JSON.parse(data)) };
  try {
    await workspace.open(ws);
    packets.length = 0;
    await writeFile(join(root, "settings.json"), JSON.stringify({ web: { theme: "dark", autocomplete: false } }));
    await env._sourceGraph.store.poll();
    const settings = packets.filter((packet) => packet.type === "settings").at(-1);
    expect(settings?.prefs.theme).toBe("dark");
    expect(settings?.prefs.autocomplete).toBe(false);
    expect(settings?.prefs.themes).toContain("late");
    expect(settings?.prefs.themeStylesVersion).toBe(0); // selection is not a token change
    await writeFile(join(root, "themes", "late.json"), JSON.stringify({ late: { accent: { fg: "#abcdef" } } }));
    await env._sourceGraph.store.poll();
    expect(packets.findLast((packet) => packet.type === "settings")?.prefs.themeStylesVersion).toBeGreaterThan(0);
    expect(loaded.slice(-2)).toEqual(["loaded", "changed"]);
  } finally { env.offEvent(handle); env.offEvent(changedHandle); workspace.stop(); env.close(); await rm(root, { recursive: true, force: true }); }
});

for (const event of ["SETTINGS_CHANGED", "SETTINGS_LOADED"]) {
  test(`Web does not republish unchanged snapshots on ${event}`, async () => {
    const { root, env } = await fixture();
    await env.ready();
    const workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
    const packets = [];
    const ws = { readyState: WebSocket.OPEN, send: (data) => packets.push(JSON.parse(data)) };
    try {
      await workspace.open(ws);
      packets.length = 0;
      env._emitEvent(Env.EVENT[event], {});
      expect(packets.filter((packet) => ["settings", "endpoints"].includes(packet.type))).toEqual([]);
      workspace.stop();
      packets.length = 0;
      env._emitEvent(Env.EVENT[event], {});
      expect(packets).toEqual([]);
    } finally { workspace.stop(); env.close(); await rm(root, { recursive: true, force: true }); }
  });
}
