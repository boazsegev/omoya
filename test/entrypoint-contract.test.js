import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Agent, * as Core from "../lib/agent.js";
import Full, * as Application from "../lib/app.js";
import Jobs from "../lib/jobs.js";
import CLI, { finishSignalsArm } from "../lib/app/cli.js";

describe("0.3.0 library entrypoints", () => {
  test("the package publishes only core and application facades", () => {
    const { exports } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(exports).toEqual({ ".": "./lib/agent.js", "./agent": "./lib/agent.js", "./app": "./lib/app.js" });
    for (const barrel of ["../lib/index.js", "../lib/index_app.js"]) {
      expect(existsSync(fileURLToPath(new URL(barrel, import.meta.url)))).toBe(false);
    }
  });

  test("named and default core symbols have identical identities and no UI surface", () => {
    expect(Core.default).toBe(Core.Agent);
    expect(Core.Agent).toBe(Agent);
    expect(Agent.Jobs).toBe(Jobs);
    expect(Agent.Context).toBeDefined();
    expect(Agent.Env).toBeDefined();
    expect(Agent.IO).toBeDefined();
    for (const name of ["Context", "Env", "IO", "Jobs", "NAMES", "EVENT", "EVENT_CALLBACKS", "finishAdd", "finishRun"]) {
      expect(Agent[name], name).toBeDefined();
      expect(Object.hasOwn(Core, name), `core export ${name}`).toBe(false);
    }
    expect(Core.finishSignalsArm).toBeUndefined();
    expect(Agent.finishSignalsArm).toBeUndefined();
    for (const name of ["App", "CLI", "GTUI", "TUI", "Web", "Markdown"]) {
      expect(Core[name]).toBeUndefined();
      expect(Agent[name]).toBeUndefined();
    }
  });

  test("application extends core while keeping presentation under App", () => {
    expect(Object.keys(Application).sort()).toEqual(["Agent", "App", "default"]);
    expect(Object.keys(Full).sort()).toEqual(["Agent", "App"]);
    expect(Object.isFrozen(Full)).toBe(true);
    expect(Full.Agent).toBe(Application.Agent);
    expect(Full.App).toBe(Application.App);
    expect(Full.Agent).toBe(Agent);
    for (const name of ["Context", "Env", "IO", "Jobs", "NAMES", "EVENT", "EVENT_CALLBACKS", "finishAdd", "finishRun"]) {
      expect(Object.hasOwn(Full, name), `application facade ${name}`).toBe(false);
      expect(Object.hasOwn(Application, name), `application export ${name}`).toBe(false);
      expect(Full.Agent[name]).toBe(Agent[name]);
    }
    expect(Full.App.CLI).toBe(CLI);
    expect(Full.finishSignalsArm).toBeUndefined();
    expect(Application.finishSignalsArm).toBeUndefined();
    expect(Full.App.CLI.finishSignalsArm).toBe(finishSignalsArm);
    for (const name of ["CLI", "GTUI", "TUI", "Web", "Markdown"]) expect(Full[name]).toBeUndefined();
  });

  test("fresh imports expose exactly the two entrypoint shapes without flattened aliases", () => {
    const script = `
      const core = await import("./lib/agent.js");
      const app = await import("./lib/app.js");
      const expectedCore = ["Agent", "default"];
      const expectedApp = ["Agent", "App", "default"];
      if (JSON.stringify(Object.keys(core).sort()) !== JSON.stringify(expectedCore)) throw new Error("core: " + Object.keys(core));
      if (JSON.stringify(Object.keys(app).sort()) !== JSON.stringify(expectedApp)) throw new Error("app: " + Object.keys(app));
      if (core.default !== core.Agent || app.Agent !== core.Agent) throw new Error("Agent identity");
      if (JSON.stringify(Object.keys(app.default).sort()) !== JSON.stringify(["Agent", "App"])) throw new Error("default app aliases");
      if (!Object.isFrozen(app.default)) throw new Error("default app is mutable");
      for (const name of ["Context", "Env", "IO", "Jobs", "NAMES", "EVENT", "finishAdd", "finishRun"]) {
        if (!core.Agent[name]) throw new Error("missing Agent." + name);
        if (name in app.default || name in core) throw new Error("flattened alias " + name);
      }
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("Jobs and its tools import before Agent initializes in a fresh process", () => {
    for (const module of ["./lib/jobs.js", "./tools/job-schedule.js", "./tools/worker-create.js"]) {
      const script = `await import(${JSON.stringify(module)}); const { default: Agent } = await import("./lib/agent.js"); if (!Agent.Jobs) throw new Error("Jobs missing");`;
      const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
      expect(result.exitCode, `${module}: ${result.stderr.toString()}`).toBe(0);
    }
  });

  test("core import graph cannot reach presentation modules", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../lib");
    const seen = new Set();
    const stack = [resolve(root, "agent.js")];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = await Bun.file(file).text();
      for (const { path: spec } of new Bun.Transpiler({ loader: "js" }).scanImports(source)) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (target.startsWith(root + "/")) stack.push(target);
      }
    }
    for (const file of seen) {
      expect(file.includes("/app/")).toBe(false);
      expect(file.endsWith("/app.js")).toBe(false);
      expect(file.endsWith("/cli.js")).toBe(false);
      expect(file.includes("/cli/")).toBe(false);
    }
  });
});
