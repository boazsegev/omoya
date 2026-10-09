import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import Env from "../lib/env.js";
import { createWorkspace } from "../lib/app/web/workspace.js";
import "../lib/agent.js";

async function settled() {
  for (let turn = 0; turn < 100; turn++) await new Promise((resolve) => setImmediate(resolve));
}

test("unchanged theme reads and polling do not rebuild settings or rebroadcast browser preferences", async () => {
  const root = await mkdtemp("ai-tmp/settings-stability-");
  const env = await Env.open(root, { settingsDir: root, themes: true, settings: { theme: "dark" } });
  let workspace;
  let settingsEvents = 0;
  const handle = env.onEvent(Env.EVENT.SETTINGS_CHANGED, () => { settingsEvents++; });
  const packets = [];
  try {
    await env.ready();
    workspace = await createWorkspace({}, { env, options: {} });
    const ws = { readyState: WebSocket.OPEN, data: { local: true }, send: (text) => packets.push(JSON.parse(text)) };
    await workspace.open(ws);
    await settled();
    const before = { settingsEvents, packets: packets.length };
    const preferences = packets.findLast((packet) => packet.type === "settings").prefs;
    for (let count = 0; count < 20; count++) {
      Object.keys(env.settings.themes);
      JSON.stringify(env.settings.web);
      env.settings.toJSON();
      await env._sourceGraph.store.poll();
      await settled();
    }
    expect(settingsEvents).toBe(before.settingsEvents);
    expect(packets.filter((packet, index) => index >= before.packets && packet.type === "settings")).toEqual([]);
    expect(JSON.parse(JSON.stringify(env.settings.web))).toMatchObject({ theme: "dark" });
    expect(preferences).toBeDefined();
    env.settings.web.theme = "light";
    await env.settingsFlush();
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 20)); // browser preference packets follow the update event
    expect(settingsEvents).toBeGreaterThan(before.settingsEvents);
    expect(packets.findLast((packet) => packet.type === "settings").prefs.theme).toBe("light");
    // Reads after a real edit never emit another update.
    env.settings.toJSON();
    await settled();
    const after = { settingsEvents };
    for (let count = 0; count < 10; count++) { env.settings.toJSON(); await settled(); }
    expect(settingsEvents).toBe(after.settingsEvents);
  } finally {
    workspace?.stop();
    env.offEvent(handle);
    await env.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("equal file reloads and same-value theme writes do not republish settings or styles", async () => {
  const root = await mkdtemp("ai-tmp/settings-equal-");
  const file = `${root}/ai-settings.json`;
  await writeFile(file, JSON.stringify({ theme: { tui: "dark" }, web: { theme: "dark" } }));
  const env = await Env.open(root, { dir: root, settingsDir: null });
  let workspace;
  const packets = [];
  let changes = 0;
  let loads = 0;
  const changed = env.onEvent(Env.EVENT.SETTINGS_CHANGED, () => { changes++; });
  const loaded = env.onEvent(Env.EVENT.SETTINGS_LOADED, () => { loads++; });
  try {
    await env.ready();
    workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
    await workspace.open({ readyState: WebSocket.OPEN, send: (text) => packets.push(JSON.parse(text)) });
    await settled();
    const before = { changes, loads, version: env._sourceGraph.store.version };
    packets.length = 0;
    env.settings.theme.tui = "dark";
    env.settings.web.theme = "dark";
    env.settings.tui.theme = env.settings.tui.theme.toJSON();
    env.settings.web.autocomplete = env.settings.web.autocomplete; // equal to the effective value
    await env.settingsFlush();
    await settled();
    expect(changes).toBe(before.changes);
    expect(env._sourceGraph.store.version).toBe(before.version);
    await writeFile(file, '{\n"web": {"theme": "dark"}, "theme": {"tui": "dark"}\n}');
    await env._sourceGraph.store.poll();
    await settled();
    expect(loads).toBeGreaterThan(before.loads);
    expect(changes).toBe(before.changes);
    expect(packets.filter((packet) => packet.type === "settings")).toEqual([]);
    env.settings.pluginValue = 42;
    await env.settingsFlush();
    await settled();
    const update = packets.findLast((packet) => packet.type === "settings");
    expect(update.settings.pluginValue).toBe(42);
    expect(update.prefs.themeStylesVersion).toBe(0);
  } finally {
    workspace?.stop(); env.offEvent(changed); env.offEvent(loaded);
    await env.close(); await rm(root, { recursive: true, force: true });
  }
});
