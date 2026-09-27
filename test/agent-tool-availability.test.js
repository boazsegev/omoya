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
import { providerAdd, toolExists, toolNames, toolSchemas } from "./env-internals.js";

let env;
afterEach(() => { env = null; });

async function toolsEnv() {
  env = await testEnv();
  env.toolAdd("alpha", () => "A", { description: "a", inputSchema: { type: "object" } });
  env.toolAdd("beta", () => "B", { description: "b", inputSchema: { type: "object" } });
  return env;
}

describe("tool availability selection", () => {
  test("omitted and [\"*\"] expose all current tools", async () => {
    const e = await toolsEnv();
    const all = ["tool-refresh", "alpha", "beta"];
    expect(toolSchemas(e).map((t) => t.name)).toEqual(all);
    expect(toolSchemas(e, ["*"]).map((t) => t.name)).toEqual(all);
    expect(toolNames(e)).toEqual(all);
  });

  test("[] exposes none", async () => {
    const e = await toolsEnv();
    expect(toolSchemas(e, [])).toEqual([]);
  });

  test("explicit list exposes only recognized names", async () => {
    const e = await toolsEnv();
    expect(toolSchemas(e, ["alpha", "nope"]).map((t) => t.name)).toEqual(["alpha"]);
    expect(toolSchemas(e, ["beta"])).toEqual([{ name: "beta", description: "b", inputSchema: { type: "object" } }]);
  });

  test("callTool dispatches by exact flattened lookup", async () => {
    const e = await toolsEnv();
    expect(await e.toolCall("alpha", {})).toBe("A");
    await expect(e.toolCall("alph", {})).rejects.toThrow(/unknown tool/); // misspelling
    await expect(e.toolCall("tool-refresh.x", {})).rejects.toThrow(/unknown tool/); // no path parsing
  });

  test("tool-refresh is always registered; availability decides visibility only", async () => {
    const e = await toolsEnv();
    expect(toolExists(e, "tool-refresh")).toBe(true);
    expect(toolSchemas(e, ["alpha"]).map((t) => t.name)).toEqual(["alpha"]); // hidden from model
    const result = await e.toolCall("tool-refresh", {}); // dispatch still exact
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
    providerAdd(e, "x", Protocol);
    e._endpoints.x = { provider: "x", url: "test://x" };
    const all = new IO({ env: e, model: "x/m" });
    const none = new IO({ env: e, model: "x/m", tools: [] });
    const some = new IO({ env: e, model: "x/m", tools: ["alpha"] });
    // each request snapshots Env.tools() once (lib/io/request.js)
    for (const io of [all, none, some]) io._toolCatalog = await e.tools();
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
    expect(agent.context.at(2)).toMatchObject({ type: 4, name: "beta", content: [{ type: "text", text: "B" }] });
  });
});
