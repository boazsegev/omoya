import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import Agent from "../lib/agent.js";
import Context from "../lib/context.js";
import Env from "../lib/env.js";

async function withAgent(run) {
  const dir = mkdtempSync("./ai-tmp/fork-direct-");
  const env = await Env.open(dir, { dir, settingsDir: dir,
    settings: { providers: { p: { provider: "test", url: "test://script" } } },
    init: { providers: false, tools: false, detect: false, models: false } });
  const source = await Agent.create({ env, model: "p/m", contextId: false });
  try { await run(source, env); }
  finally {
    await Promise.all(env.agents().map((agent) => agent.close()));
    await env.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Agent.fork creates an independent Agent at a context boundary without closing the source", async () => {
  await withAgent(async (source, env) => {
    source.context.append(Context.messageUser("first"));
    source.context.append({ type: Context.MessageType.Assistant, content: [{ type: "text", text: "second" }] });
    source.thinking = "high";
    const branch = await source.fork({ through: 1 });
    expect(env.agents()).toContain(source);
    expect(env.agents()).toContain(branch);
    expect(branch).not.toBe(source);
    expect(source.closed).toBe(false);
    expect(branch.parent).toBeUndefined();
    expect(!source.context.id).toBe(true);
    expect(branch.context.id).toBeTruthy();
    expect(branch.context.uuid).not.toBe(source.context.uuid);
    expect(branch.context.messages()).toEqual(source.context.messages().slice(0, 1));
    expect(branch.thinking).toBe(source.thinking);
    expect(branch.name).not.toBe(source.name);
    expect(branch.pending).toEqual([]);
    branch.context.at(0).content[0].text = "branch only";
    expect(source.context.at(0).content[0].text).toBe("first");
    source.context.append(Context.messageUser("third"));
    expect(branch.context.length).toBe(1);
    await branch.close();
    expect(source.closed).toBe(false);
  });
});

test("Agent.fork rejects invalid boundaries and source ids, preserving the source", async () => {
  await withAgent(async (source) => {
    source.context.append(Context.messageUser("one"));
    await expect(source.fork({ through: -1 })).rejects.toThrow(/boundary/);
    await expect(source.fork({ through: 2 })).rejects.toThrow(/boundary/);
    await expect(source.fork({ id: "bad/name" })).rejects.toThrow(/invalid session/);
    expect(source.closed).toBe(false);
    expect(source.env.agents()).toEqual([source]);
  });
});
