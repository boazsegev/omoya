import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
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
  test("maps each open folder to its one Env; close() deregisters, idempotently", () => {
    const a = new Env({ cwd: folder() });
    const b = new Env({ cwd: folder() });
    const envs = Env.envs;
    expect(Object.isFrozen(envs)).toBe(true);
    expect(envs[a.cwd]).toBe(a);
    expect(Object.keys(envs).indexOf(b.cwd)).toBeGreaterThan(Object.keys(envs).indexOf(a.cwd)); // creation order
    expect(() => new Env({ cwd: a.cwd })).toThrow("already has an open Env");
    a.close();
    a.close();
    expect(a.closed).toBe(true);
    expect(Env.envs[a.cwd]).toBeUndefined();
    expect(envs[a.cwd]).toBe(a); // snapshots never change
    expect(new Env({ cwd: a.cwd }).closed).toBe(false); // the folder is free again
    b.close();
  });

  test("cwd is the absolute, fixed registry key", () => {
    const env = new Env({ cwd: folder() });
    expect(() => { env.cwd = "/"; }).toThrow();
    env.close();
  });

  test("names are the shortest unique path suffixes", () => {
    const base = folder();
    const one = new Env({ cwd: folder() });
    const fiz = new Env({ cwd: join(base, "fiz", "bar", "foo") });
    expect(fiz.name).toBe("foo");
    const faz = new Env({ cwd: join(base, "faz", "bar", "foo") });
    expect([fiz.name, faz.name]).toEqual(["fiz/bar/foo", "faz/bar/foo"]);
    faz.close();
    expect(fiz.name).toBe("foo");
    one.close();
    fiz.close();
  });

  test("a rejected construction registers nothing", () => {
    const cwd = folder();
    expect(() => new Env({ cwd, sessionsDir: "" })).toThrow(TypeError);
    expect(Env.envs[cwd]).toBeUndefined();
  });

  test("Env.create closes its Env when loading fails", async () => {
    const cwd = folder();
    await expect(Env.create({ cwd, toolDirs: [42] })).rejects.toThrow();
    expect(Env.envs[cwd]).toBeUndefined();
  });

  test("Env.use borrows an open Env or creates one, closing it unless agents joined", async () => {
    const cwd = folder();
    expect(await Env.use(cwd, (env) => env.cwd)).toBe(cwd);
    expect(Env.envs[cwd]).toBeUndefined();
    let kept;
    await Env.use(cwd, (env) => { kept = env.agentCreate(); });
    expect(Env.envs[cwd]).toBe(kept.env);
    expect(await Env.use(cwd, (env) => env)).toBe(kept.env);
    kept.close();
    kept.env.close();
  });

  test("tools without an Env use the root folder's Env, closed afterwards", async () => {
    expect(Env.envs["/"]).toBeUndefined();
    expect(await skill({})).toBeString();
    expect(Env.envs["/"]).toBeUndefined();
  });

  test("an Agent without an Env shares the process folder's Env; the last one closes it", () => {
    const owned = new Agent();
    const other = new Agent();
    expect(other.env).toBe(owned.env);
    expect(Env.envs[process.cwd()]).toBe(owned.env);
    owned.close();
    expect(owned.env.closed).toBe(false);
    other.close();
    expect(owned.env.closed).toBe(true);

    const env = new Env();
    expect(new Agent().env).toBe(env); // the open folder Env is reused, never closed by its agents
    for (const agent of env.agents()) agent.close();
    expect(env.closed).toBe(false);
    env.close();
  });

  test("an Agent rejected after creating its own Env closes that Env", () => {
    expect(() => new Agent({ model: "missing/m" })).toThrow();
    expect(Env.envs[process.cwd()]).toBeUndefined();
  });

  test("a closed Env refuses agentCreate and childCreate", () => {
    const env = new Env({ cwd: folder() });
    const parent = env.agentCreate();
    env.close();
    expect(env.closed).toBe(true);
    const before = env.agents().length;
    expect(() => env.agentCreate()).toThrow("Env is closed");
    expect(() => parent.childCreate({ name: "w" })).toThrow("Env is closed");
    expect(env.agents()).toHaveLength(before);
    expect(parent.children).toHaveLength(0);
    parent.close();
  });

  test("names reading as addresses or privileged identities are reserved, any case or disguise", () => {
    const env = new Env({ cwd: folder() });
    const reserved = ["new", "NEW", " new ", "all", "Everyone", "assistant", "Tool", "omoya",
      "user", "User-2", "users", "superuser", "my_user", "admin", "SysAdmin", "ad-min", "ａｄｍｉｎ", "\u0430dmin", "adm\u200bin", "ädmin".normalize("NFD").replace("a\u0308", "a\u0301"),
      "group", "workgroup", "Group-Lead", "root", "sudo", "system", "developer", "owner", "operator", "supervisor", "moderator", "privileged", "authorized"];
    for (const name of reserved) expect(() => env.agentCreate({ name })).toThrow("reserved");
    for (const name of ["newbie", "builder", "reviewer", "agent-7", "author", "tools-check"]) env.agentCreate({ name }).close();
    const agent = env.agentCreate({ name: "newbie" });
    expect(() => { agent.name = "uSeR"; }).toThrow("reserved");
    expect(() => agent.childCreate({ name: "new" })).toThrow("reserved");
    expect(agent.name).toBe("newbie");
    agent.close();
    env.close();
  });
});
