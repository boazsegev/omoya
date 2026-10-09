/** Private TUI workspace ownership, project metadata and saved-session contracts. */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import Agent from "../lib/agent.js";
import { createWorkspace } from "../lib/app/tui/workspace.js";
import { emitScript, fakeIO } from "./fakes.js";

const { Env, Context, NAMES } = Agent;
const INIT = { providers: false, tools: false, detect: false, models: false };
const PROVIDERS = {
  workspace: { provider: "openai", url: "http://invalid.test", models: { alpha: {}, beta: {} } },
};

/** Real facades and local folders; clean up even after a failed assertion. */
async function fixture(run) {
  await mkdir("./ai-tmp", { recursive: true });
  const root = resolve(await mkdtemp("./ai-tmp/tui-workspace-"));
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  const gamma = join(root, "gamma");
  const sessions = join(root, "sessions");
  await Promise.all([alpha, beta, gamma, sessions].map((folder) => mkdir(folder)));
  const envs = new Set();
  const workspaces = new Set();
  const pins = new Set([alpha, beta, gamma]);
  const own = (env) => { envs.add(env); return env; };
  const embedded = async (folder, settings = {}) => own(await Env.open(folder, {
    dir: root, settingsDir: null, sessionsDir: sessions,
    settings: { providers: PROVIDERS, ...settings }, init: INIT,
  }));
  const env = await embedded(alpha);
  const initial = await env.agentCreate({ model: "workspace/alpha" });
  const workspace = createWorkspace(initial);
  workspaces.add(workspace);
  await Env.ready();
  try {
    return await run({
      root, alpha, beta, gamma, sessions, env, initial, workspace, embedded, own, pins,
    });
  } finally {
    await Promise.allSettled([...workspaces].map((value) => value.close()));
    for (const target of [...envs, ...Object.values(Env.envs)].filter((target) => target.folder.startsWith(`${root}/`))) {
      await Promise.allSettled(target.agents().map((agent) => agent.close()));
      await target.close();
    }
    for (const path of pins) delete Env.settings.projects[path];
    await Env.settingsFlush();
    await rm(root, { recursive: true, force: true });
  }
}

/** Gate a real Agent.run() through the injected IO boundary without networking. */
async function busyAgent(env, { contextId } = {}) {
  let release;
  let started;
  const ready = new Promise((done) => { started = done; });
  const gate = new Promise((done) => { release = done; });
  const io = fakeIO(async (_io, callbacks) => {
    _io._onKill = release;
    started();
    await gate;
    return emitScript([{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, text: "done" }, { type: "text_end", contentIndex: 0 }, { type: "done", stopReason: "end_turn" }], callbacks, _io.context);
  });
  const agent = await env.agentCreate({ model: "workspace/alpha", createIO: () => io, contextId });
  agent.context.append(Context.messageUser("hold this request"));
  const running = agent.run();
  await ready;
  return { agent, io, async finish() { release(); await running; } };
}

