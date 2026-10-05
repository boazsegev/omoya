import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { worker_create, toolDescription } from "../tools/worker-create.js";
import { worker_message } from "../tools/worker-message.js";
import { worker_close } from "../tools/worker-close.js";
import { worker_status } from "../tools/worker-status.js";

function setup(permission = true, cwd) {
  const folder = cwd ?? mkdtempSync("./ai-tmp/worker-env-");
  const env = new Env({ settings: { maxActive: 4 }, cwd: folder, sessionsDir: join(folder, "sessions") });
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
  test("inherits the parent's live logging preference for each worker's independent session", async () => {
    const root = mkdtempSync("ai-tmp/worker-logging-");
    try {
      const { env, manager, context } = setup(true, root);
      manager.context.save = true;
      await worker_create({ workers: [{ name: "logged" }] }, context);
      const logged = manager.children[0];
      expect(logged.context.save).toBe(true);
      expect(logged.context.id).not.toBe(manager.context.id);
      logged.context.append({ type: 2, content: [{ type: "text", text: "logged task" }] });
      logged.context.flush();
      expect(existsSync(logged.context.file)).toBe(true);
      manager.context.save = false;
      await worker_create({ workers: [{ name: "private" }] }, context);
      const privateWorker = manager.children[1];
      expect(privateWorker.context.save).toBe(false);
      privateWorker.context.append({ type: 2, content: [{ type: "text", text: "private task" }] });
      privateWorker.context.flush();
      expect(existsSync(privateWorker.context.file)).toBe(false);
      manager.close();
      logged.close();
      privateWorker.close();
      env.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("scopes individual workers to existing env.cwd subfolders, without changing their siblings", async () => {
    const root = mkdtempSync("ai-tmp/worker-scope-");
    try {
      mkdirSync(join(root, "area"));
      const { env, manager, context } = setup(true, root);
      await worker_create({ prompt: "review", workers: [{ name: "scoped", subfolder: "area" }, { name: "default" }] }, context);
      expect(manager.children.map((child) => child.folder)).toEqual([resolve(env.cwd, "area"), resolve(env.cwd)]);
      expect(env.cwd).toBe(resolve(root));
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
        expect(manager.children.map((child) => child.folder)).toEqual([resolve(root, "area"), resolve(root, "area")]);
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
  test("rejects wider worker folders before registering any of a batch", async () => {
    const root = mkdtempSync("ai-tmp/worker-parent-scope-");
    try {
      mkdirSync(join(root, "area/nested"), { recursive: true });
      mkdirSync(join(root, "sibling"));
      const { env, manager, context } = setup(true, root);
      manager.folder = "area";
      await expect(worker_create({ workers: [{ name: "ok", subfolder: "area/nested" }, { name: "wide", subfolder: "sibling" }] }, context)).rejects.toThrow(/leader folder/);
      expect(manager.children).toHaveLength(0);
      await worker_create({ workers: [{ name: "nested", subfolder: "area/nested" }, { name: "inherited" }] }, context);
      expect(manager.children.map((child) => child.folder)).toEqual([resolve(root, "area/nested"), resolve(root, "area")]);
      expect(env.cwd).toBe(resolve(root));
      const separate = mkdtempSync("ai-tmp/worker-disjoint-");
      manager.folder = resolve(separate);
      await expect(worker_create({ workers: [{ name: "outside-project", subfolder: "area" }] }, context)).rejects.toThrow(/leader folder/);
      await worker_create({ workers: [{ name: "in-disjoint-folder" }] }, context);
      expect(manager.children.at(-1).folder).toBe(resolve(separate));
      rmSync(separate, { recursive: true, force: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
    const schema = toolDescription()["worker-create"].inputSchema;
    expect(schema.required).toEqual(["workers"]);
    expect(schema.properties.prompt.minLength).toBeUndefined();
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
    const commands = worker_status({ commands: true }, context);
    expect(commands.split("\n").slice(0, 2)).toEqual(["Commands (start a worker-message with one)", "    /compact [focus] — compact the worker's context before it continues"]);
    for (const name of context.agent.env.prompts().keys()) expect(commands).toContain(`    /${name} [text] — `);
    expect(worker_status({ workers: true }, context)).not.toContain("Commands");
    expect(worker_status({}, context)).toContain("Models");
    expect(worker_status({ workers: false, models: false }, context)).toContain("Busy Workers");
    expect(await worker_close({ workers: ["*"] }, context)).toBe("a: closing\nb: closing");
    expect(manager.children[0].pending.at(-1).content[0].text).toBe("/handoff");
  });
});
