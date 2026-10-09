import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { skill } from "../tools/skill.js";

const folder = (...names) => {
  const path = join(mkdtempSync(resolve("ai-tmp/envs-")), ...names);
  mkdirSync(path, { recursive: true });
  return path;
};

describe("Env.envs process registry", () => {
  test("path-only Env.open returns the project Env under any path naming it", async () => {
    const cwd = folder("project");
    const link = join(folder(), "link");
    symlinkSync(cwd, link);
    const env = await Env.open(cwd);
    try {
      expect(await Env.open(cwd)).toBe(env);
      expect(await Env.open(link)).toBe(env);
      expect(await Env.open(cwd, { settingsDir: null, init: { providers: false, tools: false } })).not.toBe(env);
    } finally { await env.close(); }
  });


  test("maps each open folder to its one Env; close() deregisters, idempotently", async () => {
    const a = await Env.open(folder(), {  });
    const b = await Env.open(folder(), {  });
    const envs = Env.envs;
    expect(Object.isFrozen(envs)).toBe(true);
    expect(envs[a.folder]).toBe(a);
    expect(Object.keys(envs).indexOf(b.folder)).toBeGreaterThan(Object.keys(envs).indexOf(a.folder)); // creation order
    expect(await Env.open(a.folder)).toBe(a);
    const firstClose = a.close();
    const secondClose = a.close();
    expect(a.closed).toBe(true);
    expect(Env.envs[a.folder]).toBeUndefined();
    expect(envs[a.folder]).toBe(a); // snapshots never change
    const replacement = await Env.open(a.folder, {  });
    expect(replacement.closed).toBe(false); // the folder is free again
    await Promise.all([firstClose, secondClose]);
    await Promise.all([replacement.close(), b.close()]);
  });

  test("folder is the absolute, fixed registry key", async () => {
    const env = await Env.open(folder(), {  });
    expect(() => { env.folder = "/"; }).toThrow();
    await env.close();
  });

  test("names are the shortest unique path suffixes", async () => {
    const base = folder();
    const one = await Env.open(folder(), {  });
    const fiz = await Env.open(join(base, "fiz", "bar", "foo"), {  });
    expect(fiz.name).toBe("foo");
    const faz = await Env.open(join(base, "faz", "bar", "foo"), {  });
    expect([fiz.name, faz.name]).toEqual(["fiz/bar/foo", "faz/bar/foo"]);
    await faz.close();
    expect(fiz.name).toBe("foo");
    await Promise.all([one.close(), fiz.close()]);
  });

  test("a rejected construction registers nothing", async () => {
    const cwd = folder();
    await expect(Env.open(cwd, { sessionsDir: "" })).rejects.toThrow(TypeError);
    expect(Env.envs[cwd]).toBeUndefined();
  });

  test("Env.open releases a failed project startup", async () => {
    const cwd = folder();
    await expect(Env.open(cwd, { toolDirs: [42] })).rejects.toThrow();
    expect(Env.envs[cwd]).toBeUndefined();
  });

  test("Env.open callers explicitly own close, even while Agents are registered", async () => {
    const cwd = folder();
    const env = await Env.open(cwd);
    const agent = await env.agentCreate();
    expect(Env.envs[cwd]).toBe(env);
    await agent.close();
    expect(env.closed).toBe(false);
    await env.close();
    expect(Env.envs[cwd]).toBeUndefined();
  });

  test("tools without an Env use the root folder's Env, closed afterwards", async () => {
    expect(Env.envs["/"]).toBeUndefined();
    expect(await skill({})).toBeString();
    expect(Env.envs["/"]).toBeUndefined();
  });

  test("Agent.open shares a project Env but Agents never close it", async () => {
    const owned = await Agent.create();
    const other = await Agent.create();
    const env = owned.env;
    expect(other.env).toBe(env);
    expect(Env.envs[process.cwd()]).toBe(env);
    await owned.close();
    await other.close();
    expect(env.closed).toBe(false);
    await env.close();
  });

  test("a rejected Agent.open leaves its acquired Env for the caller to close", async () => {
    const cwd = folder();
    await expect(Agent.create({ cwd, model: "missing/m" })).rejects.toThrow();
    const env = Env.envs[cwd];
    expect(env).toBeDefined();
    await env.close();
    expect(Env.envs[cwd]).toBeUndefined();
  });

  test("a closed Env refuses agentCreate and childCreate", async () => {
    const env = await Env.open(folder(), {  });
    const parent = await env.agentCreate();
    const closed = env.close();
    expect(env.closed).toBe(true);
    const before = env.agents().length;
    await expect(env.agentCreate()).rejects.toThrow("Env is closed");
    await expect(parent.childCreate({ name: "w" })).rejects.toThrow("Env is closed");
    expect(env.agents()).toHaveLength(before);
    expect(parent.children).toHaveLength(0);
    await closed;
    await parent.close();
  });

  test("names reading as addresses or privileged identities are reserved, any case or disguise", async () => {
    const env = await Env.open(folder(), {  });
    const reserved = ["new", "NEW", " new ", "all", "Everyone", "assistant", "Tool", "omoya",
      "user", "User-2", "users", "superuser", "my_user", "admin", "SysAdmin", "ad-min", "ａｄｍｉｎ", "\u0430dmin", "adm\u200bin", "ädmin".normalize("NFD").replace("a\u0308", "a\u0301"),
      "group", "workgroup", "Group-Lead", "root", "sudo", "system", "developer", "owner", "operator", "supervisor", "moderator", "privileged", "authorized"];
    for (const name of reserved) await expect(env.agentCreate({ name })).rejects.toThrow("reserved");
    await Promise.all(["newbie", "builder", "reviewer", "agent-7", "author", "tools-check"]
      .map(async (name) => (await env.agentCreate({ name })).close()));
    const agent = await env.agentCreate({ name: "newbie" });
    expect(() => { agent.name = "uSeR"; }).toThrow("reserved");
    await expect(agent.childCreate({ name: "new" })).rejects.toThrow("reserved");
    expect(agent.name).toBe("newbie");
    await agent.close();
    await env.close();
  });
});