describe("TUI workspace project lifecycle", () => {
  test("opens relative and symlink directories without pinning or copying initial overrides", async () => fixture(async ({ root, alpha, beta, env, workspace }) => {
    const alias = join(root, "alias");
    await symlink(beta, alias, "dir");
    const target = await workspace.open("../beta");
    expect(target.folder).toBe(beta);
    expect(target).not.toBe(env);
    expect(target.settings.providers.workspace).toBeUndefined();
    expect(await workspace.open(alias)).toBe(target);
    expect(await workspace.open(alpha)).toBe(env);
    expect(Env.settings.projects[beta]).toBeUndefined();
    expect(workspace.projects().find((item) => item.path === beta)).toMatchObject({ env: target, open: true, pinned: false, current: false, groups: [], description: "" });
    await workspace.close();
    expect(target.closed).toBe(true);
    expect(env.closed).toBe(false);
  }));

  test("expands ~/ paths without pinning", async () => fixture(async ({ beta, workspace }) => {
    // The native homedir() may ignore preload HOME; navigate to an existing
    // under-tree fixture rather than creating anything in the actual home.
    expect((await workspace.open(`~/${relative(homedir(), beta)}`)).folder).toBe(beta);
    expect(Env.settings.projects[beta]).toBeUndefined();
  }));

  test("rejects invalid directories without changing enrollment", async () => fixture(async ({ root, workspace }) => {
    const file = join(root, "file");
    await writeFile(file, "not a directory");
    await expect(workspace.open("")).rejects.toThrow(/non-empty/);
    await expect(workspace.open("../missing")).rejects.toThrow(/does not exist/);
    await expect(workspace.open(file)).rejects.toThrow(/directory/);
    await expect(workspace.closeProject(".")).rejects.toThrow(/last/);
  }));

  test("metadata edits preserve models, unrelated groups and description without inheriting groups", async () => fixture(async ({ alpha, beta, gamma, workspace }) => {
    Env.settings.projects[alpha] = { groups: { inherited: true } };
    Env.settings.projects[beta] = {
      models: { "workspace/beta": "2026-01-01T00:00:00.000Z" },
      groups: { keep: true, disabled: false }, description: "before",
    };
    workspace.pin(beta, true);
    workspace.group(beta, "team", true);
    expect(Env.settings.projects[beta]).toMatchObject({ description: "before", groups: { keep: true, disabled: false, team: true }, models: { "workspace/beta": "2026-01-01T00:00:00.000Z" } });
    workspace.describe(beta, "after");
    workspace.group(beta, "team", false);
    expect(Env.settings.projects[beta]).toMatchObject({ description: "after", groups: { keep: true, disabled: false }, models: { "workspace/beta": "2026-01-01T00:00:00.000Z" } });
    workspace.describe(beta, "");
    expect(Env.settings.projects[beta].description).toBeUndefined();
    workspace.group(gamma, "new", true);
    expect(Env.settings.projects[gamma].groups).toEqual({ new: true });
    workspace.pin(gamma, false);
    expect(Env.settings.projects[gamma]).toBeUndefined();
    workspace.describe(gamma, "pins on describe");
    expect(workspace.projects().find((item) => item.path === gamma)).toMatchObject({ pinned: true, open: false, description: "pins on describe", groups: [] });
    workspace.pin(beta, false);
    expect(Env.settings.projects[beta]).toBeUndefined();
  }));

  test("invalid metadata is rejected before pinning and no-op removals never pin", async () => fixture(async ({ beta, workspace }) => {
    for (const name of ["", "  ", "a/b", "__proto__"]) expect(() => workspace.group(beta, name, true)).toThrow(/group/);
    expect(() => workspace.describe(beta, "x".repeat(2049))).toThrow(/2048/);
    expect(() => workspace.describe(beta, null)).toThrow(/string/);
    expect(() => workspace.pin(beta, "yes")).toThrow(/boolean/);
    workspace.describe(beta, "");
    workspace.group(beta, "none", false);
    expect(Env.settings.projects[beta]).toBeUndefined();
  }));

  test("borrowed canonical and isolated Envs survive close and live agents deduplicate initial first", async () => fixture(async ({ alpha, beta, env, initial, workspace, embedded, own }) => {
    const other = await embedded(beta);
    const borrowed = await other.agentCreate();
    const canonical = own(await Env.open(alpha));
    const canonicalAgent = await canonical.agentCreate();
    workspace.enroll(other);
    workspace.enroll(other);
    expect(workspace.agents()[0]).toBe(initial);
    expect(workspace.agents().filter((agent) => agent === initial)).toHaveLength(1);
    expect(workspace.agents()).toContain(borrowed);
    expect(workspace.agents()).toContain(canonicalAgent);
    expect(await workspace.open(beta)).toBe(other);
    const created = await workspace.add();
    const close = workspace.close();
    expect(workspace.close()).toBe(close);
    await close;
    expect(created.closed).toBe(true);
    expect(initial.closed).toBe(false);
    expect(borrowed.closed).toBe(false);
    expect(canonicalAgent.closed).toBe(false);
    expect(env.closed).toBe(false);
    expect(other.closed).toBe(false);
    expect(canonical.closed).toBe(false);
    await expect(workspace.open(beta)).rejects.toThrow(/closed/);
  }));

  test("own adopts App-created Agents without adopting their Env or changing the selection", async () => fixture(async ({ beta, env, initial, workspace, embedded }) => {
    const other = await embedded(beta);
    const adopted = await other.agentCreate();
    const unrelated = await other.agentCreate();
    expect(workspace.own(adopted)).toBe(adopted);
    expect(workspace.own(adopted)).toBe(adopted);
    expect(() => workspace.own({ env: other })).toThrow(/invalid/);
    const closed = await other.agentCreate();
    await closed.close();
    expect(() => workspace.own(closed)).toThrow(/closed/);
    await expect(workspace.closeProject(env.folder)).rejects.toThrow(/last/);
    const same = await workspace.add();
    expect(same.env).toBe(initial.env);
    await workspace.close();
    expect(adopted.closed).toBe(true);
    expect(unrelated.closed).toBe(false);
    expect(other.closed).toBe(false);
    expect(initial.closed).toBe(false);
    expect(() => workspace.own(unrelated)).toThrow(/closed/);
  }));

  test("close cancels owned busy Agents without interrupting borrowed busy Agents", async () => fixture(async ({ env, workspace }) => {
    const owned = await busyAgent(env);
    const borrowed = await busyAgent(env);
    workspace.own(owned.agent);
    try {
      await workspace.close();
      expect(owned.io.cancels).toBe(1);
      expect(owned.agent.closed).toBe(true);
      expect(borrowed.io.cancels).toBe(0);
      expect(borrowed.agent.busy).toBe(true);
      expect(borrowed.agent.closeMarked).toBe(false);
      expect(env.closed).toBe(false);
    } finally {
      await Promise.all([owned.finish(), borrowed.finish()]);
    }
  }));

  test("closed borrowed canonical projects stay hidden until reopened enrolled or remembered", async () => fixture(async ({ alpha, beta, initial, workspace, own }) => {
    const target = own(await Env.open(beta));
    const borrowed = await target.agentCreate();
    workspace.enroll(target);
    workspace.pin(beta, true);
    expect(workspace.agents()).toContain(borrowed);
    expect(await workspace.closeProject(beta)).toBe(initial);
    expect(target.closed).toBe(false);
    expect(borrowed.closed).toBe(false);
    expect(Env.envs[beta]).toBe(target);
    expect(Env.settings.projects[beta]).toBeDefined();
    expect(workspace.projects().some((record) => record.path === beta)).toBe(false);
    expect(workspace.agents()).not.toContain(borrowed);
    expect(await workspace.open(beta)).toBe(target);
    expect(workspace.projects().some((record) => record.path === beta)).toBe(true);
    await workspace.closeProject(beta);
    workspace.enroll(target);
    expect(workspace.agents()).toContain(borrowed);
    await workspace.closeProject(beta);
    workspace.remember(borrowed);
    expect(workspace.projects().some((record) => record.path === beta)).toBe(true);
    expect(await workspace.closeProject(alpha)).toBe(borrowed);
    expect(initial.closed).toBe(false);
    expect(workspace.agents()).not.toContain(initial);
    expect(workspace.projects().some((record) => record.path === alpha)).toBe(false);
    expect(await workspace.open(alpha)).toBe(initial.env);
    expect(workspace.agents()).toContain(initial);
  }));

  test("closeProject accepts a visible canonical project before enrollment without adopting its resources", async () => fixture(async ({ beta, initial, workspace, own }) => {
    const canonical = own(await Env.open(beta));
    const borrowed = await canonical.agentCreate();
    expect(workspace.projects().find((record) => record.path === beta)?.env).toBe(canonical);
    expect(await workspace.closeProject(beta)).toBe(initial);
    expect(canonical.closed).toBe(false);
    expect(borrowed.closed).toBe(false);
    expect(workspace.projects().some((record) => record.path === beta)).toBe(false);
    expect(workspace.agents()).not.toContain(borrowed);
    await expect(workspace.closeProject(beta)).rejects.toThrow(/unknown/);
    expect(workspace.projects().some((record) => record.path === beta)).toBe(false);
    expect(await workspace.open(beta)).toBe(canonical);
    expect(workspace.agents()).toContain(borrowed);
  }));

  test("closing a nonviewed project preserves the viewed Agent instead of choosing the first enrolled Env", async () => fixture(async ({ beta, gamma, env, initial, workspace, embedded }) => {
    const middle = await embedded(beta);
    const currentEnv = await embedded(gamma);
    workspace.enroll(middle);
    const current = await currentEnv.agentCreate({ model: "workspace/beta" });
    workspace.remember(current);
    const before = env.agents().length + currentEnv.agents().length;
    expect(await workspace.closeProject(beta)).toBe(current);
    expect(env.agents().length + currentEnv.agents().length).toBe(before);
    expect(initial.closed).toBe(false);
    expect(current.closed).toBe(false);
    expect((await workspace.add()).env).toBe(currentEnv);
    expect(workspace.projects().some((record) => record.path === beta)).toBe(false);
  }));

  test("select remembers live Agents and otherwise chooses roots then creates project defaults", async () => fixture(async ({ beta, workspace, embedded }) => {
    const other = await embedded(beta);
    workspace.enroll(other);
    const root = await other.agentCreate({ model: "workspace/beta" });
    const child = await root.childCreate({ name: "worker", model: "workspace/alpha" });
    expect(await workspace.select(beta)).toBe(root);
    workspace.remember(child);
    expect(await workspace.select(beta)).toBe(child);
    await child.close();
    expect(await workspace.select(beta)).toBe(root);
    await root.close();
    const fresh = await workspace.select(beta);
    expect(fresh.parent).toBeUndefined();
    expect(fresh.model).toBe("workspace/beta");
    expect(fresh.context.id).toMatch(/^[0-9a-f-]{36}$/);
  }));

  test("add inherits viewed capabilities model and thinking but different projects use their own defaults", async () => fixture(async ({ beta, initial, workspace, embedded }) => {
    initial.can.write = false;
    initial.can.delegate = false;
    initial.can.interact = false;
    initial.thinking = "high";
    const same = await workspace.add({ safe: false });
    expect(same.parent).toBeUndefined();
    expect(same.model).toBe(initial.model);
    expect(same.thinking).toBe("high");
    expect(same.can).toMatchObject({ write: false, delegate: false, interact: false });
    expect(same.context.id).toBeUndefined();
    expect(same.context.save).toBe(false);
    const logged = await workspace.add({ anonymous: false });
    expect(logged.context.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(logged.context.save).toBe(true);
    const inheritedLogged = await workspace.add();
    expect(inheritedLogged.context.id).toMatch(/^[0-9a-f-]{36}$/);
    const other = await embedded(beta, { providers: { own: { provider: "openai", models: { z: {}, a: {} } } } });
    const different = await workspace.add({ env: other });
    expect(different.model).toBe("own/a");
    expect(different.thinking).toBeUndefined();
    expect(different.can.interact).toBe(true);
    expect(different.context.save).toBe(true);
    expect(different.context.id).toMatch(/^[0-9a-f-]{36}$/);
    const explicit = await workspace.add({ model: "own/z", safe: true, anonymous: true });
    expect(explicit.model).toBe("own/z");
    expect(explicit.can.write).toBe(false);
    expect(explicit.context.id).toBeUndefined();
    const before = other.agents().length;
    await expect(workspace.add({ model: "missing/model" })).rejects.toThrow(/unknown endpoint/);
    await expect(workspace.add({ model: null })).rejects.toThrow();
    await expect(workspace.add({ safe: "yes" })).rejects.toThrow(/boolean/);
    await expect(workspace.add(null)).rejects.toThrow(/object/);
    expect(other.agents()).toHaveLength(before);
  }));

  test("closeProject refuses last and busy projects and only closes workspace-created borrowed Agents", async () => fixture(async ({ beta, env, initial, workspace, embedded }) => {
    await expect(workspace.closeProject(env.folder)).rejects.toThrow(/last/);
    const other = await embedded(beta);
    const borrowed = await other.agentCreate();
    const created = await workspace.add({ env: other });
    workspace.pin(beta, true);
    const busy = await busyAgent(other);
    try {
      await expect(workspace.closeProject(beta)).rejects.toThrow(/busy/);
      expect(created.closed).toBe(false);
      expect(borrowed.closed).toBe(false);
    } finally { await busy.finish(); }
    expect(await workspace.closeProject(beta)).toBe(initial);
    expect(created.closed).toBe(true);
    expect(borrowed.closed).toBe(false);
    expect(busy.agent.closed).toBe(false);
    expect(other.closed).toBe(false);
    expect(Env.settings.projects[beta]).toBeDefined();
    await expect(workspace.closeProject(env.folder)).rejects.toThrow(/last/);
  }));

  test("closeProject releases owned Envs and all their Agents and creates a replacement when needed", async () => fixture(async ({ beta, initial, workspace }) => {
    const target = await workspace.open(beta);
    const outside = await target.agentCreate();
    const owned = await workspace.add({ env: target });
    await initial.close();
    const replacement = await workspace.closeProject(beta);
    expect(replacement.closed).toBe(false);
    expect(replacement.env.folder).toBe(initial.env.folder);
    expect(replacement).not.toBe(initial);
    expect(outside.closed).toBe(true);
    expect(owned.closed).toBe(true);
    expect(target.closed).toBe(true);
    await workspace.close();
    expect(replacement.closed).toBe(true);
  }));

  test("replacement creation failure leaves a project and its Agents open without leaked Agents", async () => fixture(async ({ beta, env, initial, workspace }) => {
    const other = await workspace.open(beta);
    const agent = await workspace.add({ env: other });
    await initial.close();
    const original = env.agentCreate;
    env.agentCreate = async () => { throw new Error("cannot create replacement"); };
    try {
      await expect(workspace.closeProject(beta)).rejects.toThrow(/cannot create replacement/);
      expect(agent.closed).toBe(false);
      expect(other.closed).toBe(false);
      expect(env.agents()).toHaveLength(0);
    } finally { env.agentCreate = original; }
  }));
});

describe("TUI workspace saved sessions", () => {
  test("lists all origins, deduplicates shared dir+origin and renames/deletes offline without foreign access", async () => fixture(async ({ alpha, beta, sessions, workspace, embedded, own }) => {
    const other = await embedded(beta);
    workspace.enroll(other);
    // An independently registered Env of the same origin shares the directory.
    await writeFile(join(alpha, NAMES.projectSettings), JSON.stringify({ sessions }));
    own(await Env.open(alpha));
    const saved = await other.agentCreate({ contextId: "offline" });
    saved.context.append(Context.messageUser("offline history"));
    await saved.close();
    const local = new Context({ id: "local", dir: sessions, origin: alpha });
    local.append(Context.messageUser("local history"));
    await local.close();
    const foreign = new Context({ id: "foreign", dir: sessions, origin: resolve(".") });
    foreign.append(Context.messageUser("foreign history"));
    await foreign.close();
    const records = await workspace.sessions();
    expect(records.filter((record) => record.id === "local")).toHaveLength(1);
    expect(records.filter((record) => record.id === "offline")).toHaveLength(1);
    expect(records.some((record) => record.id === "foreign")).toBe(false);
    const offline = records.find((record) => record.id === "offline");
    expect(offline).toMatchObject({ env: other, project: beta, projectName: other.name, name: "offline", live: null });
    const renamed = await workspace.renameSession(offline, "renamed");
    expect(renamed.id).toBe("renamed");
    expect(Context.list({ dir: sessions, cwd: beta }).map((record) => record.id)).toEqual(["renamed"]);
    const current = (await workspace.sessions()).find((record) => record.id === "renamed");
    expect(await workspace.deleteSession(current)).toEqual({ deleted: 1 });
    expect(Context.list({ dir: sessions, cwd: beta })).toHaveLength(0);
    await expect(workspace.deleteSession({ id: "foreign", env: other })).rejects.toThrow(/foreign/);
    await expect(workspace.deleteSession({ id: "unknown", env: other })).rejects.toThrow(/unknown/);
    await expect(workspace.renameSession({ ...offline, id: "local", project: alpha }, "bad")).rejects.toThrow(/foreign/);
    await expect(workspace.resume({ ...offline, dir: join(sessions, "elsewhere") })).rejects.toThrow(/directory/);
    expect(Context.list({ dir: sessions }).some((record) => record.id === "foreign")).toBe(true);
  }));

  test("resume reuses existing writers across isolated and canonical Envs and concurrent resumes create only one", async () => fixture(async ({ alpha, sessions, env, workspace, own }) => {
    await writeFile(join(alpha, NAMES.projectSettings), JSON.stringify({ sessions }));
    const canonical = own(await Env.open(alpha));
    const borrowed = await canonical.agentCreate({ contextId: "borrowed" });
    borrowed.context.append(Context.messageUser("keep saved history"));
    borrowed.context.flush();
    let record = (await workspace.sessions()).find((item) => item.id === "borrowed");
    expect(record.env).toBe(env);
    expect(await workspace.resume(record)).toBe(borrowed);
    const before = canonical.agents().length + env.agents().length;
    expect(await workspace.resume(record)).toBe(borrowed);
    expect(canonical.agents().length + env.agents().length).toBe(before);
    await borrowed.close();
    const oldFile = await readFile(record.file, "utf8");
    record = (await workspace.sessions()).find((item) => item.id === "borrowed");
    const [first, second] = await Promise.all([workspace.resume(record), workspace.resume(record)]);
    expect(first).toBe(second);
    expect(first.context.messages()).toContainEqual(Context.messageUser("keep saved history"));
    expect(await readFile(record.file, "utf8")).toBe(oldFile);
    await workspace.close();
    expect(first.closed).toBe(true);
  }));

  test("resuming does not close a current busy Agent and deleting refuses busy saved owners", async () => fixture(async ({ env, workspace }) => {
    const saved = await env.agentCreate({ contextId: "saved" });
    saved.context.append(Context.messageUser("saved history"));
    await saved.close();
    const busy = await busyAgent(env, { contextId: "running" });
    busy.agent.context.flush();
    workspace.remember(busy.agent);
    try {
      const records = await workspace.sessions();
      const running = records.find((record) => record.id === "running");
      const resumed = await workspace.resume(records.find((record) => record.id === "saved"));
      expect(resumed.context.id).toBe("saved");
      expect(busy.agent.busy).toBe(true);
      expect(busy.agent.closeMarked).toBe(false);
      await expect(workspace.deleteSession(running)).rejects.toThrow(/busy/);
      expect(busy.agent.closeMarked).toBe(false);
    } finally { await busy.finish(); }
    const running = (await workspace.sessions()).find((record) => record.id === "running");
    expect(await workspace.deleteSession(running)).toEqual({ deleted: 1 });
    expect(busy.agent.closed).toBe(true);
  }));

  test("live rename uses the owned Context and delete closes idle duplicate owners before removing files", async () => fixture(async ({ env, workspace, sessions }) => {
    const saved = await env.agentCreate({ contextId: "live" });
    saved.context.append(Context.messageUser("history"));
    saved.context.flush();
    const record = (await workspace.sessions()).find((item) => item.id === "live");
    expect(record.live).toBe(saved);
    expect((await workspace.renameSession(record, "renamed-live")).id).toBe("renamed-live");
    expect(saved.context.id).toBe("renamed-live");
    const duplicate = await env.agentCreate({ contextId: "renamed-live" });
    const renamed = (await workspace.sessions()).find((item) => item.id === "renamed-live");
    await expect(workspace.renameSession(renamed, "unsafe")).rejects.toThrow(/multiple/);
    expect(await workspace.deleteSession(renamed)).toEqual({ deleted: 1 });
    expect(saved.closed).toBe(true);
    expect(duplicate.closed).toBe(true);
    expect(Context.list({ dir: sessions, cwd: env.folder })).toHaveLength(0);
  }));
});
