// test/agent-tool-repair.test.js — proof for lib/agent/tool-repair.js:
// an assistant tool_call no ToolResult ever answered (a cancelled
// turn's kill-partial, a runaway guard firing after the append, a
// crash between append and dispatch) breaks strict chat dialects —
// Moonshot 400s the WHOLE request ("tool_call_ids did not have
// response messages"). The Agent repairs before every request: a
// synthetic error result joins the call's answer window, the context
// becomes wire-valid, and the repair persists (idempotent).
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import KimiProvider from "../providers/kimi.js";
import { scriptedIO, testEnv, TOOLCALL, TEXT, USER } from "./fakes.js";

const DONE = { type: "done" };
const CANCELLED = { type: "error", error: "cancelled", kind: "cancelled" };

/** The Moonshot wire view of a context: every tool_call id answered? */
function kimiWire(context) {
  const provider = new KimiProvider("https://api.kimi.com/coding/v1", {
    model: "test/kimi-for-coding",
    settings: {},
    tools: () => [],
  });
  const [, body] = provider.context2msg(context);
  const calls = body.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id));
  const answered = new Set(body.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  return { calls, answered, orphans: calls.filter((id) => !answered.has(id)) };
}

describe("tool-call repair: unanswered calls never reach the wire", () => {
  test("a cancelled turn's orphan call gets a synthetic error result before the next request", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "bash:1", "bash", { command: "ls" }), CANCELLED], // kill-partial keeps the call
      [...TEXT(0, "after"), DONE],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("hi")], createIO: () => io });

    const first = await agent.run({});
    expect(first.type).toBe("error"); // the cancelled turn
    // the partial assistant message with the unanswered call is kept
    const orphan = agent.context.messages().find((m) =>
      (m.content ?? []).some((b) => b.type === "toolCall" && b.callId === "bash:1"));
    expect(orphan).toBeDefined();

    await agent.run({}); // the repair runs before this request
    const sent = io.writes[1].context;
    const at = sent.findIndex((m) => m === sent.find((x) =>
      (x.content ?? []).some((b) => b.type === "toolCall" && b.callId === "bash:1")));
    const next = sent[at + 1];
    expect(next?.type).toBe(4); // a ToolResult right after the assistant message
    expect(next.callId).toBe("bash:1");
    expect(next.error).toBe(true);
    expect(next.content[0].text).toContain("interrupted");
    expect(kimiWire(sent).orphans).toEqual([]); // the exact Moonshot 400 is gone
  });

  test("the open answer window puts repaired results and queued input before guidance", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "ok"), DONE]]);
    const context = [
      USER("q"),
      { type: 3, content: [
        { type: "toolCall", callId: "read:1", name: "read", arguments: {} },
        { type: "toolCall", callId: "bash:1", name: "bash", arguments: {} },
      ] },
      { type: 4, callId: "read:1", name: "read", content: [{ type: "text", text: "file" }] },
      { type: 1, content: [{ type: "text", text: "skill payload" }] }, // a tool's System payload
      USER("next"),
    ];
    const agent = await Agent.create({ env, model: "p/m", context, createIO: () => io });
    await agent.run({});

    const sent = io.writes[0].context;
    const userAt = sent.findIndex((m, i) => i > 0 && m.type === 2 && m.content?.[0]?.text === "next");
    const synthetic = sent[userAt - 1];
    expect(synthetic.type).toBe(4);
    expect(synthetic.callId).toBe("bash:1");
    expect(sent[userAt + 1]).toEqual({ type: 1, content: [{ type: "text", text: "skill payload" }] });
    expect(sent.map((message) => message.type)).toEqual([2, 3, 4, 4, 2, 1]);
    expect(kimiWire(sent).orphans).toEqual([]);
  });

  test("an empty failed assistant response does not hide the still-unanswered tool batch", async () => {
    const env = await testEnv();
    const io = scriptedIO([TEXT(0, "recovered")]);
    const agent = await Agent.create({ env, model: "p/m", context: [
      USER("go"),
      { type: 3, content: [
        { type: "toolCall", callId: "skill", name: "skill", arguments: {} },
        { type: "toolCall", callId: "read", name: "read", arguments: {} },
      ] },
      { type: 4, callId: "skill", content: [{ type: "text", text: "loaded" }] },
      { type: 1, content: [{ type: "text", text: "skill guidance" }] },
      { type: 4, callId: "read", content: [{ type: "text", text: "result" }] },
      { type: 3, content: [], error: "HTTP 400 invalid placement" },
      USER("continue"),
    ], createIO: () => io });
    try {
      await agent.run();
      const sent = io.writes[0].context.filter((message) => message.content?.length > 0);
      expect(sent.map((message) => message.type)).toEqual([2, 3, 4, 4, 2, 1]);
      expect(sent.at(-1).content[0].text).toBe("skill guidance");
    } finally { await agent.close(); await env.close(); }
  });

  test("open-batch ordering never moves guidance in a previously answered prefix", async () => {
    const env = await testEnv();
    const io = scriptedIO([TEXT(0, "reply")]);
    const context = [
      USER("old"),
      { type: 3, content: [{ type: "toolCall", callId: "old", name: "read", arguments: {} }] },
      { type: 4, callId: "old", content: [{ type: "text", text: "old result" }] },
      { type: 1, content: [{ type: "text", text: "old guidance" }] },
      { type: 3, content: [{ type: "thinking", text: "old plan", signature: "preserve" }, { type: "text", text: "old answer" }] },
      USER("new"),
      { type: 3, content: [{ type: "toolCall", callId: "new", name: "read", arguments: {} }] },
      { type: 4, callId: "new", content: [{ type: "text", text: "new result" }] },
      { type: 1, content: [{ type: "text", text: "new guidance" }] },
      USER("queued"),
    ];
    const prefix = structuredClone(context.slice(0, 7));
    const agent = await Agent.create({ env, model: "p/m", context, createIO: () => io });
    try {
      await agent.run();
      expect(io.writes[0].context.slice(0, prefix.length)).toEqual(prefix);
      expect(io.writes[0].context.slice(prefix.length).map((message) => message.type)).toEqual([4, 2, 1]);
      const settled = structuredClone(agent.context.messages());
      await agent.run();
      expect(io.writes[1].context).toEqual(settled);
    } finally { await agent.close(); await env.close(); }
  });

  test("a detached result is preserved as System JSON; duplicate results are detached too", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "ok"), DONE]]);
    const context = [
      USER("q"),
      { type: 3, content: [{ type: "toolCall", callId: "new-call", name: "read", arguments: {} }] },
      // residue after the original call block was edited away
      { type: 4, callId: "old-call", name: "read", content: [{ type: "text", text: "valuable old output" }] },
      // the first new-call result is valid; its duplicate is not
      { type: 4, callId: "new-call", name: "read", content: [{ type: "text", text: "current output" }] },
      { type: 4, callId: "new-call", name: "read", content: [{ type: "text", text: "duplicate output" }] },
      USER("next"),
    ];
    const agent = await Agent.create({ env, model: "p/m", context, createIO: () => io });
    await agent.run({});

    const sent = io.writes[0].context;
    const results = sent.filter((m) => m.type === 4);
    expect(results).toHaveLength(1);
    expect(results[0].callId).toBe("new-call");
    const preserved = sent.filter((m) => m.type === 1)
      .map((m) => m.content?.[0]?.text ?? "")
      .filter((text) => text.includes("detached tool result preserved"));
    expect(preserved).toHaveLength(2);
    expect(preserved.join("\n")).toContain("valuable old output");
    expect(preserved.join("\n")).toContain("duplicate output");
    expect(kimiWire(sent).orphans).toEqual([]);
  });

  test("a callId-less orphan gets a fresh linkage id; the repair is idempotent", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "ok"), DONE]]);
    const block = { type: "toolCall", name: "write", arguments: {} }; // no callId at all
    const agent = await Agent.create({
      env, model: "p/m",
      context: [USER("q"), { type: 3, content: [block] }, USER("next")],
      createIO: () => io,
    });
    await agent.run({});

    const sent = io.writes[0].context;
    // stored messages are REPLACED, never mutated in place: the original
    // block the caller seeded stays id-less; the context's replacement
    // carries the fresh linkage id
    expect(block.callId).toBeUndefined();
    const storedBlock = agent.context.messages().flatMap((m) => m.content ?? []).find((b) => b?.type === "toolCall");
    expect(typeof storedBlock.callId).toBe("string");
    const result = sent.find((m) => m.type === 4 && m.callId === storedBlock.callId);
    expect(result?.error).toBe(true);
    expect(kimiWire(sent).orphans).toEqual([]);

    const before = agent.context.messages().filter((m) => m.type === 4).length;
    await agent.run({}); // nothing left to repair
    expect(agent.context.messages().filter((m) => m.type === 4).length).toBe(before);
  });

  test("repair never mutates a stored message (deep-frozen context survives)", async () => {
    // Identity-keyed caches across the app (context-blocks text memo,
    // usage estimate memo, transcript projector) all bet that stored
    // context messages are only ever REPLACED. Freeze the seeded
    // context hard: any in-place write throws under ESM strict mode.
    const freezeDeep = (value, seen = new Set()) => {
      if (value === null || typeof value !== "object" || seen.has(value)) return value;
      seen.add(value);
      for (const key of Object.keys(value)) freezeDeep(value[key], seen);
      return Object.freeze(value);
    };
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "ok"), DONE]]);
    const orphan = freezeDeep({ type: 3, content: [{ type: "toolCall", name: "write", arguments: {} }] });
    // the ARRAY stays caller-owned and mutable; messages/blocks are frozen
    const agent = await Agent.create({ env, model: "p/m", context: [freezeDeep(USER("q")), orphan, freezeDeep(USER("next"))], createIO: () => io });
    await agent.run({});

    const storedBlock = agent.context.messages().flatMap((m) => m.content ?? []).find((b) => b?.type === "toolCall");
    expect(typeof storedBlock.callId).toBe("string"); // the replacement carries the id
    expect(Object.isFrozen(storedBlock)).toBe(false); // on a REPLACEMENT, not the frozen original
    expect(kimiWire(io.writes[0].context).orphans).toEqual([]); // the wire is still valid
  });
});
