import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { runJobAgent } from "../lib/jobs/agent-execution.js";
import { dispatchJobs } from "../lib/jobs/dispatcher.js";
import { ensureJobsLayout } from "../lib/jobs/lifecycle.js";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  await fs.mkdir("./ai-tmp", { recursive: true });
  const root = resolve(await fs.mkdtemp("./ai-tmp/jobs-open-"));
  roots.push(root);
  return root;
}
function agentFactory(created) {
  return (settings) => {
    const agent = {
      settings, context: { append() {}, flush() {} }, onEvent() {},
      async run(options) { agent.runOptions = options; return { type: "done" }; },
      async close() { agent.closed = true; },
    };
    created.push(agent);
    return agent;
  };
}
function selection() { return "test/model"; }

test("standalone execution passes path and only explicit options to its Env factory and closes its Env", async () => {
  const root = await fixture();
  for (const environment of [undefined, { settingsDir: null }]) {
    const calls = [], agents = [];
    const env = { models: () => new Map(), async close() { env.closed = true; } };
    const result = await runJobAgent({ prompt: "hello", timeout: 200 }, {
      projectRoot: root, ...(environment === undefined ? {} : { environment }),
      createEnv: async (...args) => { calls.push(args); return env; },
      selectModel: selection, effectiveTimeout: () => 200, createAgent: agentFactory(agents),
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual([environment === undefined ? [root] : [root, environment]]);
    expect(agents[0].settings).not.toHaveProperty("timeout");
    expect(agents[0].runOptions).toEqual({ timeout: 200 });
    expect(agents[0].closed).toBeTrue();
    expect(env.closed).toBeTrue();
  }
});

test("caller-owned Env is not closed and default timeout applies to run only", async () => {
  const agents = [];
  const env = { models: () => new Map(), async close() { throw new Error("caller-owned Env closed"); } };
  const result = await runJobAgent({ prompt: "hello" }, {
    env, defaultTimeout: 123, selectModel: selection, effectiveTimeout: () => 123,
    createAgent: agentFactory(agents),
  });
  expect(result.outcome).toBe("completed");
  expect(agents[0].settings).not.toHaveProperty("timeout");
  expect(agents[0].runOptions).toEqual({ timeout: 123 });
});

test("dispatcher acquires one shared Env with path-only call and closes it after both agents", async () => {
  const root = await fixture();
  const paths = await ensureJobsLayout(root);
  for (const name of ["a.md", "b.md"]) await fs.writeFile(join(paths.tasks, name), name);
  const calls = [], agents = [];
  const env = { models: () => new Map(), agentCreate: agentFactory(agents), async close() { env.closed = true; } };
  const result = await dispatchJobs(root, { execution: {
    createEnv: async (...args) => { calls.push(args); return env; },
    selectModel: selection, effectiveTimeout: () => 1, timeout: 99,
  } });
  expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(["completed", "completed"]);
  expect(calls).toEqual([[root]]);
  expect(agents.map(({ runOptions }) => runOptions)).toEqual([{ timeout: 99 }, { timeout: 99 }]);
  expect(agents.every(({ closed }) => closed)).toBeTrue();
  expect(env.closed).toBeTrue();
});
test("dispatcher forwards explicit environment options without merging cwd", async () => {
  const root = await fixture();
  const paths = await ensureJobsLayout(root);
  await fs.writeFile(join(paths.tasks, "a.md"), "a");
  const environment = { settingsDir: null };
  const calls = [];
  const env = { models: () => new Map(), agentCreate: agentFactory([]), async close() {} };
  const result = await dispatchJobs(root, { execution: {
    environment, createEnv: async (...args) => { calls.push(args); return env; },
    selectModel: selection, effectiveTimeout: () => 1,
  } });
  expect(result.outcomes[0].outcome).toBe("completed");
  expect(calls).toEqual([[root, environment]]);
});
