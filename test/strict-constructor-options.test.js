import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Agent from "../lib/agent.js";
import Env from "../lib/env.js";
import IO from "../lib/io.js";
import Context from "../lib/context.js";
import { SettingsStore } from "../lib/env/settings-store.js";
import { testEnv } from "./fakes.js";
import { providerAdd } from "./env-internals.js";

const roots = [];
const opened = [];
function root() {
  const dir = resolve(mkdtempSync("./ai-tmp/strict-options-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const instance of opened.splice(0).reverse()) await instance.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const constructors = [
  ["IO", IO, () => ({ env: { connection() { throw new Error("provider resolution was reached"); } }, model: "x/m" })],
  ["Context", Context, () => ({ dir: join(root(), "sessions"), save: true })],
  ["SettingsStore", SettingsStore, () => ({ sources: [{ data: { retained: true } }] })],
];

for (const [name, Constructor, options] of constructors) {
  test(`${name} rejects invalid option containers at the public boundary`, () => {
    for (const value of [null, 3, "options", [], () => {}]) {
      expect(() => new Constructor(value)).toThrow(new RegExp(`${name}.*options.*object`, "i"));
    }
  });

  test(`${name} rejects own unknown keys before owned work`, () => {
    const input = options();
    const unknown = { ...input, misspelledOption: true };
    expect(() => new Constructor(unknown)).toThrow(new RegExp(`${name}.*misspelledOption`));
    const unknownSymbol = Symbol("misspelledSymbol");
    expect(() => new Constructor({ ...input, [unknownSymbol]: true })).toThrow(new RegExp(`${name}.*misspelledSymbol`));
    if (name === "Env") expect(Object.hasOwn(Env.envs, input.cwd)).toBe(false);
    if (name === "Context") expect(existsSync(input.dir)).toBe(false);
    if (name === "SettingsStore") {
      const valid = new SettingsStore(input);
      opened.push(valid);
      expect(valid.read(["retained"])).toBe(true);
    }
  });
}

test("inherited keys are not an own constructor-option vocabulary", () => {
  const context = new Context(Object.assign(Object.create({ externalHint: true }), { messages: [] }));
  opened.push(context);
  expect(context.length).toBe(0);
});

test("Env.open validates embedding options without replacing the project Env", async () => {
  const cwd = root();
  const init = { providers: false, tools: false, models: false };
  await expect(Env.open(cwd, { settingsDir: null, typo: true, init })).rejects.toThrow(/Env.*typo/);
  await expect(Env.open(cwd, { settingsDir: null, init: { ...init, typo: true } })).rejects.toThrow(/Env.*typo/);
  await expect(Env.open(cwd, { settingsDir: null, init: { ...init, [Symbol("initSymbol")]: true } })).rejects.toThrow(/Env.*initSymbol/);
  expect(Object.hasOwn(Env.envs, cwd)).toBe(false);
  const project = await Env.open(cwd);
  const embedded = await Env.open(cwd, { settingsDir: null, init });
  opened.push(project, embedded);
  expect(Env.envs[cwd]).toBe(project);
  expect(embedded).not.toBe(project);
  await expect(Env.open(cwd, { settingsDir: null, typo: true, init })).rejects.toThrow(/Env.*typo/);
});

test("Env.open rejects invalid embedding options and init containers", async () => {
  for (const value of [null, 7, [], "wrong"]) {
    await expect(Env.open(root(), value)).rejects.toThrow(/Env.*options.*object/i);
    await expect(Env.open(root(), { settingsDir: null, init: value })).rejects.toThrow(/Env.*initOptions.*object/i);
  }
});

test("Agent rejects unsupported stale flags and nested async without leaking membership", async () => {
  const env = await testEnv();
  opened.push(env);
  for (const invalid of [{ safe: false }, { maxTurns: 3 }, { maxToolCalls: 5 }, { toolCall: { async: false } }]) {
    const key = Object.hasOwn(invalid, "toolCall") ? "async" : Object.keys(invalid)[0];
    await expect(Agent.create({ env, ...invalid })).rejects.toThrow(new RegExp(key));
    expect(env.agents()).toHaveLength(0);
  }
});

test("Agent accepts all existing response callback names and nested supported flags", async () => {
  const env = await testEnv();
  opened.push(env);
  const observed = [];
  const callbacks = Object.fromEntries(Agent.EVENT_CALLBACKS.map(([name]) => [name, (payload) => observed.push([name, payload])]));
  const agent = await Agent.create({ env, can: { write: false, customCapability: true }, toolCall: { fork: false, timeout: "1s", detached: false }, ...callbacks });
  opened.push(agent);
  expect(env.agents()).toContain(agent);
  for (const [name, event] of Agent.EVENT_CALLBACKS) agent._emit(event, { name });
  expect(observed).toEqual(Agent.EVENT_CALLBACKS.map(([name]) => [name, { name }]));
  expect(agent.can.write).toBe(false);
  expect(agent.can.customCapability).toBe(true);
});

test("Agent rejects unknown options before adopting a borrowed Context", async () => {
  const env = await testEnv();
  opened.push(env);
  const seed = new Context({ messages: [] });
  opened.push(seed);
  await expect(Agent.create({ env, context: seed, unknownFlag: true })).rejects.toThrow(/Agent.*unknownFlag/);
  expect(env.agents()).toHaveLength(0);
  seed.append(Context.messageUser("still caller-owned"));
  expect(seed.length).toBe(1);
});

test("Agent rejects invalid callbacks without retaining an acquired Env", async () => {
  const before = Object.keys(Env.envs);
  const env = await testEnv();
  opened.push(env);
  await expect(Agent.create({ env, onTextDelta: false })).rejects.toThrow(/Agent.*onTextDelta.*function/);
  await expect(Agent.create({ env, onError: null })).rejects.toThrow(/Agent.*onError.*function/);
  expect(env.agents()).toHaveLength(0);
  expect(Object.keys(Env.envs)).toEqual(before);
});

test("IO preserves callback options and reads provider settings from Env while refusing typos before lookup", async () => {
  const env = await testEnv();
  opened.push(env);
  class FixtureProvider { static provider = {}; }
  providerAdd(env, "test", FixtureProvider);
  const original = env.connection.bind(env);
  let lookups = 0;
  env.connection = (...args) => { lookups++; return original(...args); };
  expect(() => new IO({ env, model: "p/m", onData: () => {}, onLog: () => {}, settings: { customProviderField: 1 }, typo: true })).toThrow(/IO.*typo/);
  expect(lookups).toBe(0);
  env.settings.providers.p.customProviderField = 1;
  const io = new IO({ env, model: "p/m", onData: () => {}, onLog: () => {}, remember: false });
  opened.push(io);
  expect(io.settings.customProviderField).toBe(1);
  expect(lookups).toBe(1);
});

test("Context keeps arbitrary settings payload and rejects unknown keys before creating a session folder", () => {
  const dir = join(root(), "sessions");
  expect(() => new Context({ dir, save: true, messages: [], surprise: 1 })).toThrow(/Context.*surprise/);
  expect(existsSync(dir)).toBe(false);
  const context = new Context({ dir, save: true, messages: [], settings: { custom: { arbitrary: 1 } } });
  opened.push(context);
  expect(context.settings.custom.arbitrary).toBe(1);
  expect(existsSync(dir)).toBe(true);
});

test("SettingsStore preserves open source payloads and an optional parent", () => {
  const parent = new SettingsStore({ sources: [{ data: { provider: { custom: true } } }] });
  opened.push(parent);
  const child = new SettingsStore({ parent, sources: [{ data: { other: 1 } }] });
  opened.push(child);
  expect(child.read()).toEqual({ provider: { custom: true }, other: 1 });
});
