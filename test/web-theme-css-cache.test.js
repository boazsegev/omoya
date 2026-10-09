import { expect, test } from "bun:test";
import Env from "../lib/env.js";
import { createWorkspace } from "../lib/app/web/workspace.js";
import { serve } from "../lib/app/web/server.js";
import { testEnv } from "./fakes.js";

function fixture(themes) {
  const listeners = new Map();
  const settings = { themes, web: {} };
  const env = {
    folder: "project", name: "project", settings,
    tools: async () => new Map(), agents: () => [],
    onEvent(event, callback) { const callbacks = listeners.get(event) ?? new Set(); callbacks.add(callback); listeners.set(event, callbacks); return { event, callback }; },
    offEvent({ event, callback }) { listeners.get(event)?.delete(callback); },
  };
  return { env, settings, emit: (event) => { for (const callback of listeners.get(event) ?? []) callback({}); } };
}

test("theme CSS is rendered eagerly once, reused across requests, and refreshed only for changed themes", async () => {
  let reads = 0;
  const theme = { text: { get fg() { reads++; return "#123456"; } } };
  const { env, settings, emit } = fixture({ ember: theme });
  const workspace = await createWorkspace({}, { env }, null);
  try {
    expect(reads).toBeGreaterThan(1); // snapshot and initial CSS render before any request
    const initialReads = reads;
    const initial = workspace.themeCss();
    expect(initial).toContain("#123456");
    for (let i = 0; i < 20; i++) expect(workspace.themeCss()).toBe(initial);
    expect(reads).toBe(initialReads);
    settings.web.theme = "dark";
    emit(Env.EVENT.SETTINGS_CHANGED);
    expect(workspace.themeCss()).toBe(initial);
    expect(reads).toBe(initialReads + 1); // comparison only, no CSS render
    const afterUnrelated = reads;
    emit(Env.EVENT.SETTINGS_LOADED);
    expect(workspace.themeCss()).toBe(initial);
    expect(reads).toBe(afterUnrelated + 1); // equal load does not render
    settings.themes = { ember: { text: { fg: "#abcdef" } } };
    emit(Env.EVENT.SETTINGS_CHANGED);
    expect(workspace.themeCss()).toContain("#abcdef");
    expect(workspace.themeCss()).not.toContain("#123456");
    settings.themes = {};
    emit(Env.EVENT.SETTINGS_CHANGED);
    expect(workspace.themeCss()).toBe("");
  } finally { workspace.stop(); }
});

test("separate workspaces keep theme CSS isolated", async () => {
  const first = fixture({ a: { text: { fg: "#111111" } } });
  const second = fixture({ b: { text: { fg: "#222222" } } });
  const a = await createWorkspace({}, { env: first.env }, null);
  const b = await createWorkspace({}, { env: second.env }, null);
  try {
    expect(a.themeCss()).toContain("#111111");
    expect(b.themeCss()).toContain("#222222");
    first.settings.themes = { a: { text: { fg: "#333333" } } };
    first.emit(Env.EVENT.SETTINGS_CHANGED);
    expect(a.themeCss()).toContain("#333333");
    expect(b.themeCss()).toContain("#222222");
  } finally { a.stop(); b.stop(); }
});

test("the served stylesheet reflects settings changes", async () => {
  const env = await testEnv();
  env.settings.themes = { ember: { text: { fg: "#123456" } } };
  const web = await serve({ port: 0, env, session: { kind: "anonymous" } });
  try {
    const url = `http://127.0.0.1:${web.port}/themes.css`;
    const css = async () => (await fetch(url)).text();
    expect(await css()).toContain("#123456");
    env.settings.themes = { ember: { text: { fg: "#abcdef" } } };
    const deadline = Date.now() + 4000;
    while (!(await css()).includes("#abcdef") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await css()).toContain("#abcdef");
    expect(await css()).not.toContain("#123456");
  } finally { await web.stop(); }
});
