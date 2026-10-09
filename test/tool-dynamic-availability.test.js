import { mkdtempSync } from "node:fs";
import { test, expect } from "bun:test";
import { Context } from "../lib/context.js";
import Env from "../lib/env.js";
import IO from "../lib/io.js";
import TestPlugin from "../providers/test.js";
import { providerAdd, toolEntry, toolSchemas } from "./env-internals.js";

test("dynamic eligibility refreshes before every real IO request while ordinary tools remain unchanged", async () => {
  const env = await Env.open(process.cwd(), { settingsDir: null, settings: { providers: { fixture: { provider: "fixture", url: "test://script" } } } });
  let enabled = true, checks = 0;
  const seen = [];
  class Probe extends TestPlugin {
    context2msg(context, aiio) { seen.push(aiio.tools().map((tool) => tool.name)); return super.context2msg(context, aiio); }
  }
  providerAdd(env, "fixture", Probe);
  const ordinary = () => "ordinary";
  env.toolAdd("ordinary", ordinary, { description: "ordinary", inputSchema: {} });
  env.toolAdd("dynamic", () => "dynamic", { description: "dynamic", inputSchema: {}, available: async () => { checks++; return enabled; } });
  env.settings.providers.fixture.script = [[{ text: "done" }]];
  const io = new IO({ env, model: "fixture/test-model" });
  const context = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
  expect((await io.write(new Context({ messages: context }))).type).toBe("done");
  enabled = false; expect((await io.write(new Context({ messages: context }))).type).toBe("done");
  enabled = true; expect((await io.write(new Context({ messages: context }))).type).toBe("done");
  expect(seen.map((names) => names.includes("dynamic"))).toEqual([true, false, true]);
  expect(seen.every((names) => names.includes("ordinary"))).toBe(true);
  expect(checks).toBe(3); expect(toolEntry(env, "ordinary").fn).toBe(ordinary);
  expect(toolSchemas(env).find((tool) => tool.name === "dynamic").available).toBeUndefined();
  enabled = false; await expect(env.toolCall("dynamic", {})).rejects.toThrow("not currently available");
  expect(await env.toolCall("ordinary", {})).toBe("ordinary");
});
