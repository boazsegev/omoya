// test/agent-loop.test.js — proof for the Agent core loop: complete
// context → IO request → tool calls executed, results appended beside
// their calls, loop until done/error; runaway guards; failed/denied
// tool calls surface as tool-result errors, never a crash.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

async function loopEnv(tools = {}) {
  const env = await testEnv();
  for (const [name, fn] of Object.entries(tools)) {
    env.registerTool(name, fn, { description: name, inputSchema: {} });
  }
  return env;
}

describe("Agent tool storage", () => {
  test("is stable per agent/tool, isolated, clearable, and injected into calls", async () => {
    const seen = [];
    const env = await loopEnv({
      alpha: (_args, context) => { context.storage.count = (context.storage.count ?? 0) + 1; seen.push(context.storage); return context.storage.count; },
      beta: (_args, context) => { seen.push(context.storage); return "beta"; },
    });
    const agent = new Agent({ env });

    expect(agent.toolStorage("alpha")).toBe(agent.toolStorage("alpha"));
    expect(agent.toolStorage("alpha")).not.toBe(agent.toolStorage("beta"));
    await agent.env.callTool("alpha", {}, agent._toolContext({ name: "alpha", callId: "1" }));
    await agent.env.callTool("alpha", {}, agent._toolContext({ name: "alpha", callId: "2" }));
    await agent.env.callTool("beta", {}, agent._toolContext({ name: "beta", callId: "3" }));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0].count).toBe(2);
    expect(seen[2]).toBe(agent.toolStorage("beta"));

    agent.toolStorageClear("alpha");
    expect(agent.toolStorage("alpha")).not.toBe(seen[0]);
    agent.toolStorageClear();
    expect(agent._toolStorage).toBeUndefined();
  });
});

describe("Agent loop: tool execution", () => {
  test("tool call → execute → result beside its call → next request → done", async () => {
    const calls = [];
    const env = await loopEnv({
      "fake-tool": (args) => {
        calls.push(args);
        return "tool output";
      },
    });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "fake-tool", { path: "./a" }), { type: "done" }],
      [...TEXT(0, "finished"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();

    expect(terminal.type).toBe("done");
    expect(calls).toEqual([{ path: "./a" }]);
    expect(agent.context).toEqual([
      USER("go"),
      { type: 3, content: [{ type: "toolCall", callId: "c1", name: "fake-tool", arguments: { path: "./a" } }] },
      { type: 4, callId: "c1", name: "fake-tool", content: [{ type: "text", text: "tool output" }] },
      { type: 3, content: [{ type: "text", text: "finished" }] },
    ]);
    expect(io.writes).toHaveLength(2);
  });

  test("multiple tool calls in one message execute in order, results beside the call message", async () => {
    const order = [];
    const env = await loopEnv({
      a: () => { order.push("a"); return "A"; },
      b: () => { order.push("b"); return "B"; },
    });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "a", {}), ...TOOLCALL(1, "c2", "b", {}), { type: "done" }],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run();

    expect(order).toEqual(["a", "b"]);
    expect(agent.context.map((m) => m.type)).toEqual([2, 3, 4, 4]);
    expect(agent.context[2]).toMatchObject({ callId: "c1", name: "a", content: [{ type: "text", text: "A" }] });
    expect(agent.context[3]).toMatchObject({ callId: "c2", name: "b", content: [{ type: "text", text: "B" }] });
  });
});

