import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCompletionSources } from "../lib/tui-app/completion-sources.js";
import { createApp } from "../lib/tui-app/app.js";

test("filesystem completion never uses synchronous directory IO", async () => {
  const source = await readFile("lib/tui-app/completion.js", "utf8");
  expect(source).not.toMatch(/\breaddirSync\s*\(/);
});

test("completion source catalogues keep raw menu data and mapped completion data", async () => {
  let resolvePrompts;
  const prompts = new Promise((resolve) => { resolvePrompts = resolve; });
  const env = { endpointNames: () => [], toolNames: () => [], promptNamesAsync: () => prompts };
  const agent = { context: [], listSessionsAsync: async () => [{ id: "saved", preview: "p" }] };
  const sources = createCompletionSources(agent, env);
  expect(sources().prompts).toEqual([]);
  resolvePrompts(["menu"]);
  await sources.refresh();
  expect(sources().prompts).toEqual(["/menu"]);
  expect(sources.catalog().prompts).toEqual(["menu"]);
  expect(sources.catalog().sessions).toEqual([{ id: "saved", preview: "p" }]);
  expect(sources().argCandidates["/session-resume"]).toEqual(["saved"]);
});

test("stale delayed filesystem completion is ignored after typing or Escape", () => {
  const env = { endpointNames: () => [], toolNames: () => [], promptNamesAsync: async () => [] };
  const agent = { context: [], pending: [], model: "x/y", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, listSessionsAsync: async () => [] };
  const app = createApp(agent, { env, completionIO: { listDir: async () => ["file"] } });
  let state = app.init().model;
  state = app.update(state, { type: "input.change", value: "fi", caret: 2 }).model;
  const requested = app.update(state, { type: "key", key: "tab" }); state = requested.model;
  state = app.update(state, { type: "input.change", value: "fix", caret: 3 }).model;
  state = app.update(state, { type: "completion.path.ready", request: { dir: ".", value: "fi", caret: 2, agent, generation: 1 }, entries: ["file"] }).model;
  expect(state.input.completions).toEqual([]);
  state = app.update(state, { type: "key", key: "escape" }).model;
  state = app.update(state, { type: "completion.path.ready", request: { dir: ".", value: "fix", caret: 3, agent, generation: 2 }, entries: ["file"] }).model;
  expect(state.input.completions).toEqual([]);
});

test("delayed filesystem Tab previews its first candidate and retains an interactive menu", () => {
  const env = { endpointNames: () => [], toolNames: () => [], promptNamesAsync: async () => [] };
  const agent = { context: [], pending: [], model: "x/y", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, listSessionsAsync: async () => [] };
  const app = createApp(agent, { env, completionIO: { listDir: async () => ["file", "filter"] } });
  let state = app.init().model;
  state = app.update(state, { type: "input.change", value: "fi", caret: 2 }).model;
  state = app.update(state, { type: "key", key: "tab" }).model;
  state = app.update(state, { type: "completion.path.ready", request: { dir: ".", value: "fi", caret: 2, agent, generation: 1, nonce: 1 }, entries: ["file", "filter"] }).model;
  expect(state.input).toMatchObject({ value: "file", caret: 4, completionIndex: 0, completions: ["file", "filter"] });
  state = app.update(state, { type: "key", key: "tab" }).model;
  expect(state.input.value).toBe("filter");
  state = app.update(state, { type: "key", key: "enter" }).model;
  expect(state.input).toMatchObject({ value: "filter", completions: [] });
});

test("Tab on an exact slash command does not request filesystem completion", () => {
  let reads = 0;
  const env = { endpointNames: () => [], toolNames: () => [], promptNamesAsync: async () => [] };
  const agent = { context: [], pending: [], model: "x/y", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, listSessionsAsync: async () => [] };
  const app = createApp(agent, { env, completionIO: { listDir: async () => { reads++; return []; } } });
  let state = app.init().model;
  state = app.update(state, { type: "input.change", value: "/" + "context", caret: 8 }).model;
  const outcome = app.update(state, { type: "key", key: "tab" });
  expect(outcome.effects).toEqual([]);
  expect(reads).toBe(0);
});

test("same-draft repeated Tabs reject a stale filesystem response by request nonce", () => {
  const env = { endpointNames: () => [], toolNames: () => [], promptNamesAsync: async () => [] };
  const agent = { context: [], pending: [], model: "x/y", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, listSessionsAsync: async () => [] };
  const app = createApp(agent, { env, completionIO: { listDir: async () => [] } });
  let state = app.init().model;
  state = app.update(state, { type: "input.change", value: "fi", caret: 2 }).model;
  state = app.update(state, { type: "key", key: "tab" }).model;
  state = app.update(state, { type: "key", key: "tab" }).model;
  state = app.update(state, { type: "completion.path.ready", request: { dir: ".", value: "fi", caret: 2, agent, generation: 1, nonce: 1 }, entries: ["file"] }).model;
  expect(state.input.completions).toEqual([]);
  state = app.update(state, { type: "completion.path.ready", request: { dir: ".", value: "fi", caret: 2, agent, generation: 1, nonce: 2 }, entries: ["file"] }).model;
  expect(state.input.value).toBe("file");
});

test("missing asynchronous completion directory invokes and safely settles the runtime boundary", async () => {
  let calls = 0;
  const env = { endpointNames: () => [], toolNames: () => [], promptNamesAsync: async () => [] };
  const agent = { context: [], pending: [], model: "x/y", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, listSessionsAsync: async () => [] };
  const app = createApp(agent, { env, completionIO: { listDir: async () => { calls++; throw new Error("missing"); } } });
  let state = app.init().model;
  state = app.update(state, { type: "input.change", value: "fi", caret: 2 }).model;
  const effect = app.update(state, { type: "key", key: "tab" }).effects[0];
  let message;
  await effect.run({ send: (value) => { message = value; } });
  expect(calls).toBe(1);
  expect(message.entries).toEqual([]);
});

test("master menu uses supplied catalogue without synchronous prompt or session scans", () => {
  const env = { endpointNames: () => [], toolNames: () => [], promptNamesAsync: async () => ["menu"], promptNames: () => { throw new Error("sync prompt scan"); } };
  const agent = { context: [], pending: [], model: "x/y", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, listSessionsAsync: async () => [{ id: "saved", preview: "p" }], listSessions: () => { throw new Error("sync session scan"); } };
  const app = createApp(agent, { env });
  let state = app.init().model;
  state = app.update(state, { type: "key", key: "ctrl+x" }).model;
  expect(state.overlay).not.toBeNull();
});
