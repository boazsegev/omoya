import { expect, test } from "bun:test";
import Agent from "../lib/agent.js";
import Env from "../lib/env.js";
import Sandbox from "../lib/sandbox.js";
import { createExitController } from "../lib/app/web/exit.js";

function fixture() {
  const timers = new Map();
  let next = 0;
  const clock = { setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; }, clearTimeout: (id) => timers.delete(id) };
  const exits = [];
  const proc = { exit: (code) => exits.push(code), abort: () => exits.push("abort"), stderr: { write: () => {} } };
  const listeners = new Map();
  const envListeners = new Map();
  const agent = { busy: false, onEvent: (event, callback) => { listeners.set(event, callback); return event; }, offEvent: (event) => listeners.delete(event), cancel: async () => {} };
  const env = { agents: () => [agent], onEvent: (event, callback) => { envListeners.set(event, callback); return event; }, offEvent: (event) => envListeners.delete(event), constructor: { EVENT: Env.EVENT } };
  agent.env = env;
  const registry = { entries: [{ env }] };
  let stopped = 0;
  const stop = async () => { stopped++; };
  const controller = createExitController(registry, { stop, clock, proc });
  controller.watchEnv(env);
  const fire = () => { const [id, { callback }] = timers.entries().next().value; timers.delete(id); callback(); };
  return { controller, clock, timers, agent, listeners, envListeners, exits, fire, registry, env, proc, get stopped() { return stopped; } };
}

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("an idle exit request stops immediately without scheduling a timer", async () => {
  const f = fixture();
  f.controller.request();
  await settle();
  expect(f.timers.size).toBe(0);
  expect(f.stopped).toBe(1);
  expect(f.exits).toEqual([0]);
});

test("a busy exit request cleanly exits after the timer if agents become idle", async () => {
  const f = fixture();
  f.agent.busy = true;
  f.controller.request();
  expect([...f.timers.values()][0].delay).toBe(60_000);
  f.agent.busy = false;
  f.fire();
  await settle();
  expect(f.exits).toEqual([0]);
  expect(f.stopped).toBe(1);
});

test("busy timeout waits for a terminal event and keeps one global timer", async () => {
  const f = fixture();
  f.agent.busy = true;
  f.controller.request();
  f.fire();
  expect(f.timers.size).toBe(0);
  expect(f.exits).toEqual([]);
  f.listeners.get(Agent.EVENT.REQUEST_DONE)();
  expect(f.timers.size).toBe(1);
  f.listeners.get(Agent.EVENT.REQUEST_ERROR)();
  expect(f.timers.size).toBe(1);
  f.agent.busy = false;
  f.fire();
  await settle();
  expect(f.exits).toEqual([0]);
});

test("a second exit request kills only Sandbox-owned processes before immediate abort", async () => {
  const f = fixture();
  const original = Sandbox.processesKill;
  Sandbox.processesKill = () => f.exits.push("owned kill");
  try {
    f.agent.busy = true;
    f.controller.request();
    f.controller.request();
    await settle();
    expect(f.exits).toEqual(["owned kill", "abort"]);
    expect(f.stopped).toBe(0);
  } finally { Sandbox.processesKill = original; }
});

test("all served projects must be idle at the single timer sample", async () => {
  const f = fixture();
  const other = { agents: () => [{ busy: true }] };
  f.registry.entries.push({ env: other });
  f.controller.request();
  f.fire();
  expect(f.exits).toEqual([]);
  expect(f.timers.size).toBe(0);
  other.agents = () => [{ busy: false }];
  f.listeners.get(Agent.EVENT.REQUEST_ERROR)();
  f.fire();
  await settle();
  expect(f.exits).toEqual([0]);
});

test("new agents are subscribed and removed agents release terminal callbacks", () => {
  const f = fixture();
  f.agent.busy = true;
  const childListeners = new Map();
  const child = { env: f.env, busy: false, onEvent: (event, callback) => { childListeners.set(event, callback); return event; }, offEvent: (event) => childListeners.delete(event) };
  f.envListeners.get(Env.EVENT.AGENT_ADDED)({ agent: child });
  expect(childListeners.has(Agent.EVENT.REQUEST_DONE)).toBe(true);
  f.controller.request();
  const initial = f.timers.keys().next().value;
  childListeners.get(Agent.EVENT.REQUEST_DONE)();
  expect(f.timers.keys().next().value).not.toBe(initial);
  f.envListeners.get(Env.EVENT.AGENT_REMOVED)({ agent: child });
  expect(childListeners.size).toBe(0);
  f.controller.dispose();
  expect(f.listeners.size).toBe(0);
  expect(f.envListeners.size).toBe(0);
});

test("only terminal Agent callbacks replace an exit timer", () => {
  const f = fixture();
  f.agent.busy = true;
  f.controller.request();
  const initial = f.timers.keys().next().value;
  expect(f.timers.keys().next().value).toBe(initial);
  f.listeners.get(Agent.EVENT.REQUEST_DONE)();
  expect(f.timers.size).toBe(1);
  expect(f.timers.keys().next().value).not.toBe(initial);
  f.controller.dispose();
});

test("clean exit reports an owned cleanup failure with nonzero status", async () => {
  const f = fixture();
  f.proc.exit = (code) => f.exits.push(code);
  // A failing cleanup rejects instead of silently reporting successful exit.
  const failed = createExitController(f.registry, { clock: f.clock, proc: f.proc,
    stop: async () => { throw new Error("persist failed"); } });
  failed.request();
  await settle();
  expect(f.exits).toEqual([1]);
  failed.dispose(); f.controller.dispose();
});

test("disposing stops an outstanding timer and rejects subsequent exit requests", () => {
  const f = fixture();
  f.agent.busy = true;
  f.controller.request();
  f.controller.dispose();
  f.controller.request();
  expect(f.timers.size).toBe(0);
  expect(f.exits).toEqual([]);
});
