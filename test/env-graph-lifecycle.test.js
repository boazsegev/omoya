import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";

const roots = [];
function fixture() {
  const root = mkdtempSync("ai-tmp/env-graph-lifecycle-");
  roots.push(root);
  const host = join(root, "host");
  const user = join(root, "user");
  const project = join(root, "project");
  const other = join(root, "other");
  for (const dir of [host, user, project, other]) mkdirSync(dir);
  return { host, user, project, other };
}
afterEach(async () => {
  await Promise.all(Object.values(Env.envs).filter((env) => roots.some((root) => env.folder.startsWith(`${resolve(root)}/`))).map((env) => env.close()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("Env exposes authorized live settings and shared user changes without leaking project settings", async () => {
  const { host, user, project, other } = fixture();
  const first = await Env.open(project, { dir: host, settingsDir: user });
  const second = await Env.open(other, { dir: host, settingsDir: user });
  try {
    await Promise.all([first.ready(), second.ready()]);
    const nested = first.settings.tui;
    second.settings.tui.theme = "shared";
    expect(nested).toBe(first.settings.tui);
    expect(nested.theme).toBe("shared");
    first.settings.projectOnly = "one";
    expect(second.settings.projectOnly).toBe("one");
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ onlyHere: "local" }));
    await first._sourceGraph.store.poll();
    expect(first.settings.onlyHere).toBe("local");
    expect(second.settings.onlyHere).toBeUndefined();
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("Env settings changes invalidate model snapshots and notify once after coalescing", async () => {
  const { host, user, project } = fixture();
  const env = await Env.open(project, { dir: host, settingsDir: user, settings: { providers: { ep: { provider: "openai", url: "https://example.test", models: { first: {} } } } } });
  try {
    await env.ready();
    const before = env.models();
    const observed = [];
    const changed = new Promise((resolveChanged) => {
      env.onEvent(Env.EVENT.MODELS_CHANGED, () => { observed.push(true); resolveChanged(); });
    });
    env.settings.providers.ep.models.second = {};
    env.settings.providers.ep.models.third = {};
    await changed;
    expect([...before.keys()]).toEqual(["ep/first"]);
    expect([...env.models().keys()].sort()).toEqual(["ep/first", "ep/second", "ep/third"]);
    expect(observed).toHaveLength(1);
  } finally { await env.close(); }
});

test("Env resolves project sessions, isolates project settings and releases graph on close", async () => {
  const { host, user, project, other } = fixture();
  writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ sessions: "logs", feature: "local" }));
  const first = await Env.open(project, { dir: host, settingsDir: user });
  const second = await Env.open(other, { dir: host, settingsDir: user });
  try {
    await Promise.all([first.ready(), second.ready()]);
    expect(first.settings.sessions).toBe(resolve(project, "logs"));
    expect(second.settings.feature).toBeUndefined();
    first.settings.feature = "updated";
    await first.settingsFlush();
    expect(JSON.parse(readFileSync(join(project, NAMES.projectSettings), "utf8")).feature).toBe("updated");
    await first.close();
    await first.close();
    expect(first.closed).toBe(true);
    expect(Env.envs[resolve(project)]).toBeUndefined();
    expect(first.settings.sessions).toBe(resolve(project, "logs"));
    expect(second.settings.sessions).toBeDefined();
    second.settings.feature = "shared";
    expect(second.settings.feature).toBe("shared");
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("failed async startup releases graph and leaves registry available", async () => {
  const { host, user, project } = fixture();
  writeFileSync(join(project, NAMES.projectSettings), "{ bad json");
  await expect(Env.open(project, { dir: host, settingsDir: user, init: { providers: false, tools: false } })).rejects.toThrow(SyntaxError);
  expect(Env.envs[resolve(project)]).toBeUndefined();
  rmSync(join(project, NAMES.projectSettings));
  const env = await Env.open(project, { dir: host, settingsDir: user });
  try { await env.ready(); expect(env.settings).toBeDefined(); } finally { await env.close(); }
});

test("auth-disabled Env never recovers credentials through its connection view", async () => {
  const { host, user, project } = fixture();
  writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { provider: "openai", url: "http://example.test", auth: { token: "secret" } } }));
  const env = await Env.open(project, { dir: host, settingsDir: user, auth: false });
  try {
    await env.ready();
    expect(env.connection("ep/model", { remember: false }).settings.auth).toBeUndefined();
  } finally { await env.close(); }
});
