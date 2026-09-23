import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { runJobAgent, ensureJobsLayout, dispatchJobs, parseTask, loadTaskState } from "../lib/jobs.js";
import Agent, { findSessionFile } from "../lib/agent.js";
import Env from "../lib/env.js";
import Context from "../lib/context.js";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function root() { await fs.mkdir("./ai-tmp", { recursive: true }); const p = resolve(await fs.mkdtemp("./ai-tmp/jobs-agent-")); roots.push(p); return p; }
function harness(extra = {}) {
  const agents = [], calls = [];
  const env = { endpointSettings: () => ({}), maxAttempts: 9 };
  return { agents, calls, options: {
    createEnv: async () => env,
    selectModel: async (_, args, flags) => { calls.push({ args, flags }); return { endpoint: "test", model: args.model ?? "default" }; },
    effectiveTimeout: ({ timeout }) => timeout ?? 1234,
    createAgent: (settings) => {
      const listeners = [];
      const agent = { settings, append: (message) => { agent.prompt = message; }, session: { flush() {} },
        onEvent(_event, callback) { listeners.push(callback); return listeners.length; }, emit(call) { for (const listener of listeners) listener(call); },
        async run() { return { type: "done" }; }, cancel() { agent.cancelled = true; }, close() {} };
      agents.push(agent); return agent;
    }, close() {}, ...extra,
  } };
}
test("fresh agents/sessions, omitted tools vs empty tools, Agent-owned timeout and snapshot", async () => {
  const h = harness(); const ready = [];
  const first = await runJobAgent({ prompt: "snapshot" }, { ...h.options, onReady: (v) => ready.push(v) });
  const second = await runJobAgent({ prompt: "other", tools: [], model: "explicit", timeout: 4567 }, { ...h.options, onReady: (v) => ready.push(v) });
  expect(first.outcome).toBe("completed"); expect(second.session).not.toBe(first.session);
  expect(h.agents[0]).not.toBe(h.agents[1]); expect(Object.hasOwn(h.agents[0].settings, "tools")).toBeFalse();
  expect(h.agents[1].settings.tools).toEqual([]); expect(h.agents[1].settings.model).toBe("test/explicit");
  // Jobs does not impose a deadline; an explicit task timeout remains Agent/IO policy.
  expect(Object.hasOwn(h.agents[0].settings, "timeout")).toBeFalse();
  expect(h.agents[1].settings.timeout).toBe(4567);
  expect(ready.map((v) => v.timeout)).toEqual([1234, 4567]);
  expect(h.agents[0].prompt).toEqual(Context.userMessage("snapshot"));
  expect(h.agents[0].settings).toMatchObject({ toolCall: { detached: false } });
  expect(h.calls[0].flags.lastUsed).toBeTrue();
});
test("missing model/login and question requests finish blocked", async () => {
  for (const mode of ["model", "login", "question", "auth", "bridge"]) {
    const h = harness(mode === "model" ? { selectModel: async () => ({}) } : mode === "login" ? { createEnv: async () => ({ endpointSettings: () => ({ loginRequired: true }) }) } : {});
    const create = h.options.createAgent;
    h.options.createAgent = (settings) => { const agent = create(settings); agent.run = async () => {
      if (mode === "question") agent.emit({ name: mode });
      if (mode === "bridge") await settings.question.ask([]);
      return mode === "auth" ? { type: "error", kind: "auth" } : { type: "done" };
    }; return agent; };
    expect((await runJobAgent({ prompt: "body" }, h.options)).outcome).toBe("blocked");
  }
});
test("a deliberate cancel signal cancels the in-flight agent and reports cancelled", async () => {
  const h = harness(); const controller = new AbortController();
  const create = h.options.createAgent;
  h.options.createAgent = (settings) => { const agent = create(settings); agent.run = async () => { controller.abort(); return { type: "done" }; }; return agent; };
  const result = await runJobAgent({ prompt: "body" }, { ...h.options, signal: controller.signal });
  expect(result.outcome).toBe("cancelled"); expect(h.agents[0].cancelled).toBeTrue();
});
test("real Agent owns provider retries, transcript and inherited tool context", async () => {
  const p = await root(); const env = new Env({ dir: p, cwd: p, settingsDir: null, settings: { maxAttempts: 2, retryBase: 1, retryMax: 1, contextGuardCap: 0.5 } });
  env.endpoints.test = { provider: "test" };
  let writes = 0, detached;
  env.registerTool("probe", (_, context) => { detached = context.detached; return "ok"; }, { safe: true, inputSchema: { type: "object" } });
  const result = await runJobAgent({ prompt: "persisted prompt", tools: [] }, {
    projectRoot: p, createEnv: async () => env, selectModel: async () => ({ endpoint: "test", model: "fake" }), effectiveTimeout: () => 1000,
    createAgent: (settings) => new Agent({ ...settings, sessionDir: p, createIO: () => ({
      async write() { writes++; return writes === 1 ? { type: "error", kind: "network" } : { type: "done", message: Context.assistantMessage([Context.textContent("answer")]) }; }, kill() {},
    }) }),
  });
  expect(result.outcome).toBe("completed"); expect(writes).toBe(2);
  const transcript = await fs.readFile(findSessionFile(p, result.session), "utf8");
  expect(transcript).toContain("persisted prompt"); expect(transcript).toContain("answer");
  for (const policy of [undefined, false]) {
    let turn = 0;
    const agent = new Agent({ env, model: "test/fake", toolCall: policy === undefined ? {} : { detached: false }, createIO: () => ({ async write() {
      return ++turn === 1 ? { type: "done", message: Context.assistantMessage([{ type: "toolCall", name: "probe", arguments: {} }]) } : { type: "done" };
    }, kill() {} }) });
    await agent.run(); expect(detached).toBe(policy !== false); agent.close();
  }
});
test("default dispatcher runs agents in-process serially against one shared env and persists outcomes/sessions", async () => {
  const p = await root(); const paths = await ensureJobsLayout(p);
  for (const name of ["a.md", "b.md"]) await fs.writeFile(join(paths.tasks, name), name);
  let envCreations = 0, active = 0, maximum = 0; const agents = [], closes = [];
  const sharedEnv = {
    endpointSettings: () => ({}), maxAttempts: 1,
    createAgent(settings) {
      let closed = false;
      const agent = { settings, append() {}, session: { flush() {} }, onEvent() {}, cancel() {},
        async run() { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return { type: "done" }; },
        close() { if (!closed) { closed = true; closes.push(agent); } } };
      agents.push(agent); return agent;
    },
  };
  const result = await dispatchJobs(p, { execution: {
    createEnv: async () => { envCreations++; return sharedEnv; },
    close: () => {},
    selectModel: async (_, args) => ({ endpoint: "test", model: args.model ?? "default" }),
    effectiveTimeout: ({ timeout }) => timeout, // the fake env has no real endpoint to resolve
  } });
  expect(result.outcomes.map((item) => item.outcome)).toEqual(["completed", "completed"]);
  expect(envCreations).toBe(1); // one Env shared by the whole wake
  expect(agents).toHaveLength(2); expect(agents[0]).not.toBe(agents[1]); // fresh agent per task
  expect(maximum).toBe(1); // serial, never concurrent
  expect(closes).toHaveLength(2); // each agent released exactly once after its own run
  const sessions = [];
  for (const name of ["a.md", "b.md"]) sessions.push((await loadTaskState(p, parseTask(name, name))).occurrences[0].attempts[0].session);
  expect(sessions.every(Boolean)).toBeTrue(); expect(new Set(sessions).size).toBe(2);
});
test("dispatcher durably preserves every executor terminal outcome and session", async () => {
  for (const outcome of ["completed", "failed", "blocked", "cancelled", "timed-out"]) {
    const p = await root(); const paths = await ensureJobsLayout(p);
      await fs.writeFile(join(paths.tasks, "a.md"), "snapshot");
    await dispatchJobs(p, { executor: async () => ({ outcome, session: "durable-session" }) });
    const saved = await loadTaskState(p, parseTask("a.md", "snapshot"));
    expect(saved.occurrences[0].attempts[0]).toMatchObject({ outcome, session: "durable-session" });
  }
});
