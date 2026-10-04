import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { worker_create, toolDescription } from "../tools/worker-create.js";
import { worker_message } from "../tools/worker-message.js";
import { worker_close } from "../tools/worker-close.js";
import { worker_status } from "../tools/worker-status.js";

function setup(permission = true, cwd) {
  const env = new Env({ settings: { maxActive: 4 }, cwd });
  env._endpoints.ep = { provider: "test", models: { m: { maxActive: 3 } } }; // capacity is the catalog's (Agent's modelInfo)
  const manager = new Agent({ env, model: "ep/m", ...(permission === null ? {} : { spawnPermission: permission }), createIO: () => ({ state: "idle" }) });
  const create = env.agentCreate.bind(env);
  env.agentCreate = (options) => {
    const child = create({ ...options, createIO: () => ({ state: "idle", write: async () => ({ type: "done" }) }) });
    child.send = function send(message) { this._pending.push(message); return Promise.resolve({ type: "done" }); };
    return child;
  };
  return { env, manager, context: { agent: manager } };
}

describe("worker actions", () => {
  test("creates distinct workers with the same prompt and independent options", async () => {
    const { manager, context } = setup();
    const output = await worker_create({ prompt: "review", workers: [{ name: "one", safe: true, thinking: "high" }, { name: "two", model: "ep/m" }] }, context);
    expect(output).toContain("one (ep/m): started");
    expect(manager.children.map((w) => w.name)).toEqual(["one", "two"]);
    expect(manager.children[0].safe).toBe(true);
    expect(manager.children[0].thinking).toBe("high");
    expect(manager.children.map((w) => w.pending.at(-1).content[0].text)).toEqual(["review", "review"]);
  });
  test("scopes individual workers to existing env.cwd subfolders, without changing their siblings", async () => {
    const root = mkdtempSync("ai-tmp/worker-scope-");
    try {
      mkdirSync(join(root, "area"));
      const { env, manager, context } = setup(true, root);
      await worker_create({ prompt: "review", workers: [{ name: "scoped", subfolder: "area" }, { name: "default" }] }, context);
      expect(manager.children.map((child) => child.folder)).toEqual([resolve(env.cwd, "area"), env.cwd]);
      expect(env.cwd).toBe(root);
      expect(manager.children[0].context.messages().some((message) => JSON.stringify(message).includes("Your assigned working folder"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const subfolder of [undefined, "", ".", "/", "./", false, null, "  ", "././", ".\\"]) {
    test(`treats root alias ${JSON.stringify(subfolder)} exactly like an omitted subfolder`, async () => {
      const root = mkdtempSync("ai-tmp/worker-root-");
      const { env, manager, context } = setup(true, root);
      try {
        mkdirSync(join(root, "area"));
        manager.folder = "area";
        const aliased = Object.freeze({ name: "aliased", subfolder });
        await worker_create({ workers: [aliased, { name: "omitted" }] }, context);
        expect(manager.children.map((child) => child.folder)).toEqual([env.cwd, env.cwd]);
        for (const child of manager.children) {
          expect(child.context.messages().some((message) => JSON.stringify(message).includes("Your assigned working folder"))).toBe(false);
        }
        expect(aliased.subfolder).toBe(subfolder);
      } finally {
        manager.close();
        env.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  test("publishes root aliases without excluding empty strings or false from the schema", () => {
    const schema = toolDescription()["worker-create"].inputSchema.properties.workers.items.properties.subfolder;
    expect(schema.type).toBeUndefined();
    expect(schema.minLength).toBeUndefined();
    for (const alias of ['""', '"."', '"/"', '"./"', "false"]) expect(schema.description).toContain(alias);
  });
  test("rejects invalid worker scopes and rolls back when a later subfolder is missing or escapes via symlink", async () => {
    const root = mkdtempSync("ai-tmp/worker-scope-");
    const outside = mkdtempSync("ai-tmp/worker-outside-");
    try {
      mkdirSync(join(root, "area"));
      writeFileSync(join(root, "file"), "not a folder");
      symlinkSync(resolve(outside), join(root, "escape"));
      const { env, manager, context } = setup(true, root);
      const events = [];
      env.onEvent(Env.EVENT.AGENT_ADDED, ({ agent }) => events.push(agent.name));
      for (const subfolder of ["../area", "area/../area", "./../area", "./area/..", "area\\..\\area", `${String.fromCharCode(47)}tmp`, "//", "C:\\area", "\\\\server\\share", 3, 0, true, [], {}]) {
        await expect(worker_create({ prompt: "go", workers: [{ name: "invalid", subfolder }] }, context)).rejects.toThrow(/subfolder/);
        expect(manager.children).toHaveLength(0);
      }
      for (const subfolder of ["missing", "file", "escape"]) {
        await expect(worker_create({ prompt: "go", workers: [{ name: "valid", subfolder: "area" }, { name: "invalid", subfolder }] }, context)).rejects.toThrow(/Agent.folder:/);
        expect(manager.children).toHaveLength(0);
      }
      expect(events).toEqual([]); // preflight rejects the batch before any child registers
      expect(env.agents()).toEqual([manager]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  test("prevalidates names and models before creation", async () => {
    const { manager, context } = setup();
    await expect(worker_create({ prompt: "go", workers: [{ name: "a" }, { name: "a" }] }, context)).rejects.toThrow(/occurs twice/);
    await expect(worker_create({ prompt: "go", workers: [{ name: "a" }, { name: "b", model: "ep/missing" }] }, context)).rejects.toThrow(/unknown model/);
    expect(manager.children).toHaveLength(0);
  });
  test("missing or empty prompt creates idle workers for a separate message call", async () => {
    const { manager, context } = setup();
    expect(await worker_create({ workers: [{ name: "standby" }] }, context)).toBe("standby (ep/m): idle; send a task with worker-message");
    expect(manager.children[0].busy).toBe(false);
    expect(manager.children[0].pending).toHaveLength(0);
    expect(await worker_create({ prompt: "", workers: [{ name: "another" }] }, context)).toBe("another (ep/m): idle; send a task with worker-message");
    await worker_message({ workers: ["standby", "another"], prompt: "start" }, context);
    expect(manager.children.map((worker) => worker.pending.at(-1).content[0].text)).toEqual(["start", "start"]);
  });
  test("creation rolls back all workers before sending prompts if any creation fails", async () => {
    const { env, manager, context } = setup();
    const create = env.agentCreate;
    env.agentCreate = function (options) { if (options.name === "broken") throw new Error("creation refused"); return create(options); };
    await expect(worker_create({ prompt: "start", workers: [{ name: "ok" }, { name: "broken" }] }, context)).rejects.toThrow(/No workers created/);
    expect(manager.children).toHaveLength(0);
  });
  test("permission is required for mutations; status remains read-only", async () => {
    const { manager, context } = setup(false);
    expect(worker_status({}, context)).toContain("Models");
    await expect(worker_create({ prompt: "go", workers: [{ name: "a" }] }, context)).rejects.toThrow(/permit worker creation/);
    const pending = setup(null);
    let asked;
    await worker_create({ prompt: "go", workers: [{ name: "a" }] }, { ...pending.context, question: { ask: async ([question]) => { asked = question; return [{ labels: ["Allow"] }]; } } });
    expect(asked.details).toContain("a: ep/m");
    expect(pending.manager.spawnPermission).toBe(true);
  });
  test("messages target one, many or snapshot of all; reject ambiguity", async () => {
    const { manager, context } = setup();
    await worker_create({ prompt: "initial", workers: [{ name: "a" }, { name: "b" }] }, context);
    await worker_message({ workers: ["a"], prompt: "private" }, context);
    expect(manager.children[0].pending.at(-1).content[0].text).toBe("private");
    expect(manager.children[1].pending.at(-1).content[0].text).toBe("initial");
    expect(await worker_message({ workers: ["*"], prompt: "/handoff" }, context)).toBe("a: queued\nb: queued");
    await expect(worker_message({ workers: ["*", "a"], prompt: "x" }, context)).rejects.toThrow(/alone/);
    await expect(worker_message({ workers: ["absent"], prompt: "x" }, context)).rejects.toThrow(/No workers match/);
    expect(await worker_message({ workers: ["/^a$/"], prompt: "pattern" }, context)).toBe("a: queued");
    expect(await worker_message({ workers: ["/^(a|b)$/"], prompt: "pattern" }, context)).toBe("a: queued\nb: queued");
    await expect(worker_message({ workers: ["/[/"], prompt: "x" }, context)).rejects.toThrow(/invalid worker pattern/);
  });
  test("status emits only populated requested headings; close handles busy work", async () => {
    const { manager, context } = setup();
    expect(worker_status({ workers: true }, context)).toBe("No workers or models.");
    await worker_create({ prompt: "go", workers: [{ name: "a" }, { name: "b" }] }, context);
    Object.defineProperty(manager.children[0], "busy", { value: true });
    expect(worker_status({ workers: true }, context)).toBe("Busy Workers\n    a (ep/m)\nIdle Workers\n    b (ep/m)");
    expect(worker_status({ models: true }, context)).toBe("Models\n    ep/m (available: 2)");
    expect(worker_status({}, context)).toContain("Models");
    expect(worker_status({ workers: false, models: false }, context)).toContain("Busy Workers");
    expect(await worker_close({ workers: ["*"] }, context)).toBe("a: closing\nb: closing");
    expect(manager.children[0].pending.at(-1).content[0].text).toBe("/handoff");
  });
});
