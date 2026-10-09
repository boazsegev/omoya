import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import "../lib/agent.js";
import { serve } from "../lib/app/web/server.js";
import { testEnv } from "./fakes.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("web startup serves only folder pin keys, never project name aliases", async () => {
  const env = await testEnv();
  const project = join(env.folder, "cstl");
  mkdirSync(project);
  await Env.ready();
  const diagnostics = [];
  let web;
  let socket;
  try {
    Env.settings.projects[project] = { description: "A pinned project" };
    web = await serve({ port: 0, env, session: { kind: "anonymous" },
      diagnostics: { write: (message) => diagnostics.push(message) },
      envOptions: { settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } } });
    const messages = [];
    socket = new WebSocket(`ws://127.0.0.1:${web.port}/ws`, {
      headers: { Origin: `http://127.0.0.1:${web.port}` },
    });
    socket.onmessage = (event) => messages.push(JSON.parse(event.data));
    const deadline = Date.now() + 4000;
    while (!messages.some((message) => message.type === "hello") && Date.now() < deadline) await tick();
    expect(messages.find((message) => message.type === "hello")?.projects.some((item) => item.path === project)).toBe(true);
    await env._sourceGraph.store.poll(); // a reload also scans global pin aliases
    await tick();
    expect(diagnostics.join(" ")).not.toContain("pinned project cstl not served");
  } finally {
    socket?.close();
    await web?.stop();
    delete Env.settings.projects[project];
    await Env.settingsFlush();
    await env.close();
  }
});
