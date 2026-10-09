import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import Env from "../lib/env.js";
import { createWorkspace } from "../lib/app/web/workspace.js";
import { serve } from "../lib/app/web/server.js";
import { session } from "../lib/app/web/public/app/orchestrators/session.js";

function context() {
  const invalidations = [];
  return { state: { settings: {}, envSettings: {}, prefs: {}, blocks: [] }, invalidations, invalidate: (name) => invalidations.push(name) };
}

test("settings packets retain unknown readouts and replace complete Env and preference snapshots", () => {
  const ctx = context();
  const first = { type: "settings", settings: { plugin: { enabled: false, count: 0, label: "", value: null, list: [1, 2] } }, prefs: { collapse: { tools: true }, future: { enabled: true } }, pluginReadout: { status: "ready" } };
  session.packets.settings(ctx, first);
  expect(ctx.state.envSettings).toEqual(first.settings);
  expect(ctx.state.settings.pluginReadout).toEqual(first.pluginReadout);
  expect(ctx.state.settings).not.toHaveProperty("type");
  expect(ctx.state.prefs.future).toEqual({ enabled: true });
  session.packets.settings(ctx, { type: "settings", settings: { later: false }, prefs: { collapse: { tools: false } } });
  expect(ctx.state.envSettings).toEqual({ later: false });
  expect(ctx.state.settings).not.toHaveProperty("pluginReadout");
  expect(ctx.state.prefs).not.toHaveProperty("future");
});

test("display settings changes refresh existing transcript cards without resetting the conversation", () => {
  const ctx = context();
  ctx.state.prefs = { theme: "system", collapse: { thinking: true, tools: true }, previewRows: { default: { thinking: 8 } } };
  ctx.state.blocks.push({ kind: "thinking", open: false }, { kind: "tool", open: true });
  const blocks = ctx.state.blocks;
  session.packets.settings(ctx, { settings: {}, prefs: { ...ctx.state.prefs, collapse: { thinking: false, tools: true }, previewRows: { default: { thinking: 2 } } } });
  expect(ctx.invalidations).toContain("transcript");
  expect(ctx.state.fullRender).toBe(true);
  expect(ctx.state.resetTranscript).not.toBe(true);
  expect(ctx.state.blocks).toBe(blocks);
  expect(blocks[0].open).toBe(true);
  expect(blocks[1].open).toBe(true); // an unchanged default preserves local choice
});

test("workspace syncs every public Env and web key on initial, changed, loaded and removed settings", async () => {
  const root = await mkdtemp("./ai-tmp/web-settings-sync-");
  const env = await Env.open(root, { dir: root, settingsDir: null, settings: {
    plugin: { enabled: false, count: 0, label: "", value: null, list: [1, 2] },
    web: { future: { nested: "first" } },
    providers: { private: { auth: { token: "server-only" } } },
  } });
  await env.ready();
  const workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
  const packets = [];
  const ws = { readyState: WebSocket.OPEN, send: (data) => packets.push(JSON.parse(data)) };
  const latest = () => packets.findLast((packet) => packet.type === "settings");
  try {
    await workspace.open(ws);
    expect(latest().settings?.plugin).toEqual({ enabled: false, count: 0, label: "", value: null, list: [1, 2] });
    expect(latest().settings.sessions).toBe(env.settings.sessions);
    expect(latest().prefs.future).toEqual({ nested: "first" });
    expect(JSON.stringify(latest())).not.toContain("server-only");
    packets.length = 0;
    const changed = new Promise((resolve) => {
      const handle = env.onEvent(Env.EVENT.SETTINGS_CHANGED, () => { env.offEvent(handle); resolve(); });
    });
    env.settings.plugin = { newer: true };
    env.settings.web.future = { nested: "second" };
    env.settings.added = { array: [false, 0, "", null] };
    await changed;
    expect(latest().settings.plugin).toEqual({ newer: true });
    expect(latest().settings.added).toEqual({ array: [false, 0, "", null] });
    expect(latest().prefs.future).toEqual({ nested: "second" });
    await writeFile(join(root, "extra.json"), JSON.stringify({ loadedPlugin: { ready: true } }));
    await env._sourceGraph.store.poll();
    expect(latest().settings.loadedPlugin).toEqual({ ready: true });
    await rm(join(root, "extra.json"));
    await env._sourceGraph.store.poll();
    expect(latest().settings).not.toHaveProperty("loadedPlugin");
  } finally { workspace.stop(); await env.close(); await rm(root, { recursive: true, force: true }); }
});

test("normal Env acquisition discovers package and project themes without application-specific options", async () => {
  const root = await mkdtemp("./ai-tmp/default-theme-discovery-");
  await mkdir(join(root, "ai-themes"));
  await writeFile(join(root, "ai-themes", "local.json"), JSON.stringify({ local: { accent: { fg: "#123456" } } }));
  const env = await Env.open(root);
  try {
    expect(env.settings.themes.local?.accent.fg).toBe("#123456");
    expect(Object.keys(env.settings.themes).length).toBeGreaterThan(1);
    expect(env.settings.local).toBeUndefined();
    const web = await serve({ port: 0, env, session: { kind: "anonymous" } });
    try {
      expect(web.env).toBe(env); // canonical shared acquisition is not replaced
      const css = await (await fetch(`http://127.0.0.1:${web.port}/themes.css`)).text();
      expect(css).toContain(':root[data-theme="local"]');
    } finally { await web.stop(); }
  } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
});

