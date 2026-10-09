// test/agent-autocompact.test.js — proof for auto-compaction
// (settings.context.autocompact → agent._policyCurrent.context.autocompact,
// compactAuto in lib/agent/compact.js): before any provider request whose
// context usage reached the threshold, the run loop compacts, holding the
// not-yet-answered user tail out of the summary and re-attaching it in
// order; the compact turn never auto-compacts itself, and a failed
// compaction leaves the context exactly as it was.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { MessageType } from "../lib/context.js";
import { compactAuto } from "../lib/agent/compact.js";
import { runLoop } from "../lib/agent/run.js";
import { fakeIO, emitScript, scriptedIO, testEnv, TEXT, TOOLCALL, USER } from "./fakes.js";

const ASSISTANT = (text) => ({ type: MessageType.Assistant, content: [{ type: "text", text }] });
const LONG = "word ".repeat(60).trim(); // ~80 estimated tokens: 40% of a 200-token window
const INSTRUCTION = "Create a detailed summary";

/** Env with a 200-token window and auto-compaction at `autocompact` — set BEFORE the Agent exists. */
async function windowEnv({ context = { autocompact: 0.3 }, contextWindow = 200, tools = {} } = {}) {
  const env = await testEnv({ context, providers: {
    p: { provider: "test", models: { m: {} }, ...(contextWindow === null ? {} : { contextWindow }) },
  } });
  await env.ready();
  for (const [name, fn] of Object.entries(tools)) env.toolAdd(name, fn, { description: name, inputSchema: {} });
  return env;
}

/** Text of a request's last message. */
const lastText = (write) => write.context.at(-1).content.map((b) => b.text ?? "").join("");
const isCompactRequest = (write) => lastText(write).includes(INSTRUCTION);

/** The LOG lines an agent emits. */
function logs(agent) {
  const lines = [];
  agent.onEvent(Agent.EVENT.LOG, (line) => lines.push(String(line)));
  return lines;
}

