import { expect, test } from "bun:test";
import { SettingsStore } from "../lib/env/settings-store.js";
import { settingsStoreView } from "../lib/env/store-view.js";

test("store view keeps nested proxy identity and sees shared updates", async () => {
  const store = new SettingsStore();
  const shared = store.attach({ data: { providers: { ep: { disabled: true } } }, catchAll: true });
  store.attach({});
  try {
    const view = settingsStoreView(store);
    const provider = view.providers.ep;
    expect(provider.disabled).toBe(true);
    shared.assign(["providers", "ep", "disabled"], false);
    expect(provider.disabled).toBe(false);
    expect(view.providers.ep).toBe(provider);
    provider.maxActive = 3;
    expect(store.read(["providers", "ep", "maxActive"])).toBe(3);
    expect(Object.keys(view.providers.ep)).toContain("maxActive");
  } finally { await store.close(); }
});

test("view delegates authorized writes to caller and rejects unsafe keys", async () => {
  const store = new SettingsStore({ sources: [{ catchAll: true }] });
  try {
    const updates = [];
    const view = settingsStoreView(store, { write: (path, value) => { updates.push([path, value]); } });
    view.preference = false;
    delete view.preference;
    expect(updates).toEqual([[ ["preference"], false ], [ ["preference"], undefined ]]);
    expect(() => { view.__proto__ = {}; }).toThrow(TypeError);
    expect(() => { delete view.constructor; }).toThrow(TypeError);
  } finally { await store.close(); }
});