describe("Agent loop: failures surface as tool-result errors, never a crash", () => {
  test("throwing tool → error tool-result → loop continues", async () => {
    const env = await loopEnv({
      broken: () => { throw new Error("boom"); },
    });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "broken", {}), { type: "done" }],
      [...TEXT(0, "recovered"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();

    expect(terminal.type).toBe("done");
    const result = agent.context[2];
    expect(result.type).toBe(4);
    expect(result.error).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(agent.context[3].content).toEqual([{ type: "text", text: "recovered" }]);
  });

  test("unknown/misspelled tool name → error tool-result, not a crash", async () => {
    const env = await loopEnv({});
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "no-such-tool", {}), { type: "done" }],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(agent.context[2]).toMatchObject({ type: 4, error: true, name: "no-such-tool" });
    expect(agent.context[2].content).toHaveLength(1);
  });

  test("non-function published entry / unparseable arguments → error tool-result", async () => {
    const env = await loopEnv({ t: () => "ok" });
    const io = scriptedIO([
      [
        { type: "toolcall_start", contentIndex: 0, callId: "c1", name: "t", arguments: "{oops" },
        // no toolcall_end: arguments stay a raw unparseable string
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(agent.context[2]).toMatchObject({ type: 4, error: true });
    expect(agent.context[2].content).toHaveLength(1);
    expect(env.toolEntry("t")).toBeDefined(); // malformed input never reaches the tool
  });

  test("malformed streamed tool JSON is returned to the model for repair", async () => {
    const env = await loopEnv({ question: () => "not called" });
    const raw = '{"anonymous":false,"describe":"story\\n\\n"+""}';
    const io = scriptedIO([
      [
        { type: "toolcall_start", contentIndex: 0, callId: "c1", name: "question", arguments: raw },
        { type: "toolcall_end", contentIndex: 0 },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(agent.context[2]).toMatchObject({ type: 4, error: true, callId: "c1", name: "question" });
    expect(agent.context[2].content).toHaveLength(1);
  });

  test("provider error terminal ends the loop; partial message persisted", async () => {
    const env = await loopEnv({});
    const io = scriptedIO([
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, text: "partial" },
        { type: "error", error: "cancelled", kind: "cancelled", cancelled: true },
      ],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(terminal.type).toBe("error");
    expect(terminal.kind).toBe("cancelled");
    expect(io.writes).toHaveLength(1); // loop stopped
    expect(agent.context.at(-1)).toEqual({
      type: 3,
      content: [{ type: "text", text: "partial" }],
    });
  });
});

describe("Agent loop: live calls EXECUTE (identical repeats too), history calls never do", () => {
  test("identical calls in ONE message EACH execute — no dedup, no reuse, no refusal", async () => {
    let executions = 0;
    const env = await loopEnv({
      "mutate-state": () => { executions++; return "done " + executions; },
    });
    const io = scriptedIO([
      [
        ...TOOLCALL(0, "c1", "mutate-state", { path: "./a" }),
        ...TOOLCALL(1, "c2", "mutate-state", { path: "./a" }), // identical dupe: EXECUTES
        ...TOOLCALL(2, "c3", "mutate-state", { path: "./b" }),
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();

    expect(terminal.type).toBe("done");
    expect(executions).toBe(3); // every live call runs
    const results = agent.context.filter((m) => m.type === 4);
    expect(results).toHaveLength(3); // every call gets its own FRESH answer
    expect(results.map((m) => m.content)).toEqual([
      [{ type: "text", text: "done 1" }],
      [{ type: "text", text: "done 2" }], // the dupe's own execution, not c1's answer
      [{ type: "text", text: "done 3" }],
    ]);
    expect(results.every((m) => m.error === undefined)).toBe(true);
  });

  test("a live repeat of an already-answered call EXECUTES again (data may have changed)", async () => {
    let executions = 0;
    const env = await loopEnv({ "mutate-state": () => { executions++; return "fresh " + executions; } });
    // History ALREADY holds call c1 + its result (e.g. after a resume);
    // the provider re-issues the identical call — a NEW live call.
    const history = [
      USER("go"),
      { type: 3, content: [{ type: "toolCall", callId: "c1", name: "mutate-state", arguments: {} }] },
      { type: 4, callId: "c1", name: "mutate-state", content: [{ type: "text", text: "stale" }] },
      USER("again"),
    ];
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "mutate-state", {}), { type: "done" }],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: history, createIO: () => io });
    const terminal = await agent.run();

    expect(terminal.type).toBe("done");
    expect(executions).toBe(1); // the live repeat RAN
    const results = agent.context.filter((m) => m.type === 4);
    expect(results).toHaveLength(2);
    expect(results[1].content).toEqual([{ type: "text", text: "fresh 1" }]); // NEVER the stored answer
    expect(results[1].callId).not.toBe("c1"); // id regenerated for linkage only (callId is irrelevant to execution)
    expect(results[1].error).toBeUndefined();
  });

  test("a call found in HISTORY (even unanswered) is NEVER executed — only live-response calls run", async () => {
    let executions = 0;
    const env = await loopEnv({ "mutate-state": () => { executions++; return "ok"; } });
    // Resumed context ends with an UNANSWERED tool call (crash left it).
    const history = [
      USER("go"),
      { type: 3, content: [{ type: "toolCall", callId: "c1", name: "mutate-state", arguments: {} }] },
      USER("continue"),
    ];
    const io = scriptedIO([[...TEXT(0, "carried on"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: history, createIO: () => io });
    const terminal = await agent.run();

    expect(terminal.type).toBe("done");
    expect(executions).toBe(0); // mid-context calls never execute
    // ...but the unanswered call gets a SYNTHETIC interruption result
    // (lib/agent/tool-repair.js): strict dialects 400 the request over
    // an orphan tool_call, so the repair answers it — never by running
    // the tool, always with an honest error result
    const results = agent.context.filter((m) => m.type === 4);
    expect(results).toHaveLength(1);
    expect(results[0].callId).toBe("c1");
    expect(results[0].error).toBe(true);
    expect(results[0].content[0].text).toContain("interrupted");
  });

  test("a live repeat after edits EXECUTES again — the answer is always the fresh one", async () => {
    let executions = 0;
    const env = await loopEnv({ "mutate-state": () => { executions++; return "fresh " + executions; } });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "mutate-state", { path: "./a" }), { type: "done" }],
      [...TEXT(0, "done"), { type: "done" }],
      [...TOOLCALL(0, "c1", "mutate-state", { path: "./a" }), { type: "done" }], // provider re-issues
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run();
    expect(executions).toBe(1);

    // Edit the tool OUTPUT, then an EARLIER message, then run again —
    // the re-issued call executes (re-reading an edited file must
    // return the edits, never a cached answer).
    agent.edit(2, { type: 4, callId: "c1", name: "mutate-state", content: [{ type: "text", text: "user-edited output" }] });
    agent.edit(0, USER("go — edited"));
    agent.append(USER("once more"));
    const terminal = await agent.run();

    expect(terminal.type).toBe("done");
    expect(executions).toBe(2); // the repeat RAN again
    const last = agent.context.at(-1);
    expect(last.type).toBe(4);
    expect(last.content).toEqual([{ type: "text", text: "fresh 2" }]); // the FRESH answer
  });

  test("onToolExecute/onToolResult lifecycle fires around EVERY execution", async () => {
    const lifecycle = [];
    const env = await loopEnv({ t: () => "out" });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), ...TOOLCALL(1, "c1", "t", {}), { type: "done" }],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_EXECUTE, (call) => lifecycle.push(["execute", call.callId]));
    agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result }) => lifecycle.push(["result", result.callId, Boolean(result.error)]));
    await agent.run();

    expect(lifecycle).toEqual([
      ["execute", "c1"],
      ["result", "c1", false],
      ["execute", "agent-1"], // dupe id regenerated for linkage; EXECUTES
      ["result", "agent-1", false],
    ]);
  });
});