describe("auto-compaction: triggers before the next request", () => {
  test("after a tool call — the tool result pushes usage over the threshold", async () => {
    const env = await windowEnv({ context: { autocompact: 0.3, turn: 1 }, tools: { t: () => LONG } });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "final answer"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const lines = logs(agent);
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(3); // request, compaction, continuation — no recursion
    expect(isCompactRequest(io.writes[0])).toBe(false);
    expect(isCompactRequest(io.writes[1])).toBe(true);
    expect(io.writes[1].context.some((m) => m.type === MessageType.ToolResult)).toBe(true);
    const next = io.writes[2].context;
    expect(next.at(-2).type).toBe(MessageType.Assistant);
    expect(next.at(-2).content[0].text).toContain("the summary");
    expect(next.at(-1)).toEqual(USER("Please continue."));
    expect(next.some((m) => m.type === MessageType.ToolResult)).toBe(false);
    expect(lines.some((line) => line.startsWith("auto-compacting: context usage is"))).toBe(true);
    // the continuation answers a context ending in a user prompt after the summary
    expect(agent.context.at(-1).content[0].text).toEndWith("final answer");
  });

  test("after a new user message — the message is held out of the summary and sent after it", async () => {
    const env = await windowEnv();
    const io = scriptedIO([
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    await agent.send(USER("next question"));
    expect(io.writes).toHaveLength(2);
    expect(isCompactRequest(io.writes[0])).toBe(true);
    expect(JSON.stringify(io.writes[0].context)).not.toContain("next question");
    const sent = io.writes[1].context;
    expect(sent.at(-3).type).toBe(MessageType.Assistant);
    expect(sent.at(-3).content[0].text).toContain("the summary");
    expect(sent.at(-2)).toEqual(USER("Please continue."));
    expect(sent.at(-1)).toEqual(USER("next question"));
    expect(JSON.stringify(sent)).not.toContain("q1");
  });

  test("trailing user and worker messages are preserved after compaction, in order", async () => {
    const env = await windowEnv();
    const io = scriptedIO([
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    const worker = { ...USER("[Message from worker: \"w\"]\nworker result"), worker: "w" };
    agent.context.append(USER("first"), { merge: false });
    agent.context.append(worker, { merge: false });
    agent.context.append(USER("third"), { merge: false });
    await agent.run();
    expect(isCompactRequest(io.writes[0])).toBe(true);
    for (const text of ["first", "worker result", "third"]) expect(JSON.stringify(io.writes[0].context)).not.toContain(text);
    const tail = io.writes[1].context.slice(-3);
    expect(tail.map((m) => m.content[0].text)).toEqual(["first", worker.content[0].text, "third"]);
    expect(io.writes[1].context.at(-5).content[0].text).toContain("the summary");
    expect(io.writes[1].context.at(-4)).toEqual(USER("Please continue."));
  });

  test("messages queued during the tool round and the compact turn stay pending, then follow the summary", async () => {
    let agent;
    const env = await windowEnv({ context: { autocompact: 0.3, turn: 1 }, tools: { t: () => { agent.send(USER("during tools")); return LONG; } } });
    const io = fakeIO(async (self, callbacks) => {
      const n = self.writes.length;
      if (n === 1) return emitScript([...TOOLCALL(0, "c1", "t", {}), { type: "done" }], callbacks);
      if (n === 2) {
        agent.send(USER("during compaction"));
        return emitScript([...TEXT(0, "the summary"), { type: "done" }], callbacks);
      }
      return emitScript([...TEXT(0, "reply"), { type: "done" }], callbacks);
    });
    agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run();
    expect(io.writes).toHaveLength(3);
    expect(isCompactRequest(io.writes[1])).toBe(true);
    expect(JSON.stringify(io.writes[1].context)).not.toContain("during");
    expect(lastText(io.writes[2])).toContain("during tools");
    expect(lastText(io.writes[2])).toContain("during compaction");
    expect(io.writes[2].context.at(-2).content[0].text).toContain("the summary");
    expect(io.writes[2].context.at(-1).type).toBe(MessageType.User);
    expect(lastText(io.writes[2])).toContain("Please continue.");
    expect(agent.pending).toHaveLength(0);
  });
});

describe("auto-compaction: when it does not run", () => {
  test("the context window is unknown", async () => {
    const env = await windowEnv({ contextWindow: null, tools: { t: () => LONG } });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TEXT(0, "final"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    expect(agent.contextUsage.total).toBe(null);
    await agent.run();
    expect(io.writes).toHaveLength(2);
    expect(io.writes.some(isCompactRequest)).toBe(false);
  });

  for (const autocompact of [0, false]) {
    test(`the setting is ${autocompact === 0 ? "zero" : "false"}`, async () => {
      // cap/turn at 100%: the runaway guard stays out of it
      const context = { cap: 1, turn: 1, autocompact };
      const env = await windowEnv({ context, tools: { t: () => LONG } });
      const io = scriptedIO([
        [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
        [...TEXT(0, "final"), { type: "done" }],
      ]);
      const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
      expect(agent._policyCurrent.context.autocompact).toBe(false);
      await agent.run();
      expect(io.writes).toHaveLength(2);
      expect(io.writes.some(isCompactRequest)).toBe(false);
    });
  }

  test("a compact turn never auto-compacts itself, but the guard retains pre-compaction usage", async () => {
    const env = await windowEnv();
    const io = scriptedIO([
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ], { onRequest: (activeIO) => { activeIO.context.contextUsage = { used: 185, total: 200 }; } });
    // 92.5% reported for every request, the compact one included: over
    // the runaway guard's 90% cap until compaction drops the report
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT("a1")], createIO: () => io });
    agent.context.contextUsage = { used: 185, total: 200 };
    const terminal = await agent.send(USER("next"));
    expect(terminal.type).toBe("error");
    expect(terminal.error).toContain("runaway guard");
    expect(io.writes).toHaveLength(1); // one compaction, no unsafe continuation
    expect(isCompactRequest(io.writes[0])).toBe(true);
  });
});

describe("auto-compaction: guard survives compaction", () => {
  test("a continuing turn charges growth across successive compactions", async () => {
    const env = await windowEnv({ context: { autocompact: 0.1, turn: 0.4, cap: 1 }, tools: { t: () => "word ".repeat(35) } });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TEXT(0, "summary one"), { type: "done" }],
      [...TOOLCALL(0, "c2", "t", {}), { type: "done" }],
      [...TEXT(0, "summary two"), { type: "done" }],
      [...TEXT(0, "must not continue"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run();
    expect(io.writes.map(isCompactRequest)).toEqual([false, true, false, true]);
    expect(terminal.type).toBe("error");
    expect(terminal.error).toContain("this turn alone");
  });
});

describe("auto-compaction: absolute token ceiling", () => {
  test("the lower of percentage and token ceiling triggers, including at the boundary", async () => {
    for (const [used, max, shouldCompact] of [[29, 30, false], [30, 30, true], [79, 0, false], [80, 0, true]]) {
      const env = await windowEnv({ context: { autocompact: 0.4, autocompactMax: max, cap: 1, turn: 1 } });
      const io = scriptedIO([[...TEXT(0, "summary"), { type: "done" }], [...TEXT(0, "answer"), { type: "done" }]]);
      const agent = await Agent.create({ env, model: "p/m", context: [USER("q"), ASSISTANT("a")], createIO: () => io });
      agent.context.contextUsage = { used, total: 200 };
      await agent.run();
      expect(isCompactRequest(io.writes[0])).toBe(shouldCompact);
      if (shouldCompact) expect(io.writes).toHaveLength(2); // resumes after summary
      await agent.close();
      await env.close();
    }
  });

  test("absolute token ceiling triggers even without a known window", async () => {
    const env = await windowEnv({ contextWindow: null, context: { autocompactMax: 30 } });
    const io = scriptedIO([[...TEXT(0, "summary"), { type: "done" }], [...TEXT(0, "answer"), { type: "done" }]]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q"), ASSISTANT("a")], createIO: () => io });
    agent.context.contextUsage = { used: 30, total: null };
    await agent.run();
    expect(isCompactRequest(io.writes[0])).toBe(true);
    expect(io.writes).toHaveLength(2);
  });
});

describe("auto-compaction: failure and cancellation", () => {
  test("an errored partial summary does not replace the original conversation", async () => {
    const env = await windowEnv();
    env.settings.retry = { attempts: 1 };
    const io = scriptedIO([
      [...TEXT(0, "partial summary"), { type: "error", error: "transport broke", kind: "provider" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    agent.context.append(USER("next"), { merge: false });
    const original = structuredClone(agent.context.messages());
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(2);
    expect(io.writes[1].context).toEqual(original);
    await agent.close();
  });

  test("an errored partial summary during manual compaction leaves the context intact", async () => {
    const env = await windowEnv();
    env.settings.retry = { attempts: 1 };
    const io = scriptedIO([[...TEXT(0, "partial summary"), { type: "error", error: "transport broke", kind: "provider" }]]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT("a1")], createIO: () => io });
    const original = structuredClone(agent.context.messages());
    const result = await agent.compact();
    expect(result.ok).toBe(false);
    expect(agent.context.messages()).toEqual(original);
    await agent.close();
  });

  test("a rejected compact request restores the history and waiting messages", async () => {
    const env = await windowEnv();
    const io = fakeIO(async () => { throw new Error("transport broke"); });
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    agent.context.append(USER("next"), { merge: false });
    agent._pending.push(USER("queued"));
    const original = structuredClone(agent.context.messages());
    await expect(agent.run()).rejects.toThrow("transport broke");
    expect(agent.context.messages()).toEqual(original);
    expect(agent.pending).toEqual([USER("queued")]);
    await agent.close();
  });

  test("a failed compaction leaves the context intact and the request proceeds", async () => {
    const env = await windowEnv();
    env.settings.retry = { attempts: 1 };
    const io = scriptedIO([
      [{ type: "error", error: "boom", kind: "provider" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    const before = [USER("q1"), ASSISTANT(LONG)];
    const agent = await Agent.create({ env, model: "p/m", context: before, createIO: () => io });
    const lines = logs(agent);
    agent.context.append(USER("a"), { merge: false });
    agent.context.append(USER("b"), { merge: false });
    const original = agent.context.messages().map((m) => structuredClone(m));
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(2);
    expect(isCompactRequest(io.writes[0])).toBe(true);
    expect(io.writes[1].context).toEqual(original);
    expect(agent.context.messages().slice(0, -1)).toEqual(original);
    expect(lines.some((line) => line.includes("auto-compaction produced no summary"))).toBe(true);
  });

  test("a cancel during the compact turn ends the run with the tail re-attached", async () => {
    let agent;
    const env = await windowEnv();
    const io = fakeIO(async (self) => {
      const cancelled = new Promise((resolve) => { self._onKill = resolve; });
      queueMicrotask(() => { void agent.cancel(); }); // wait until fakeIO owns the active request
      await cancelled;
      return { type: "error", error: "cancelled", kind: "cancelled", cancelled: true };
    });
    agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    agent.context.append(USER("next"), { merge: false });
    const original = agent.context.messages().map((m) => structuredClone(m));
    const terminal = await agent.run();
    expect(terminal.cancelled).toBe(true);
    expect(io.writes).toHaveLength(1);
    expect(agent.context.messages()).toEqual(original);
    expect(agent.busy).toBe(false);
  });
});

describe("auto-compaction: a waiting manual /compact joins the automatic round", () => {
  test("a /compact in the tail is removed, its focus guides the summary, and the turn ends there", async () => {
    const env = await windowEnv();
    const io = scriptedIO([[...TEXT(0, "the summary"), { type: "done" }]]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    agent.context.append(USER("/compact keep the API names"), { merge: false });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(1); // one compaction, never a second (manual) one
    expect(lastText(io.writes[0])).toContain(INSTRUCTION);
    expect(lastText(io.writes[0])).toContain("keep the API names");
    expect(JSON.stringify(agent.context.messages())).not.toContain("/compact");
    expect(agent.context.at(-2).content[0].text).toContain("the summary");
    expect(agent.context.at(-1)).toEqual(USER("Please continue."));
  });

  test("other tail messages follow the summary; a queued /compact's focus joins too", async () => {
    const env = await windowEnv();
    let agent;
    const io = fakeIO(async (self, callbacks) => {
      if (self.writes.length === 1) return emitScript([...TEXT(0, "the summary"), { type: "done" }], callbacks);
      return emitScript([...TEXT(0, "reply"), { type: "done" }], callbacks);
    });
    agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    agent.context.append(USER("/compact first focus"), { merge: false });
    agent.context.append(USER("next question"), { merge: false });
    agent._pending.push(USER("/compact queued focus"));
    await agent.run();
    expect(io.writes).toHaveLength(2);
    expect(lastText(io.writes[0])).toContain("first focus\nqueued focus");
    expect(io.writes[1].context.at(-1)).toEqual(USER("next question"));
    expect(JSON.stringify(io.writes[1].context)).not.toContain("/compact");
    expect(agent.pending).toHaveLength(0);
  });

  test("a failed round restores the waiting /compact (in the context and the queue)", async () => {
    const env = await windowEnv();
    env.settings.retry = { attempts: 1 };
    const io = scriptedIO([[{ type: "error", error: "boom", kind: "provider" }]]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    agent.context.append(USER("/compact tail focus"), { merge: false });
    agent._pending.push(USER("/compact queued focus"));
    // the round alone (the run loop would go on to the manual /compact)
    const result = await compactAuto(agent, (options) => runLoop(agent, options));
    expect(result.done).toBe(false);
    expect(lastText(io.writes[0])).toContain("tail focus\nqueued focus");
    expect(agent.context.at(-1)).toEqual(USER("/compact tail focus"));
    expect(agent.pending).toEqual([USER("/compact queued focus")]);
  });
});
