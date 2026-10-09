import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sourceGraphCreate } from "../lib/env/source-graph.js";
import Env from "../lib/env.js";
import { extensionRoots } from "../lib/env/extensions.js";
import { refreshEndpointSettings } from "../lib/env/endpoints.js";

describe("asynchronous Env startup", () => {
  it("makes explicit memory settings available before disk discovery, then loads extension settings and models", async () => {
    const root = await mkdtemp("./ai-tmp/env-async-");
    const ext = join(root, "node_modules", "async-extension");
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, "package.json"), JSON.stringify({ name: "async-extension" }));
    await writeFile(join(ext, "options.json"), JSON.stringify({ extensionMarker: "loaded" }));
    const env = await Env.open(root, { dir: root, settingsDir: root, settings: {
      extensions: { "async-extension": true }, providers: { local: { provider: "openai", url: "https://example.test" } },
    } });
    try {
      expect(env.settings.extensionMarker).toBe("loaded");
      expect(env.settings.providers.local.url).toBe("https://example.test");
      await env.ready();
      expect(env.settings.extensionMarker).toBe("loaded");
      expect(env.models()).toBeInstanceOf(Map);
      expect(await extensionRoots({ "async-extension": true }, { dir: root })).toEqual([resolve(ext)]);
    } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("a write before the settings file loads is never saved over it; the load merges it over the file", async () => {
    const root = await mkdtemp("./ai-tmp/env-early-");
    const user = join(root, "user");
    await mkdir(user);
    await writeFile(join(user, "settings.json"), JSON.stringify({ diskMarker: "kept" }));
    const env = await Env.open(root, { dir: root, settingsDir: user });
    try {
      env.settings.memoryMarker = "early"; // before the file has loaded
      expect(env.settings.memoryMarker).toBe("early");
      await env.ready();
      await env.settingsFlush();
      expect(env.settings.diskMarker).toBe("kept");
      expect(JSON.parse(await readFile(join(user, "settings.json"), "utf8"))).toEqual({ diskMarker: "kept", memoryMarker: "early" });
    } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("returns fully loaded settings; subsequent writes still emit updates", async () => {
    const root = await mkdtemp("./ai-tmp/env-auto-");
    await writeFile(join(root, "settings.json"), JSON.stringify({ marker: "disk" }));
    const env = await Env.open(root, { dir: root, settingsDir: root });
    try {
      expect(env.settings.marker).toBe("disk");
      const updated = new Promise((resolveEvent) => env.onEvent(Env.EVENT.SETTINGS_CHANGED, resolveEvent));
      env.settings.marker = "changed";
      await updated;
      expect(env.settings.marker).toBe("changed");
    } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("coalesces async settings notifications without losing model notifications", async () => {
    const root = await mkdtemp("./ai-tmp/env-events-");
    const env = await Env.open(root, { dir: root, settingsDir: null });
    try {
      await env.ready();
      const settings = [];
      const models = [];
      env.onEvent(Env.EVENT.SETTINGS_CHANGED, () => settings.push(true));
      env.onEvent(Env.EVENT.MODELS_CHANGED, () => models.push(true));
      env.settings.maxActive = 3;
      env.settings.maxActive = 4;
      expect(settings).toHaveLength(0);
      await new Promise((resolveTick) => setTimeout(resolveTick, 30)); // one debounced storage round
      expect(settings).toHaveLength(1);
      expect(models).toHaveLength(1);
    } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("awaits explicit endpoint reload before returning its auth snapshot", async () => {
    const root = await mkdtemp("./ai-tmp/env-reload-");
    const env = await Env.open(root, { dir: root, settingsDir: root });
    try {
      await env.ready();
      const result = await refreshEndpointSettings(env, "missing");
      expect(result).toBeUndefined();
    } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
  });
});
