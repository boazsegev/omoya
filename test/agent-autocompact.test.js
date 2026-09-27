// test/agent-autocompact.test.js — proof for auto-compaction
// (settings.context.autocompact → agent.policy.context.autocompact,
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
  const env = await testEnv();
  for (const [name, fn] of Object.entries(tools)) env.toolAdd(name, fn, { description: name, inputSchema: {} });
  if (contextWindow !== null) env.settings.p = { ...env.settings.p, contextWindow };
  env.settings.context = context;
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
    const env = await windowEnv({ tools: { t: () => LONG } });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "final answer"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const lines = logs(agent);
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(3); // request, compaction, continuation — no recursion
    expect(isCompactRequest(io.writes[0])).toBe(false);
    expect(isCompactRequest(io.writes[1])).toBe(true);
    expect(io.writes[1].context.some((m) => m.type === MessageType.ToolResult)).toBe(true);
    const next = io.writes[2].context;
    expect(next.at(-1).type).toBe(MessageType.Assistant);
    expect(lastText(io.writes[2])).toContain("the summary");
    expect(next.some((m) => m.type === MessageType.ToolResult)).toBe(false);
    expect(lines.some((line) => line.startsWith("auto-compacting: context usage is"))).toBe(true);
    // the continuation answers a context ending in the summary: the assistant turns merge
    expect(agent.context.at(-1).content[0].text).toEndWith("final answer");
  });

  test("after a new user message — the message is held out of the summary and sent after it", async () => {
    const env = await windowEnv();
    const io = scriptedIO([
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    await agent.send(USER("next question"));
    expect(io.writes).toHaveLength(2);
    expect(isCompactRequest(io.writes[0])).toBe(true);
    expect(JSON.stringify(io.writes[0].context)).not.toContain("next question");
    const sent = io.writes[1].context;
    expect(sent.at(-2).type).toBe(MessageType.Assistant);
    expect(sent.at(-2).content[0].text).toContain("the summary");
    expect(sent.at(-1)).toEqual(USER("next question"));
    expect(JSON.stringify(sent)).not.toContain("q1");
  });

  test("trailing user and worker messages are preserved after compaction, in order", async () => {
    const env = await windowEnv();
    const io = scriptedIO([
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    const worker = { ...USER("[Message from worker: \"w\"]\nworker result"), worker: "w" };
    agent.context.append(USER("first"), { merge: false });
    agent.context.append(worker, { merge: false });
    agent.context.append(USER("third"), { merge: false });
    await agent.run();
    expect(isCompactRequest(io.writes[0])).toBe(true);
    for (const text of ["first", "worker result", "third"]) expect(JSON.stringify(io.writes[0].context)).not.toContain(text);
    const tail = io.writes[1].context.slice(-3);
    expect(tail.map((m) => m.content[0].text)).toEqual(["first", worker.content[0].text, "third"]);
    expect(io.writes[1].context.at(-4).content[0].text).toContain("the summary");
  });

  test("messages queued during the tool round and the compact turn stay pending, then follow the summary", async () => {
    let agent;
    const env = await windowEnv({ tools: { t: () => { agent.send(USER("during tools")); return LONG; } } });
    const io = fakeIO(async (self, callbacks) => {
      const n = self.writes.length;
      if (n === 1) return emitScript([...TOOLCALL(0, "c1", "t", {}), { type: "done" }], callbacks);
      if (n === 2) {
        agent.send(USER("during compaction"));
        return emitScript([...TEXT(0, "the summary"), { type: "done" }], callbacks);
      }
      return emitScript([...TEXT(0, "reply"), { type: "done" }], callbacks);
    });
    agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run();
    expect(io.writes).toHaveLength(3);
    expect(isCompactRequest(io.writes[1])).toBe(true);
    expect(JSON.stringify(io.writes[1].context)).not.toContain("during");
    expect(lastText(io.writes[2])).toContain("during tools");
    expect(lastText(io.writes[2])).toContain("during compaction");
    expect(io.writes[2].context.at(-2).content[0].text).toContain("the summary");
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
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    expect(agent.contextUsage.total).toBe(null);
    await agent.run();
    expect(io.writes).toHaveLength(2);
    expect(io.writes.some(isCompactRequest)).toBe(false);
  });

  for (const autocompact of [undefined, false]) {
    test(`the setting is ${autocompact === undefined ? "missing" : "false"}`, async () => {
      // cap/turn at 100%: the runaway guard stays out of it
      const context = autocompact === undefined ? { cap: 1, turn: 1 } : { cap: 1, turn: 1, autocompact };
      const env = await windowEnv({ context, tools: { t: () => LONG } });
      const io = scriptedIO([
        [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
        [...TEXT(0, "final"), { type: "done" }],
      ]);
      const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
      expect(agent.policy.context.autocompact).toBe(false);
      await agent.run();
      expect(io.writes).toHaveLength(2);
      expect(io.writes.some(isCompactRequest)).toBe(false);
    });
  }

  test("the compact turn never auto-compacts itself; dropping its stale usage report keeps the runaway guard quiet", async () => {
    const env = await windowEnv();
    const io = scriptedIO([
      [...TEXT(0, "the summary"), { type: "done" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    // 92.5% reported for every request, the compact one included: over
    // the runaway guard's 90% cap until compaction drops the report
    io.contextUsage = { used: 185, total: 200 };
    const agent = new Agent({ env, model: "p/m", context: [USER("q1"), ASSISTANT("a1")], createIO: () => io });
    agent._contextReport = { used: 185, total: 200 };
    const terminal = await agent.send(USER("next"));
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(2); // one compaction, then the request — no compaction of the compaction
    expect(isCompactRequest(io.writes[0])).toBe(true);
    expect(isCompactRequest(io.writes[1])).toBe(false);
    expect(io.writes[1].context.at(-1)).toEqual(USER("next"));
  });
});

describe("auto-compaction: failure and cancellation", () => {
  test("a failed compaction leaves the context intact and the request proceeds", async () => {
    const env = await windowEnv();
    env.settings.retry = { attempts: 1 };
    const io = scriptedIO([
      [{ type: "error", error: "boom", kind: "provider" }],
      [...TEXT(0, "reply"), { type: "done" }],
    ]);
    const before = [USER("q1"), ASSISTANT(LONG)];
    const agent = new Agent({ env, model: "p/m", context: before, createIO: () => io });
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
    const io = fakeIO(async () => {
      await agent.cancel();
      return { type: "error", error: "cancelled", kind: "cancelled", cancelled: true };
    });
    agent = new Agent({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
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
    const agent = new Agent({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
    agent.context.append(USER("/compact keep the API names"), { merge: false });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(1); // one compaction, never a second (manual) one
    expect(lastText(io.writes[0])).toContain(INSTRUCTION);
    expect(lastText(io.writes[0])).toContain("keep the API names");
    expect(JSON.stringify(agent.context.messages())).not.toContain("/compact");
    expect(agent.context.at(-1).content[0].text).toContain("the summary");
  });

  test("other tail messages follow the summary; a queued /compact's focus joins too", async () => {
    const env = await windowEnv();
    let agent;
    const io = fakeIO(async (self, callbacks) => {
      if (self.writes.length === 1) return emitScript([...TEXT(0, "the summary"), { type: "done" }], callbacks);
      return emitScript([...TEXT(0, "reply"), { type: "done" }], callbacks);
    });
    agent = new Agent({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
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
    const agent = new Agent({ env, model: "p/m", context: [USER("q1"), ASSISTANT(LONG)], createIO: () => io });
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