test("explicit themes false still opts out of file discovery", async () => {
  const root = await mkdtemp("./ai-tmp/no-theme-discovery-");
  const env = await Env.open(root, { themes: false, init: { providers: false, tools: false, detect: false, models: false } });
  try { expect(Object.keys(env.settings.themes)).toEqual([]); }
  finally { await env.close(); await rm(root, { recursive: true, force: true }); }
});

test("browser plugins observe synchronized snapshots, deletions and loads without mutating app settings", async () => {
  const originals = new Map(["navigator", "matchMedia"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "", userAgent: "" } });
  globalThis.matchMedia = () => ({ matches: false });
  let unsubscribe;
  let unsubscribeBroken;
  const originalError = console.error;
  try {
    const { state } = await import("../lib/app/web/public/app/state.js");
    const { settingsRead, settingsSubscribe, settingsChanged } = await import("../lib/app/web/public/app/settings-service.js");
    const previous = { envSettings: state.envSettings, settings: state.settings, prefs: state.prefs, fullRender: state.fullRender };
    const observed = [];
    try {
      state.envSettings = {};
      unsubscribe = settingsSubscribe((settings) => { observed.push(settings); settings.touched = true; });
      let failures = 0;
      console.error = () => { failures++; };
      unsubscribeBroken = settingsSubscribe(() => { throw new Error("plugin failed"); });
      const ctx = { state, invalidate() {}, settingsChanged };
      session.packets.settings(ctx, { type: "settings", settings: { plugin: { value: false } }, prefs: state.prefs });
      expect(observed.at(-1).plugin.value).toBe(false);
      expect(settingsRead()).toEqual({ plugin: { value: false } });
      const detached = settingsRead();
      detached.plugin.value = true;
      expect(settingsRead().plugin.value).toBe(false);
      session.packets.settings(ctx, { type: "settings", settings: {}, prefs: state.prefs });
      expect(observed.at(-1)).not.toHaveProperty("plugin");
      const count = observed.length;
      session.packets.settings(ctx, { type: "settings", settings: {}, prefs: state.prefs });
      expect(observed).toHaveLength(count);
      expect(failures).toBeGreaterThan(1);
      unsubscribe(); unsubscribe();
      settingsChanged();
      expect(observed).toHaveLength(count);
      expect(() => settingsSubscribe(null)).toThrow(TypeError);
    } finally { Object.assign(state, previous); }
  } finally {
    unsubscribe?.(); unsubscribeBroken?.(); console.error = originalError;
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test("autocomplete settings invalidate existing suggestions without changing the draft", () => {
  const ctx = context();
  ctx.state.prefs = { autocomplete: true };
  ctx.state.composerFill = undefined;
  session.packets.settings(ctx, { settings: {}, prefs: { autocomplete: false } });
  expect(ctx.invalidations).toContain("autocomplete");
  expect(ctx.state.composerFill).toBeUndefined();
});

test("equal settings packets are no-ops and plugin-only changes do not dirty UI regions", () => {
  const ctx = context();
  let notices = 0;
  ctx.settingsChanged = () => { notices++; };
  const packet = { type: "settings", settings: { plugin: { enabled: true } }, prefs: { theme: "dark", autocomplete: true, collapse: { tools: true } } };
  session.packets.settings(ctx, packet);
  ctx.invalidations.length = 0;
  const before = { env: ctx.state.envSettings, settings: ctx.state.settings, prefs: ctx.state.prefs };
  session.packets.settings(ctx, structuredClone(packet));
  expect(ctx.invalidations).toEqual([]);
  expect(notices).toBe(1);
  expect(ctx.state.envSettings).toBe(before.env);
  expect(ctx.state.settings).toBe(before.settings);
  expect(ctx.state.prefs).toBe(before.prefs);
  session.packets.settings(ctx, { ...packet, settings: { plugin: { enabled: false } } });
  expect(notices).toBe(2);
  expect(ctx.invalidations).toEqual([]);
  session.packets.settings(ctx, { ...packet, prefs: { ...packet.prefs, pluginPreference: false }, settings: { plugin: { enabled: false } }, pluginReadout: { status: "ready" } });
  expect(ctx.invalidations).not.toContain("header");
  expect(ctx.invalidations).not.toContain("composer");
});

test("switching project stylesheet sources invalidates CSS even at the same local revision", () => {
  const ctx = context();
  ctx.state.prefs = { theme: "dark", themes: [], themeStylesVersion: 0, themeStylesUrl: "/first/themes.css" };
  session.packets.settings(ctx, { settings: {}, prefs: { ...ctx.state.prefs, themeStylesUrl: "/second/themes.css" } });
  expect(ctx.invalidations).toContain("themeStyles");
});