describe("Agent loop: runaway guard is CONTEXT USAGE, not a request/tool-call count", () => {
  test("the OVERALL cap (default 90%) refuses to continue BEFORE even making a request", async () => {
    const env = await loopEnv({});
    const io = scriptedIO([[...TEXT(0, "should never be sent"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent._contextReport = { used: 91, total: 100 }; // inherited from earlier turns: already over cap
    const terminal = await agent.run();
    expect(terminal.type).toBe("error");
    expect(terminal.error).toContain("runaway guard");
    expect(terminal.error).toContain("91%");
    expect(terminal.error).toContain("cap 90%");
    expect(terminal.error).toContain("/compact");
    expect(terminal.error).toContain("user oversight");
    expect(io.writes).toHaveLength(0); // refused before ever connecting
  });

  test("settings.contextGuardCap is settable — a lower cap trips at a usage the default would allow", async () => {
    const env = await loopEnv({});
    env.settings.contextGuardCap = 0.5;
    const io = scriptedIO([[...TEXT(0, "x"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent._contextReport = { used: 60, total: 100 }; // 60%: under the default 90%, over a configured 50%
    const terminal = await agent.run();
    expect(terminal.error).toContain("cap 50%");
    expect(io.writes).toHaveLength(0);
  });

  test("the PER-TURN cap (default 40%) trips when one turn's OWN growth alone crosses it, even well under the overall cap", async () => {
    // a "huge tool result" stand-in (quoting one big file) — the growth
    // lands in the TOOL RESULT text, exactly the scenario this guard
    // targets: ~80 words ≈ 107 estimated tokens (words × 4/3),
    // comfortably between the 40% turn cap and the 90% overall cap of
    // a 200-token window
    const env = await loopEnv({ t: () => "word ".repeat(80) });
    env.settings.p = { ...env.settings.p, contextWindow: 200 }; // 40% = 80 tokens
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TOOLCALL(0, "c2", "t", {}), { type: "done" }], // would run forever if not stopped
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(terminal.type).toBe("error");
    expect(terminal.error).toContain("runaway guard");
    expect(terminal.error).toContain("this turn alone");
    expect(terminal.error).toContain("cap 40%");
    expect(io.writes).toHaveLength(1); // stopped before the second scripted request
  });

  test("settings.contextGuardTurnCap is settable", async () => {
    const env = await loopEnv({ t: () => "word ".repeat(20) });
    env.settings.p = { ...env.settings.p, contextWindow: 200 };
    env.settings.contextGuardTurnCap = 0.1; // 10%: trips on far less growth
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TOOLCALL(0, "c2", "t", {}), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(terminal.error).toContain("cap 10%");
    expect(io.writes).toHaveLength(1);
  });

  test("request and tool-call counts never limit a run when the context window is unknown", async () => {
    const env = await loopEnv({ t: () => "ok" });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TOOLCALL(0, "c2", "t", {}), { type: "done" }],
      [...TOOLCALL(0, "c3", "t", {}), { type: "done" }],
      [...TEXT(0, "completed"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(4);
    expect(agent.context.filter((m) => m.type === 4)).toHaveLength(3);
  });

  test("compaction bypasses the normal context guard so it can recover an over-cap context", async () => {
    const env = await loopEnv({});
    const io = scriptedIO([[...TEXT(0, "compact summary"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("long history")], createIO: () => io });
    agent._contextReport = { used: 95, total: 100 };
    const result = await agent.compact();
    expect(result.ok).toBe(true);
    expect(io.writes).toHaveLength(1);
    expect(agent.context.some((m) => m.type === 3 && m.content[0].text.includes("compact summary"))).toBe(true);
  });
});
