import { expect, test } from "bun:test";
import { SettingsStore } from "../lib/env/settings-store.js";
import { settingsStoreView } from "../lib/env/store-view.js";
import { storeSettingsCreate } from "../lib/env/store-settings.js";

test("JSON serialization reads one plain snapshot rather than enumerating live leaves", async () => {
  const store = new SettingsStore({ sources: [{ data: { section: { first: 1, second: [2, 3] }, flag: false } }] });
  const paths = [];
  const view = settingsStoreView(store, { read(path) { paths.push(path); return store.read(path); } });
  try {
    expect(JSON.stringify(view)).toBe(JSON.stringify(store.read()));
    expect(paths).toEqual([["toJSON"], []]);
    paths.length = 0;
    const section = view.section;
    paths.length = 0;
    expect(JSON.stringify(section)).toBe(JSON.stringify(store.read(["section"])));
    expect(paths).toEqual([["section", "toJSON"], ["section"]]);
    expect(Object.keys(view)).not.toContain("toJSON");
    expect(Object.getOwnPropertyDescriptor(view, "toJSON")).toBeUndefined();
    expect("toJSON" in view).toBe(false);
    const detached = view.toJSON();
    detached.section.first = 99;
    expect(store.read(["section", "first"])).toBe(1);
  } finally { await store.close(); }
});

test("serializer snapshots are detached: changing one never changes settings", async () => {
  const providers = {};
  for (let index = 0; index < 6000; index++) providers[`ep${index}`] = { url: `u${index}` };
  const store = new SettingsStore({ sources: [{ data: { providers } }] });
  const view = settingsStoreView(store);
  try {
    const snapshot = view.toJSON();
    snapshot.providers.ep0.url = "bypass";
    expect(store.read(["providers", "ep0", "url"])).toBe("u0");
    expect(JSON.parse(JSON.stringify(view)).providers.ep5999.url).toBe("u5999");
  } finally { await store.close(); }
});

test("an explicitly stored toJSON setting remains an ordinary published value", async () => {
  const store = new SettingsStore({ sources: [{ data: { toJSON: "custom", section: { toJSON: false, value: 1 } } }] });
  const view = settingsStoreView(store);
  try {
      expect(view.toJSON).toBe("custom");
    expect(view.section.toJSON).toBe(false);
    expect(JSON.parse(JSON.stringify(view))).toEqual({ toJSON: "custom", section: { toJSON: false, value: 1 } });
    expect(Object.keys(view)).toContain("toJSON");
    expect(Object.getOwnPropertyDescriptor(view, "toJSON").enumerable).toBe(true);
  } finally { await store.close(); }
});

test("the Env defaults adapter serializer publishes defaults and no virtual hook key", async () => {
  const store = new SettingsStore({ sources: [{ data: { theme: "night", custom: { flag: true } } }] });
  const env = { cwd: ".", _settingsDir: "ai-tmp" };
  const adapter = storeSettingsCreate(env, store, { globalOnly: true });
  const view = settingsStoreView(store, { read: adapter.read, write: adapter.write });
  try {
      const json = JSON.parse(JSON.stringify(view));
    expect(json.tui.theme).toBe("night");
    expect(json.tools.timeout).toBe(120000);
    expect(json.custom.flag).toBe(true);
    expect(json).not.toHaveProperty("toJSON");
  } finally { adapter.close(); await store.close(); }
});
