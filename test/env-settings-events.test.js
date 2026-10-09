import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import Env from "../lib/env.js";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
async function fixture(data) {
  const root = await mkdtemp("ai-tmp/settings-events-"); roots.push(root);
  const filename = `${root}/settings.json`;
  await writeFile(filename, JSON.stringify(data));
  return { root, filename };
}

test("Env exposes separate fresh-file completion events and unchanged defaults do not write", async () => {
  const { root } = await fixture({ web: { theme: "dark" } });
  const env = await Env.open(`${root}/project`, { dir: root, settingsDir: root });
  try {
    await env.ready(); await tick();
    expect(typeof Env.EVENT.SETTINGS_LOADED).toBe("symbol");
    const events = [];
    env.onEvent(Env.EVENT.SETTINGS_CHANGED, () => events.push("update"));
    env.onEvent(Env.EVENT.SETTINGS_LOADED, () => events.push("load"));
    const before = env.settings.web.autocomplete;
    env.settings.web.autocomplete = before;
    env.settings.web.theme = "dark";
    await env.settingsFlush(); await tick();
    expect(events).toEqual([]);
    env.settings.web.theme = "light";
    await env.settingsFlush(); await tick();
    expect(events).toEqual(["update"]);
    events.length = 0;
    await writeFile(`${root}/options.json`, '{ "fresh": true }');
    await env._sourceGraph.store.poll(); await tick();
    expect(env.settings.fresh).toBe(true);
    expect(events).toContain("load");
    events.length = 0;
    await env._sourceGraph.store.poll(); await tick();
    expect(events).toEqual([]);
  } finally { await env.close(); }
});
