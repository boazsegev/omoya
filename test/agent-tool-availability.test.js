// test/agent-tool-availability.test.js — proof for per-Agent tool
// availability: omitted/["*"] = all, [] = none, explicit = recognized
// subset; toolNames(), toolSchemas(names), callTool(name, args) exact
// lookup; the built-in tool-refresh is always registered while
// availability still decides what a model is shown.
import { describe, expect, test, afterEach } from "bun:test";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

let env;
afterEach(() => { env = null; });

async function toolsEnv() {
  env = await testEnv();
  env.registerTool("alpha", () => "A", { description: "a", inputSchema: { type: "object" } });
  env.registerTool("beta", () => "B", { description: "b", inputSchema: { type: "object" } });
  return env;
}

describe("tool availability selection", () => {
  test("omitted and [\"*\"] expose all current tools", async () => {
    const e = await toolsEnv();
    const all = ["tool-refresh", "alpha", "beta"];
    expect(e.toolSchemas().map((t) => t.name)).toEqual(all);
    expect(e.toolSchemas(["*"]).map((t) => t.name)).toEqual(all);
    expect(e.toolNames()).toEqual(all);
  });

  test("[] exposes none", async () => {
    const e = await toolsEnv();
    expect(e.toolSchemas([])).toEqual([]);
  });

  test("explicit list exposes only recognized names", async () => {
    const e = await toolsEnv();
    expect(e.toolSchemas(["alpha", "nope"]).map((t) => t.name)).toEqual(["alpha"]);
    expect(e.toolSchemas(["beta"])).toEqual([{ name: "beta", description: "b", inputSchema: { type: "object" } }]);
  });

  test("callTool dispatches by exact flattened lookup", async () => {
    const e = await toolsEnv();
    expect(await e.callTool("alpha", {})).toBe("A");
    await expect(e.callTool("alph", {})).rejects.toThrow(/unknown tool/); // misspelling
    await expect(e.callTool("tool-refresh.x", {})).rejects.toThrow(/unknown tool/); // no path parsing
  });

  test("tool-refresh is always registered; availability decides visibility only", async () => {
    const e = await toolsEnv();
    expect(e.hasTool("tool-refresh")).toBe(true);
    expect(e.toolSchemas(["alpha"]).map((t) => t.name)).toEqual(["alpha"]); // hidden from model
    const result = await e.callTool("tool-refresh", {}); // dispatch still exact
    expect(result.refreshed).toBe(true);
    // refresh rebuilds from disk roots: manual registrations drop, built-ins stay
    expect(result.tools).toContain("tool-refresh");
    expect(result.tools).not.toContain("alpha");
  });
});

describe("availability flows into the request (IO tools())", () => {
  test("IO applies its per-instance selection to the catalog", async () => {
    const e = await toolsEnv();
    class Protocol {}
    e.registerProvider("x", Protocol);
    e.endpoints.x = { provider: "x", url: "test://x" };
    const all = new IO({ env: e, model: "x/m" });
    const none = new IO({ env: e, model: "x/m", tools: [] });
    const some = new IO({ env: e, model: "x/m", tools: ["alpha"] });
    expect(all.tools().map((t) => t.name)).toEqual(["tool-refresh", "alpha", "beta"]);
    expect(none.tools()).toEqual([]);
    expect(some.tools().map((t) => t.name)).toEqual(["alpha"]);
  });

  test("Agent passes its availability selection to the IO factory", async () => {
    const e = await toolsEnv();
    let seen;
    const io = scriptedIO([[...TEXT(0, "ok"), { type: "done" }]]);
    const agent = new Agent({
      env: e, model: "p/m", tools: ["alpha"], context: [USER("hi")],
      createIO: (opts) => { seen = opts; return io; },
    });
    await agent.run();
    expect(seen.tools).toEqual(["alpha"]);
  });

  test("a tool the model cannot see still resolves by exact dispatch when called", async () => {
    const e = await toolsEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "beta", {}), { type: "done" }], // beta NOT in availability
      [{ type: "done" }],
    ]);
    const agent = new Agent({
      env: e, model: "p/m", tools: ["alpha"], context: [USER("hi")],
      createIO: () => io,
    });
    await agent.run();
    expect(agent.context[2]).toMatchObject({ type: 4, name: "beta", content: [{ type: "text", text: "B" }] });
  });
});
