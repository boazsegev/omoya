import { describe, expect, test } from "bun:test";
import Agent from "../lib/agent.js";
import { testEnv, USER, TEXT, scriptedIO } from "./fakes.js";

const REMOVED = [
  "contextNew", "contextFork", "contextResume", "toolStorage", "toolStorageClear",
  "toolMessageSet", "toolMessagesDetect", "backgroundStart", "backgroundList",
  "backgroundOutput", "backgroundStop", "backgroundStopAll", "questionInstall",
  "questionTimeoutReset", "policy",
];

describe("Agent's minimal conversation boundary", () => {
  test("exposes conversation operations rather than session and tool internals", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env });
    try {
      for (const name of REMOVED) expect(name in agent, name).toBe(false);
      for (const name of ["reseat", "folderResolve", "TOOL_TIMEOUT_DEFAULT"]) expect(Agent[name], name).toBeUndefined();
    } finally { agent.close(); env.close(); }
  });

  test("owns the same Context and Env until close and rejects replacement", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, context: [USER("original")] });
    const context = agent.context;
    const replacement = new Agent.Context({ save: false });
    try {
      expect(() => { agent.context = replacement; }).toThrow(TypeError);
      expect(() => { agent.env = env; }).toThrow(TypeError);
      expect(agent.context).toBe(context);
      agent.context.append(USER("still this conversation"));
      expect(agent.context.messages()[0].content[0].text).toContain("still this conversation");
    } finally { agent.close(); replacement.close(); env.close(); }
  });

  test("new Agents isolate usage, pending messages, workers, and provider connections", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done", usage: { inputTokens: 8, outputTokens: 3, cost: 0.25 } }]]);
    const first = await Agent.create({ env, model: "p/m", createIO: () => io });
    const second = await Agent.create({ env, model: "p/m", createIO: () => scriptedIO([]) });
    try {
      await first.send("first conversation");
      expect(first.usage.inputTokens).toBe(8);
      expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
      expect(second.pending).toEqual([]);
      expect(second.children).toEqual([]);
      expect(second.context).not.toBe(first.context);
      expect(second.context.messages()).toEqual([]);
      expect(second.io).not.toBe(first.io);
    } finally { first.close(); second.close(); env.close(); }
  });

  test("close releases owned IO and cannot recreate a connection", async () => {
    const env = await testEnv();
    const io = scriptedIO([]);
    const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
    expect(agent.io).toBe(io);
    agent.close();
    expect(io.closes).toBe(1);
    expect(agent.io).toBeUndefined();
    agent.close();
    expect(io.closes).toBe(1);
    env.close();
  });

  test("does not let public run options bypass guards or access compaction bookkeeping", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env });
    try {
      for (const name of ["contextGuard", "compacting", "pendingHold"]) {
        expect(() => agent.run({ [name]: false }), name).toThrow(/internal|unsupported/);
      }
    } finally { agent.close(); env.close(); }
  });
});
