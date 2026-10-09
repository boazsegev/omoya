import { describe, expect, test } from "bun:test";
import Agent from "../lib/agent.js";
import IO from "../lib/io.js";
import { testEnv } from "./fakes.js";
import { providerAdd } from "./env-internals.js";

const schema = (description, extra = {}) => ({ description, safe: true, inputSchema: { type: "object", properties: { value: { type: "string", description: "A value." } } }, ...extra });

describe("Agent published tools", () => {
  test("returns a name-to-descriptor Map without hidden tools or execution metadata", async () => {
    const env = await testEnv();
    env.toolAdd("reader", () => "ok", schema("Reads", { storage: "private", detect: () => [], onTimeout: () => {} }));
    env.toolAdd("hidden", () => "ok", schema("Hidden", { secret: true }));
    const agent = await Agent.create({ env, can: { write: false } });
    try {
      const tools = await agent.tools;
      expect(tools).toBeInstanceOf(Map);
      expect([...tools.keys()]).toEqual(["tool-refresh", "reader"]);
      expect(tools.get("reader")).toEqual({ name: "reader", description: "Reads", inputSchema: schema().inputSchema });
      expect(agent._io.size).toBe(0); // inspection must not connect to a provider
      tools.clear();
      expect((await agent.tools).has("reader")).toBe(true);
    } finally { await agent.close(); }
  });

  test("shares IO publication semantics for selection, and dynamic availability", async () => {
    const env = await testEnv();
    let available = false;
    env.toolAdd("reader", () => "ok", schema("Reads"));
    env.toolAdd("dynamic", () => "ok", schema("Dynamic", { available: () => available }));
    env.toolAdd("writer", () => "ok", schema("Writes", { safe: false }));
    env.toolAdd("other", () => "ok", schema("Other"));
    const agent = await Agent.create({ env, can: { write: false }, tools: ["reader", "dynamic", "writer"] });
    const io = Object.create(IO.prototype);
    io._toolSelection = ["reader", "dynamic", "writer"];
    try {
      expect([...(await agent.tools).keys()]).toEqual(["reader", "writer"]);
      available = true;
      io._toolCatalog = await env.tools(false, agent.model);
      expect([...(await agent.tools).values()]).toEqual(io.tools());
      expect([...(await agent.tools).keys()]).toEqual(["reader", "dynamic", "writer"]);
      const none = await Agent.create({ env, can: { write: false }, tools: [] });
      const all = await Agent.create({ env, can: { write: false }, tools: ["*"] });
      try {
        expect((await none.tools).size).toBe(0);
        expect([...(await all.tools).keys()]).toEqual(["tool-refresh", "reader", "dynamic", "writer", "other"]);
      } finally { await none.close(); await all.close(); }
    } finally { await agent.close(); }
  });

  test("includes provider-only tools and provider schemas that shadow global tools", async () => {
    const env = await testEnv({ providers: { p: { provider: "test", models: { m: {} } } } });
    await env.ready();
    class Provider {
      static provider = { capabilities: { tools: {
        reader: { description: "Provider reader", safe: true, schema: { type: "object", properties: { query: { type: "string" } } }, function: () => "provider" },
        native: { description: "Native", safe: true, schema: { type: "object" }, function: () => "native" },
      } } };
    }
    providerAdd(env, "test", Provider);
    env.toolAdd("reader", () => "global", schema("Global"));
    const agent = await Agent.create({ env, model: "p/m", can: { write: false } });
    try {
      const tools = await agent.tools;
      expect(tools.get("reader").description).toBe("Provider reader");
      expect(tools.get("reader").inputSchema.properties).toEqual({ query: { type: "string" } });
      expect(tools.has("native")).toBe(true);
      const io = Object.create(IO.prototype);
      io._toolCatalog = await env.tools(false, "p/m");
      expect([...tools.values()]).toEqual(io.tools());
      env.settings.providers.tools = { native: false, reader: false };
      expect((await agent.tools).get("reader").description).toBe("Global");
      expect((await agent.tools).has("native")).toBe(false);
      agent.model = undefined;
      expect((await agent.tools).get("reader").description).toBe("Global");
      expect((await agent.tools).has("native")).toBe(false);
    } finally { await agent.close(); }
  });

  test("matches tools delivered to the provider during a real IO request without injecting conversation messages", async () => {
    const env = await testEnv();
    const sent = [];
    class Provider {
      static provider = {};
      constructor(url, io) { this.io = io; this.done = false; }
      context2msg(context) { return [{}, { context, tools: this.io.tools() }]; }
      async send(message) { sent.push(message[1]); }
      async read() { if (this.done) return null; this.done = true; return {}; }
      msg2events() { return [{ type: "text_delta", contentIndex: 0, text: "done" }, { type: "done" }]; }
      async close() {}
    }
    providerAdd(env, "test", Provider);
    env.toolAdd("reader", () => "ok", schema("Reads"));
    env.toolAdd("hidden", () => "ok", schema("Hidden", { secret: true }));
    const agent = await Agent.create({ env, model: "p/m", can: { write: false }, tools: ["reader", "hidden"], context: [{ type: 2, content: [{ type: "text", text: "go" }] }] });
    try {
      const catalog = await agent.tools;
      expect((await agent.run()).type).toBe("done");
      expect(sent[0].tools).toEqual([...catalog.values()]);
      expect(sent[0].context).toEqual([{ type: 2, content: [{ type: "text", text: "go" }] }]);
    } finally { await agent.close(); }
  });

  test("read-only toggles keep the same provider connection and wire tool list", async () => {
    const env = await testEnv();
    const sent = [];
    class Provider {
      static provider = {};
      constructor(_url, io) { this.io = io; this.done = false; }
      context2msg(context) { return [{}, { context, tools: this.io.tools() }]; }
      async send(message) { sent.push(message[1].tools); this.done = false; }
      async read() { if (this.done) return null; this.done = true; return {}; }
      msg2events() { return [{ type: "text_delta", contentIndex: 0, text: "done" }, { type: "done" }]; }
      async close() {}
    }
    providerAdd(env, "test", Provider);
    env.toolAdd("writer", () => "ok", schema("Writes", { safe: false }));
    const agent = await Agent.create({ env, model: "p/m", tools: ["writer"], context: [{ type: 2, content: [{ type: "text", text: "go" }] }] });
    try {
      await agent.run();
      const io = agent.io;
      agent.can.write = false;
      expect(agent.can.write).toBe(false);
      await agent.run();
      agent.can.write = true;
      expect(agent.io).toBe(io);
      await agent.run();
      expect(sent).toHaveLength(3);
      expect(sent[0].map(({ name }) => name)).toEqual(["writer"]);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[2]).toEqual(sent[0]);
    } finally { await agent.close(); }
  });

  test("tracks inherited safety and late tool registrations without cached publication state", async () => {
    const env = await testEnv();
    env.toolAdd("writer", () => "ok", schema("Writes", { safe: false }));
    const parent = await Agent.create({ env, can: { write: false } });
    const child = await Agent.create({ env, parent });
    try {
      expect((await child.tools).has("writer")).toBe(true);
      env.toolAdd("late", () => "ok", schema("Late"));
      expect((await child.tools).has("late")).toBe(true);
      parent.can.write = true;
      expect((await child.tools).has("writer")).toBe(true);
      parent.can.write = false;
      expect((await child.tools).has("writer")).toBe(true);
    } finally { await child.close(); await parent.close(); }
  });

  test("does not expose authorization probes or tool-context construction as public API", () => {
    expect(Agent.toolContext).toBeUndefined();
    expect(Agent.prototype.toolCallable).toBeUndefined();
  });
});
