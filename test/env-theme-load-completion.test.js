import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import Env from "../lib/env.js";
import Agent from "../lib/agent.js";
import { resolveTheme } from "../lib/app/tui/theme-data.js";
import { createApp } from "../lib/app/tui/app.js";
import { createWorkspace } from "../lib/app/web/workspace.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("bundled theme names, roles, and both App palettes are complete at the load event and first ready read", async () => {
  const root = await mkdtemp("./ai-tmp/theme-bundled-");
  const files = (await readdir("themes")).filter((name) => name.endsWith(".json"));
  const expected = {};
  const bytes = new Map();
  for (const file of files) {
    const text = await readFile(join("themes", file), "utf8");
    bytes.set(file, text);
    Object.assign(expected, JSON.parse(text));
  }
  const names = Object.keys(expected).sort();
  const env = await Env.open(root, { dir: ".", settingsDir: null, init: { providers: false, tools: false, detect: false, models: false } });
  const events = [];
  env.onEvent(Env.EVENT.SETTINGS_LOADED, () => events.push(env.settings.themes?.toJSON()));
  try {
    await env.ready();
    expect(Object.keys(env.settings.themes).sort()).toEqual(names);
    for (const name of names) {
      const tokens = resolveTheme({ tui: { theme: name }, themes: env.settings.themes });
      expect(tokens.dark.accent.fg).toBe(expected[name].dark.accent.fg);
      expect(tokens.light.background.bg).toBe(expected[name].light.background.bg);
    }
    await tick();
    expect(events).toHaveLength(0); // Env.open returns after initial settings load
    const agent = await Agent.create({ env });
    const app = createApp(agent);
    const opened = app.update(app.init().model, { type: "key", key: "ctrl+x" }).model;
    expect(opened.overlay.stack[0].items.find((item) => item.value?.type === "themes").value.themes.sort()).toEqual(["default", ...names].sort());
    const workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
    const packets = [];
    try {
      await workspace.open({ readyState: WebSocket.OPEN, send: (data) => packets.push(JSON.parse(data)) });
      expect(packets.find((item) => item.type === "settings").prefs.themes.sort()).toEqual(["dark", "light", ...names].sort());
      const css = workspace.themeCss();
      for (const name of names) {
        expect(css).toContain(`:root[data-theme="${name}"][data-mode="dark"]`);
        expect(css).toContain(`--accent:${expected[name].dark.accent.fg}`);
        expect(css).toContain(`--page:${expected[name].light.background.bg}`);
      }
    } finally { workspace.stop(); app.dispose(); agent.close(); }
    for (const [file, text] of bytes) expect(await readFile(join("themes", file), "utf8")).toBe(text);
  } finally { env.close(); await rm(root, { recursive: true, force: true }); }
});
