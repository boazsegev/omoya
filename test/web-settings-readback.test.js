import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Env from "../lib/env.js";
import "../lib/agent.js";
import { serve } from "../lib/app/web/server.js";
import { createWorkspace } from "../lib/app/web/workspace.js";

class ReadbackProvider {
  static provider = { label: "Readback", capabilities: {} };
  static login({ token }) { return { type: "api_key", token }; }
  static async testConnection() { return { models: 1 }; }
  static async models() { return { "acme-pro": {}, "acme-mini": {} }; }
}

async function readbackEnv() {
  const root = mkdtempSync("ai-tmp/web-settings-readback-");
  const env = await Env.open(root, { dir: root, settingsDir: root, providers: { readback: ReadbackProvider }, settings: {
    providers: { acme: { provider: "readback", url: "https://acme.invalid", models: { "acme-pro": {}, "acme-mini": {} } } },
  } });
  await env.ready();
  return env;
}

/** Event-driven wire readback: no timing assumptions about server dispatch. */
async function connect(web) {
  const packets = [];
  const waiters = new Set();
  const socket = new WebSocket(`ws://127.0.0.1:${web.port}/ws`, { headers: { Origin: `http://127.0.0.1:${web.port}` } });
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    packets.push(packet);
    for (const waiter of waiters) waiter(packet);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let cursor = 0;
  const next = (predicate) => {
    const index = packets.findIndex((packet, index) => index >= cursor && predicate(packet));
    if (index !== -1) { cursor = index + 1; return Promise.resolve(packets[index]); }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(listener); reject(new Error("missing readback packet")); }, 3000);
      const listener = (packet) => {
        if (packet.type === "error") { clearTimeout(timeout); waiters.delete(listener); reject(new Error(packet.message)); }
        else if (predicate(packet)) { clearTimeout(timeout); waiters.delete(listener); cursor = packets.length; resolve(packet); }
      };
      waiters.add(listener);
    });
  };
  return { socket, next };
}

test("group membership preserves live pin metadata and is available to routes and flushed persistence", async () => {
  const env = await readbackEnv();
  const web = await serve({ port: 0, env, session: { kind: "anonymous" } });
  let socket;
  try {
    const wire = await connect(web);
    socket = wire.socket;
    await wire.next((packet) => packet.type === "hello");
    for (const group of ["ruby", "c"]) {
      socket.send(JSON.stringify({ type: "project.group", path: env.folder, group, member: true }));
      const packet = await wire.next((packet) => packet.type === "projects" && packet.projects[0].groups.includes(group));
      expect(packet.projects[0].pinned).toBe(true);
    }
    const response = await fetch(`http://127.0.0.1:${web.port}/group:ruby`, { redirect: "manual" });
    expect(response.headers.get("location")).toBe("/group:ruby/");
    await Env.settingsFlush();
    const pin = Env.settings.projects[env.folder].toJSON();
    expect(pin.groups).toEqual({ ruby: true, c: true });
    expect(Object.keys(pin.models)).toHaveLength(1);
    for (const group of ["ruby", "c"]) {
      socket.send(JSON.stringify({ type: "project.group", path: env.folder, group, member: false }));
      await wire.next((packet) => packet.type === "projects" && !packet.projects[0].groups.includes(group));
    }
    await Env.settingsFlush();
    const remaining = Env.settings.projects[env.folder].toJSON();
    expect(remaining.groups).toBeUndefined();
    expect(remaining.models).toEqual(pin.models);
  } finally { socket?.close(); await web.stop(); await env.close(); delete Env.settings.projects[env.folder]; await Env.settingsFlush(); }
});

test("catalog changes refresh endpoint policy packets as well as settings for connected viewers", async () => {
  const env = await readbackEnv();
  const workspace = await createWorkspace({}, { env, options: {} });
  const packets = [];
  const ws = { readyState: WebSocket.OPEN, data: { local: true }, send: (data) => packets.push(JSON.parse(data)) };
  try {
    await workspace.open(ws);
    const before = packets.length;
    const changed = new Promise((resolve) => {
      const handle = env.onEvent(Env.EVENT.MODELS_CHANGED, () => { env.offEvent(handle); resolve(); });
    });
    env.settings.providers.acme.disabled = true;
    await changed;
    const endpoints = packets.slice(before).findLast((packet) => packet.type === "endpoints");
    expect(endpoints?.policies.find((entry) => entry.name === "acme")?.disabled).toBe(true);
    expect(endpoints.endpoints.map((entry) => entry.name)).not.toContain("acme");
  } finally { workspace.stop(); await env.settingsFlush(); env.close(); }
});

test("a socket open pending its session listing stops without reading a closed environment", async () => {
  const env = await readbackEnv();
  const workspace = await createWorkspace({}, { env, options: {} });
  const packets = [];
  const ws = { readyState: WebSocket.OPEN, data: { local: true }, send: (data) => packets.push(JSON.parse(data)) };
  const opening = workspace.open(ws);
  workspace.stop();
  env.close();
  const count = packets.length;
  await opening;
  expect(packets).toHaveLength(count);
  expect(workspace.viewers()).toEqual([]);
});

test("a deferred host session factory cannot reattach a socket after its workspace stops", async () => {
  const env = await readbackEnv();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const workspace = await createWorkspace({ createSession: () => pending }, { env, options: {} });
  const ws = { readyState: WebSocket.OPEN, data: { local: true }, send: () => { throw new Error("stopped socket received a packet"); } };
  const opening = workspace.open(ws);
  workspace.stop();
  env.close();
  let closed = 0;
  release({ agent: { close() { closed++; } } });
  await opening;
  expect(closed).toBe(1);
  expect(workspace.viewers()).toEqual([]);
});

test("a public non-secret login fixture supplies concrete model choices in the initial settings packet", async () => {
  const env = await readbackEnv();
  await env.login("catalog", { provider: "readback", url: "https://catalog.invalid", token: "t" });
  await env.modelsReady;
  const workspace = await createWorkspace({}, { env, options: {} });
  const packets = [];
  const ws = { readyState: WebSocket.OPEN, data: { local: true }, send: (data) => packets.push(JSON.parse(data)) };
  try {
    await workspace.open(ws);
    expect(packets.find((packet) => packet.type === "settings").models).toEqual(["acme/acme-mini", "acme/acme-pro", "catalog/acme-mini", "catalog/acme-pro"]);
  } finally { workspace.stop(); await env.settingsFlush(); env.close(); }
});
