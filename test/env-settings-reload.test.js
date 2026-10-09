import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Env from "../lib/env.js";
import "../lib/agent.js";
import { authSet } from "../lib/env/auth.js";
import { sourceGraphCreate } from "../lib/env/source-graph.js";
import { detectEndpoints, endpointSettings } from "../lib/env/endpoints.js";

const environments = [];
const graphs = [];
const roots = [];
afterEach(async () => {
  const results = await Promise.allSettled(environments.splice(0).map((env) => env.close()));
  const graphResults = await Promise.allSettled(graphs.splice(0).map((graph) => graph.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  const errors = [...results, ...graphResults].filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Settings reload owners failed to close");
});

async function fixture({ models } = {}) {
  const root = await mkdtemp("ai-tmp/settings-reload-");
  roots.push(root);
  const [dir, settingsDir, cwd] = ["system", "user", "project"].map((name) => join(root, name));
  await Promise.all([dir, settingsDir, cwd].map((folder) => mkdir(folder)));
  const filename = join(settingsDir, "settings.json");
  await writeFile(filename, JSON.stringify({ untouched: true }));
  const state = { token: "first", url: "https://api.example.test", models, detections: 0 };
  class Protocol {
    static provider = {};
    static async detect() {
      state.detections++;
      return state.token ? { ephemeral: { provider: "probe", url: state.url, dynamic: true,
        auth: { token: state.token }, ...(state.models ? { models: state.models } : {}) } } : {};
    }
  }
  const env = await Env.open(cwd, { dir, settingsDir, providers: { probe: Protocol }, init: { providers: false, tools: false, detect: false, models: false } });
  environments.push(env);
  await env.ready();
  await detectEndpoints(env);
  return { env, graph: env._sourceGraph, filename, state, settingsDir };
}

const modelPath = ["providers", "ephemeral", "models", "m", "maxActive"];

test("model policy edits on a detected endpoint persist as user preferences and survive polling and detection", async () => {
  const { env, graph, filename, state } = await fixture({ models: { m: { maxActive: 4, contextWindow: 8192 } } });
  env.settings.providers.ephemeral.models.m.maxActive = 1;
  expect(env.models(true).get("ephemeral/m").maxActive).toBe(1);
  await graph.flush();
  expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({ untouched: true, providers: { ephemeral: { models: { m: { maxActive: 1 } } } } });
  expect(graph.detectionGet("ephemeral").models.m.maxActive).toBe(4); // detected facts stay as detected
  expect(await graph.store.poll()).toBe(false); // unchanged files change nothing
  expect(await detectEndpoints(env)).toEqual([]);
  expect(state.detections).toBe(2);
  expect(graph.store.read(modelPath)).toBe(1);
  expect(env.models(true).get("ephemeral/m").maxActive).toBe(1);
});

test("a learned catalog survives repeated detection and credential rotation", async () => {
  const { env, graph, filename, state } = await fixture(); // the detector publishes no model list
  authSet(env, "ephemeral", { models: { m: { maxActive: 4, contextWindow: 8192 } } });
  const connection = env.connection("ephemeral/m", { remember: false });
  await graph.store.poll();
  await detectEndpoints(env);
  expect(connection.settings.models.m).toMatchObject({ maxActive: 4, contextWindow: 8192 });
  state.token = "rotated";
  await detectEndpoints(env);
  expect((await connection.authReload({ token: "first" })).auth.token).toBe("rotated");
  expect(env.models(true).get("ephemeral/m").maxActive).toBe(4);
  expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({ untouched: true }); // detection writes no file
});

test("changed detector metadata keeps user preferences but removes obsolete catalog entries", async () => {
  const { env, graph, state } = await fixture({ models: {
    m: { maxActive: 4, contextWindow: 8192, plugin: { limit: 2 } }, obsolete: { contextWindow: 1024 },
  } });
  env.settings.providers.ephemeral.models.m.maxActive = 1;
  state.models = { m: { maxActive: 4, contextWindow: 32768, plugin: { limit: 2 } }, added: { contextWindow: 2048 } };
  await detectEndpoints(env);
  expect(endpointSettings(env, "ephemeral").models).toEqual({
    m: { maxActive: 1, contextWindow: 32768, plugin: { limit: 2 } }, added: { contextWindow: 2048 },
  });
  const facts = graph.detectionGet("ephemeral");
  await detectEndpoints(env);
  expect(graph.detectionGet("ephemeral")).toEqual(facts);
});

test("public absent model policy leaves persist instead of being rejected as detected facts", async () => {
  const { env, graph, filename } = await fixture({ models: { m: { contextWindow: 8192 } } });
  env.settings.providers.ephemeral.models.m.maxActive = 2;
  await graph.flush();
  expect(JSON.parse(await readFile(filename, "utf8")).providers.ephemeral.models.m.maxActive).toBe(2);
  await detectEndpoints(env);
  expect(env.models(true).get("ephemeral/m").maxActive).toBe(2);
});

test("a changed settings file reloads without touching detected facts, and detection never writes an auth file", async () => {
  const { env, graph, filename, state, settingsDir } = await fixture({ models: { m: { contextWindow: 8192 } } });
  await writeFile(filename, JSON.stringify({ external: true, providers: { ephemeral: { models: { m: { maxActive: 3 } } } } }));
  await graph.endpointReload("ephemeral");
  expect(env.settings.external).toBe(true);
  expect(env.settings.untouched).toBeUndefined();
  expect(env.models(true).get("ephemeral/m")).toMatchObject({ maxActive: 3, caps: { contextWindow: 8192 } });
  state.token = "new-key";
  await detectEndpoints(env);
  expect(endpointSettings(env, "ephemeral").auth.token).toBe("new-key");
  expect(env.models(true).get("ephemeral/m")).toMatchObject({ maxActive: 3, caps: { contextWindow: 8192 } });
  expect(await readFile(join(settingsDir, "auth-ephemeral.json"), "utf8").catch((error) => error.code)).toBe("ENOENT");
});

test("a changed detector connection drops the old connection's learned model list", async () => {
  const { env, graph, state } = await fixture();
  authSet(env, "ephemeral", { models: { m: { maxActive: 4 } } });
  await detectEndpoints(env);
  expect(graph.detectionGet("ephemeral").models).toEqual({ m: { maxActive: 4 } });
  state.url = "https://other.example.test";
  state.token = "new-service";
  await detectEndpoints(env);
  expect(graph.detectionGet("ephemeral").models).toBeUndefined();
  expect(endpointSettings(env, "ephemeral")).toMatchObject({ url: state.url, auth: { token: "new-service" } });
});

test("settings trees over the same user folder share its files, including edits made before ready", async () => {
  const { env, settingsDir } = await fixture();
  const firstCwd = join(settingsDir, "first-project");
  const secondCwd = join(settingsDir, "second-project");
  await Promise.all([firstCwd, secondCwd].map((folder) => mkdir(folder)));
  const first = sourceGraphCreate({ dir: env._dir, settingsDir, cwd: firstCwd });
  const second = sourceGraphCreate({ dir: env._dir, settingsDir, cwd: secondCwd });
  graphs.push(first, second);
  first.store.write(["beforeReady"], "keep");
  expect(second.store.read(["beforeReady"])).toBe("keep");
  await Promise.all([first.ready(), second.ready()]);
  expect(second.store.read(["beforeReady"])).toBe("keep");
  expect(second.store.read(["untouched"])).toBe(true);
  second.store.write(["tui", "theme"], "shared");
  expect(first.store.read(["tui", "theme"])).toBe("shared");
  await second.flush();
  await first.close();
  expect(second.store.read(["tui", "theme"])).toBe("shared");
});

test("Envs over the same user folder share user settings after ready", async () => {
  const { env, settingsDir } = await fixture();
  const cwd = join(settingsDir, "peer-project");
  await mkdir(cwd);
  const peer = await Env.open(cwd, { dir: env._dir, settingsDir });
  environments.push(peer);
  await peer.ready();
  const heldView = env.settings.tui;
  peer.settings.tui.theme = "shared";
  expect(heldView.theme).toBe("shared");
  await peer.settingsFlush();
  expect(heldView.theme).toBe("shared");
});

test("a changed auth file rotates credentials, and close stops polling and drops detected facts", async () => {
  const { env, graph, state, settingsDir } = await fixture({ models: { m: { maxActive: 4 } } });
  const filename = join(settingsDir, "auth-static.json");
  await writeFile(filename, JSON.stringify({ static: { provider: "probe", url: "https://static", auth: { token: "old" }, models: { m: {} } } }));
  expect(await graph.store.poll()).toBe(true);
  expect(graph.authFile("static")).toBeDefined();
  const connection = env.connection("static/m", { remember: false });
  await writeFile(filename, JSON.stringify({ static: { provider: "probe", url: "https://static", auth: { token: "rotated" }, models: { m: {} } } }));
  expect((await connection.authReload({ token: "old" })).auth.token).toBe("rotated");
  state.token = "";
  await detectEndpoints(env);
  expect(graph.detectionGet("ephemeral")).toBeUndefined();
  await env.close();
  await env.close();
  expect(graph.store.closed).toBe(true);
  expect(env.closed).toBe(true);
});
