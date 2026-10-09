import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import Env from "../lib/env.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Env announces a newly discovered batch only once with all data, then announces changed and equal file reloads", async () => {
  const root = await mkdtemp("./ai-tmp/env-load-discovery-");
  await mkdir(join(root, "themes"));
  const env = await Env.open(root, { dir: root, settingsDir: null, themes: true });
  try {
    await env.ready();
    await tick();
    const events = [];
    env.onEvent(Env.EVENT.SETTINGS_LOADED, () => events.push({
      names: Object.keys(env.settings.themes).sort(),
      data: env.settings.catalog?.toJSON(),
      color: env.settings.themes.first?.dark?.accent?.fg,
    }));
    const firstFile = join(root, "themes", "first.json");
    await writeFile(firstFile, JSON.stringify({ first: { dark: { accent: { fg: "#123456" } } } }));
    await writeFile(join(root, "themes", "second.json"), JSON.stringify({ second: { dark: { accent: { fg: "#abcdef" } } } }));
    const catalog = Object.fromEntries(Array.from({ length: 1500 }, (_, index) => [`item${index}`, { label: `Item ${index}` }]));
    await writeFile(join(root, "catalog.json"), JSON.stringify({ catalog }));
    expect(await env._sourceGraph.store.poll()).toBe(true);
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ names: ["first", "second"], data: catalog, color: "#123456" });
    events.length = 0;
    await writeFile(firstFile, JSON.stringify({ first: { dark: { accent: { fg: "#654321" } } } }));
    await env._sourceGraph.store.poll();
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0].color).toBe("#654321");
    events.length = 0;
    await writeFile(firstFile, '{ "first": { "dark": { "accent": { "fg": "#654321" } } } }'); // equal content, new bytes
    await env._sourceGraph.store.poll();
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0].names).toEqual(["first", "second"]);
    events.length = 0;
    await env._sourceGraph.store.poll();
    await env._sourceGraph.store.poll();
    await tick();
    expect(events).toEqual([]);
  } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
});

test("theme files load at themes only: user and project ai-themes, never the settings root", async () => {
  const root = await mkdtemp("./ai-tmp/env-theme-scopes-");
  const [pkg, user, project] = ["pkg", "user", "project"].map((name) => join(root, name));
  for (const folder of [join(pkg, "themes"), join(user, "themes"), join(project, "ai-themes")]) await mkdir(folder, { recursive: true });
  await writeFile(join(pkg, "themes", "base.json"), JSON.stringify({ base: { text: { fg: 1 } } }));
  await writeFile(join(user, "themes", "mine.json"), JSON.stringify({ mine: { text: { fg: 2 } }, base: { text: { fg: 3 } } }));
  await writeFile(join(project, "ai-themes", "local.json"), JSON.stringify({ local: { text: { fg: 4 } }, providers: { evil: { url: "x" } } }));
  const env = await Env.open(project, { dir: pkg, settingsDir: user, themes: true });
  try {
    await env.ready();
    expect(Object.keys(env.settings.themes).sort()).toEqual(["base", "local", "mine", "providers"]);
    expect(env.settings.themes.base.text.fg).toBe(3); // user over package
    expect(env.settings.providers.evil).toBeUndefined(); // a theme file cannot reach root settings
  } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
});
